import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function summaryXml(title: string): string {
  return `<summary><title>${title}</title><narrative>${title} narrative with enough detail for validation.</narrative><decisions></decisions><files></files><concepts></concepts></summary>`;
}

async function runSummarizeWithEnvFile(envLines: string[]): Promise<{
  success: boolean;
  maxInflight: number;
  calls: Array<{ system: string; prompt: string }>;
}> {
  const home = mkdtempSync(join(tmpdir(), "agentmemory-summarize-env-"));
  try {
    writeFileSync(join(home, ".env"), [...envLines, ""].join("\n"));
    process.env.AGENTMEMORY_HOME = home;
    vi.resetModules();

    const { registerSummarizeFunction } = await import("../src/functions/summarize.js");

    const values = new Map<string, unknown>();
    values.set("session-1", {
      id: "session-1",
      project: "proj",
      startedAt: "2026-07-05T00:00:00.000Z",
    });

    const observations = ["one", "two", "three", "four"].map((word, index) => ({
      id: `o${index + 1}`,
      type: "test",
      title: word,
      summary: word,
      facts: [`fact ${word}`],
      narrative: `${word} narrative`,
      files: [`src/${word}.ts`],
      concepts: [word],
      timestamp: `2026-07-05T00:00:0${index + 1}.000Z`,
    }));

    const kv = {
      get: async (_bucket: string, key: string) => values.get(key),
      list: async (bucket: string) => {
        if (bucket !== "mem:obs:session-1") return [];
        return observations;
      },
      set: async (bucket: string, key: string, value: unknown) => {
        values.set(`${bucket}:${key}`, value);
      },
    };

    let inflight = 0;
    let maxInflight = 0;
    const calls: Array<{ system: string; prompt: string }> = [];
    const provider = {
      name: "test-provider",
      summarize: async (system: string, prompt: string) => {
        calls.push({ system, prompt });
        const isReduce = system.includes("merging multiple partial summaries");
        if (!isReduce) {
          inflight += 1;
          maxInflight = Math.max(maxInflight, inflight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inflight -= 1;
          return summaryXml(`chunk ${calls.length}`);
        }
        return summaryXml("merged");
      },
    };

    const functions = new Map<string, Function>();
    const sdk = {
      registerFunction: (id: string, handler: Function) => {
        functions.set(id, handler);
      },
    };

    registerSummarizeFunction(sdk as never, kv as never, provider as never);
    const handler = functions.get("mem::summarize");
    if (!handler) throw new Error("mem::summarize was not registered");

    const result = await handler({ sessionId: "session-1" });
    return { success: result.success, maxInflight, calls };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("mem::summarize env file config", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("uses AGENTMEMORY_HOME .env chunk concurrency of 1", async () => {
    const result = await runSummarizeWithEnvFile([
      "SUMMARIZE_CHUNK_SIZE=2",
      "SUMMARIZE_CHUNK_CONCURRENCY=1",
    ]);

    expect(result.success).toBe(true);
    expect(result.calls).toHaveLength(3);
    expect(result.maxInflight).toBe(1);
    expect(result.calls[2].system).toContain("merging multiple partial summaries");
    expect(result.calls[2].prompt).toContain("Chunk 1 of 2");
    expect(result.calls[2].prompt).toContain("Chunk 2 of 2");
  });

  it("uses AGENTMEMORY_HOME .env chunk concurrency of 2", async () => {
    const result = await runSummarizeWithEnvFile([
      "SUMMARIZE_CHUNK_SIZE=2",
      "SUMMARIZE_CHUNK_CONCURRENCY=2",
    ]);

    expect(result.success).toBe(true);
    expect(result.calls).toHaveLength(3);
    expect(result.maxInflight).toBe(2);
  });
});

import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerExtractionRunIndexFunction } from "../src/functions/extraction-run-index.js";
import { KV } from "../src/state/schema.js";
import type { ExtractionRunIndex } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

describe("mem::extraction-run-record", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerExtractionRunIndexFunction(sdk as never, kv as never);
  });

  it("upserts extraction run records idempotently with deduplicated ids", async () => {
    await sdk.trigger("mem::extraction-run-record", {
      runId: "run-1",
      mark: "full-2026-07",
      status: "running",
      summarySessionId: "ses-a",
      lessonRunId: "lesson-a",
      semanticWindowId: "win-a",
      corpusWindowId: "corpus-a",
    });
    const result = (await sdk.trigger("mem::extraction-run-record", {
      runId: "run-1",
      mark: "full-2026-07",
      status: "partial",
      summarySessionId: "ses-a",
      lessonRunId: "lesson-a",
      semanticWindowId: "win-a",
      corpusWindowId: "corpus-a",
    })) as { success: boolean; run: ExtractionRunIndex };

    expect(result.success).toBe(true);
    expect(result.run).toMatchObject({
      id: "run-1",
      mark: "full-2026-07",
      status: "partial",
      summarySessionIds: ["ses-a"],
      lessonRunIds: ["lesson-a"],
      semanticWindowIds: ["win-a"],
      corpusWindowIds: ["corpus-a"],
    });

    const stored = await kv.get<ExtractionRunIndex>(KV.extractionRuns, "run-1");
    expect(stored).toEqual(result.run);
    const audits = await kv.list<{ operation: string; targetIds: string[] }>(KV.audit);
    expect(audits.map((entry) => entry.operation)).toEqual([
      "extraction_run_record",
      "extraction_run_record",
    ]);
    expect(audits[1].targetIds).toEqual(["run-1"]);
  });

  it("serializes concurrent updates for the same run id", async () => {
    await Promise.all([
      sdk.trigger("mem::extraction-run-record", {
        runId: "run-concurrent",
        mark: "full-2026-07",
        summarySessionId: "ses-a",
      }),
      sdk.trigger("mem::extraction-run-record", {
        runId: "run-concurrent",
        mark: "full-2026-07",
        lessonRunId: "lesson-a",
      }),
      sdk.trigger("mem::extraction-run-record", {
        runId: "run-concurrent",
        mark: "full-2026-07",
        semanticWindowId: "win-a",
      }),
      sdk.trigger("mem::extraction-run-record", {
        runId: "run-concurrent",
        mark: "full-2026-07",
        corpusWindowId: "corpus-a",
      }),
    ]);

    const stored = await kv.get<ExtractionRunIndex>(KV.extractionRuns, "run-concurrent");
    expect(stored).toMatchObject({
      id: "run-concurrent",
      summarySessionIds: ["ses-a"],
      lessonRunIds: ["lesson-a"],
      semanticWindowIds: ["win-a"],
      corpusWindowIds: ["corpus-a"],
    });
  });
});

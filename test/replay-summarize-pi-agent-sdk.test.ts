import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/eval/schemas.js", () => ({
  SummaryOutputSchema: {},
}));

vi.mock("../src/eval/validator.js", () => ({
  validateOutput: () => ({ valid: true, result: { errors: [] } }),
}));

vi.mock("../src/eval/quality.js", () => ({
  scoreSummary: () => 100,
}));

vi.mock("../src/functions/audit.js", () => ({
  safeAudit: vi.fn(),
}));

const streamCalls: Array<{ context: unknown; options: unknown }> = [];

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: vi.fn(
    async function* (_model: unknown, context: unknown, options: unknown) {
      streamCalls.push({ context, options });
      yield {
        type: "text_delta",
        text_delta:
          "<summary><title>Claude replay session</title><narrative>Recovered from import</narrative></summary>",
      };
      yield {
        type: "done",
        reason: "stop",
        message: {
          model: "gpt-5.4",
          responseModel: "gpt-5.4-response",
          usage: { input: 17, output: 9, totalTokens: 26 },
        },
      };
    },
  ),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModel: vi.fn(() => ({ provider: "openai-codex", model: "gpt-5.4" })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    inMemory: vi.fn(() => ({ getSessionId: () => "019f5a00-0000-7000-8000-000000000001" })),
  },
  AuthStorage: { create: vi.fn(() => ({ auth: true })) },
  ModelRegistry: {
    create: vi.fn(() => ({
      find: vi.fn(() => ({ provider: "openai-codex", model: "gpt-5.4" })),
      getApiKeyAndHeaders: vi.fn(() => ({
        configured: true,
        ok: true,
        apiKey: "pi-key",
      })),
    })),
  },
}));

import { loadConfig } from "../src/config.js";
import { createProvider } from "../src/providers/index.js";
import { registerReplayFunctions } from "../src/functions/replay.js";
import { registerSummarizeFunction } from "../src/functions/summarize.js";
import type { MemoryProvider } from "../src/types.js";

const CLAUDE_FIXTURE = `{"type":"user","uuid":"u1","sessionId":"sess-claude","timestamp":"2026-04-17T10:00:00.000Z","cwd":"~/.tmp/cl-project","message":{"role":"user","content":[{"type":"text","text":"请总结这次会话"}]}}
{"type":"assistant","uuid":"a1","sessionId":"sess-claude","timestamp":"2026-04-17T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"这是一次修复登录问题的会话。"}]}}`;

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (_scope: string, _key: string) => {},
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function noopProvider(): MemoryProvider {
  return {
    name: "noop",
    compress: vi.fn().mockResolvedValue(""),
    summarize: vi.fn().mockResolvedValue(""),
  };
}

function mockSdk(kv: ReturnType<typeof mockKV>) {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: vi.fn(),
    trigger: async (
      idOrInput: string | { function_id: string; payload?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
    _kv: kv,
  } as any;
}

describe("mem::summarize with pi-agent-sdk provider", () => {
  const originalEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "AGENTMEMORY_PROVIDER",
    "AGENTMEMORY_ALLOW_PI_AGENT_SDK",
    "PI_AGENT_MODEL",
  ];
  let tmpRoot: string;

  beforeEach(() => {
    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    streamCalls.length = 0;
    tmpRoot = mkdtempSync(join(tmpdir(), "replay-pi-summary-"));
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("loads pi provider from config and summaries an imported Claude JSONL session", async () => {
    process.env.AGENTMEMORY_PROVIDER = "pi-agent-sdk";
    process.env.AGENTMEMORY_ALLOW_PI_AGENT_SDK = "true";
    process.env.PI_AGENT_MODEL = "gpt-5.4";

    const cfg = await loadConfig();
    const provider = createProvider(cfg.provider);
    expect(provider.name).toBe("resilient(pi-agent-sdk)");

    const kv = mockKV();
    const sdk = mockSdk(kv);
    registerReplayFunctions(sdk, kv as never, noopProvider());
    registerSummarizeFunction(sdk as never, kv as never, provider);

    const dir = join(tmpRoot, "project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), CLAUDE_FIXTURE);

    const importResult = (await sdk.trigger("mem::replay::import-jsonl", {
      path: dir,
    })) as {
      success: boolean;
      sessionIds?: string[];
      error?: string;
    };
    expect(importResult.success).toBe(true);
    const sessionId = importResult.sessionIds?.[0];
    expect(sessionId).toBe("sess-claude");

    const summarizeResult = (await sdk.trigger("mem::summarize", {
      sessionId,
    })) as { success: boolean; error?: string; telemetry?: Array<Record<string, unknown>> };
    expect(summarizeResult.success).toBe(true);
    expect(summarizeResult.telemetry).toEqual([
      expect.objectContaining({
        operation: "summarize",
        callRole: "single",
        callIndex: 0,
        metadataStatus: "supported",
        metadata: expect.objectContaining({
          inputTokens: 17,
          outputTokens: 9,
          totalTokens: 26,
          maxOutputTokens: 4096,
          responseModel: "gpt-5.4-response",
        }),
      }),
    ]);
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]).toMatchObject({
      context: { messages: [{ role: "user", content: expect.any(String) }] },
      options: {
        transport: "sse",
        sessionId: "019f5a00-0000-7000-8000-000000000001",
      },
    });
  });
});

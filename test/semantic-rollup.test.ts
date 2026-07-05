import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSemanticRollupFunction } from "../src/functions/semantic-rollup.js";
import { KV } from "../src/state/schema.js";
import type { MemoryProvider, SemanticMemory, SessionSummary } from "../src/types.js";

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

function summary(sessionId: string): SessionSummary {
  return {
    sessionId,
    project: "agentmemory",
    createdAt: "2026-07-01T00:00:00.000Z",
    title: `Summary ${sessionId}`,
    narrative: `Narrative ${sessionId}`,
    keyDecisions: [`Decision ${sessionId}`],
    filesModified: [],
    concepts: ["memory"],
    observationCount: 3,
  };
}

function semantic(id: string, fact: string, sourceSessionIds = ["ses-a"]): SemanticMemory {
  return {
    id,
    fact,
    confidence: 0.7,
    sourceSessionIds,
    sourceMemoryIds: [],
    accessCount: 1,
    lastAccessedAt: "2026-07-01T00:00:00.000Z",
    strength: 0.7,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("mem::semantic-rollup", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let provider: MemoryProvider;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    provider = {
      name: "test-provider",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue('<facts><fact confidence="0.92">提炼事实</fact></facts>'),
    };
    registerSemanticRollupFunction(sdk as never, kv as never, provider);
  });

  it("writes window rollup semantic memories with provenance and audit", async () => {
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));
    await kv.set(KV.summaries, "ses-b", summary("ses-b"));

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-1",
      windowId: "win-1",
      mark: "full-2026-07",
      kind: "window",
      sessionIds: ["ses-a", "ses-b"],
    })) as {
      success: boolean;
      semanticMemoryIds: string[];
      semanticMemoryCharSizes: Record<string, number>;
      inputHash: string;
      facts: Array<{ fact: string; confidence: number }>;
    };

    expect(result.success).toBe(true);
    expect(result.semanticMemoryIds).toHaveLength(1);
    expect(result.semanticMemoryCharSizes).toEqual({
      [result.semanticMemoryIds[0]]: "提炼事实".length,
    });
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.facts).toEqual([{ fact: "提炼事实", confidence: 0.92 }]);

    const stored = await kv.get<SemanticMemory>(KV.semantic, result.semanticMemoryIds[0]);
    expect(stored).toMatchObject({
      fact: "提炼事实",
      confidence: 0.92,
      sourceSessionIds: ["ses-a", "ses-b"],
      sourceMemoryIds: [],
      extractionRunId: "run-1",
      extractionWindowId: "win-1",
      extractionMark: "full-2026-07",
      extractionInputHash: result.inputHash,
      extractionKind: "window",
    });

    const audits = await kv.list<{ operation: string; targetIds: string[] }>(KV.audit);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      operation: "semantic_rollup",
      targetIds: result.semanticMemoryIds,
    });
  });

  it("fails when window session summaries are missing", async () => {
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-1",
      windowId: "win-1",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a", "missing-session"],
    })) as {
      success: boolean;
      error: string;
      runId: string;
      windowId: string;
      mark: string;
      kind: string;
      inputHash: string;
      missingSessionIds: string[];
      missingSemanticMemoryIds: string[];
    };

    expect(result).toMatchObject({
      success: false,
      error: "missing_sources",
      runId: "run-1",
      windowId: "win-1",
      mark: "full",
      kind: "window",
      missingSessionIds: ["missing-session"],
      missingSemanticMemoryIds: [],
    });
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("fails when corpus source semantic memories are missing", async () => {
    await kv.set(KV.semantic, "sem-a", semantic("sem-a", "Fact A"));

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-1",
      windowId: "corpus-1",
      mark: "full",
      kind: "corpus",
      semanticMemoryIds: ["sem-a", "missing-sem"],
    })) as {
      success: boolean;
      error: string;
      runId: string;
      windowId: string;
      mark: string;
      kind: string;
      inputHash: string;
      missingSemanticMemoryIds: string[];
    };

    expect(result).toMatchObject({
      success: false,
      error: "missing_sources",
      runId: "run-1",
      windowId: "corpus-1",
      mark: "full",
      kind: "corpus",
      missingSessionIds: [],
      missingSemanticMemoryIds: ["missing-sem"],
    });
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("fails when provider returns no facts", async () => {
    (provider.summarize as ReturnType<typeof vi.fn>).mockResolvedValue("<facts></facts>");
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-1",
      windowId: "win-1",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as { success: boolean; error: string; runId: string; windowId: string; mark: string; kind: string; inputHash: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("empty_facts");
    expect(result).toMatchObject({
      runId: "run-1",
      windowId: "win-1",
      mark: "full",
      kind: "window",
    });
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("rejects non-string source id arrays without calling the provider", async () => {
    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-1",
      windowId: "win-1",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a", 1],
    })) as { success: boolean; error: string; runId: string; windowId: string; mark: string; kind: string; inputHash: string };

    expect(result).toMatchObject({
      success: false,
      error: "sessionIds and semanticMemoryIds must be string arrays",
      runId: "run-1",
      windowId: "win-1",
      mark: "full",
      kind: "window",
    });
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("returns a structured failure when the provider throws", async () => {
    (provider.summarize as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-1",
      windowId: "win-1",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as { success: boolean; error: string; runId: string; windowId: string; mark: string; kind: string; inputHash: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("provider_error");
    expect(result).toMatchObject({
      runId: "run-1",
      windowId: "win-1",
      mark: "full",
      kind: "window",
    });
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("rejects oversized source id lists before calling the provider", async () => {
    const sessionIds = Array.from({ length: 101 }, (_, i) => `ses-${i}`);
    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-1",
      windowId: "win-oversized",
      mark: "full",
      kind: "window",
      sessionIds,
    })) as {
      success: boolean;
      error: string;
      runId: string;
      windowId: string;
      mark: string;
      kind: string;
      sourceIds: number;
      maxSourceIds: number;
      inputHash: string;
    };

    expect(result).toMatchObject({
      success: false,
      error: "input_too_large",
      runId: "run-1",
      windowId: "win-oversized",
      mark: "full",
      kind: "window",
      sourceIds: 101,
      maxSourceIds: 100,
    });
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("rejects oversized prompts before calling the provider", async () => {
    await kv.set(KV.summaries, "ses-a", {
      ...summary("ses-a"),
      narrative: "x".repeat(25_000),
    });

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-1",
      windowId: "win-large",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as {
      success: boolean;
      error: string;
      runId: string;
      windowId: string;
      mark: string;
      kind: string;
      inputHash: string;
      promptChars: number;
      maxPromptChars: number;
    };

    expect(result).toMatchObject({
      success: false,
      error: "input_too_large",
      runId: "run-1",
      windowId: "win-large",
      mark: "full",
      kind: "window",
      maxPromptChars: 24000,
    });
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.promptChars).toBeGreaterThan(24000);
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("writes corpus rollups with source memory provenance", async () => {
    await kv.set(KV.semantic, "sem-a", semantic("sem-a", "Fact A", ["ses-a"]));
    await kv.set(KV.semantic, "sem-b", semantic("sem-b", "Fact B", ["ses-b"]));

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-2",
      windowId: "corpus-1",
      mark: "full",
      kind: "corpus",
      semanticMemoryIds: ["sem-a", "sem-b"],
    })) as { success: boolean; semanticMemoryIds: string[]; inputHash: string };

    expect(result.success).toBe(true);
    const stored = await kv.get<SemanticMemory>(KV.semantic, result.semanticMemoryIds[0]);
    expect(stored).toMatchObject({
      sourceSessionIds: ["ses-a", "ses-b"],
      sourceMemoryIds: ["sem-a", "sem-b"],
      extractionKind: "corpus",
    });
  });

  it("uses run-aware semantic ids while keeping the input hash source-only", async () => {
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));

    const first = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-a",
      windowId: "win-1",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as { semanticMemoryIds: string[]; inputHash: string };
    const second = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-b",
      windowId: "win-1",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as { semanticMemoryIds: string[]; inputHash: string };
    const repeat = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-a",
      windowId: "win-1",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as { semanticMemoryIds: string[]; inputHash: string; reused: boolean };

    expect(first.inputHash).toBe(second.inputHash);
    expect(repeat.inputHash).toBe(first.inputHash);
    expect(second.semanticMemoryIds[0]).not.toBe(first.semanticMemoryIds[0]);
    expect(repeat.semanticMemoryIds[0]).toBe(first.semanticMemoryIds[0]);
    expect(repeat.reused).toBe(true);
  });

  it("preserves runtime fields when an idempotent semantic write repeats", async () => {
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));
    const first = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-a",
      windowId: "win-1",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as { semanticMemoryIds: string[] };
    const existing = await kv.get<SemanticMemory>(KV.semantic, first.semanticMemoryIds[0]);
    await kv.set(KV.semantic, first.semanticMemoryIds[0], {
      ...existing!,
      accessCount: 7,
      lastAccessedAt: "2026-06-01T00:00:00.000Z",
      createdAt: "2026-05-01T00:00:00.000Z",
    });

    (provider.summarize as ReturnType<typeof vi.fn>).mockClear();
    const repeat = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-a",
      windowId: "win-1",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as { reused: boolean };

    const stored = await kv.get<SemanticMemory>(KV.semantic, first.semanticMemoryIds[0]);
    expect(repeat.reused).toBe(true);
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(stored).toMatchObject({
      accessCount: 7,
      lastAccessedAt: "2026-06-01T00:00:00.000Z",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
  });
});

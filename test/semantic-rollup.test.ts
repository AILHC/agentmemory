import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSemanticRollupFunction } from "../src/functions/semantic-rollup.js";
import { getSemanticRollupMaxPromptChars } from "../src/config.js";
import { KV } from "../src/state/schema.js";
import type { MemoryProvider, SemanticMemory, SessionSummary } from "../src/types.js";
import { ProviderCallError } from "../src/providers/provider-call-result.js";
import { buildExtractionOperationKey } from "../src/functions/extraction-operation-receipts.js";

function stableHash(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child)]));
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

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
    delete: async (scope: string, key: string): Promise<boolean> =>
      store.get(scope)?.delete(key) ?? false,
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

function expectHardFailure(result: unknown, cause: string): void {
  expect(result).toMatchObject({
    success: false,
    error: cause,
    failure: {
      class: "hard",
      cause,
    },
  });
}

describe("mem::semantic-rollup", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let provider: MemoryProvider;

  beforeEach(() => {
    delete process.env.AGENTMEMORY_SEMANTIC_ROLLUP_MODEL;
    delete process.env.AGENTMEMORY_SEMANTIC_ROLLUP_MAX_PROMPT_CHARS;
    delete process.env.AGENTMEMORY_EVALUATION_MODE;
    delete process.env.AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY;
    delete process.env.PI_AGENT_MODEL;
    sdk = mockSdk();
    kv = mockKV();
    provider = {
      name: "test-provider",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue('<facts><fact confidence="0.92">提炼事实</fact></facts>'),
    };
    registerSemanticRollupFunction(sdk as never, kv as never, provider);
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_SEMANTIC_ROLLUP_MODEL;
    delete process.env.AGENTMEMORY_SEMANTIC_ROLLUP_MAX_PROMPT_CHARS;
    delete process.env.AGENTMEMORY_EVALUATION_MODE;
    delete process.env.AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY;
    delete process.env.PI_AGENT_MODEL;
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

    const audits = await kv.list<{
      operation: string;
      targetIds: string[];
      details: { semanticRollupCommit?: { phase?: string } };
    }>(KV.audit);
    expect(audits).toHaveLength(2);
    expect(audits.map((audit) => audit.operation)).toEqual(["semantic_rollup", "semantic_rollup"]);
    expect(audits.map((audit) => audit.targetIds)).toEqual([
      result.semanticMemoryIds,
      result.semanticMemoryIds,
    ]);
    expect(audits.map((audit) => audit.details.semanticRollupCommit?.phase)).toEqual([
      "prepared",
      "committed",
    ]);
  });

  it("blocks semantic rollup before the provider", async () => {
    process.env.AGENTMEMORY_EVALUATION_MODE = "context-strategy";
    process.env.AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY = JSON.stringify({
      schemaVersion: 1,
      expectedProvider: "pi-agent-sdk",
      expectedModel: "gpt-5.4",
      worstTokensPerChar: 0.5,
      fixedTokens: 1,
      proportionalReserve: 0,
      contextWindow: 1,
      modelMaxTokens: 8192,
      maxOutputTokens: 128,
      reasoningReserve: 0,
      safetyMargin: 0,
      calibrationHash: `sha256:${"c".repeat(64)}`,
    });
    process.env.PI_AGENT_MODEL = "gpt-5.4";
    provider.name = "pi-agent-sdk";
    provider.summarizeWithMetadata = vi.fn(async () => ({ text: "unexpected" }));
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));
    await kv.set(KV.summaries, "ses-b", summary("ses-b"));

    const result: any = await sdk.trigger("mem::semantic-rollup", {
      runId: "run-preflight",
      windowId: "window-preflight",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a", "ses-b"],
    });

    expect(result).toMatchObject({ success: false, status: "infeasible", error: "infeasible" });
    expect(provider.summarizeWithMetadata).not.toHaveBeenCalled();
    expect(result.telemetry).toEqual([
      expect.objectContaining({ providerInvoked: false, preflightBlocked: true }),
    ]);
  });

  it("returns summarize telemetry without changing semantic output", async () => {
    provider.summarize = vi.fn(() => {
      throw new Error("legacy summarize path should not be used");
    });
    provider.summarizeWithMetadata = vi.fn(async () => ({
      text: '<facts><fact confidence="0.92">提炼事实</fact></facts>',
      metadata: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        maxOutputTokens: 4096,
        stopReason: "stop" as const,
        responseModel: "semantic-model",
      },
    }));
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-telemetry",
      windowId: "win-telemetry",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as any;

    expect(result.success).toBe(true);
    expect(result.telemetry).toEqual([
      expect.objectContaining({
        operation: "summarize",
        callRole: "window",
        callIndex: 0,
        metadataStatus: "supported",
        metadata: expect.objectContaining({
          inputTokens: 12,
          outputTokens: 5,
          totalTokens: 17,
          maxOutputTokens: 4096,
          responseModel: "semantic-model",
        }),
      }),
    ]);
    expect(JSON.stringify(result.telemetry)).not.toContain("提炼事实");
    expect(JSON.stringify(result.telemetry)).not.toContain("Extract durable semantic facts");
  });

  it("keeps ProviderCallError metadata on semantic failure responses", async () => {
    const metadata = {
      inputTokens: 4,
      outputTokens: 0,
      totalTokens: 4,
      maxOutputTokens: 4096,
      stopReason: "error" as const,
      responseModel: "semantic-error-model",
    };
    provider.summarizeWithMetadata = vi.fn(async () => {
      throw new ProviderCallError("pi_stream_failed", metadata);
    });
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-error-telemetry",
      windowId: "win-error-telemetry",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as any;

    expect(result.success).toBe(false);
    expect(result.error).toBe("provider_error");
    expect(result).not.toHaveProperty("failure");
    expect(result.telemetry).toEqual([
      expect.objectContaining({
        metadataStatus: "supported",
        metadata,
      }),
    ]);
  });

  it("leaves a provider-failed recovery receipt running without semantic effects", async () => {
    provider.summarizeWithMetadata = vi.fn(async () => {
      throw new ProviderCallError("pi_stream_failed");
    });
    const storedSummary = summary("ses-a");
    await kv.set(KV.summaries, "ses-a", storedSummary);
    const summaryHash = stableHash({
      title: storedSummary.title,
      narrative: storedSummary.narrative,
      keyDecisions: storedSummary.keyDecisions,
      filesModified: storedSummary.filesModified,
      concepts: storedSummary.concepts,
    });
    const runnerInputHash = stableHash([["ses-a", summaryHash]]);
    const recoveryIdentity = {
      runId: "semantic-provider-failure",
      stage: "semantic_rollup" as const,
      unitId: "semantic-provider-failure-window",
      inputHash: "a".repeat(64),
    };
    const receiptKey = buildExtractionOperationKey(recoveryIdentity);
    const runningReceipt = {
      ...recoveryIdentity,
      key: receiptKey,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:00:00.000Z",
    };
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, runningReceipt);

    const result = await sdk.trigger("mem::semantic-rollup", {
      runId: recoveryIdentity.runId,
      windowId: recoveryIdentity.unitId,
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
      sourceSummaryHashes: { "ses-a": summaryHash },
      runnerInputHash,
      recoveryIdentity,
    });

    expect(result).toMatchObject({
      success: false,
      status: "failed",
      error: "provider_error",
    });
    expect(provider.summarizeWithMetadata).toHaveBeenCalledTimes(1);
    expect(await kv.get(KV.extractionOperationReceipt(receiptKey), receiptKey))
      .toEqual(runningReceipt);
    expect(await kv.list(KV.semantic)).toEqual([]);
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("bounds AGENTMEMORY_SEMANTIC_ROLLUP_MAX_PROMPT_CHARS config", () => {
    expect(getSemanticRollupMaxPromptChars({
      AGENTMEMORY_SEMANTIC_ROLLUP_MAX_PROMPT_CHARS: "not-a-number",
    })).toBe(64_000);
    expect(getSemanticRollupMaxPromptChars({
      AGENTMEMORY_SEMANTIC_ROLLUP_MAX_PROMPT_CHARS: "0",
    })).toBe(64_000);
    expect(getSemanticRollupMaxPromptChars({
      AGENTMEMORY_SEMANTIC_ROLLUP_MAX_PROMPT_CHARS: "999999",
    })).toBe(120_000);
  });

  it("returns effective model metadata for applied pi-agent-sdk model routing", async () => {
    provider.name = "pi-agent-sdk";
    process.env.AGENTMEMORY_SEMANTIC_ROLLUP_MODEL = "semantic-env-model";
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-1",
      windowId: "win-model",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as {
      success: boolean;
      stage: string;
      model: string;
      modelSource: string;
      provider: string;
      modelApplied: boolean;
      promptChars: number;
      charBudget: number;
      durationMs: number;
      parseFailures: number;
    };

    expect(result.success).toBe(true);
    expect(result).toMatchObject({
      stage: "semantic_rollup",
      model: "semantic-env-model",
      modelSource: "AGENTMEMORY_SEMANTIC_ROLLUP_MODEL",
      provider: "pi-agent-sdk",
      modelApplied: true,
      parseFailures: 0,
    });
    expect(result.promptChars).toBeGreaterThan(0);
    expect(result.charBudget).toBeGreaterThanOrEqual(result.promptChars);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
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

  it("rejects corpus rollups before reading semantic memory sources", async () => {
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
      missingSemanticMemoryIds?: string[];
    };

    expect(result).toMatchObject({
      success: false,
      error: "kind corpus is not supported; use kind window",
      runId: "run-1",
      windowId: "corpus-1",
      mark: "full",
      kind: "corpus",
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
    expect(result).not.toHaveProperty("failure");
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
    expect(result).not.toHaveProperty("failure");
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("rejects oversized prompts before calling the provider", async () => {
    await kv.set(KV.summaries, "ses-a", {
      ...summary("ses-a"),
      narrative: "x".repeat(70_000),
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
      maxPromptChars: 64000,
    });
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.promptChars).toBeGreaterThan(64000);
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("uses AGENTMEMORY_SEMANTIC_ROLLUP_MAX_PROMPT_CHARS for the service prompt cap", async () => {
    process.env.AGENTMEMORY_SEMANTIC_ROLLUP_MAX_PROMPT_CHARS = "30000";
    await kv.set(KV.summaries, "ses-a", {
      ...summary("ses-a"),
      narrative: "x".repeat(25_000),
    });

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-1",
      windowId: "win-env-cap",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as {
      success: boolean;
      charBudget: number;
      promptChars: number;
    };

    expect(result.success).toBe(true);
    expect(result.charBudget).toBe(30000);
    expect(result.promptChars).toBeGreaterThan(24000);
    expect(provider.summarize).toHaveBeenCalled();
  });

  it("does not accept corpus rollups as a success path", async () => {
    await kv.set(KV.semantic, "sem-a", semantic("sem-a", "Fact A", ["ses-a"]));
    await kv.set(KV.semantic, "sem-b", semantic("sem-b", "Fact B", ["ses-b"]));

    const result = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-2",
      windowId: "corpus-1",
      mark: "full",
      kind: "corpus",
      semanticMemoryIds: ["sem-a", "sem-b"],
    })) as { success: boolean; error: string; inputHash: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("corpus");
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("uses run-aware semantic ids while keeping the input hash source-only", async () => {
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));

    const first = (await sdk.trigger("mem::semantic-rollup", {
      runId: "run-a",
      windowId: "win-1",
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
    })) as { runId: string; windowId: string; semanticMemoryIds: string[]; inputHash: string };
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
    expect(first).toMatchObject({ runId: "run-a", windowId: "win-1" });
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

  it("resumes a frozen semantic result collection after a partial write without another provider call", async () => {
    provider.summarize = vi.fn().mockResolvedValue(
      '<facts><fact confidence="0.9">First frozen fact</fact><fact confidence="0.8">Second frozen fact</fact></facts>',
    );
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));
    const originalSet = kv.set;
    let semanticWrites = 0;
    let failSecondWrite = true;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (scope === KV.semantic) {
        semanticWrites += 1;
        if (failSecondWrite && semanticWrites === 2) {
          failSecondWrite = false;
          throw new Error("semantic write interrupted");
        }
      }
      return originalSet(scope, key, data);
    };

    const input = {
      runId: "run-partial",
      windowId: "win-partial",
      mark: "full",
      kind: "window" as const,
      sessionIds: ["ses-a"],
    };
    await expect(sdk.trigger("mem::semantic-rollup", input)).rejects.toThrow("semantic write interrupted");

    const resumed = (await sdk.trigger("mem::semantic-rollup", input)) as {
      success: boolean;
      resumed: boolean;
      semanticMemoryIds: string[];
      facts: Array<{ fact: string; confidence: number }>;
      semanticRecoveryEvidence: { kind: string; identity: { configHash: string } };
    };
    expect(resumed.success).toBe(true);
    expect(resumed.resumed).toBe(true);
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(resumed.semanticMemoryIds).toHaveLength(2);
    expect(resumed.facts).toEqual([
      { fact: "First frozen fact", confidence: 0.9 },
      { fact: "Second frozen fact", confidence: 0.8 },
    ]);
    expect(resumed.semanticRecoveryEvidence).toMatchObject({
      kind: "committed",
      identity: { configHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(await kv.list<SemanticMemory>(KV.semantic)).toHaveLength(2);
    expect(await kv.list(KV.audit)).toHaveLength(2);
  });

  it("fails closed when the same semantic input is retried with a different configuration", async () => {
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));
    const input = {
      runId: "run-config",
      windowId: "win-config",
      mark: "full",
      kind: "window" as const,
      sessionIds: ["ses-a"],
    };
    await sdk.trigger("mem::semantic-rollup", { ...input, model: "model-a" });
    const conflict = (await sdk.trigger("mem::semantic-rollup", {
      ...input,
      model: "model-b",
    })) as { success: boolean; error: string };

    expect(conflict).toEqual(expect.objectContaining({
      success: false,
      error: "configuration_identity_conflict",
    }));
    expectHardFailure(conflict, "configuration_identity_conflict");
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("returns closed structured hard failures for formal recovery identity faults", async () => {
    const storedSummary = summary("ses-a");
    await kv.set(KV.summaries, "ses-a", storedSummary);
    const summaryHash = stableHash({
      title: storedSummary.title,
      narrative: storedSummary.narrative,
      keyDecisions: storedSummary.keyDecisions,
      filesModified: storedSummary.filesModified,
      concepts: storedSummary.concepts,
    });
    const runnerInputHash = stableHash([["ses-a", summaryHash]]);
    const recoveryIdentity = {
      runId: "attempt-binding",
      stage: "semantic_rollup" as const,
      unitId: "w-binding",
      inputHash: "a".repeat(64),
    };
    const baseInput = {
      runId: recoveryIdentity.runId,
      windowId: recoveryIdentity.unitId,
      mark: "full",
      kind: "window" as const,
      sessionIds: ["ses-a"],
      sourceSummaryHashes: { "ses-a": summaryHash },
      runnerInputHash,
      recoveryIdentity,
    };

    const identityConflict = await sdk.trigger("mem::semantic-rollup", {
      ...baseInput,
      recoveryIdentity: {
        ...recoveryIdentity,
        runId: "different-attempt",
      },
    });
    expectHardFailure(identityConflict, "semantic_rollup_recovery_identity_conflict");

    const receiptUnavailable = await sdk.trigger("mem::semantic-rollup", baseInput);
    expectHardFailure(receiptUnavailable, "semantic_rollup_recovery_receipt_unavailable");

    const runnerConflict = await sdk.trigger("mem::semantic-rollup", {
      ...baseInput,
      runnerInputHash: "b".repeat(64),
    });
    expectHardFailure(runnerConflict, "semantic_rollup_runner_input_hash_conflict");
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("returns a structured hard failure when a committed semantic item conflicts", async () => {
    await kv.set(KV.summaries, "ses-a", summary("ses-a"));
    const input = {
      runId: "run-item-conflict",
      windowId: "win-item-conflict",
      mark: "full",
      kind: "window" as const,
      sessionIds: ["ses-a"],
    };
    const first = await sdk.trigger("mem::semantic-rollup", input) as {
      semanticMemoryIds: string[];
    };
    const memoryId = first.semanticMemoryIds[0];
    const stored = await kv.get<SemanticMemory>(KV.semantic, memoryId);
    await kv.set(KV.semantic, memoryId, {
      ...stored!,
      fact: "mutated after commit",
    });

    const conflict = await sdk.trigger("mem::semantic-rollup", input);

    expectHardFailure(conflict, "semantic_rollup_commit_conflict");
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("freezes the provider result in the outer receipt and re-verifies a committed plan item by item", async () => {
    const storedSummary = summary("ses-a");
    await kv.set(KV.summaries, "ses-a", storedSummary);
    provider.summarize = vi.fn().mockResolvedValue(
      '<facts><fact confidence="0.9">First receipt fact</fact><fact confidence="0.8">Second receipt fact</fact></facts>',
    );
    const summaryHash = stableHash({
      title: storedSummary.title,
      narrative: storedSummary.narrative,
      keyDecisions: storedSummary.keyDecisions,
      filesModified: storedSummary.filesModified,
      concepts: storedSummary.concepts,
    });
    const runnerInputHash = stableHash([["ses-a", summaryHash]]);
    const recoveryIdentity = {
      runId: "attempt-semantic",
      stage: "semantic_rollup" as const,
      unitId: "w0001",
      inputHash: "e".repeat(64),
    };
    const receiptKey = buildExtractionOperationKey(recoveryIdentity);
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...recoveryIdentity,
      key: receiptKey,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:00:00.000Z",
    });
    const input = {
      runId: recoveryIdentity.runId,
      windowId: recoveryIdentity.unitId,
      mark: "full",
      kind: "window" as const,
      sessionIds: ["ses-a"],
      sourceSummaryHashes: { "ses-a": summaryHash },
      runnerInputHash,
      recoveryIdentity,
    };

    const first = await sdk.trigger("mem::semantic-rollup", input) as any;
    const committedReceipt = await kv.get<any>(KV.extractionOperationReceipt(receiptKey), receiptKey);
    expect(committedReceipt.semanticRecovery).toMatchObject({
      schema: "semantic-rollup-recovery/v1",
      phase: "committed",
      identity: {
        runId: recoveryIdentity.runId,
        unitId: recoveryIdentity.unitId,
        receiptInputHash: recoveryIdentity.inputHash,
        runnerInputHash,
      },
      expectedFacts: expect.arrayContaining([
        expect.objectContaining({ fact: "First receipt fact" }),
        expect.objectContaining({ fact: "Second receipt fact" }),
      ]),
    });
    expect(first.semanticRecoveryEvidence).toMatchObject({
      schema: "semantic-rollup-recovery/v1",
      phase: "committed",
      receiptKey,
    });

    const missingId = first.semanticMemoryIds[1];
    await kv.delete(KV.semantic, missingId);
    const replay = await sdk.trigger("mem::semantic-rollup", input) as any;

    expect(replay.semanticMemoryIds).toEqual(first.semanticMemoryIds);
    expect(await kv.get(KV.semantic, missingId)).not.toBeNull();
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("rejects source-summary and runner-unit drift before provider dispatch", async () => {
    const storedSummary = summary("ses-a");
    await kv.set(KV.summaries, "ses-a", storedSummary);
    const recoveryIdentity = {
      runId: "attempt-drift",
      stage: "semantic_rollup" as const,
      unitId: "w0001",
      inputHash: "e".repeat(64),
    };
    const receiptKey = buildExtractionOperationKey(recoveryIdentity);
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...recoveryIdentity,
      key: receiptKey,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:00:00.000Z",
    });

    const result = await sdk.trigger("mem::semantic-rollup", {
      runId: recoveryIdentity.runId,
      windowId: recoveryIdentity.unitId,
      mark: "full",
      kind: "window",
      sessionIds: ["ses-a"],
      sourceSummaryHashes: { "ses-a": "f".repeat(64) },
      runnerInputHash: "d".repeat(64),
      recoveryIdentity,
    }) as any;

    expect(result).toMatchObject({
      success: false,
      error: "semantic_rollup_source_summary_drifted",
    });
    expectHardFailure(result, "semantic_rollup_source_summary_drifted");
    expect(provider.summarize).not.toHaveBeenCalled();
  });
});

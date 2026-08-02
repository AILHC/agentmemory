import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getConsolidationDecayDays: () => 30,
  isConsolidationEnabled: vi.fn(() => true),
  resolveStageModelCallOptions: vi.fn(() => undefined),
  resolveStageModelMetadata: vi.fn((stage: string, provider?: { name?: string }) => ({
    stage,
    provider: provider?.name ?? "test",
    modelApplied: provider?.name === "pi-agent-sdk",
    ...(provider?.name === "pi-agent-sdk"
      ? { model: "test-model", modelSource: "provider_default" }
      : { providerModelOverride: "unsupported" }),
  })),
}));

import {
  buildConsolidationProceduralSourceVersion,
  CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
  enqueueConsolidationProceduralBacklog,
  planConsolidationProceduralWindows,
  reconcileConsolidationProceduralContribution,
  registerConsolidationPipelineFunction,
  runConsolidationProceduralWindow,
} from "../src/functions/consolidation-pipeline.js";
import { isConsolidationEnabled, resolveStageModelCallOptions, resolveStageModelMetadata } from "../src/config.js";
import type {
  AuditEntry,
  ContributionRecord,
  SessionSummary,
  Memory,
  SemanticMemory,
  ProceduralMemory,
} from "../src/types.js";
import { ProviderCallError } from "../src/providers/provider-call-result.js";
import { logger } from "../src/logger.js";
import { KV } from "../src/state/schema.js";
import { buildExtractionOperationKey } from "../src/functions/extraction-operation-receipts.js";

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
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
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
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeSummary(i: number): SessionSummary {
  return {
    sessionId: `ses_${i}`,
    project: "test-project",
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
    title: `Session ${i} summary`,
    narrative: `Worked on feature ${i}`,
    keyDecisions: [`Decision ${i}`],
    filesModified: [`src/file${i}.ts`],
    concepts: ["typescript", "testing"],
    observationCount: 5,
  };
}

function makePattern(i: number): Memory {
  return {
    id: `mem_${i}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    type: "pattern",
    title: `Pattern ${i}`,
    content: `Always do thing ${i}`,
    concepts: ["testing"],
    files: [],
    sessionIds: ["ses_1", "ses_2"],
    strength: 5,
    version: 1,
    isLatest: true,
  };
}

async function seedProceduralReceipt(
  kv: ReturnType<typeof mockKV>,
  identity: { runId: string; unitId: string; inputHash: string },
): Promise<string> {
  const key = buildExtractionOperationKey({
    ...identity,
    stage: "consolidation_procedural",
  });
  await kv.set(KV.extractionOperationReceipt(key), key, {
    ...identity,
    stage: "consolidation_procedural",
    key,
    version: 1,
    status: "running",
    startedAt: "2026-08-02T00:00:00.000Z",
  });
  return key;
}

async function completeProceduralReceipt(
  kv: ReturnType<typeof mockKV>,
  key: string,
  response: Record<string, unknown>,
): Promise<void> {
  const receipt = await kv.get<Record<string, unknown>>(
    KV.extractionOperationReceipt(key),
    key,
  );
  await kv.set(KV.extractionOperationReceipt(key), key, {
    ...receipt,
    status: "succeeded",
    completedAt: "2026-08-02T00:01:00.000Z",
    response,
  });
}

describe("Consolidation Pipeline", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
    delete process.env.AGENTMEMORY_EVALUATION_MODE;
    delete process.env.AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY;
  });

  it("fails fast for unsupported output language instead of returning success with tier errors", async () => {
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "fr";
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    await expect(
      sdk.trigger("mem::consolidate-pipeline", { tier: "semantic", force: true }),
    ).rejects.toThrow("Unsupported AGENTMEMORY_OUTPUT_LANGUAGE: fr");
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("pipeline skips semantic when fewer than 5 summaries", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 3; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const semantic = result.results.semantic as { skipped: boolean; reason: string };
    expect(semantic.skipped).toBe(true);
    expect(semantic.reason).toContain("fewer than 5");
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("pipeline skips procedural when fewer than 2 patterns", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const mem: Memory = {
      ...makePattern(1),
      sessionIds: ["ses_1", "ses_2"],
    };
    await kv.set("mem:memories", "mem_1", mem);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const procedural = result.results.procedural as { skipped: boolean; reason: string };
    expect(procedural.skipped).toBe(true);
    expect(procedural.reason).toContain("fewer than 2");
  });

  it("with enough summaries, creates semantic memories from provider response", async () => {
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<facts><fact confidence="0.9">TypeScript 是主要语言</fact></facts>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const semantic = result.results.semantic as {
      newFacts: number;
      telemetry: Array<Record<string, unknown>>;
    };
    expect(semantic.newFacts).toBe(1);
    expect(semantic.telemetry).toEqual([
      expect.objectContaining({
        operation: "summarize",
        callRole: "window",
        callIndex: 0,
        metadataStatus: "unsupported",
      }),
    ]);

    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored.length).toBe(1);
    expect(stored[0].fact).toBe("TypeScript 是主要语言");
    expect(stored[0].confidence).toBe(0.9);
    expect(provider.summarize).toHaveBeenCalledWith(
      expect.stringContaining("AgentMemory Output Language Policy"),
      expect.any(String),
    );
  });

  it("keeps non-Chinese semantic facts as warning but still saves when retry cannot fully fix", async () => {
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn()
        .mockResolvedValueOnce("<facts><fact confidence=\"0.88\">This is English only.</fact></facts>")
        .mockResolvedValueOnce("<facts><fact confidence=\"0.88\">这是中文事实。</fact></facts>"),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as {
      success: boolean;
      results: {
        semantic: {
          languageViolations?: string[];
          telemetry: Array<Record<string, unknown>>;
        };
      };
    };

    expect(result.success).toBe(true);
    expect(result.results.semantic.languageViolations).toBeUndefined();
    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored).toHaveLength(1);
    expect(stored[0].fact).toBe("这是中文事实。");
    expect(result.results.semantic.telemetry.map((item) => item.callIndex)).toEqual([0, 1]);
    expect(result.results.semantic.telemetry.every((item) => item.metadataStatus === "unsupported")).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("keeps the first semantic extraction when strict retry fails and records both attempts", async () => {
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn()
        .mockResolvedValueOnce("<facts><fact confidence=\"0.88\">This is English only.</fact></facts>")
        .mockRejectedValueOnce(new Error("strict retry failed")),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as {
      success: boolean;
      results: { semantic: { telemetry: Array<Record<string, unknown>> } };
    };

    expect(result.success).toBe(true);
    expect(result.results.semantic.telemetry.map((item) => item.callIndex)).toEqual([0, 1]);
    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored).toHaveLength(1);
    expect(stored[0].fact).toBe("This is English only.");
  });

  it("keeps non-Chinese semantic facts with warning when retry also violates language contract", async () => {
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn()
        .mockResolvedValueOnce("<facts><fact confidence=\"0.85\">This is still English.</fact></facts>")
        .mockResolvedValueOnce("<facts><fact confidence=\"0.85\">Still English after retry.</fact></facts>"),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as {
      success: boolean;
      results: {
        semantic: {
          languageViolations?: string[];
          telemetry: Array<Record<string, unknown>>;
        };
      };
    };

    expect(result.success).toBe(true);
    expect(result.results.semantic.languageViolations).toEqual(["Still English after retry."]);
    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored).toHaveLength(1);
    expect(stored[0].fact).toBe("Still English after retry.");
    expect(result.results.semantic.telemetry.map((item) => item.callIndex)).toEqual([0, 1]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("keeps ProviderCallError metadata on the first semantic attempt", async () => {
    const metadata = {
      inputTokens: 7,
      outputTokens: 0,
      totalTokens: 7,
      maxOutputTokens: 4096,
      stopReason: "error" as const,
      responseModel: "semantic-error-model",
    };
    const provider = {
      name: "pi-agent-sdk",
      compress: vi.fn(),
      summarize: vi.fn().mockRejectedValue(new Error("legacy summarize should not be used")),
      summarizeWithMetadata: vi.fn(async () => {
        throw new ProviderCallError("pi_stream_failed", metadata);
      }),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as {
      success: boolean;
      results: {
        semantic: {
          error: string;
          telemetry: Array<Record<string, unknown>>;
        };
      };
    };

    expect(result.success).toBe(true);
    expect(result.results.semantic.error).toBe("pi_stream_failed");
    expect(result.results.semantic.telemetry).toEqual([
      expect.objectContaining({
        operation: "summarize",
        callRole: "window",
        callIndex: 0,
        metadataStatus: "supported",
        metadata,
      }),
    ]);
    expect(JSON.stringify(result.results.semantic.telemetry)).not.toContain("pi_stream_failed");
  });

  it("with enough patterns, creates procedural memories from provider response", async () => {
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Test Workflow" trigger="when writing tests"><step>Create test file</step><step>Write assertions</step></procedure></procedures>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 3; i++) {
      await kv.set("mem:memories", `mem_${i}`, makePattern(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const procedural = result.results.procedural as { newProcedures: number };
    expect(procedural.newProcedures).toBe(1);

    const stored = await kv.list<ProceduralMemory>("mem:procedural");
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe("Test Workflow");
    expect(stored[0].steps.length).toBe(2);
    expect(stored[0].triggerCondition).toBe("when writing tests");
    expect(provider.summarize).toHaveBeenCalledWith(
      expect.stringContaining("AgentMemory Output Language Policy"),
      expect.any(String),
    );
  });

  it("returns procedural summarize telemetry and keeps the compress path unused", async () => {
    const provider = {
      name: "pi-agent-sdk",
      compress: vi.fn(() => {
        throw new Error("compress must not be used for procedural extraction");
      }),
      summarize: vi.fn(() => {
        throw new Error("legacy summarize path should not be used");
      }),
      summarizeWithMetadata: vi.fn(async () => ({
        text: '<procedures><procedure name="Telemetry Workflow" trigger="when observing"><step>Observe</step><step>Record</step></procedure></procedures>',
        metadata: {
          inputTokens: 14,
          outputTokens: 8,
          totalTokens: 22,
          maxOutputTokens: 4096,
          stopReason: "stop" as const,
          responseModel: "procedural-model",
        },
      })),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 3; i++) {
      await kv.set("mem:memories", `mem_${i}`, makePattern(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
    })) as any;

    expect(result.success).toBe(true);
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(provider.compress).not.toHaveBeenCalled();
    expect(result.results.procedural.telemetry).toEqual([
      expect.objectContaining({
        operation: "summarize",
        callRole: "window",
        callIndex: 0,
        metadataStatus: "supported",
        metadata: expect.objectContaining({
          inputTokens: 14,
          totalTokens: 22,
          maxOutputTokens: 4096,
        }),
      }),
    ]);
    expect(JSON.stringify(result.results.procedural.telemetry)).not.toContain("Telemetry Workflow");
  });

  it("keeps ProviderCallError metadata on a procedural window failure", async () => {
    const metadata = {
      inputTokens: 3,
      outputTokens: 0,
      totalTokens: 3,
      maxOutputTokens: 4096,
      stopReason: "error" as const,
      responseModel: "procedural-error-model",
    };
    const provider = {
      name: "pi-agent-sdk",
      compress: vi.fn(),
      summarize: vi.fn(),
      summarizeWithMetadata: vi.fn(async () => {
        throw new ProviderCallError("pi_stream_failed", metadata);
      }),
    };
    await kv.set("mem:memories", "mem_1", makePattern(1));
    await kv.set("mem:memories", "mem_2", makePattern(2));

    const result = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: ["mem_1", "mem_2"],
    });

    expect(result.success).toBe(false);
    expect(result.telemetry).toEqual([
      expect.objectContaining({ metadataStatus: "supported", metadata }),
    ]);
  });

  it("leaves a provider-failed procedural receipt running without formal effects", async () => {
    const provider = {
      name: "pi-agent-sdk",
      compress: vi.fn(),
      summarize: vi.fn(),
      summarizeWithMetadata: vi.fn(async () => {
        throw new ProviderCallError("pi_stream_failed");
      }),
    };
    await kv.set(KV.memories, "mem_provider_failure_1", {
      ...makePattern(1),
      id: "mem_provider_failure_1",
    });
    await kv.set(KV.memories, "mem_provider_failure_2", {
      ...makePattern(2),
      id: "mem_provider_failure_2",
    });
    const recoveryIdentity = {
      runId: "procedural-provider-failure",
      unitId: "procedural-provider-failure-window",
      inputHash: "a".repeat(64),
    };
    const receiptKey = buildExtractionOperationKey({
      ...recoveryIdentity,
      stage: "consolidation_procedural",
    });
    const runningReceipt = {
      ...recoveryIdentity,
      stage: "consolidation_procedural",
      key: receiptKey,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:00:00.000Z",
    };
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, runningReceipt);

    const result = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: ["mem_provider_failure_1", "mem_provider_failure_2"],
      recoveryIdentity,
    });

    expect(result).toMatchObject({
      success: false,
      status: "failed",
      error: "pi_stream_failed",
    });
    expect(provider.summarizeWithMetadata).toHaveBeenCalledTimes(1);
    expect(await kv.get(KV.extractionOperationReceipt(receiptKey), receiptKey))
      .toEqual(runningReceipt);
    expect(await kv.list(KV.procedural)).toEqual([]);
    expect(await kv.list(KV.audit)).toEqual([]);
    expect(await kv.list(KV.memories)).toHaveLength(2);
  });

  it("blocks procedural extraction before the provider", async () => {
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
      calibrationHash: `sha256:${"d".repeat(64)}`,
    });
    const provider = {
      name: "pi-agent-sdk",
      model: "gpt-5.4",
      compress: vi.fn(),
      summarize: vi.fn(),
      summarizeWithMetadata: vi.fn(async () => ({ text: "unexpected" })),
    };
    await kv.set("mem:memories", "mem_preflight_1", { ...makePattern(1), id: "mem_preflight_1" });
    await kv.set("mem:memories", "mem_preflight_2", { ...makePattern(2), id: "mem_preflight_2" });

    const result: any = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: ["mem_preflight_1", "mem_preflight_2"],
    });

    expect(result).toMatchObject({ success: false, status: "infeasible", error: "infeasible" });
    expect(provider.summarizeWithMetadata).not.toHaveBeenCalled();
    expect(result.telemetry).toEqual([
      expect.objectContaining({ providerInvoked: false, preflightBlocked: true }),
    ]);
  });

  it("full procedural window only uses latest recurring pattern memories", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Full Procedure" trigger="when patterns recur"><step>Read pattern</step><step>Apply pattern</step></procedure></procedures>`,
      ),
    };
    await kv.set("mem:memories", "eligible-1", { ...makePattern(1), id: "eligible-1" });
    await kv.set("mem:memories", "eligible-2", { ...makePattern(2), id: "eligible-2" });
    await kv.set("mem:memories", "old", { ...makePattern(3), id: "old", isLatest: false });
    await kv.set("mem:memories", "fact", { ...makePattern(4), id: "fact", type: "fact" });
    await kv.set("mem:memories", "rare", { ...makePattern(5), id: "rare", sessionIds: ["ses_1"] });

    const result = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: ["eligible-1", "eligible-2", "old", "fact", "rare"],
    });

    expect(result.success).toBe(true);
    expect(result.patternsAnalyzed).toBe(2);
    expect(result.proceduralMemoryIds).toEqual([expect.stringMatching(/^proc_/)]);
    expect(provider.summarize).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.stringContaining("Always do thing 3"),
    );
    const stored = await kv.list<ProceduralMemory>("mem:procedural");
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe("Full Procedure");
    expect(resolveStageModelMetadata).toHaveBeenCalledWith("procedural", provider, undefined);
    expect(resolveStageModelCallOptions).toHaveBeenCalledWith("procedural", undefined);
  });

  it("plans only the procedural backlog and waits without an empty contribution below threshold", async () => {
    for (let index = 0; index < 100; index += 1) {
      await kv.set(KV.memories, `historical-${index}`, {
        ...makePattern(index),
        id: `historical-${index}`,
      });
    }
    const listSpy = vi.spyOn(kv, "list");
    await enqueueConsolidationProceduralBacklog({
      kv: kv as never,
      memoryIds: ["historical-1"],
    });

    const waiting = await planConsolidationProceduralWindows({ kv: kv as never });
    expect(waiting).toMatchObject({
      success: true,
      windows: [],
      totalPatterns: 1,
      reason: "fewer than 2 unconsumed recurring patterns",
    });
    expect(listSpy.mock.calls.some(([scope]) => scope === KV.memories)).toBe(false);
    expect(await kv.list(KV.consolidationProceduralBacklog)).toHaveLength(1);
    expect(await kv.list(KV.extractionContributionRecords(
      "consolidation_procedural",
      CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
    ))).toEqual([]);

    await enqueueConsolidationProceduralBacklog({
      kv: kv as never,
      memoryIds: ["historical-2"],
    });
    const ready = await planConsolidationProceduralWindows({ kv: kv as never });
    expect(ready.windows).toHaveLength(1);
    expect(ready.windows[0]).toMatchObject({
      memoryIds: ["historical-1", "historical-2"],
      stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
      patternCount: 2,
    });
    expect(ready.windows[0].sourceVersionKeys).toHaveLength(2);
  });

  it("uses procedures only as history, commits new pattern contribution once, and isolates a later correction", async () => {
    const sourceMemories = [
      { ...makePattern(1), id: "incremental-pattern-1", project: "repo" },
      { ...makePattern(2), id: "incremental-pattern-2", project: "repo" },
    ];
    for (const memory of sourceMemories) await kv.set(KV.memories, memory.id, memory);
    await enqueueConsolidationProceduralBacklog({
      kv: kv as never,
      memoryIds: sourceMemories.map((memory) => memory.id),
    });
    await kv.set(KV.procedural, "existing-procedure", {
      id: "existing-procedure",
      name: "Existing Procedure",
      steps: ["Old step"],
      triggerCondition: "when old",
      frequency: 4,
      sourceSessionIds: [],
      strength: 0.6,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const [window] = (await planConsolidationProceduralWindows({
      kv: kv as never,
      project: "repo",
    })).windows;
    const identity = {
      runId: "incremental-procedural-run",
      unitId: window.windowId,
      inputHash: "8".repeat(64),
    };
    const receiptKey = await seedProceduralReceipt(kv, identity);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        '<procedures><procedure name="Existing Procedure" trigger="when new patterns recur"><step>Use new evidence</step></procedure></procedures>',
      ),
    };

    const response = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      project: window.project,
      memoryIds: window.memoryIds,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      recoveryIdentity: identity,
    });
    expect(response).toMatchObject({ success: true, status: "succeeded" });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(provider.summarize.mock.calls[0][1]).toContain("Existing procedures (context only)");
    expect(provider.summarize.mock.calls[0][1]).toContain("Existing Procedure");
    await completeProceduralReceipt(kv, receiptKey, response);
    const reconciled = await reconcileConsolidationProceduralContribution({
      kv: kv as never,
      identity: { ...identity, stage: "consolidation_procedural" },
      sourceVersionKeys: window.sourceVersionKeys,
      operationReceiptRef: {
        scope: KV.extractionOperationReceipt(receiptKey),
        key: receiptKey,
      },
    });
    expect(reconciled).toMatchObject({ success: true, status: "succeeded" });
    expect((await kv.get<ProceduralMemory>(KV.procedural, "existing-procedure"))?.frequency).toBe(5);
    expect(await kv.list(KV.consolidationProceduralBacklog)).toEqual([]);
    expect((await planConsolidationProceduralWindows({ kv: kv as never })).windows).toEqual([]);
    expect(provider.summarize).toHaveBeenCalledTimes(1);

    await kv.set(KV.memories, sourceMemories[0].id, {
      ...sourceMemories[0],
      content: "Corrected pattern content",
      updatedAt: "2026-08-02T00:02:00.000Z",
    });
    await enqueueConsolidationProceduralBacklog({
      kv: kv as never,
      memoryIds: [sourceMemories[0].id],
    });
    const corrected = await planConsolidationProceduralWindows({ kv: kv as never });
    expect(corrected.windows).toEqual([
      expect.objectContaining({
        memoryIds: [sourceMemories[0].id],
        isolateReason: "consolidation_procedural_source_correction_requires_migration",
      }),
    ]);
  });

  it("persists a strict procedural no-effect and never re-invokes the provider", async () => {
    const memories = [
      { ...makePattern(1), id: "empty-pattern-1" },
      { ...makePattern(2), id: "empty-pattern-2" },
    ];
    for (const memory of memories) await kv.set(KV.memories, memory.id, memory);
    await enqueueConsolidationProceduralBacklog({
      kv: kv as never,
      memoryIds: memories.map((memory) => memory.id),
    });
    const [window] = (await planConsolidationProceduralWindows({ kv: kv as never })).windows;
    const identity = {
      runId: "empty-procedural-run",
      unitId: window.windowId,
      inputHash: "9".repeat(64),
    };
    const receiptKey = await seedProceduralReceipt(kv, identity);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue("<procedures></procedures>"),
    };
    const response = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: window.memoryIds,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      recoveryIdentity: identity,
    });
    expect(response).toMatchObject({
      success: true,
      status: "skipped",
      proceduralMemoryIds: [],
      proceduralRecoveryEvidence: {
        kind: "no_effect",
        observation: "business_empty",
        reasonCode: "no_reusable_procedure",
      },
    });
    await completeProceduralReceipt(kv, receiptKey, response);
    expect(await reconcileConsolidationProceduralContribution({
      kv: kv as never,
      identity: { ...identity, stage: "consolidation_procedural" },
      sourceVersionKeys: window.sourceVersionKeys,
      operationReceiptRef: {
        scope: KV.extractionOperationReceipt(receiptKey),
        key: receiptKey,
      },
    })).toMatchObject({ success: true, status: "skipped" });
    const records = await kv.list<ContributionRecord>(KV.extractionContributionRecords(
      "consolidation_procedural",
      CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
    ));
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.state === "no_effect")).toBe(true);
    expect(records.every((record) => record.effectRefs?.length === 0)).toBe(true);
    expect(await kv.list(KV.procedural)).toEqual([]);
    expect((await planConsolidationProceduralWindows({ kv: kv as never })).windows).toEqual([]);
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("allows only one provider call for overlapping formal procedural claims", async () => {
    const memories = [
      { ...makePattern(1), id: "overlap-pattern-1" },
      { ...makePattern(2), id: "overlap-pattern-2" },
    ];
    for (const memory of memories) await kv.set(KV.memories, memory.id, memory);
    await enqueueConsolidationProceduralBacklog({
      kv: kv as never,
      memoryIds: memories.map((memory) => memory.id),
    });
    const [window] = (await planConsolidationProceduralWindows({ kv: kv as never })).windows;
    const firstIdentity = {
      runId: "overlap-procedural-run-a",
      unitId: window.windowId,
      inputHash: "a".repeat(64),
    };
    const secondIdentity = {
      runId: "overlap-procedural-run-b",
      unitId: window.windowId,
      inputHash: "b".repeat(64),
    };
    await seedProceduralReceipt(kv, firstIdentity);
    await seedProceduralReceipt(kv, secondIdentity);
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(async () => {
        await providerGate;
        return '<procedures><procedure name="Single owner" trigger="when recurring"><step>Apply once</step></procedure></procedures>';
      }),
    };
    const first = runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: window.memoryIds,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      recoveryIdentity: firstIdentity,
    });
    await vi.waitFor(() => expect(provider.summarize).toHaveBeenCalledTimes(1));
    const second = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: window.memoryIds,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      recoveryIdentity: secondIdentity,
    });
    expect(second).toMatchObject({
      success: false,
      failure: {
        cause: "consolidation_procedural_contribution_reconciliation_required",
      },
    });
    releaseProvider();
    expect(await first).toMatchObject({ success: true, status: "succeeded" });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("releases a malformed response claim and replaces a source that drifts before commit", async () => {
    const memories = [
      { ...makePattern(1), id: "drift-pattern-1" },
      { ...makePattern(2), id: "drift-pattern-2" },
    ];
    for (const memory of memories) await kv.set(KV.memories, memory.id, memory);
    await enqueueConsolidationProceduralBacklog({
      kv: kv as never,
      memoryIds: memories.map((memory) => memory.id),
    });
    const [window] = (await planConsolidationProceduralWindows({ kv: kv as never })).windows;
    const malformedIdentity = {
      runId: "malformed-procedural-run",
      unitId: window.windowId,
      inputHash: "c".repeat(64),
    };
    await seedProceduralReceipt(kv, malformedIdentity);
    const malformedProvider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue("<procedures><procedure"),
    };
    expect(await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: malformedProvider as never,
      memoryIds: window.memoryIds,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      recoveryIdentity: malformedIdentity,
    })).toMatchObject({
      success: false,
      failure: { class: "unit", cause: "consolidation_procedural_response_parse_failure" },
    });
    expect(await kv.list(KV.extractionContributionRecords(
      "consolidation_procedural",
      CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
    ))).toEqual([]);

    const driftIdentity = {
      runId: "drifted-procedural-run",
      unitId: window.windowId,
      inputHash: "d".repeat(64),
    };
    await seedProceduralReceipt(kv, driftIdentity);
    const driftProvider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(async () => {
        await kv.set(KV.memories, memories[0].id, {
          ...memories[0],
          content: "Changed while the provider was running",
          updatedAt: "2026-08-02T00:03:00.000Z",
        });
        return '<procedures><procedure name="Stale" trigger="when stale"><step>Do not commit</step></procedure></procedures>';
      }),
    };
    expect(await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: driftProvider as never,
      memoryIds: window.memoryIds,
      stageContractVersion: window.stageContractVersion,
      sourceVersionKeys: window.sourceVersionKeys,
      recoveryIdentity: driftIdentity,
    })).toMatchObject({
      success: false,
      failure: {
        class: "hard",
        cause: "consolidation_procedural_source_drifted_before_commit",
      },
    });
    expect(await kv.list(KV.procedural)).toEqual([]);
    expect(await kv.list(KV.audit)).toEqual([]);
    expect(await kv.list(KV.extractionContributionRecords(
      "consolidation_procedural",
      CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
    ))).toEqual([]);
    const replanned = await planConsolidationProceduralWindows({ kv: kv as never });
    expect(replanned.windows).toHaveLength(1);
    expect(replanned.windows[0].sourceVersionKeys[0]).toBe(
      buildConsolidationProceduralSourceVersion(
        (await kv.get<Memory>(KV.memories, memories[0].id))!,
      ).sourceVersionKey,
    );
  });

  it("recovers a frozen procedural commit without another model call or duplicate reinforcement", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="New Procedure" trigger="when new"><step>Record</step></procedure><procedure name="Existing Procedure" trigger="when existing"><step>Reinforce</step></procedure></procedures>`,
      ),
    };
    await kv.set(KV.memories, "mem_recovery_1", { ...makePattern(1), id: "mem_recovery_1" });
    await kv.set(KV.memories, "mem_recovery_2", { ...makePattern(2), id: "mem_recovery_2" });
    await kv.set(KV.procedural, "proc_existing", {
      id: "proc_existing",
      name: "Existing Procedure",
      steps: ["Old step"],
      triggerCondition: "when existing",
      frequency: 4,
      sourceSessionIds: [],
      strength: 0.6,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const recoveryIdentity = {
      runId: "run-procedural-recovery",
      unitId: "cpw-recovery-1",
      inputHash: "a".repeat(64),
    };
    const receiptKey = buildExtractionOperationKey({
      ...recoveryIdentity,
      stage: "consolidation_procedural",
    });
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...recoveryIdentity,
      stage: "consolidation_procedural",
      key: receiptKey,
      version: 1,
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    let interruptAfterReinforcement = true;
    const interruptingKv = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        const stored = await kv.set(scope, key, data);
        if (interruptAfterReinforcement && scope === KV.procedural && key === "proc_existing") {
          interruptAfterReinforcement = false;
          throw new Error("interrupted after durable procedural mutation");
        }
        return stored;
      },
    };

    const interrupted = await runConsolidationProceduralWindow({
      kv: interruptingKv as never,
      provider: provider as never,
      memoryIds: ["mem_recovery_1", "mem_recovery_2"],
      recoveryIdentity,
    });
    expect(interrupted.success).toBe(false);
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    await kv.delete(KV.memories, "mem_recovery_2");

    const resumed = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: ["mem_recovery_1", "mem_recovery_2"],
      recoveryIdentity,
    });
    expect(resumed).toMatchObject({
      success: true,
      usedFallback: true,
      newProcedures: 1,
      patternsAnalyzed: 2,
      inputHash: recoveryIdentity.inputHash,
      proceduralRecoveryEvidence: expect.objectContaining({
        schema: "consolidation-procedural-commit/v1",
        receiptKey,
        identity: recoveryIdentity,
      }),
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    const procedures = await kv.list<ProceduralMemory>(KV.procedural);
    expect(procedures).toHaveLength(2);
    expect(procedures.find((procedure) => procedure.id === "proc_existing")?.frequency).toBe(5);
    const audits = await kv.list<AuditEntry>(KV.audit);
    expect(audits).toEqual([
      expect.objectContaining({
        id: resumed.auditId,
        timestamp: "2026-01-01T00:00:00.000Z",
        operation: "consolidate",
        functionId: "mem::consolidate-procedural-window",
        targetIds: resumed.proceduralMemoryIds,
      }),
    ]);
    await kv.set(KV.audit, audits[0].id, {
      ...audits[0],
      details: { ...audits[0].details, patternsAnalyzed: 999 },
    });
    await expect(runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: ["mem_recovery_1", "mem_recovery_2"],
      recoveryIdentity,
    })).resolves.toMatchObject({
      success: false,
      error: "consolidation_procedural_audit_conflict",
      failure: {
        class: "hard",
        cause: "consolidation_procedural_audit_conflict",
      },
    });
    await kv.delete(KV.audit, audits[0].id);
    await expect(runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: ["mem_recovery_1", "mem_recovery_2"],
      recoveryIdentity,
    })).resolves.toMatchObject({
      success: false,
      error: "consolidation_procedural_committed_audit_missing",
      failure: {
        class: "hard",
        cause: "consolidation_procedural_committed_audit_missing",
      },
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("serializes different procedural recoveries that share one baseline", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Shared Procedure" trigger="when shared"><step>Reinforce</step></procedure></procedures>`,
      ),
    };
    await kv.set(KV.memories, "mem_concurrent_1", {
      ...makePattern(1),
      id: "mem_concurrent_1",
    });
    await kv.set(KV.memories, "mem_concurrent_2", {
      ...makePattern(2),
      id: "mem_concurrent_2",
    });
    await kv.set(KV.procedural, "proc_concurrent", {
      id: "proc_concurrent",
      name: "Shared Procedure",
      steps: ["Original"],
      triggerCondition: "when shared",
      frequency: 4,
      sourceSessionIds: [],
      strength: 0.6,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const identities = [
      {
        runId: "run-procedural-concurrent-a",
        unitId: "cpw-concurrent-a",
        inputHash: "a".repeat(64),
      },
      {
        runId: "run-procedural-concurrent-b",
        unitId: "cpw-concurrent-b",
        inputHash: "b".repeat(64),
      },
    ];
    for (const identity of identities) {
      const key = buildExtractionOperationKey({
        ...identity,
        stage: "consolidation_procedural",
      });
      await kv.set(KV.extractionOperationReceipt(key), key, {
        ...identity,
        stage: "consolidation_procedural",
        key,
        version: 1,
        status: "running",
        startedAt: "2026-07-30T00:00:00.000Z",
      });
      let loseStagedResponse = true;
      const stagingKv = {
        ...kv,
        set: async <T>(scope: string, receiptKey: string, data: T): Promise<T> => {
          const stored = await kv.set(scope, receiptKey, data);
          const recovery = (
            data as { proceduralRecovery?: { phase?: string } }
          ).proceduralRecovery;
          if (loseStagedResponse && recovery?.phase === "staged") {
            loseStagedResponse = false;
            throw new Error("staged response lost");
          }
          return stored;
        },
      };
      const staged = await runConsolidationProceduralWindow({
        kv: stagingKv as never,
        provider: provider as never,
        memoryIds: ["mem_concurrent_1", "mem_concurrent_2"],
        recoveryIdentity: identity,
      });
      expect(staged).toMatchObject({ success: false, error: "staged response lost" });
    }

    const snapshotKv = {
      ...kv,
      get: async <T>(scope: string, key: string): Promise<T | null> => {
        const value = await kv.get<T>(scope, key);
        return value === null ? null : structuredClone(value);
      },
    };
    const results = await Promise.all(identities.map((recoveryIdentity) =>
      runConsolidationProceduralWindow({
        kv: snapshotKv as never,
        provider: provider as never,
        memoryIds: ["mem_concurrent_1", "mem_concurrent_2"],
        recoveryIdentity,
      })));

    expect(results.filter((result) => result.success === true)).toHaveLength(1);
    expect(results.filter(
      (result) => result.error === "consolidation_procedural_source_mutation_conflict",
    )).toHaveLength(1);
    const finalProcedure = await kv.get<ProceduralMemory & {
      sourceMutationWatermarks?: Record<string, string>;
    }>(KV.procedural, "proc_concurrent");
    expect(finalProcedure?.frequency).toBe(5);
    expect(finalProcedure?.strength).toBeCloseTo(0.7);
    expect(Object.keys(finalProcedure?.sourceMutationWatermarks ?? {})).toHaveLength(1);
    const audits = (await kv.list<AuditEntry>(KV.audit))
      .filter((audit) => audit.operation === "consolidate");
    expect(audits).toHaveLength(1);
    const receipts = await Promise.all(identities.map((identity) => {
      const key = buildExtractionOperationKey({
        ...identity,
        stage: "consolidation_procedural",
      });
      return kv.get<{ proceduralRecovery?: { phase?: string } }>(
        KV.extractionOperationReceipt(key),
        key,
      );
    }));
    expect(receipts.filter(
      (receipt) => receipt?.proceduralRecovery?.phase === "committed",
    )).toHaveLength(1);
    expect(provider.summarize).toHaveBeenCalledTimes(2);
  });

  it("rejects a committed procedural receipt when a formal effect is missing", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Durable Procedure" trigger="when recurring"><step>Record</step></procedure></procedures>`,
      ),
    };
    await kv.set(KV.memories, "mem_committed_1", { ...makePattern(1), id: "mem_committed_1" });
    await kv.set(KV.memories, "mem_committed_2", { ...makePattern(2), id: "mem_committed_2" });
    const recoveryIdentity = {
      runId: "run-procedural-committed-verification",
      unitId: "cpw-committed-verification",
      inputHash: "e".repeat(64),
    };
    const receiptKey = buildExtractionOperationKey({
      ...recoveryIdentity,
      stage: "consolidation_procedural",
    });
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...recoveryIdentity,
      stage: "consolidation_procedural",
      key: receiptKey,
      version: 1,
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    const first = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: ["mem_committed_1", "mem_committed_2"],
      recoveryIdentity,
    });
    expect(first.success).toBe(true);
    const committedReceipt = await kv.get<Record<string, unknown>>(
      KV.extractionOperationReceipt(receiptKey),
      receiptKey,
    );
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...committedReceipt,
      status: "succeeded",
      completedAt: "2026-01-01T00:01:00.000Z",
      response: { success: true, proceduralMemoryIds: first.proceduralMemoryIds },
    });
    await kv.delete(KV.procedural, first.proceduralMemoryIds![0]);

    const verified = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: ["mem_committed_1", "mem_committed_2"],
      recoveryIdentity,
    });
    expect(verified).toMatchObject({
      success: false,
      error: "consolidation_procedural_source_mutation_conflict",
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("rejects a procedural recovery identity that is not bound to its receipt", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    await kv.set(KV.memories, "mem_identity_1", { ...makePattern(1), id: "mem_identity_1" });
    await kv.set(KV.memories, "mem_identity_2", { ...makePattern(2), id: "mem_identity_2" });
    const identity = {
      runId: "run-procedural-identity",
      unitId: "cpw-identity-1",
      inputHash: "b".repeat(64),
    };
    const receiptKey = buildExtractionOperationKey({ ...identity, stage: "consolidation_procedural" });
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...identity,
      inputHash: "c".repeat(64),
      stage: "consolidation_procedural",
      key: receiptKey,
      version: 1,
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: ["mem_identity_1", "mem_identity_2"],
      recoveryIdentity: identity,
    });
    expect(result).toMatchObject({
      success: false,
      error: "consolidation_procedural_recovery_receipt_unavailable",
    });
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("records receipt-bound business-empty evidence for a procedural recovery skip", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    await kv.set(KV.memories, "mem_skip_only", { ...makePattern(1), id: "mem_skip_only" });
    const recoveryIdentity = {
      runId: "run-procedural-skip",
      unitId: "cpw-skip-1",
      inputHash: "d".repeat(64),
    };
    const receiptKey = buildExtractionOperationKey({ ...recoveryIdentity, stage: "consolidation_procedural" });
    await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, {
      ...recoveryIdentity,
      stage: "consolidation_procedural",
      key: receiptKey,
      version: 1,
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await runConsolidationProceduralWindow({
      kv: kv as never,
      provider: provider as never,
      memoryIds: ["mem_skip_only"],
      recoveryIdentity,
    });
    expect(result).toMatchObject({
      success: true,
      status: "skipped",
      skipped: true,
      inputHash: recoveryIdentity.inputHash,
      proceduralRecoveryEvidence: {
        kind: "no_effect",
        observation: "business_empty",
        reasonCode: "fewer_than_2_recurring_patterns",
        identity: recoveryIdentity,
        proof: {
          kind: "receipt_before_formal_effect",
          receiptKey,
          receiptVersion: 1,
          phase: "candidate_staging",
          commitPlanAbsent: true,
        },
      },
    });
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("consolidation records an audit entry", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });

    const audits = await kv.list("mem:audit");
    expect(audits.length).toBe(1);
  });

  it("pipeline returns early when consolidation is disabled", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {})) as {
      success: boolean;
      skipped?: boolean;
      reason?: string;
    };

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("CONSOLIDATION_ENABLED");
    expect(provider.summarize).not.toHaveBeenCalled();
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  it("pipeline proceeds with force=true even when consolidation is disabled", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      force: true,
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    expect(result.results).toBeDefined();
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });
});

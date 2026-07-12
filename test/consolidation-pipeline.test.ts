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
  registerConsolidationPipelineFunction,
  runConsolidationProceduralWindow,
} from "../src/functions/consolidation-pipeline.js";
import { isConsolidationEnabled, resolveStageModelCallOptions, resolveStageModelMetadata } from "../src/config.js";
import type { SessionSummary, Memory, SemanticMemory, ProceduralMemory } from "../src/types.js";
import { ProviderCallError } from "../src/providers/provider-call-result.js";
import { logger } from "../src/logger.js";

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

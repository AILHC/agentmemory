import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
  enqueueReflectInsightBacklog,
  planReflectInsightWindows,
  reconcileReflectInsightContribution,
  registerReflectFunctions,
  runReflectInsightWindow,
} from "../src/functions/reflect.js";
import { buildExtractionOperationKey } from "../src/functions/extraction-operation-receipts.js";
import { fingerprintId, KV } from "../src/state/schema.js";
import type {
  AuditEntry,
  Insight,
  GraphNode,
  GraphEdge,
  SemanticMemory,
  Lesson,
  Crystal,
} from "../src/types.js";
import { ProviderCallError } from "../src/providers/provider-call-result.js";

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

function makeConceptNode(name: string): GraphNode {
  return {
    id: `node_${name}`,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

function makeEdge(src: string, tgt: string): GraphEdge {
  return {
    id: `edge_${src}_${tgt}`,
    type: "related_to",
    sourceNodeId: `node_${src}`,
    targetNodeId: `node_${tgt}`,
    weight: 1,
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

function makeSemantic(fact: string, id?: string): SemanticMemory {
  return {
    id: id || `sem_${fact.slice(0, 8)}`,
    fact,
    confidence: 0.8,
    sourceSessionIds: [],
    sourceMemoryIds: [],
    accessCount: 1,
    lastAccessedAt: "2026-04-01T00:00:00Z",
    strength: 0.8,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
  };
}

function makeLesson(content: string, tags: string[]): Lesson {
  return {
    id: `lsn_${content.slice(0, 8)}`,
    content,
    context: "",
    confidence: 0.7,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    tags,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    decayRate: 0.05,
  };
}

function makeCrystal(narrative: string, lessons: string[]): Crystal {
  return {
    id: `crys_${narrative.slice(0, 8)}`,
    narrative,
    keyOutcomes: [],
    filesAffected: [],
    lessons,
    sourceActionIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

const XML_RESPONSE = `<insights>
<insight confidence="0.85" title="Defense in Depth">
Security requires layered protection: input validation, safe APIs, and deny-lists together.
</insight>
<insight confidence="0.7" title="Testing at Boundaries">
Focus test effort on system boundaries where trust transitions occur.
</insight>
</insights>`;

type PlannedReflectWindow = {
  windowId: string;
  semanticMemoryIds: string[];
  lessonIds: string[];
  crystalIds: string[];
  stageContractVersion: string;
  sourceVersionKeys: string[];
};

async function seedIncrementalReflectSources(
  kv: ReturnType<typeof mockKV>,
  suffix: string,
  count = 3,
): Promise<{
  semanticMemoryId: string;
  lessonId: string;
  crystalId: string;
  window?: PlannedReflectWindow;
}> {
  const semanticMemoryId = `sem_incremental_${suffix}`;
  const lessonId = `lsn_incremental_${suffix}`;
  const crystalId = `crys_incremental_${suffix}`;
  await kv.set(KV.semantic, semanticMemoryId, makeSemantic(
    `Security boundary evidence ${suffix}`,
    semanticMemoryId,
  ));
  await kv.set(KV.lessons, lessonId, {
    ...makeLesson(`Validate security boundaries ${suffix}`, ["security", "boundaries"]),
    id: lessonId,
  });
  await kv.set(KV.crystals, crystalId, {
    ...makeCrystal(`Completed boundary validation ${suffix}`, ["security"]),
    id: crystalId,
  });
  await enqueueReflectInsightBacklog({
    kv: kv as never,
    semanticMemoryIds: count >= 1 ? [semanticMemoryId] : [],
    lessonIds: count >= 2 ? [lessonId] : [],
    crystalIds: count >= 3 ? [crystalId] : [],
  });
  const plan = await planReflectInsightWindows({ kv: kv as never, useGraph: false }) as {
    windows: PlannedReflectWindow[];
  };
  return { semanticMemoryId, lessonId, crystalId, window: plan.windows[0] };
}

async function createReflectOperationReceipt(
  kv: ReturnType<typeof mockKV>,
  identity: { runId: string; unitId: string; inputHash: string },
): Promise<string> {
  const key = buildExtractionOperationKey({ ...identity, stage: "reflect_insight" });
  await kv.set(KV.extractionOperationReceipt(key), key, {
    ...identity,
    stage: "reflect_insight",
    key,
    version: 1,
    status: "running",
    startedAt: "2026-08-02T00:00:00.000Z",
  });
  return key;
}

async function finalizeReflectContribution(options: {
  kv: ReturnType<typeof mockKV>;
  identity: { runId: string; unitId: string; inputHash: string };
  sourceVersionKeys: string[];
  response: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const key = buildExtractionOperationKey({ ...options.identity, stage: "reflect_insight" });
  const scope = KV.extractionOperationReceipt(key);
  const receipt = await options.kv.get<Record<string, unknown>>(scope, key);
  await options.kv.set(scope, key, {
    ...receipt,
    status: "succeeded",
    completedAt: "2026-08-02T00:01:00.000Z",
    response: options.response,
  });
  return reconcileReflectInsightContribution({
    kv: options.kv as never,
    identity: { ...options.identity, stage: "reflect_insight" },
    sourceVersionKeys: options.sourceVersionKeys,
    operationReceiptRef: { scope, key },
  });
}

describe("Reflect", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let provider: { name: string; compress: ReturnType<typeof vi.fn>; summarize: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
    provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(XML_RESPONSE),
    };
    registerReflectFunctions(sdk as never, kv as never, provider as never);
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
    delete process.env.AGENTMEMORY_EVALUATION_MODE;
    delete process.env.AGENTMEMORY_CONTEXT_PREFLIGHT_POLICY;
  });

  describe("mem::reflect", () => {
    it("returns empty when no graph nodes or memories exist", async () => {
      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
        clustersProcessed: number;
      };

      expect(result.success).toBe(true);
      expect(result.newInsights).toBe(0);
      expect(result.clustersProcessed).toBe(0);
    });

    it("synthesizes insights from graph concept clusters", async () => {
      process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:nodes", "node_testing", makeConceptNode("testing"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:graph:edges", "edge_2", makeEdge("security", "testing"));

      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection attacks"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use execFile for security", ["security"]));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
      };

      expect(result.success).toBe(true);
      expect(result.newInsights).toBe(2);
      expect(provider.summarize).toHaveBeenCalled();
      expect(provider.summarize).toHaveBeenCalledWith(
        expect.stringContaining("AgentMemory Output Language Policy"),
        expect.any(String),
      );

      const insights = await kv.list<Insight>("mem:insights");
      expect(insights.length).toBe(2);
      expect(insights[0].title).toBeTruthy();
      expect(insights[0].sourceConceptCluster.length).toBeGreaterThan(0);
    });

    it("skips clusters with fewer than 3 supporting items", async () => {
      await kv.set("mem:graph:nodes", "node_sparse", makeConceptNode("sparse"));
      await kv.set("mem:graph:nodes", "node_topic", makeConceptNode("topic"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("sparse", "topic"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("One sparse fact"));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        clustersSkipped: number;
        newInsights: number;
      };

      expect(result.clustersSkipped).toBe(1);
      expect(result.newInsights).toBe(0);
      expect(provider.summarize).not.toHaveBeenCalled();
    });

    it("deduplicates insights by fingerprint", async () => {
      await kv.set("mem:graph:nodes", "node_security", makeConceptNode("security"));
      await kv.set("mem:graph:nodes", "node_validation", makeConceptNode("validation"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));

      await sdk.trigger("mem::reflect", {});
      const first = await kv.list<Insight>("mem:insights");
      expect(first.length).toBe(2);

      const result = (await sdk.trigger("mem::reflect", {})) as {
        reinforced: number;
        newInsights: number;
      };

      expect(result.reinforced).toBe(2);
      expect(result.newInsights).toBe(0);

      const after = await kv.list<Insight>("mem:insights");
      expect(after.length).toBe(2);
      expect(after[0].reinforcements).toBe(1);
    });

    it("falls back to Jaccard grouping when graph is empty", async () => {
      await kv.set("mem:semantic", "sem_1", makeSemantic("security validation is important"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("security testing prevents bugs"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("validation testing framework"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use security headers", ["security", "validation"]));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        usedFallback: boolean;
      };

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });

    it("handles LLM failure gracefully", async () => {
      provider.summarize.mockRejectedValue(new Error("LLM timeout"));

      await kv.set("mem:graph:nodes", "node_a", makeConceptNode("concept_a"));
      await kv.set("mem:graph:nodes", "node_b", makeConceptNode("concept_b"));
      await kv.set("mem:graph:edges", "edge_1", makeEdge("concept_a", "concept_b"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("fact about concept_a"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("fact about concept_b"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("concept_a and concept_b together"));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
      };

      expect(result.success).toBe(true);
      expect(result.newInsights).toBe(0);
    });

    it("full insight window rejects useGraph true", async () => {
      const result = await runReflectInsightWindow({
        kv: kv as never,
        provider: provider as never,
        useGraph: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("useGraph:true");
      expect(provider.summarize).not.toHaveBeenCalled();
    });

    it("full insight window builds prompts from semantic, lesson, and crystal ids without graph reads", async () => {
      provider.name = "pi-agent-sdk";
      await kv.set("mem:semantic", "sem_1", makeSemantic("security validation is important", "sem_1"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use security headers", ["security"]));
      await kv.set("mem:crystals", "crys_1", makeCrystal("Completed security validation cleanup", ["security"]));
      const originalList = kv.list;
      const listSpy = vi.fn(originalList);
      kv.list = listSpy as typeof kv.list;

      const result = await runReflectInsightWindow({
        kv: kv as never,
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: ["sem_1"],
        lessonIds: ["lsn_1"],
        crystalIds: ["crys_1"],
        charBudget: 12000,
        model: "reflect-model",
      });

      expect(result.success).toBe(true);
      expect(result.insightIds).toHaveLength(2);
      expect(result).toMatchObject({
        stage: "reflect_insight",
        model: "reflect-model",
        modelSource: "explicitModel",
        provider: "pi-agent-sdk",
        modelApplied: true,
        charBudget: 12000,
        parseFailures: 0,
      });
      expect(result.promptChars).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(provider.summarize).toHaveBeenCalled();
      expect(listSpy).not.toHaveBeenCalledWith("mem:graph:nodes");
      expect(listSpy).not.toHaveBeenCalledWith("mem:graph:edges");
    });

    it("returns reflect summarize telemetry without exposing insight text", async () => {
      provider.name = "pi-agent-sdk";
      provider.summarize = vi.fn(() => {
        throw new Error("legacy summarize path should not be used");
      });
      (provider as any).summarizeWithMetadata = vi.fn(async () => ({
        text: XML_RESPONSE,
        metadata: {
          inputTokens: 18,
          outputTokens: 12,
          totalTokens: 30,
          maxOutputTokens: 4096,
          stopReason: "stop" as const,
          responseModel: "reflect-model",
        },
      }));
      await kv.set("mem:semantic", "sem_1", makeSemantic("security validation is important", "sem_1"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use security headers", ["security"]));
      await kv.set("mem:crystals", "crys_1", makeCrystal("Completed security validation cleanup", ["security"]));

      const result = await runReflectInsightWindow({
        kv: kv as never,
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: ["sem_1"],
        lessonIds: ["lsn_1"],
        crystalIds: ["crys_1"],
      });

      expect(result.success).toBe(true);
      expect(result.telemetry).toEqual([
        expect.objectContaining({
          operation: "summarize",
          callRole: "window",
          callIndex: 0,
          metadataStatus: "supported",
          metadata: expect.objectContaining({
            inputTokens: 18,
            totalTokens: 30,
            maxOutputTokens: 4096,
          }),
        }),
      ]);
      expect(JSON.stringify(result.telemetry)).not.toContain("Defense in Depth");
    });

    it("blocks reflect extraction before the provider", async () => {
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
        calibrationHash: `sha256:${"e".repeat(64)}`,
      });
      provider.name = "pi-agent-sdk";
      (provider as any).model = "gpt-5.4";
      (provider as any).summarizeWithMetadata = vi.fn(async () => ({ text: "unexpected" }));
      await kv.set("mem:semantic", "sem_preflight", makeSemantic("security validation is important", "sem_preflight"));
      await kv.set("mem:lessons", "lsn_preflight", makeLesson("Use security headers", ["security"]));
      await kv.set("mem:crystals", "crys_preflight", makeCrystal("Completed security cleanup", ["security"]));

      const result: any = await runReflectInsightWindow({
        kv: kv as never,
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: ["sem_preflight"],
        lessonIds: ["lsn_preflight"],
        crystalIds: ["crys_preflight"],
      });

      expect(result).toMatchObject({ success: false, status: "infeasible", error: "infeasible" });
      expect((provider as any).summarizeWithMetadata).not.toHaveBeenCalled();
      expect(result.telemetry).toEqual([
        expect.objectContaining({ providerInvoked: false, preflightBlocked: true }),
      ]);
    });

    it("keeps ProviderCallError metadata on a reflect failure response", async () => {
      const metadata = {
        inputTokens: 2,
        outputTokens: 0,
        totalTokens: 2,
        maxOutputTokens: 4096,
        stopReason: "error" as const,
        responseModel: "reflect-error-model",
      };
      (provider as any).summarizeWithMetadata = vi.fn(async () => {
        throw new ProviderCallError("pi_stream_failed", metadata);
      });
      await kv.set("mem:semantic", "sem_1", makeSemantic("fact about concept_a"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("lesson about concept_a", ["concept_a"]));
      await kv.set("mem:crystals", "crys_1", makeCrystal("crystal about concept_a", ["concept_a"]));

      const result = await runReflectInsightWindow({
        kv: kv as never,
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: ["sem_1"],
        lessonIds: ["lsn_1"],
        crystalIds: ["crys_1"],
      });

      expect(result.success).toBe(false);
      expect(result.telemetry).toEqual([
        expect.objectContaining({ metadataStatus: "supported", metadata }),
      ]);
    });

    it("leaves a provider-failed reflect receipt running without insight effects", async () => {
      (provider as any).summarizeWithMetadata = vi.fn(async () => {
        throw new ProviderCallError("pi_stream_failed");
      });
      await kv.set(KV.semantic, "sem_provider_failure", makeSemantic(
        "security validation is important",
        "sem_provider_failure",
      ));
      await kv.set(KV.lessons, "lsn_provider_failure", makeLesson(
        "Use security headers",
        ["security"],
      ));
      await kv.set(KV.crystals, "crys_provider_failure", makeCrystal(
        "Completed security validation cleanup",
        ["security"],
      ));
      const recoveryIdentity = {
        runId: "reflect-provider-failure",
        unitId: "reflect-provider-failure-window",
        inputHash: "a".repeat(64),
      };
      const receiptKey = buildExtractionOperationKey({
        ...recoveryIdentity,
        stage: "reflect_insight",
      });
      const runningReceipt = {
        ...recoveryIdentity,
        stage: "reflect_insight",
        key: receiptKey,
        version: 1,
        status: "running",
        startedAt: "2026-07-30T00:00:00.000Z",
      };
      await kv.set(KV.extractionOperationReceipt(receiptKey), receiptKey, runningReceipt);

      const result = await runReflectInsightWindow({
        kv: kv as never,
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: ["sem_provider_failure"],
        lessonIds: ["lsn_provider_failure"],
        crystalIds: ["crys_provider_failure"],
        recoveryIdentity,
      });

      expect(result).toMatchObject({
        success: false,
        status: "failed",
        error: "pi_stream_failed",
      });
      expect((provider as any).summarizeWithMetadata).toHaveBeenCalledTimes(1);
      expect(await kv.get(KV.extractionOperationReceipt(receiptKey), receiptKey))
        .toEqual(runningReceipt);
      expect(await kv.list(KV.insights)).toEqual([]);
      expect(await kv.list(KV.audit)).toEqual([]);
    });
  });

  describe("mem::insight-list", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      await kv.set("mem:insights", "ins_1", {
        id: "ins_1", title: "Insight A", content: "Content A", confidence: 0.9,
        reinforcements: 2, sourceConceptCluster: ["security"], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], project: "/app",
        tags: ["security"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
      await kv.set("mem:insights", "ins_2", {
        id: "ins_2", title: "Insight B", content: "Content B", confidence: 0.4,
        reinforcements: 0, sourceConceptCluster: ["testing"], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], project: "/other",
        tags: ["testing"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
    });

    it("lists all non-deleted insights sorted by confidence", async () => {
      const result = (await sdk.trigger("mem::insight-list", {})) as { insights: Insight[] };
      expect(result.insights.length).toBe(2);
      expect(result.insights[0].confidence).toBe(0.9);
    });

    it("filters by project", async () => {
      const result = (await sdk.trigger("mem::insight-list", { project: "/app" })) as { insights: Insight[] };
      expect(result.insights.length).toBe(1);
    });

    it("filters by minConfidence", async () => {
      const result = (await sdk.trigger("mem::insight-list", { minConfidence: 0.5 })) as { insights: Insight[] };
      expect(result.insights.length).toBe(1);
    });
  });

  describe("mem::insight-search", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      await kv.set("mem:insights", "ins_1", {
        id: "ins_1", title: "Defense in Depth", content: "Security requires layered protection",
        confidence: 0.85, reinforcements: 1, sourceConceptCluster: ["security"],
        sourceMemoryIds: [], sourceLessonIds: [], sourceCrystalIds: [],
        tags: ["security"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
    });

    it("finds insights matching query", async () => {
      const result = (await sdk.trigger("mem::insight-search", {
        query: "security layered protection",
      })) as { insights: Array<Insight & { score: number }> };

      expect(result.insights.length).toBe(1);
      expect(result.insights[0].title).toBe("Defense in Depth");
    });

    it("rejects empty query", async () => {
      const result = (await sdk.trigger("mem::insight-search", { query: "" })) as { success: boolean };
      expect(result.success).toBe(false);
    });
  });

  describe("mem::insight-decay-sweep", () => {
    it("decays old insights incrementally", async () => {
      await kv.set("mem:insights", "ins_old", {
        id: "ins_old", title: "Old", content: "Old insight", confidence: 0.8,
        reinforcements: 1, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        decayRate: 0.05,
      });

      const result = (await sdk.trigger("mem::insight-decay-sweep", {})) as { decayed: number };
      expect(result.decayed).toBe(1);

      const after = await kv.get<Insight>("mem:insights", "ins_old");
      expect(after!.confidence).toBeLessThan(0.8);
      expect(after!.lastDecayedAt).toBeDefined();
    });

    it("soft-deletes low-confidence unreinforced insights", async () => {
      await kv.set("mem:insights", "ins_weak", {
        id: "ins_weak", title: "Weak", content: "Weak insight", confidence: 0.12,
        reinforcements: 0, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        decayRate: 0.05,
      });

      const result = (await sdk.trigger("mem::insight-decay-sweep", {})) as { softDeleted: number };
      expect(result.softDeleted).toBe(1);

      const after = await kv.get<Insight>("mem:insights", "ins_weak");
      expect(after!.deleted).toBe(true);
    });
  });

  it("recovers a full insight commit without re-calling the model or double-reinforcing", async () => {
    const identity = {
      runId: "reflect-recovery-run",
      unitId: "reflect-recovery-unit",
      inputHash: "reflect-recovery-input",
    };
    const key = buildExtractionOperationKey({ ...identity, stage: "reflect_insight" });
    await kv.set("mem:extraction-operation-receipt:" + key, key, {
      ...identity,
      stage: "reflect_insight",
      key,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:00:00.000Z",
    });
    await kv.set("mem:semantic", "sem_recovery", makeSemantic("security validation is important", "sem_recovery"));
    await kv.set("mem:lessons", "lsn_Use sec", makeLesson("Use security headers", ["security"]));
    await kv.set("mem:crystals", "crys_Complete", makeCrystal("Completed security validation cleanup", ["security"]));
    const reinforcedContent = "Security requires layered protection: input validation, safe APIs, and deny-lists together.";
    const reinforcedId = fingerprintId("ins", reinforcedContent.toLowerCase());
    await kv.set("mem:insights", reinforcedId, {
      id: reinforcedId,
      title: "Defense in Depth",
      content: reinforcedContent,
      confidence: 0.85,
      reinforcements: 0,
      sourceConceptCluster: [],
      sourceMemoryIds: [],
      sourceLessonIds: [],
      sourceCrystalIds: [],
      tags: [],
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
      decayRate: 0.05,
    });

    const input = {
      kv: kv as never,
      provider: provider as never,
      useGraph: false,
      semanticMemoryIds: ["sem_recovery"],
      lessonIds: ["lsn_Use sec"],
      crystalIds: ["crys_Complete"],
      recoveryIdentity: identity,
    };
    const first = await runReflectInsightWindow(input);
    const second = await runReflectInsightWindow(input);

    expect(first.success).toBe(true);
    expect(second).toMatchObject({
      success: true,
      insightIds: first.insightIds,
      newInsights: first.newInsights,
      reinforced: first.reinforced,
    });
    expect(first).toMatchObject({ newInsights: 1, reinforced: 1 });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    const insights = await kv.list<Insight>("mem:insights");
    expect(insights).toHaveLength(2);
    expect((await kv.get<Insight>("mem:insights", reinforcedId))!.reinforcements).toBe(1);
    expect((first as any).reflectRecoveryEvidence).toMatchObject({
      kind: "committed",
      receiptKey: key,
    });
    const audits = await kv.list<AuditEntry>(KV.audit);
    expect(audits).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^aud_/),
        timestamp: "2026-07-30T00:00:00.000Z",
        operation: "reflect",
        targetIds: first.insightIds,
      }),
    ]);
    await kv.set(KV.audit, audits[0].id, {
      ...audits[0],
      details: { ...audits[0].details, newInsights: 999 },
    });
    await expect(runReflectInsightWindow(input)).resolves.toMatchObject({
      success: false,
      error: "reflect_insight_audit_conflict",
      failure: {
        class: "hard",
        cause: "reflect_insight_audit_conflict",
      },
    });
    await kv.delete(KV.audit, audits[0].id);
    await expect(runReflectInsightWindow(input)).resolves.toMatchObject({
      success: false,
      error: "reflect_insight_committed_audit_missing",
      failure: {
        class: "hard",
        cause: "reflect_insight_committed_audit_missing",
      },
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("serializes different recovery identities that share an insight baseline", async () => {
    const identities = [
      {
        runId: "reflect-concurrent-run-a",
        unitId: "reflect-concurrent-unit-a",
        inputHash: "a".repeat(64),
      },
      {
        runId: "reflect-concurrent-run-b",
        unitId: "reflect-concurrent-unit-b",
        inputHash: "b".repeat(64),
      },
    ];
    for (const identity of identities) {
      const key = buildExtractionOperationKey({ ...identity, stage: "reflect_insight" });
      await kv.set(KV.extractionOperationReceipt(key), key, {
        ...identity,
        stage: "reflect_insight",
        key,
        version: 1,
        status: "running",
        startedAt: "2026-07-30T00:00:00.000Z",
      });
    }
    await kv.set(KV.semantic, "sem_concurrent", makeSemantic(
      "security validation is important",
      "sem_concurrent",
    ));
    await kv.set(KV.lessons, "lsn_concurrent", makeLesson(
      "Use security headers",
      ["security"],
    ));
    await kv.set(KV.crystals, "crys_concurrent", makeCrystal(
      "Completed security validation cleanup",
      ["security"],
    ));
    const sharedContent =
      "Security requires layered protection: input validation, safe APIs, and deny-lists together.";
    const sharedInsightId = fingerprintId("ins", sharedContent.toLowerCase());
    await kv.set(KV.insights, sharedInsightId, {
      id: sharedInsightId,
      title: "Defense in Depth",
      content: sharedContent,
      confidence: 0.85,
      reinforcements: 0,
      sourceConceptCluster: [],
      sourceMemoryIds: [],
      sourceLessonIds: [],
      sourceCrystalIds: [],
      tags: [],
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
      decayRate: 0.05,
    });

    for (const identity of identities) {
      let loseStagedResponse = true;
      const stagingKv = {
        ...kv,
        set: async <T>(scope: string, key: string, data: T): Promise<T> => {
          const stored = await kv.set(scope, key, data);
          const recovery = (data as { reflectRecovery?: { phase?: string } }).reflectRecovery;
          if (loseStagedResponse && recovery?.phase === "staged") {
            loseStagedResponse = false;
            throw new Error("staged response lost");
          }
          return stored;
        },
      };
      const staged = await runReflectInsightWindow({
        kv: stagingKv as never,
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: ["sem_concurrent"],
        lessonIds: ["lsn_concurrent"],
        crystalIds: ["crys_concurrent"],
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
      runReflectInsightWindow({
        kv: snapshotKv as never,
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: ["sem_concurrent"],
        lessonIds: ["lsn_concurrent"],
        crystalIds: ["crys_concurrent"],
        recoveryIdentity,
      })));

    expect(results.filter((result) => result.success === true)).toHaveLength(1);
    expect(results.filter(
      (result) => result.error === "reflect_insight_source_mutation_conflict",
    )).toHaveLength(1);
    const finalInsight = await kv.get<Insight & {
      sourceMutationWatermarks?: Record<string, string>;
    }>(KV.insights, sharedInsightId);
    expect(finalInsight?.reinforcements).toBe(1);
    expect(Object.keys(finalInsight?.sourceMutationWatermarks ?? {})).toHaveLength(1);
    const audits = (await kv.list<AuditEntry>(KV.audit))
      .filter((audit) => audit.operation === "reflect");
    expect(audits).toHaveLength(1);
    const receipts = await Promise.all(identities.map((identity) => {
      const key = buildExtractionOperationKey({ ...identity, stage: "reflect_insight" });
      return kv.get<{ reflectRecovery?: { phase?: string } }>(
        KV.extractionOperationReceipt(key),
        key,
      );
    }));
    expect(receipts.filter(
      (receipt) => receipt?.reflectRecovery?.phase === "committed",
    )).toHaveLength(1);
    expect(provider.summarize).toHaveBeenCalledTimes(2);
  });

  it("rejects a committed reflect receipt when a formal insight is missing", async () => {
    const identity = {
      runId: "reflect-committed-verification-run",
      unitId: "reflect-committed-verification-unit",
      inputHash: "reflect-committed-verification-input",
    };
    const key = buildExtractionOperationKey({ ...identity, stage: "reflect_insight" });
    await kv.set("mem:extraction-operation-receipt:" + key, key, {
      ...identity,
      stage: "reflect_insight",
      key,
      version: 1,
      status: "running",
      startedAt: "2026-07-30T00:00:00.000Z",
    });
    await kv.set("mem:semantic", "sem_verify", makeSemantic("security validation is important", "sem_verify"));
    await kv.set("mem:lessons", "lsn_verify", makeLesson("Use security headers", ["security"]));
    await kv.set("mem:crystals", "crys_verify", makeCrystal("Completed security cleanup", ["security"]));
    const input = {
      kv: kv as never,
      provider: provider as never,
      useGraph: false,
      semanticMemoryIds: ["sem_verify"],
      lessonIds: ["lsn_verify"],
      crystalIds: ["crys_verify"],
      recoveryIdentity: identity,
    };

    const first = await runReflectInsightWindow(input);
    expect(first.success).toBe(true);
    const committedReceipt = await kv.get<Record<string, unknown>>(
      "mem:extraction-operation-receipt:" + key,
      key,
    );
    await kv.set("mem:extraction-operation-receipt:" + key, key, {
      ...committedReceipt,
      status: "succeeded",
      completedAt: "2026-07-30T00:01:00.000Z",
      response: { success: true, insightIds: first.insightIds },
    });
    await kv.delete("mem:insights", first.insightIds![0]);

    const verified = await runReflectInsightWindow(input);
    expect(verified).toMatchObject({
      success: false,
      error: "reflect_insight_source_mutation_conflict",
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  describe("incremental reflect insight contract", () => {
    it("plans only explicit backlog sources and keeps fewer than three pending", async () => {
      const sources = await seedIncrementalReflectSources(kv, "planner", 0);
      await kv.set(KV.insights, "ins_historical", {
        id: "ins_historical",
        title: "Historical insight",
        content: "This historical insight must not become an upstream source.",
        confidence: 0.8,
        reinforcements: 0,
        sourceConceptCluster: ["history"],
        sourceMemoryIds: [],
        sourceLessonIds: [],
        sourceCrystalIds: [],
        tags: ["history"],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        decayRate: 0.05,
      });

      expect(await planReflectInsightWindows({ kv: kv as never, useGraph: false }))
        .toMatchObject({ windows: [], totalItems: 0 });

      await enqueueReflectInsightBacklog({
        kv: kv as never,
        semanticMemoryIds: [sources.semanticMemoryId],
        lessonIds: [sources.lessonId],
      });
      expect(await planReflectInsightWindows({ kv: kv as never, useGraph: false }))
        .toMatchObject({
          windows: [],
          totalItems: 2,
          reason: "fewer than 3 unconsumed supporting items",
        });
      expect(await kv.list(KV.reflectInsightBacklog)).toHaveLength(2);
      expect(provider.summarize).not.toHaveBeenCalled();

      await enqueueReflectInsightBacklog({
        kv: kv as never,
        crystalIds: [sources.crystalId],
      });
      const ready = await planReflectInsightWindows({ kv: kv as never, useGraph: false }) as {
        windows: PlannedReflectWindow[];
      };
      expect(ready.windows).toHaveLength(1);
      expect(ready.windows[0]).toMatchObject({
        semanticMemoryIds: [sources.semanticMemoryId],
        lessonIds: [sources.lessonId],
        crystalIds: [sources.crystalId],
        stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
      });
      expect(ready.windows[0].sourceVersionKeys).toHaveLength(3);
    });

    it("uses historical insights only as context and terminally consumes exact sources", async () => {
      const { window } = await seedIncrementalReflectSources(kv, "success");
      expect(window).toBeDefined();
      const historical: Insight = {
        id: "ins_incremental_history",
        title: "Historical Boundary Evidence",
        content: "Security boundary evidence requires durable provenance.",
        confidence: 0.82,
        reinforcements: 2,
        sourceConceptCluster: ["security"],
        sourceMemoryIds: ["sem_old"],
        sourceLessonIds: [],
        sourceCrystalIds: [],
        tags: ["security"],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        decayRate: 0.05,
      };
      await kv.set(KV.insights, historical.id, historical);
      const identity = {
        runId: "reflect-incremental-success",
        unitId: window!.windowId,
        inputHash: "1".repeat(64),
      };
      await createReflectOperationReceipt(kv, identity);
      const input = {
        kv: kv as never,
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: window!.semanticMemoryIds,
        lessonIds: window!.lessonIds,
        crystalIds: window!.crystalIds,
        stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
        sourceVersionKeys: window!.sourceVersionKeys,
        recoveryIdentity: identity,
      };

      const first = await runReflectInsightWindow(input);
      expect(first).toMatchObject({ success: true, status: "succeeded" });
      expect(provider.summarize).toHaveBeenCalledTimes(1);
      expect(provider.summarize.mock.calls[0][1]).toContain(historical.title);
      expect(provider.summarize.mock.calls[0][1]).toContain(historical.content);
      expect(await kv.get(KV.insights, historical.id)).toEqual(historical);

      const reconciled = await finalizeReflectContribution({
        kv,
        identity,
        sourceVersionKeys: window!.sourceVersionKeys,
        response: first,
      });
      expect(reconciled).toMatchObject({ success: true, status: "succeeded" });
      expect(await kv.list(KV.reflectInsightBacklog)).toEqual([]);
      expect(await planReflectInsightWindows({ kv: kv as never, useGraph: false }))
        .toMatchObject({ windows: [], totalItems: 0 });
      const contributionScope = KV.extractionContributionRecords(
        "reflect_insight",
        REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
      );
      expect(await kv.list<{ state: string }>(contributionScope)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: "committed" }),
          expect.objectContaining({ state: "committed" }),
          expect.objectContaining({ state: "committed" }),
        ]),
      );

      expect(await runReflectInsightWindow(input)).toMatchObject({
        success: true,
        insightIds: first.insightIds,
      });
      expect(provider.summarize).toHaveBeenCalledTimes(1);

      const createdInsightId = (first.insightIds as string[])[0];
      const created = await kv.get<Insight>(KV.insights, createdInsightId);
      await kv.set(KV.insights, createdInsightId, { ...created!, content: "tampered" });
      expect(await runReflectInsightWindow(input)).toMatchObject({
        success: false,
        error: "reflect_insight_source_mutation_conflict",
        failure: { class: "hard", cause: "reflect_insight_source_mutation_conflict" },
      });
      expect(provider.summarize).toHaveBeenCalledTimes(1);
    });

    it("commits a strict empty response as terminal no-effect", async () => {
      provider.summarize.mockResolvedValueOnce("<insights></insights>");
      const { window } = await seedIncrementalReflectSources(kv, "empty");
      const identity = {
        runId: "reflect-incremental-empty",
        unitId: window!.windowId,
        inputHash: "2".repeat(64),
      };
      await createReflectOperationReceipt(kv, identity);
      const result = await runReflectInsightWindow({
        kv: kv as never,
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: window!.semanticMemoryIds,
        lessonIds: window!.lessonIds,
        crystalIds: window!.crystalIds,
        stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
        sourceVersionKeys: window!.sourceVersionKeys,
        recoveryIdentity: identity,
      });

      expect(result).toMatchObject({
        success: true,
        status: "skipped",
        insightIds: [],
        reflectRecoveryEvidence: {
          kind: "no_effect",
          reasonCode: "no_novel_insight",
          proof: { schema: "reflect-insight-no-effect/v1" },
        },
      });
      expect(await finalizeReflectContribution({
        kv,
        identity,
        sourceVersionKeys: window!.sourceVersionKeys,
        response: result,
      })).toMatchObject({ success: true, status: "skipped" });
      expect(await kv.list(KV.insights)).toEqual([]);
      expect(await kv.list<{ state: string }>(KV.extractionContributionRecords(
        "reflect_insight",
        REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
      ))).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: "no_effect" }),
        expect.objectContaining({ state: "no_effect" }),
        expect.objectContaining({ state: "no_effect" }),
      ]));
      expect(await planReflectInsightWindows({ kv: kv as never, useGraph: false }))
        .toMatchObject({ windows: [], totalItems: 0 });
      expect(provider.summarize).toHaveBeenCalledTimes(1);
    });

    it("recovers a persisted formal response without another provider call", async () => {
      const { window } = await seedIncrementalReflectSources(kv, "recovery");
      const identity = {
        runId: "reflect-incremental-recovery",
        unitId: window!.windowId,
        inputHash: "3".repeat(64),
      };
      const key = await createReflectOperationReceipt(kv, identity);
      let loseStagedResponse = true;
      const flakyKv = {
        ...kv,
        set: async <T>(scope: string, itemKey: string, data: T): Promise<T> => {
          const stored = await kv.set(scope, itemKey, data);
          const recovery = (data as { reflectRecovery?: { phase?: string } }).reflectRecovery;
          if (loseStagedResponse && scope === KV.extractionOperationReceipt(key)
            && recovery?.phase === "staged") {
            loseStagedResponse = false;
            throw new Error("staged response lost");
          }
          return stored;
        },
      };
      const baseInput = {
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: window!.semanticMemoryIds,
        lessonIds: window!.lessonIds,
        crystalIds: window!.crystalIds,
        stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
        sourceVersionKeys: window!.sourceVersionKeys,
        recoveryIdentity: identity,
      };

      expect(await runReflectInsightWindow({ ...baseInput, kv: flakyKv as never }))
        .toMatchObject({ success: false, error: "staged response lost" });
      const resumed = await runReflectInsightWindow({ ...baseInput, kv: kv as never });
      expect(resumed).toMatchObject({ success: true, status: "succeeded" });
      expect(provider.summarize).toHaveBeenCalledTimes(1);
      expect(await finalizeReflectContribution({
        kv,
        identity,
        sourceVersionKeys: window!.sourceVersionKeys,
        response: resumed,
      })).toMatchObject({ success: true, status: "succeeded" });
    });

    it("keeps malformed output retryable without consuming the backlog", async () => {
      provider.summarize.mockResolvedValueOnce("not structured output");
      const { window } = await seedIncrementalReflectSources(kv, "malformed");
      const identity = {
        runId: "reflect-incremental-malformed",
        unitId: window!.windowId,
        inputHash: "4".repeat(64),
      };
      await createReflectOperationReceipt(kv, identity);
      const result = await runReflectInsightWindow({
        kv: kv as never,
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: window!.semanticMemoryIds,
        lessonIds: window!.lessonIds,
        crystalIds: window!.crystalIds,
        stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
        sourceVersionKeys: window!.sourceVersionKeys,
        recoveryIdentity: identity,
      });

      expect(result).toMatchObject({
        success: false,
        error: "reflect_insight_response_parse_failure",
        failure: { class: "unit", cause: "reflect_insight_response_parse_failure" },
      });
      const replanned = await planReflectInsightWindows({ kv: kv as never, useGraph: false }) as {
        windows: PlannedReflectWindow[];
      };
      expect(replanned.windows).toHaveLength(1);
      expect(replanned.windows[0].sourceVersionKeys).toEqual(window!.sourceVersionKeys);
      expect(await kv.list<{ state: string }>(KV.extractionContributionRecords(
        "reflect_insight",
        REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
      ))).not.toEqual(expect.arrayContaining([expect.objectContaining({ state: "claimed" })]));
      expect(provider.summarize).toHaveBeenCalledTimes(1);
    });

    it("rebuilds the pending window when an upstream source drifts before commit", async () => {
      const seeded = await seedIncrementalReflectSources(kv, "drift");
      const originalKeys = [...seeded.window!.sourceVersionKeys];
      const identity = {
        runId: "reflect-incremental-drift",
        unitId: seeded.window!.windowId,
        inputHash: "5".repeat(64),
      };
      await createReflectOperationReceipt(kv, identity);
      provider.summarize.mockImplementationOnce(async () => {
        const semantic = await kv.get<SemanticMemory>(KV.semantic, seeded.semanticMemoryId);
        await kv.set(KV.semantic, seeded.semanticMemoryId, {
          ...semantic!,
          fact: `${semantic!.fact} corrected`,
          updatedAt: "2026-08-02T00:00:30.000Z",
        });
        return XML_RESPONSE;
      });

      const result = await runReflectInsightWindow({
        kv: kv as never,
        provider: provider as never,
        useGraph: false,
        semanticMemoryIds: seeded.window!.semanticMemoryIds,
        lessonIds: seeded.window!.lessonIds,
        crystalIds: seeded.window!.crystalIds,
        stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
        sourceVersionKeys: originalKeys,
        recoveryIdentity: identity,
      });
      expect(result).toMatchObject({
        success: false,
        failure: { class: "hard", cause: "reflect_insight_source_drifted_before_commit" },
      });
      const replanned = await planReflectInsightWindows({ kv: kv as never, useGraph: false }) as {
        windows: PlannedReflectWindow[];
      };
      expect(replanned.windows).toHaveLength(1);
      expect(replanned.windows[0].sourceVersionKeys).not.toEqual(originalKeys);
      expect(provider.summarize).toHaveBeenCalledTimes(1);
    });
  });
});

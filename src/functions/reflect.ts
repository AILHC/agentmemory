import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { KV, fingerprintId } from "../state/schema.js";
import type {
  Insight,
  GraphNode,
  GraphEdge,
  SemanticMemory,
  Lesson,
  Crystal,
  MemoryProvider,
  ExtractionOperationReceipt,
} from "../types.js";
import {
  AUDIT_ENTRY_CONFLICT,
  AUDIT_ENTRY_MISSING,
  recordAudit,
} from "./audit.js";
import { buildExtractionOperationKey } from "./extraction-operation-receipts.js";
import { REFLECT_SYSTEM, buildReflectPrompt } from "../prompts/reflect.js";
import { REFLECT_OUTPUT_CONTRACT } from "../prompts/reflect.js";
import { withOutputLanguagePolicy } from "../prompts/output-language.js";
import {
  callProviderWithTelemetry,
  isProviderPreflightError,
  providerPreflightStatus,
  sortProviderCallTelemetry,
  type ProviderCallTelemetry,
} from "../providers/provider-call-result.js";
import {
  resolveStageModelCallOptions,
  resolveStageModelMetadata,
} from "../config.js";

interface ConceptCluster {
  concepts: string[];
  facts: Array<{ fact: string; confidence: number }>;
  lessons: Array<{ content: string; confidence: number }>;
  crystalNarratives: string[];
  factIds: string[];
  lessonIds: string[];
  crystalIds: string[];
}

export interface ReflectInsightWindow {
  windowId: string;
  semanticMemoryIds: string[];
  lessonIds: string[];
  crystalIds: string[];
  itemCount: number;
  charSize: number;
}

export interface ReflectInsightWindowOptions {
  kv: StateKV;
  provider: MemoryProvider;
  semanticMemoryIds?: string[];
  lessonIds?: string[];
  crystalIds?: string[];
  maxItemsPerWindow?: number;
  charBudget?: number;
  project?: string;
  useGraph?: boolean;
  model?: string;
  recoveryIdentity?: { runId: string; unitId: string; inputHash: string };
}

const REFLECT_RECOVERY_SCHEMA = "reflect-insight-recovery/v1";
const REFLECT_RECOVERY_COMMIT_LOCK = "recovery-effect-commit:reflect-insight";
const REFLECT_RECOVERY_HARD_FAILURES = new Set([
  "reflect_insight_recovery_identity_conflict",
  "reflect_insight_recovery_receipt_unavailable",
  "reflect_insight_source_mutation_conflict",
  "reflect_insight_committed_result_missing",
  "reflect_insight_committed_result_conflict",
  "reflect_insight_audit_conflict",
  "reflect_insight_committed_audit_missing",
]);

interface ReflectRecoveryItem {
  id: string;
  title: string;
  content: string;
  confidence: number;
  action: "create" | "reinforce";
  mutationId: string;
  baselineDeletedHash?: string;
  baselineUpdatedAt?: string;
  baselineReinforcements?: number;
}

interface ReflectRecoveryState {
  schema: typeof REFLECT_RECOVERY_SCHEMA;
  identity: { runId: string; unitId: string; inputHash: string };
  phase: "staged" | "committed";
  cluster: ConceptCluster;
  items: ReflectRecoveryItem[];
  totalItems: number;
  promptChars: number;
  model: {
    responseHash: string;
    response: string;
    telemetry: ProviderCallTelemetry[];
    metadata: Record<string, unknown>;
  };
  result?: {
    newInsights: number;
    reinforced: number;
    totalInsights: number;
    insightIds: string[];
    auditId: string;
  };
}

type RecoverableInsight = Insight & {
  sourceMutationWatermarks?: Record<string, string>;
};

type ReflectRecoveryReceipt = ExtractionOperationReceipt<Record<string, unknown>> & {
  reflectRecovery?: ReflectRecoveryState;
};

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

function reinforceInsight(insight: Insight): void {
  const now = new Date().toISOString();
  insight.reinforcements++;
  insight.confidence = Math.min(
    1.0,
    insight.confidence + 0.1 * (1 - insight.confidence),
  );
  insight.lastReinforcedAt = now;
  insight.updatedAt = now;
}

function buildGraphClusters(
  nodes: GraphNode[],
  edges: GraphEdge[],
  maxClusters: number,
): string[][] {
  const conceptNodes = nodes.filter(
    (n) => n.type === "concept" && !n.stale,
  );
  if (conceptNodes.length === 0) return [];

  const edgeMap = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.stale) continue;
    if (!edgeMap.has(edge.sourceNodeId))
      edgeMap.set(edge.sourceNodeId, new Set());
    if (!edgeMap.has(edge.targetNodeId))
      edgeMap.set(edge.targetNodeId, new Set());
    edgeMap.get(edge.sourceNodeId)!.add(edge.targetNodeId);
    edgeMap.get(edge.targetNodeId)!.add(edge.sourceNodeId);
  }

  const degree = new Map<string, number>();
  for (const node of conceptNodes) {
    degree.set(node.id, edgeMap.get(node.id)?.size || 0);
  }

  const sorted = [...conceptNodes].sort(
    (a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0),
  );

  const visited = new Set<string>();
  const clusters: string[][] = [];
  const conceptNodeIds = new Set(conceptNodes.map((n) => n.id));

  for (const seed of sorted) {
    if (visited.has(seed.id) || clusters.length >= maxClusters) break;

    const cluster: string[] = [];
    const queue = [seed.id];
    const seen = new Set<string>();
    let depth = 0;

    while (queue.length > 0 && depth <= 2) {
      const levelCount = queue.length;
      for (let i = 0; i < levelCount; i++) {
        const current = queue.shift()!;
        if (seen.has(current)) continue;
        seen.add(current);

        if (conceptNodeIds.has(current)) {
          const node = conceptNodes.find((n) => n.id === current);
          if (node) cluster.push(node.name);
          visited.add(current);
        }

        const neighbors = edgeMap.get(current) || new Set();
        for (const neighbor of neighbors) {
          if (!seen.has(neighbor)) queue.push(neighbor);
        }
      }
      depth++;
    }

    if (cluster.length >= 2) clusters.push(cluster);
  }

  return clusters;
}

function buildJaccardClusters(
  semanticMemories: SemanticMemory[],
  lessons: Lesson[],
  maxClusters: number,
): string[][] {
  const allConcepts = new Map<string, Set<string>>();

  for (const sem of semanticMemories) {
    const terms = sem.fact.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
    for (const term of terms) {
      if (!allConcepts.has(term)) allConcepts.set(term, new Set());
      allConcepts.get(term)!.add(sem.id);
    }
  }
  for (const lesson of lessons) {
    for (const tag of lesson.tags) {
      const key = tag.toLowerCase();
      if (!allConcepts.has(key)) allConcepts.set(key, new Set());
      allConcepts.get(key)!.add(lesson.id);
    }
  }

  const conceptList = [...allConcepts.keys()].filter(
    (k) => (allConcepts.get(k)?.size || 0) >= 2,
  );

  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (const concept of conceptList) {
    if (visited.has(concept) || clusters.length >= maxClusters) break;

    const cluster = [concept];
    visited.add(concept);

    const docsA = allConcepts.get(concept) || new Set();
    for (const other of conceptList) {
      if (visited.has(other)) continue;
      const docsB = allConcepts.get(other) || new Set();
      let intersection = 0;
      for (const d of docsA) {
        if (docsB.has(d)) intersection++;
      }
      const union = docsA.size + docsB.size - intersection;
      const similarity = union > 0 ? intersection / union : 0;
      if (similarity > 0.3) {
        cluster.push(other);
        visited.add(other);
      }
    }

    if (cluster.length >= 2) clusters.push(cluster);
  }

  return clusters;
}

function itemSize(value: { fact?: string; content?: string; narrative?: string }): number {
  return (value.fact ?? value.content ?? value.narrative ?? "").length;
}

function summarizeWithOptions(
  provider: MemoryProvider,
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  telemetry?: ProviderCallTelemetry[],
  callIndex = 0,
): Promise<string> {
  const callOptions = resolveStageModelCallOptions("reflect_insight", model);
  if (!telemetry) {
    return callOptions
      ? provider.summarize(systemPrompt, userPrompt, callOptions)
      : provider.summarize(systemPrompt, userPrompt);
  }
  return callProviderWithTelemetry({
    provider,
    operation: "summarize",
    callRole: "window",
    callIndex,
    systemPrompt,
    userPrompt,
    callOptions,
    telemetry,
  });
}

export async function planReflectInsightWindows(options: {
  kv: StateKV;
  maxItemsPerWindow?: number;
  charBudget?: number;
  project?: string;
  useGraph?: boolean;
}): Promise<Record<string, unknown>> {
  if (options.useGraph === true) {
    return { success: false, error: "useGraph:true is not supported for full reflect insight windows" };
  }
  const maxItems = Math.max(3, options.maxItemsPerWindow ?? 30);
  const charBudget = Math.max(1, options.charBudget ?? 64_000);
  const [semanticMemories, lessons, crystals] = await Promise.all([
    options.kv.list<SemanticMemory>(KV.semantic).catch(() => []),
    options.kv.list<Lesson>(KV.lessons).catch(() => []),
    options.kv.list<Crystal>(KV.crystals).catch(() => []),
  ]);
  const activeLessons = lessons.filter((l) => !l.deleted && (!options.project || l.project === options.project));
  const scopedCrystals = crystals.filter((c) => !options.project || c.project === options.project);
  const items: Array<
    | { kind: "semantic"; id: string; size: number }
    | { kind: "lesson"; id: string; size: number }
    | { kind: "crystal"; id: string; size: number }
  > = [
    ...semanticMemories.map((memory) => ({ kind: "semantic" as const, id: memory.id, size: itemSize(memory) })),
    ...activeLessons.map((lesson) => ({ kind: "lesson" as const, id: lesson.id, size: itemSize(lesson) })),
    ...scopedCrystals.map((crystal) => ({ kind: "crystal" as const, id: crystal.id, size: itemSize(crystal) })),
  ];

  const windows: ReflectInsightWindow[] = [];
  let current: ReflectInsightWindow = {
    windowId: "reflect:1",
    semanticMemoryIds: [],
    lessonIds: [],
    crystalIds: [],
    itemCount: 0,
    charSize: 0,
  };

  const flush = () => {
    if (current.itemCount > 0) {
      windows.push(current);
      current = {
        windowId: `reflect:${windows.length + 1}`,
        semanticMemoryIds: [],
        lessonIds: [],
        crystalIds: [],
        itemCount: 0,
        charSize: 0,
      };
    }
  };

  for (const item of items) {
    const wouldExceedItems = current.itemCount >= maxItems;
    const wouldExceedChars = current.itemCount > 0 && current.charSize + item.size > charBudget;
    if (wouldExceedItems || wouldExceedChars) flush();
    if (item.kind === "semantic") current.semanticMemoryIds.push(item.id);
    if (item.kind === "lesson") current.lessonIds.push(item.id);
    if (item.kind === "crystal") current.crystalIds.push(item.id);
    current.itemCount++;
    current.charSize += item.size;
  }
  flush();

  return { success: true, windows, totalItems: items.length };
}

async function loadReflectWindowCluster(
  options: ReflectInsightWindowOptions,
): Promise<ConceptCluster> {
  const [semanticMemories, lessons, crystals] = await Promise.all([
    Promise.all(
      (options.semanticMemoryIds ?? []).map((id) =>
        options.kv.get<SemanticMemory>(KV.semantic, id).catch(() => null),
      ),
    ),
    Promise.all(
      (options.lessonIds ?? []).map((id) =>
        options.kv.get<Lesson>(KV.lessons, id).catch(() => null),
      ),
    ),
    Promise.all(
      (options.crystalIds ?? []).map((id) =>
        options.kv.get<Crystal>(KV.crystals, id).catch(() => null),
      ),
    ),
  ]);
  const facts = semanticMemories.filter((item): item is SemanticMemory => item !== null);
  const activeLessons = lessons
    .filter((item): item is Lesson => item !== null)
    .filter((lesson) => !lesson.deleted && (!options.project || lesson.project === options.project));
  const activeCrystals = crystals
    .filter((item): item is Crystal => item !== null)
    .filter((crystal) => !options.project || crystal.project === options.project);
  const concepts = [
    ...new Set([
      ...activeLessons.flatMap((lesson) => lesson.tags),
      ...facts.flatMap((fact) => fact.fact.toLowerCase().split(/\s+/).filter((term) => term.length > 3).slice(0, 3)),
    ]),
  ].slice(0, 12);
  return {
    concepts: concepts.length > 0 ? concepts : ["reflect-full-window"],
    facts: facts.map((f) => ({ fact: f.fact, confidence: f.confidence })),
    lessons: activeLessons.map((l) => ({ content: l.content, confidence: l.confidence })),
    crystalNarratives: activeCrystals.map((c) => c.narrative),
    factIds: facts.map((f) => f.id),
    lessonIds: activeLessons.map((l) => l.id),
    crystalIds: activeCrystals.map((c) => c.id),
  };
}

function parseReflectInsightItems(response: string, maxInsights: number): Array<{
  id: string;
  title: string;
  content: string;
  confidence: number;
}> {
  const insightRegex =
    /<insight\s+confidence="([^"]+)"\s+title="([^"]+)">([\s\S]*?)<\/insight>/g;
  const items: Array<{ id: string; title: string; content: string; confidence: number }> = [];
  let match;
  while ((match = insightRegex.exec(response)) !== null && items.length < maxInsights) {
    const content = match[3].trim();
    if (!content) continue;
    const parsedConfidence = parseFloat(match[1]);
    items.push({
      id: fingerprintId("ins", content.toLowerCase()),
      title: match[2].trim(),
      content,
      confidence: Number.isNaN(parsedConfidence)
        ? 0.5
        : Math.max(0, Math.min(1, parsedConfidence)),
    });
  }
  return items;
}

function recoveryReceiptKey(identity: NonNullable<ReflectInsightWindowOptions["recoveryIdentity"]>): string {
  return buildExtractionOperationKey({
    runId: identity.runId,
    stage: "reflect_insight",
    unitId: identity.unitId,
  });
}

function sameRecoveryIdentity(
  left: ReflectRecoveryState["identity"],
  right: NonNullable<ReflectInsightWindowOptions["recoveryIdentity"]>,
): boolean {
  return left.runId === right.runId
    && left.unitId === right.unitId
    && left.inputHash === right.inputHash;
}

async function readReflectRecovery(
  kv: StateKV,
  identity: NonNullable<ReflectInsightWindowOptions["recoveryIdentity"]>,
): Promise<{ receipt: ReflectRecoveryReceipt; recovery: ReflectRecoveryState } | null> {
  const key = recoveryReceiptKey(identity);
  const receipt = await kv.get<ReflectRecoveryReceipt>(KV.extractionOperationReceipt(key), key);
  const recovery = receipt?.reflectRecovery;
  if (!recovery) return null;
  const validReceiptStatus = receipt.status === "running"
    || (receipt.status === "succeeded" && recovery.phase === "committed");
  if (
    recovery.schema !== REFLECT_RECOVERY_SCHEMA
    || receipt.key !== key
    || receipt.stage !== "reflect_insight"
    || receipt.runId !== identity.runId
    || receipt.unitId !== identity.unitId
    || receipt.inputHash !== identity.inputHash
    || !validReceiptStatus
    || !sameRecoveryIdentity(recovery.identity, identity)
    || !["staged", "committed"].includes(recovery.phase)
  ) {
    throw new Error("reflect_insight_recovery_identity_conflict");
  }
  return { receipt, recovery };
}

async function stageReflectRecovery(options: {
  kv: StateKV;
  identity: NonNullable<ReflectInsightWindowOptions["recoveryIdentity"]>;
  cluster: ConceptCluster;
  response: string;
  totalItems: number;
  promptChars: number;
  telemetry: ProviderCallTelemetry[];
  metadata: Record<string, unknown>;
  maxInsights: number;
}): Promise<{ receipt: ReflectRecoveryReceipt; recovery: ReflectRecoveryState }> {
  const existing = await readReflectRecovery(options.kv, options.identity);
  if (existing) return existing;
  const key = recoveryReceiptKey(options.identity);
  const receipt = await options.kv.get<ReflectRecoveryReceipt>(KV.extractionOperationReceipt(key), key);
  if (
    !receipt
    || receipt.status !== "running"
    || receipt.stage !== "reflect_insight"
    || receipt.runId !== options.identity.runId
    || receipt.unitId !== options.identity.unitId
    || receipt.inputHash !== options.identity.inputHash
  ) {
    throw new Error("reflect_insight_recovery_receipt_unavailable");
  }
  const mutationSource = fingerprintId("rimsrc", JSON.stringify(options.identity));
  const items = await Promise.all(parseReflectInsightItems(options.response, options.maxInsights)
    .map(async (item): Promise<ReflectRecoveryItem> => {
      const existingInsight = await options.kv.get<RecoverableInsight>(KV.insights, item.id);
      return {
        ...item,
        action: existingInsight && !existingInsight.deleted ? "reinforce" : "create",
        mutationId: fingerprintId("rimm", JSON.stringify([
          mutationSource,
          item.id,
          stableHash({ title: item.title, content: item.content, confidence: item.confidence }),
        ])),
        ...(existingInsight && !existingInsight.deleted
          ? {
            baselineUpdatedAt: existingInsight.updatedAt,
            baselineReinforcements: existingInsight.reinforcements,
          }
          : existingInsight?.deleted
            ? { baselineDeletedHash: stableHash(existingInsight) }
            : {}),
      };
    }));
  const recovery: ReflectRecoveryState = {
    schema: REFLECT_RECOVERY_SCHEMA,
    identity: options.identity,
    phase: "staged",
    cluster: options.cluster,
    items,
    totalItems: options.totalItems,
    promptChars: options.promptChars,
    model: {
      responseHash: stableHash(options.response),
      response: options.response,
      telemetry: [...options.telemetry],
      metadata: options.metadata,
    },
  };
  const staged = { ...receipt, reflectRecovery: recovery };
  await options.kv.set(KV.extractionOperationReceipt(key), key, staged);
  return { receipt: staged, recovery };
}

function mutationSource(identity: ReflectRecoveryState["identity"]): string {
  return fingerprintId("rimsrc", JSON.stringify(identity));
}

function recoveryResultEvidence(
  receipt: ReflectRecoveryReceipt,
  recovery: ReflectRecoveryState,
): Record<string, unknown> {
  const result = recovery.result!;
  const resultRef = `reflect-insight-recoveries:${recoveryReceiptKey(recovery.identity)}`;
  return {
    schema: "reflect-insight-commit/v1",
    kind: "committed",
    receiptKey: receipt.key,
    receiptVersion: receipt.version ?? 1,
    resultRef,
    effectHash: stableHash({
      identity: recovery.identity,
      items: recovery.items.map((item) => [item.id, item.mutationId]),
      result,
    }),
  };
}

type ReflectRecoveryCommitOptions = {
  kv: StateKV;
  receipt: ReflectRecoveryReceipt;
  recovery: ReflectRecoveryState;
  project?: string;
};

async function commitReflectRecovery(
  options: ReflectRecoveryCommitOptions,
): Promise<ReflectRecoveryState> {
  return withKeyedLock(
    REFLECT_RECOVERY_COMMIT_LOCK,
    () => commitReflectRecoveryLocked(options),
  );
}

async function commitReflectRecoveryLocked(
  options: ReflectRecoveryCommitOptions,
): Promise<ReflectRecoveryState> {
  const verifyingCommitted = options.recovery.phase === "committed";
  if (verifyingCommitted && !options.recovery.result) {
    throw new Error("reflect_insight_committed_result_missing");
  }
  const source = mutationSource(options.recovery.identity);
  for (const item of options.recovery.items) {
    const existing = await options.kv.get<RecoverableInsight>(KV.insights, item.id);
    const watermark = existing?.sourceMutationWatermarks?.[source];
    if (verifyingCommitted) {
      if (!existing || watermark !== item.mutationId) {
        throw new Error("reflect_insight_source_mutation_conflict");
      }
      continue;
    }
    if (watermark === item.mutationId) continue;
    if (watermark !== undefined) throw new Error("reflect_insight_source_mutation_conflict");
    if (item.action === "create") {
      if (
        existing
          ? !existing.deleted || stableHash(existing) !== item.baselineDeletedHash
          : item.baselineDeletedHash !== undefined
      ) {
        throw new Error("reflect_insight_source_mutation_conflict");
      }
      const now = new Date().toISOString();
      const insight: RecoverableInsight = {
        id: item.id,
        title: item.title,
        content: item.content,
        confidence: item.confidence,
        reinforcements: 0,
        sourceConceptCluster: options.recovery.cluster.concepts,
        sourceMemoryIds: options.recovery.cluster.factIds,
        sourceLessonIds: options.recovery.cluster.lessonIds,
        sourceCrystalIds: options.recovery.cluster.crystalIds,
        project: options.project,
        tags: options.recovery.cluster.concepts,
        createdAt: now,
        updatedAt: now,
        decayRate: 0.05,
        sourceMutationWatermarks: { [source]: item.mutationId },
      };
      await options.kv.set(KV.insights, insight.id, insight);
      continue;
    }
    if (
      !existing
      || existing.deleted
      || existing.updatedAt !== item.baselineUpdatedAt
      || existing.reinforcements !== item.baselineReinforcements
    ) throw new Error("reflect_insight_source_mutation_conflict");
    reinforceInsight(existing);
    existing.sourceMutationWatermarks = {
      ...existing.sourceMutationWatermarks,
      [source]: item.mutationId,
    };
    await options.kv.set(KV.insights, existing.id, existing);
  }
  const result = {
    newInsights: options.recovery.items.filter((item) => item.action === "create").length,
    reinforced: options.recovery.items.filter((item) => item.action === "reinforce").length,
    totalInsights: options.recovery.items.length,
    insightIds: options.recovery.items.map((item) => item.id),
    auditId: fingerprintId("aud", JSON.stringify([
      recoveryReceiptKey(options.recovery.identity),
      stableHash(options.recovery.items.map((item) => [item.id, item.mutationId])),
    ])),
  };
  if (
    verifyingCommitted
    && stableHash(options.recovery.result) !== stableHash(result)
  ) {
    throw new Error("reflect_insight_committed_result_conflict");
  }
  try {
    await recordAudit(
      options.kv,
      "reflect",
      "mem::reflect-insight-window",
      result.insightIds,
      {
        newInsights: result.newInsights,
        reinforced: result.reinforced,
        totalItems: options.recovery.totalItems,
        useGraph: false,
      },
      undefined,
      undefined,
      {
        id: result.auditId,
        timestamp: options.receipt.startedAt,
        requireExisting: verifyingCommitted,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === AUDIT_ENTRY_CONFLICT) {
      throw new Error("reflect_insight_audit_conflict");
    }
    if (message === AUDIT_ENTRY_MISSING) {
      throw new Error("reflect_insight_committed_audit_missing");
    }
    throw error;
  }
  if (verifyingCommitted) return options.recovery;
  const committed: ReflectRecoveryState = {
    ...options.recovery,
    phase: "committed",
    result,
  };
  const receipt = { ...options.receipt, reflectRecovery: committed };
  await options.kv.set(KV.extractionOperationReceipt(receipt.key), receipt.key, receipt);
  return committed;
}

async function persistReflectInsights(options: {
  kv: StateKV;
  response: string;
  cluster: ConceptCluster;
  project?: string;
  maxInsights?: number;
}): Promise<{ newInsights: number; reinforced: number; totalInsights: number; insightIds: string[] }> {
  const insightRegex =
    /<insight\s+confidence="([^"]+)"\s+title="([^"]+)">([\s\S]*?)<\/insight>/g;
  let match;
  let newInsights = 0;
  let reinforced = 0;
  let totalInsights = 0;
  const insightIds: string[] = [];
  const maxInsights = options.maxInsights ?? 50;

  while ((match = insightRegex.exec(options.response)) !== null && totalInsights < maxInsights) {
    const parsedConf = parseFloat(match[1]);
    const confidence = Number.isNaN(parsedConf)
      ? 0.5
      : Math.max(0, Math.min(1, parsedConf));
    const title = match[2].trim();
    const content = match[3].trim();
    if (!content) continue;

    const fp = fingerprintId("ins", content.trim().toLowerCase());
    const existing = await options.kv.get<Insight>(KV.insights, fp);
    if (existing && !existing.deleted) {
      reinforceInsight(existing);
      await options.kv.set(KV.insights, existing.id, existing);
      if (!insightIds.includes(existing.id)) insightIds.push(existing.id);
      reinforced++;
    } else {
      const now = new Date().toISOString();
      const insight: Insight = {
        id: fp,
        title,
        content,
        confidence,
        reinforcements: 0,
        sourceConceptCluster: options.cluster.concepts,
        sourceMemoryIds: options.cluster.factIds,
        sourceLessonIds: options.cluster.lessonIds,
        sourceCrystalIds: options.cluster.crystalIds,
        project: options.project,
        tags: options.cluster.concepts,
        createdAt: now,
        updatedAt: now,
        decayRate: 0.05,
      };
      await options.kv.set(KV.insights, insight.id, insight);
      insightIds.push(insight.id);
      newInsights++;
    }
    totalInsights++;
  }

  return { newInsights, reinforced, totalInsights, insightIds };
}

export async function runReflectInsightWindow(
  options: ReflectInsightWindowOptions,
): Promise<Record<string, unknown>> {
  const startMs = Date.now();
  const telemetry: ProviderCallTelemetry[] = [];
  const stageMetadata = resolveStageModelMetadata("reflect_insight", options.provider, options.model);
  const responseMetadata = (status: string, extra: Record<string, unknown> = {}) => ({
    status,
    ...stageMetadata,
    durationMs: Date.now() - startMs,
    telemetry: sortProviderCallTelemetry(telemetry),
    ...extra,
  });
  if (options.useGraph === true) {
    return {
      success: false,
      error: "useGraph:true is not supported for full reflect insight windows",
      ...responseMetadata("failed"),
    };
  }
  try {
    const recovered = options.recoveryIdentity
      ? await readReflectRecovery(options.kv, options.recoveryIdentity)
      : null;
    if (recovered) {
      const committed = await commitReflectRecovery({
        kv: options.kv,
        receipt: recovered.receipt,
        recovery: recovered.recovery,
        project: options.project,
      });
      const persisted = committed.result!;
      return {
        success: true,
        newInsights: persisted.newInsights,
        reinforced: persisted.reinforced,
        totalInsights: persisted.totalInsights,
        insightIds: persisted.insightIds,
        totalItems: committed.totalItems,
        usedFallback: true,
        ...committed.model.metadata,
        promptChars: committed.promptChars,
        telemetry: committed.model.telemetry,
        parseFailures: persisted.insightIds.length > 0 ? 0 : 1,
        reflectRecoveryEvidence: recoveryResultEvidence(recovered.receipt, committed),
      };
    }
    if (!options.provider?.summarize) {
      return { success: false, error: "provider.summarize is required", ...responseMetadata("failed") };
    }
    const cluster = await loadReflectWindowCluster(options);
    const totalItems = cluster.facts.length + cluster.lessons.length + cluster.crystalNarratives.length;
    if (totalItems < 3) {
      const receiptKey = options.recoveryIdentity
        ? recoveryReceiptKey(options.recoveryIdentity)
        : undefined;
      return {
        success: true,
        skipped: true,
        reason: "fewer than 3 supporting items",
        totalItems,
        ...responseMetadata("skipped", { parseFailures: 0 }),
        ...(receiptKey ? {
          reflectRecoveryEvidence: {
            kind: "no_effect",
            observation: "business_empty",
            reasonCode: "insufficient_supporting_items",
            proof: {
              kind: "receipt_before_formal_effect",
              receiptKey,
              receiptVersion: 1,
              phase: "candidate_staging",
              commitPlanAbsent: true,
            },
          },
        } : {}),
      };
    }

    const prompt = buildReflectPrompt(cluster);
    if (options.charBudget !== undefined && prompt.length > options.charBudget) {
      return {
        success: false,
        error: "input_too_large",
        promptChars: prompt.length,
        charBudget: options.charBudget,
        ...responseMetadata("failed", {
          promptChars: prompt.length,
          charBudget: options.charBudget,
          parseFailures: 0,
        }),
      };
    }
    const response = await summarizeWithOptions(
      options.provider,
      withOutputLanguagePolicy(REFLECT_SYSTEM, undefined, REFLECT_OUTPUT_CONTRACT),
      prompt,
      options.model,
      telemetry,
      0,
    );
    if (options.recoveryIdentity) {
      const staged = await stageReflectRecovery({
        kv: options.kv,
        identity: options.recoveryIdentity,
        cluster,
        response,
        totalItems,
        promptChars: prompt.length,
        telemetry: sortProviderCallTelemetry(telemetry),
        metadata: responseMetadata("succeeded", {
          charBudget: options.charBudget,
        }),
        maxInsights: options.maxItemsPerWindow ?? 50,
      });
      const committed = await commitReflectRecovery({
        kv: options.kv,
        receipt: staged.receipt,
        recovery: staged.recovery,
        project: options.project,
      });
      const persisted = committed.result!;
      return {
        success: true,
        newInsights: persisted.newInsights,
        reinforced: persisted.reinforced,
        totalInsights: persisted.totalInsights,
        insightIds: persisted.insightIds,
        totalItems,
        usedFallback: true,
        ...committed.model.metadata,
        promptChars: committed.promptChars,
        telemetry: committed.model.telemetry,
        parseFailures: persisted.insightIds.length > 0 ? 0 : 1,
        reflectRecoveryEvidence: recoveryResultEvidence(staged.receipt, committed),
      };
    }
    const persisted = await persistReflectInsights({
      kv: options.kv,
      response,
      cluster,
      project: options.project,
      maxInsights: options.maxItemsPerWindow,
    });
    await recordAudit(options.kv, "reflect", "mem::reflect-insight-window", [], {
      newInsights: persisted.newInsights,
      reinforced: persisted.reinforced,
      totalItems,
      useGraph: false,
    });
    return {
      success: true,
      ...persisted,
      totalItems,
      usedFallback: true,
      ...responseMetadata("succeeded", {
        promptChars: prompt.length,
        charBudget: options.charBudget,
        parseFailures: persisted.insightIds.length > 0 ? 0 : 1,
      }),
    };
  } catch (err) {
    if (isProviderPreflightError(err)) {
      const status = providerPreflightStatus(err);
      return { success: false, error: status, ...responseMetadata(status) };
    }
    const error = err instanceof Error ? err.message : String(err);
    if (REFLECT_RECOVERY_HARD_FAILURES.has(error)) {
      return {
        success: false,
        error,
        failure: { class: "hard", cause: error },
        ...responseMetadata("failed"),
      };
    }
    return { success: false, error, ...responseMetadata("failed") };
  }
}

export function registerReflectFunctions(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::full-reflect-insight-windows-plan",
    async (data: {
      project?: string;
      useGraph?: boolean;
      maxItemsPerWindow?: number;
      charBudget?: number;
    }) => planReflectInsightWindows({ kv, ...data }),
  );

  sdk.registerFunction(
    "mem::full-reflect-insight-window",
    async (data: {
      project?: string;
      useGraph?: boolean;
      maxItemsPerWindow?: number;
      charBudget?: number;
      semanticMemoryIds?: string[];
      lessonIds?: string[];
      crystalIds?: string[];
      model?: string;
      recoveryIdentity?: { runId: string; unitId: string; inputHash: string };
    }) => runReflectInsightWindow({ kv, provider, ...data }),
  );

  sdk.registerFunction("mem::reflect", 
    async (data: { maxClusters?: number; project?: string; model?: string }) => {
      const maxClusters = Math.min(data?.maxClusters ?? 10, 20);
      const maxInsightsPerCluster = 5;
      const maxTotal = 50;
      const telemetry: ProviderCallTelemetry[] = [];
      let callIndex = 0;

      const [graphNodes, graphEdges, semanticMemories, lessons, crystals] =
        await Promise.all([
          kv.list<GraphNode>(KV.graphNodes).catch(() => []),
          kv.list<GraphEdge>(KV.graphEdges).catch(() => []),
          kv.list<SemanticMemory>(KV.semantic).catch(() => []),
          kv.list<Lesson>(KV.lessons).catch(() => []),
          kv.list<Crystal>(KV.crystals).catch(() => []),
        ]);

      let activeLessons = lessons.filter((l) => !l.deleted);
      if (data?.project) {
        activeLessons = activeLessons.filter((l) => l.project === data.project);
      }

      let conceptClusters = buildGraphClusters(
        graphNodes,
        graphEdges,
        maxClusters,
      );

      const usedFallback = conceptClusters.length === 0;
      if (usedFallback) {
        conceptClusters = buildJaccardClusters(
          semanticMemories,
          activeLessons,
          maxClusters,
        );
      }

      let newInsights = 0;
      let reinforced = 0;
      let clustersSkipped = 0;
      let totalInsights = 0;

      for (const conceptNames of conceptClusters) {
        if (totalInsights >= maxTotal) break;

        const conceptSet = new Set(conceptNames.map((c) => c.toLowerCase()));

        const clusterFacts = semanticMemories.filter((s) => {
          const factTerms = s.fact.toLowerCase().split(/\s+/);
          return factTerms.some((t) => conceptSet.has(t));
        });

        const clusterLessons = activeLessons.filter((l) =>
          l.tags.some((t) => conceptSet.has(t.toLowerCase())) ||
          conceptNames.some((c) =>
            l.content.toLowerCase().includes(c.toLowerCase()),
          ),
        );

        const clusterCrystals = crystals.filter((c) =>
          (c.lessons || []).some((l) =>
            conceptNames.some((cn) =>
              l.toLowerCase().includes(cn.toLowerCase()),
            ),
          ),
        );

        const totalItems =
          clusterFacts.length + clusterLessons.length + clusterCrystals.length;
        if (totalItems < 3) {
          clustersSkipped++;
          continue;
        }

        const cluster: ConceptCluster = {
          concepts: conceptNames,
          facts: clusterFacts.map((f) => ({
            fact: f.fact,
            confidence: f.confidence,
          })),
          lessons: clusterLessons.map((l) => ({
            content: l.content,
            confidence: l.confidence,
          })),
          crystalNarratives: clusterCrystals.map((c) => c.narrative),
          factIds: clusterFacts.map((f) => f.id),
          lessonIds: clusterLessons.map((l) => l.id),
          crystalIds: clusterCrystals.map((c) => c.id),
        };

        try {
          const prompt = buildReflectPrompt(cluster);
          const response = await summarizeWithOptions(
            provider,
            withOutputLanguagePolicy(REFLECT_SYSTEM, undefined, REFLECT_OUTPUT_CONTRACT),
            prompt,
            data?.model,
            telemetry,
            callIndex++,
          );

          const insightRegex =
            /<insight\s+confidence="([^"]+)"\s+title="([^"]+)">([\s\S]*?)<\/insight>/g;
          let match;
          let clusterCount = 0;

          while (
            (match = insightRegex.exec(response)) !== null &&
            clusterCount < maxInsightsPerCluster &&
            totalInsights < maxTotal
          ) {
            const parsedConf = parseFloat(match[1]);
            const confidence = Number.isNaN(parsedConf)
              ? 0.5
              : Math.max(0, Math.min(1, parsedConf));
            const title = match[2].trim();
            const content = match[3].trim();

            if (!content) continue;

            const fp = fingerprintId("ins", content.trim().toLowerCase());
            const existing = await kv.get<Insight>(KV.insights, fp);

            if (existing && !existing.deleted) {
              reinforceInsight(existing);
              await kv.set(KV.insights, existing.id, existing);
              reinforced++;
            } else {
              const now = new Date().toISOString();
              const insight: Insight = {
                id: fp,
                title,
                content,
                confidence,
                reinforcements: 0,
                sourceConceptCluster: conceptNames,
                sourceMemoryIds: cluster.factIds,
                sourceLessonIds: cluster.lessonIds,
                sourceCrystalIds: cluster.crystalIds,
                project: data?.project,
                tags: conceptNames,
                createdAt: now,
                updatedAt: now,
                decayRate: 0.05,
              };
              await kv.set(KV.insights, insight.id, insight);
              newInsights++;
            }

            clusterCount++;
            totalInsights++;
          }
        } catch (error) {
          if (isProviderPreflightError(error)) {
            const status = providerPreflightStatus(error);
            return { success: false, error: status, status, telemetry: sortProviderCallTelemetry(telemetry) };
          }
          continue;
        }
      }

      try {
        await recordAudit(kv, "reflect", "mem::reflect", [], {
          newInsights,
          reinforced,
          clustersProcessed: conceptClusters.length - clustersSkipped,
          clustersSkipped,
          usedFallback,
        });
      } catch {}

      return {
        success: true,
        newInsights,
        reinforced,
        clustersProcessed: conceptClusters.length - clustersSkipped,
        clustersSkipped,
        usedFallback,
        telemetry: sortProviderCallTelemetry(telemetry),
      };
    },
  );

  sdk.registerFunction("mem::insight-list", 
    async (data: {
      project?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      const limit = data?.limit ?? 50;
      const minConfidence = data?.minConfidence ?? 0;
      let items = await kv.list<Insight>(KV.insights);

      items = items.filter(
        (i) => !i.deleted && i.confidence >= minConfidence,
      );

      if (data?.project) {
        items = items.filter((i) => i.project === data.project);
      }

      items.sort((a, b) => b.confidence - a.confidence);

      return { success: true, insights: items.slice(0, limit) };
    },
  );

  sdk.registerFunction("mem::insight-search", 
    async (data: {
      query: string;
      project?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      if (!data?.query?.trim()) {
        return { success: false, error: "query is required" };
      }

      const query = data.query.toLowerCase();
      const minConfidence = data.minConfidence ?? 0.1;
      const limit = data.limit ?? 10;

      let items = await kv.list<Insight>(KV.insights);
      items = items.filter(
        (i) => !i.deleted && i.confidence >= minConfidence,
      );

      if (data.project) {
        items = items.filter((i) => i.project === data.project);
      }

      const terms = query.split(/\s+/).filter((t) => t.length > 1);
      const scored = items
        .map((i) => {
          const text =
            `${i.title} ${i.content} ${i.tags.join(" ")}`.toLowerCase();
          const matchCount = terms.filter((t) => text.includes(t)).length;
          if (matchCount === 0) return null;

          const relevance = matchCount / terms.length;
          const daysSince = i.lastReinforcedAt
            ? (Date.now() - new Date(i.lastReinforcedAt).getTime()) /
              (1000 * 60 * 60 * 24)
            : (Date.now() - new Date(i.createdAt).getTime()) /
              (1000 * 60 * 60 * 24);
          const recencyBoost = 1 / (1 + daysSince * 0.01);
          const score = i.confidence * relevance * recencyBoost;

          return { insight: i, score };
        })
        .filter(Boolean) as Array<{ insight: Insight; score: number }>;

      scored.sort((a, b) => b.score - a.score);

      try {
        await recordAudit(kv, "insight_search", "mem::insight-search", [], {
          query: data.query,
          resultCount: scored.length,
        });
      } catch {}

      return {
        success: true,
        insights: scored.slice(0, limit).map((s) => ({
          ...s.insight,
          score: Math.round(s.score * 1000) / 1000,
        })),
      };
    },
  );

  sdk.registerFunction("mem::insight-decay-sweep", 
    async () => {
      const items = await kv.list<Insight>(KV.insights);
      let decayed = 0;
      let softDeleted = 0;
      const now = Date.now();
      const timestamp = new Date().toISOString();
      const dirty: Insight[] = [];

      for (const insight of items) {
        if (insight.deleted) continue;

        const baseline =
          insight.lastDecayedAt ||
          insight.lastReinforcedAt ||
          insight.createdAt;
        const weeksSince =
          (now - new Date(baseline).getTime()) / (1000 * 60 * 60 * 24 * 7);

        if (weeksSince < 1) continue;

        const decay = insight.decayRate * weeksSince;
        const newConfidence = Math.max(0.05, insight.confidence - decay);

        if (newConfidence !== insight.confidence) {
          insight.confidence = Math.round(newConfidence * 1000) / 1000;
          insight.lastDecayedAt = timestamp;
          insight.updatedAt = timestamp;

          if (insight.confidence <= 0.1 && insight.reinforcements === 0) {
            insight.deleted = true;
            softDeleted++;
          } else {
            decayed++;
          }

          dirty.push(insight);
        }
      }

      await Promise.all(dirty.map((i) => kv.set(KV.insights, i.id, i)));
      await recordAudit(kv, "reflect", "mem::insight-decay-sweep", dirty.map((i) => i.id), {
        event: "insight.decay",
        decayed,
        softDeleted,
        total: items.length,
        timestamp,
      });

      return { success: true, decayed, softDeleted, total: items.length };
    },
  );
}

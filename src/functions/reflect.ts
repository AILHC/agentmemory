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
  ContributionEffectRef,
  ContributionRecord,
  ReflectInsightBacklogRecord,
  AuditEntry,
  Session,
} from "../types.js";
import {
  AUDIT_ENTRY_CONFLICT,
  AUDIT_ENTRY_MISSING,
  recordAudit,
} from "./audit.js";
import { buildExtractionOperationKey } from "./extraction-operation-receipts.js";
import {
  buildSourceVersionKey,
  claimBatch,
  commitClaimedBatch,
  inspectContributionCandidates,
  markClaimedBatchNoEffect,
  releaseClaimedBatch,
} from "./extraction-contributions.js";
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
  stageContractVersion?: string;
  sourceVersionKeys?: string[];
  itemCount: number;
  charSize: number;
  project?: string;
  isolateReason?: string;
  blockReason?: string;
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
  stageContractVersion?: string;
  sourceVersionKeys?: string[];
  recoveryIdentity?: { runId: string; unitId: string; inputHash: string };
}

export const REFLECT_INSIGHT_CONTRIBUTION_CONTRACT = "reflect_insight/v1";
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
  "reflect_insight_source_version_conflict",
  "reflect_insight_source_drifted_before_commit",
  "reflect_insight_source_correction_requires_migration",
  "reflect_insight_contribution_contract_migration_required",
  "reflect_insight_contribution_reconciliation_required",
  "reflect_insight_terminal_reconciliation_required",
]);

type ReflectSourceType = "semantic" | "lesson" | "crystal";

interface ReflectRecoverySource {
  sourceType: ReflectSourceType;
  sourceId: string;
  stableSourceId: string;
  sourceVersionKey: string;
  snapshotHash: string;
  project?: string;
}

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
  baselineHash?: string;
  expectedEffectHash: string;
}

interface ReflectRecoveryState {
  schema: typeof REFLECT_RECOVERY_SCHEMA;
  identity: { runId: string; unitId: string; inputHash: string };
  phase: "staged" | "committed";
  cluster: ConceptCluster;
  sources: ReflectRecoverySource[];
  project?: string;
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
  noEffectReason?: "no_novel_insight";
  contribution?: {
    stageContractVersion: typeof REFLECT_INSIGHT_CONTRIBUTION_CONTRACT;
    contributionId: string;
    sourceVersionKeys: string[];
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

function reinforceInsight(insight: Insight, timestamp = new Date().toISOString()): void {
  insight.reinforcements++;
  insight.confidence = Math.min(
    1.0,
    insight.confidence + 0.1 * (1 - insight.confidence),
  );
  insight.lastReinforcedAt = timestamp;
  insight.updatedAt = timestamp;
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

type ReflectSourceValue =
  | { sourceType: "semantic"; value: SemanticMemory }
  | { sourceType: "lesson"; value: Lesson }
  | { sourceType: "crystal"; value: Crystal };

function reflectBacklogIndexKey(sourceType: ReflectSourceType, sourceId: string): string {
  return `${sourceType}|${encodeURIComponent(sourceId)}`;
}

function lessonStableSourceId(lesson: Lesson): string {
  const watermarks = lesson.sourceWatermarks ?? {};
  const versionMarker = Object.keys(watermarks).length > 0
    ? stableHash(watermarks)
    : "base";
  return `${lesson.id}@${versionMarker}`;
}

export function buildReflectInsightSourceVersion(source: ReflectSourceValue): {
  sourceType: ReflectSourceType;
  sourceId: string;
  stableSourceId: string;
  snapshot: Record<string, unknown>;
  snapshotHash: string;
  sourceVersionKey: string;
} {
  let stableSourceId: string;
  let snapshot: Record<string, unknown>;
  if (source.sourceType === "semantic") {
    stableSourceId = source.value.id;
    snapshot = {
      id: source.value.id,
      fact: source.value.fact,
      confidence: source.value.confidence,
      sourceSessionIds: [...source.value.sourceSessionIds].sort(),
      sourceMemoryIds: [...source.value.sourceMemoryIds].sort(),
      extractionRunId: source.value.extractionRunId ?? null,
      extractionWindowId: source.value.extractionWindowId ?? null,
      extractionMark: source.value.extractionMark ?? null,
      extractionInputHash: source.value.extractionInputHash ?? null,
      extractionKind: source.value.extractionKind ?? null,
    };
  } else if (source.sourceType === "lesson") {
    stableSourceId = lessonStableSourceId(source.value);
    snapshot = {
      id: source.value.id,
      content: source.value.content,
      context: source.value.context,
      confidence: source.value.confidence,
      reinforcements: source.value.reinforcements,
      source: source.value.source,
      origin: source.value.origin ?? null,
      sourceIds: [...source.value.sourceIds].sort(),
      sourceRunId: source.value.sourceRunId ?? null,
      sourceWatermarks: source.value.sourceWatermarks ?? {},
      project: source.value.project ?? null,
      tags: [...source.value.tags].sort(),
      deleted: source.value.deleted ?? false,
    };
  } else {
    stableSourceId = source.value.id;
    snapshot = {
      id: source.value.id,
      narrative: source.value.narrative,
      keyOutcomes: [...source.value.keyOutcomes],
      filesAffected: [...source.value.filesAffected].sort(),
      lessons: [...source.value.lessons],
      sourceActionIds: [...source.value.sourceActionIds].sort(),
      sessionId: source.value.sessionId ?? null,
      project: source.value.project ?? null,
      createdAt: source.value.createdAt,
    };
  }
  const snapshotHash = stableHash(snapshot);
  return {
    sourceType: source.sourceType,
    sourceId: source.value.id,
    stableSourceId,
    snapshot,
    snapshotHash,
    sourceVersionKey: buildSourceVersionKey(
      "reflect_insight",
      source.sourceType,
      stableSourceId,
      snapshotHash,
    ),
  };
}

async function readReflectSource(
  kv: StateKV,
  sourceType: ReflectSourceType,
  sourceId: string,
): Promise<ReflectSourceValue | null> {
  if (sourceType === "semantic") {
    const value = await kv.get<SemanticMemory>(KV.semantic, sourceId);
    return value ? { sourceType, value } : null;
  }
  if (sourceType === "lesson") {
    const value = await kv.get<Lesson>(KV.lessons, sourceId);
    return value && !value.deleted ? { sourceType, value } : null;
  }
  const value = await kv.get<Crystal>(KV.crystals, sourceId);
  return value ? { sourceType, value } : null;
}

function sourceProject(source: ReflectSourceValue): string | undefined {
  return source.sourceType === "semantic" ? undefined : source.value.project;
}

async function semanticProject(kv: StateKV, memory: SemanticMemory): Promise<string | undefined> {
  if (memory.sourceSessionIds.length === 0) return undefined;
  const sessions = await Promise.all(memory.sourceSessionIds.map((id) => kv.get<Session>(KV.sessions, id)));
  const projects = [...new Set(sessions.filter((item): item is Session => Boolean(item)).map((item) => item.project))];
  return projects.length === 1 ? projects[0] : undefined;
}

function sourceSize(source: ReflectSourceValue): number {
  return source.sourceType === "semantic"
    ? source.value.fact.length
    : source.sourceType === "lesson"
      ? source.value.content.length
      : source.value.narrative.length;
}

async function deleteReflectBacklogRecord(
  kv: StateKV,
  record: Pick<ReflectInsightBacklogRecord, "sourceVersionKey" | "sourceType" | "sourceId">,
): Promise<void> {
  const indexKey = reflectBacklogIndexKey(record.sourceType, record.sourceId);
  const indexed = await kv.get<string>(KV.reflectInsightBacklogSourceIndex, indexKey);
  await kv.delete(KV.reflectInsightBacklog, record.sourceVersionKey);
  if (indexed === record.sourceVersionKey) {
    await kv.delete(KV.reflectInsightBacklogSourceIndex, indexKey);
  }
}

export async function enqueueReflectInsightBacklog(options: {
  kv: StateKV;
  semanticMemoryIds?: string[];
  lessonIds?: string[];
  crystalIds?: string[];
  upstreamReceiptRef?: ContributionEffectRef;
}): Promise<{ success: true; enqueued: string[]; terminal: string[]; ineligible: string[] }> {
  const requested: Array<{ sourceType: ReflectSourceType; sourceId: string }> = [
    ...(options.semanticMemoryIds ?? []).map((sourceId) => ({ sourceType: "semantic" as const, sourceId })),
    ...(options.lessonIds ?? []).map((sourceId) => ({ sourceType: "lesson" as const, sourceId })),
    ...(options.crystalIds ?? []).map((sourceId) => ({ sourceType: "crystal" as const, sourceId })),
  ];
  const requestKeys = requested.map(({ sourceType, sourceId }) => reflectBacklogIndexKey(sourceType, sourceId));
  if (
    requested.some(({ sourceId }) => !sourceId)
    || new Set(requestKeys).size !== requestKeys.length
  ) throw new Error("invalid_reflect_insight_backlog_sources");

  const sources = await Promise.all(requested.map(({ sourceType, sourceId }) =>
    readReflectSource(options.kv, sourceType, sourceId)));
  const enqueued: string[] = [];
  const terminal: string[] = [];
  const ineligible: string[] = [];
  for (let index = 0; index < requested.length; index += 1) {
    const requestedSource = requested[index];
    const source = sources[index];
    const displayKey = `${requestedSource.sourceType}:${requestedSource.sourceId}`;
    if (!source) {
      ineligible.push(displayKey);
      continue;
    }
    const version = buildReflectInsightSourceVersion(source);
    const indexKey = reflectBacklogIndexKey(version.sourceType, version.sourceId);
    const indexedVersionKey = await options.kv.get<string>(
      KV.reflectInsightBacklogSourceIndex,
      indexKey,
    );
    if (indexedVersionKey && indexedVersionKey !== version.sourceVersionKey) {
      const oldContribution = await options.kv.get<ContributionRecord>(
        KV.extractionContributionRecords("reflect_insight", REFLECT_INSIGHT_CONTRIBUTION_CONTRACT),
        indexedVersionKey,
      );
      if (oldContribution?.state === "claimed") {
        throw new Error("reflect_insight_contribution_reconciliation_required");
      }
      await options.kv.delete(KV.reflectInsightBacklog, indexedVersionKey);
    }
    const [candidate] = await inspectContributionCandidates(options.kv, {
      stage: "reflect_insight",
      stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
      sourceVersionKeys: [version.sourceVersionKey],
    });
    if (candidate.state === "terminal") {
      await deleteReflectBacklogRecord(options.kv, {
        sourceVersionKey: version.sourceVersionKey,
        sourceType: version.sourceType,
        sourceId: version.sourceId,
      });
      terminal.push(displayKey);
      continue;
    }
    const existing = await options.kv.get<ReflectInsightBacklogRecord>(
      KV.reflectInsightBacklog,
      version.sourceVersionKey,
    );
    const now = new Date().toISOString();
    const project = source.sourceType === "semantic"
      ? await semanticProject(options.kv, source.value)
      : sourceProject(source);
    const record: ReflectInsightBacklogRecord = {
      sourceVersionKey: version.sourceVersionKey,
      sourceType: version.sourceType,
      sourceId: version.sourceId,
      normalizedContentHash: version.snapshotHash,
      ...(project ? { project } : {}),
      firstWaitingAt: existing?.firstWaitingAt ?? now,
      updatedAt: now,
      ...(options.upstreamReceiptRef
        ? { upstreamReceiptRef: options.upstreamReceiptRef }
        : existing?.upstreamReceiptRef
          ? { upstreamReceiptRef: existing.upstreamReceiptRef }
          : {}),
    };
    await options.kv.set(KV.reflectInsightBacklog, record.sourceVersionKey, record);
    await options.kv.set(KV.reflectInsightBacklogSourceIndex, indexKey, record.sourceVersionKey);
    enqueued.push(displayKey);
  }
  return { success: true, enqueued, terminal, ineligible };
}

export async function planReflectInsightWindows(options: {
  kv: StateKV;
  maxItemsPerWindow?: number;
  charBudget?: number;
  project?: string;
  useGraph?: boolean;
  semanticMemoryIds?: string[];
  lessonIds?: string[];
  crystalIds?: string[];
}): Promise<Record<string, unknown>> {
  if (options.useGraph === true) {
    return { success: false, error: "useGraph:true is not supported for full reflect insight windows" };
  }
  if (
    options.semanticMemoryIds?.length
    || options.lessonIds?.length
    || options.crystalIds?.length
  ) {
    await enqueueReflectInsightBacklog({
      kv: options.kv,
      semanticMemoryIds: options.semanticMemoryIds,
      lessonIds: options.lessonIds,
      crystalIds: options.crystalIds,
    });
  }
  const backlog = (await options.kv.list<ReflectInsightBacklogRecord>(KV.reflectInsightBacklog))
    .filter((record) => !options.project || !record.project || record.project === options.project)
    .sort((left, right) => left.firstWaitingAt.localeCompare(right.firstWaitingAt)
      || left.sourceVersionKey.localeCompare(right.sourceVersionKey));
  const sources = await Promise.all(backlog.map((record) =>
    readReflectSource(options.kv, record.sourceType, record.sourceId)));
  const valid: Array<{
    record: ReflectInsightBacklogRecord;
    source: ReflectSourceValue;
  }> = [];
  const exceptional: ReflectInsightWindow[] = [];
  for (let index = 0; index < backlog.length; index += 1) {
    const record = backlog[index];
    const source = sources[index];
    if (!source) {
      await deleteReflectBacklogRecord(options.kv, record);
      continue;
    }
    const version = buildReflectInsightSourceVersion(source);
    if (
      version.sourceVersionKey !== record.sourceVersionKey
      || version.snapshotHash !== record.normalizedContentHash
    ) {
      try {
        await enqueueReflectInsightBacklog({
          kv: options.kv,
          ...(record.sourceType === "semantic" ? { semanticMemoryIds: [record.sourceId] } : {}),
          ...(record.sourceType === "lesson" ? { lessonIds: [record.sourceId] } : {}),
          ...(record.sourceType === "crystal" ? { crystalIds: [record.sourceId] } : {}),
        });
        const replacementKey = await options.kv.get<string>(
          KV.reflectInsightBacklogSourceIndex,
          reflectBacklogIndexKey(record.sourceType, record.sourceId),
        );
        const replacement = replacementKey
          ? await options.kv.get<ReflectInsightBacklogRecord>(KV.reflectInsightBacklog, replacementKey)
          : null;
        if (replacement?.sourceVersionKey === version.sourceVersionKey) {
          valid.push({ record: replacement, source });
        }
      } catch (error) {
        if (error instanceof Error && error.message === "reflect_insight_contribution_reconciliation_required") {
          exceptional.push({
            windowId: `reflect:${fingerprintId("riw", record.sourceVersionKey)}`,
            semanticMemoryIds: record.sourceType === "semantic" ? [record.sourceId] : [],
            lessonIds: record.sourceType === "lesson" ? [record.sourceId] : [],
            crystalIds: record.sourceType === "crystal" ? [record.sourceId] : [],
            stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
            sourceVersionKeys: [record.sourceVersionKey],
            itemCount: 1,
            charSize: sourceSize(source),
            ...(record.project ? { project: record.project } : {}),
            blockReason: error.message,
          });
          continue;
        }
        throw error;
      }
      continue;
    }
    valid.push({ record, source });
  }

  const candidates = valid.length > 0
    ? await inspectContributionCandidates(options.kv, {
        stage: "reflect_insight",
        stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
        sourceVersionKeys: valid.map(({ record }) => record.sourceVersionKey),
      })
    : [];
  const eligible: typeof valid = [];
  for (let index = 0; index < valid.length; index += 1) {
    const item = valid[index];
    const candidate = candidates[index];
    if (candidate.state === "terminal") {
      await deleteReflectBacklogRecord(options.kv, item.record);
      continue;
    }
    if (candidate.state === "eligible") {
      eligible.push(item);
      continue;
    }
    const reason = candidate.state === "source_correction_requires_migration"
      ? "reflect_insight_source_correction_requires_migration"
      : "reflect_insight_contribution_reconciliation_required";
    exceptional.push({
      windowId: `reflect:${fingerprintId("riw", candidate.sourceVersionKey)}`,
      semanticMemoryIds: item.record.sourceType === "semantic" ? [item.record.sourceId] : [],
      lessonIds: item.record.sourceType === "lesson" ? [item.record.sourceId] : [],
      crystalIds: item.record.sourceType === "crystal" ? [item.record.sourceId] : [],
      stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
      sourceVersionKeys: [item.record.sourceVersionKey],
      itemCount: 1,
      charSize: sourceSize(item.source),
      ...(item.record.project ? { project: item.record.project } : {}),
      ...(candidate.state === "source_correction_requires_migration"
        ? { isolateReason: reason }
        : { blockReason: reason }),
    });
  }

  const maxItems = Math.max(3, options.maxItemsPerWindow ?? 30);
  const charBudget = Math.max(1, options.charBudget ?? 64_000);
  const byProject = new Map<string, typeof valid>();
  for (const item of eligible) {
    const project = item.record.project ?? "";
    const group = byProject.get(project) ?? [];
    group.push(item);
    byProject.set(project, group);
  }
  const windows: ReflectInsightWindow[] = [];
  for (const [project, items] of [...byProject.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    let current: typeof valid = [];
    let currentChars = 0;
    const flush = () => {
      if (current.length < 3) return;
      const sourceVersionKeys = current.map(({ record }) => record.sourceVersionKey);
      windows.push({
        windowId: `reflect:${fingerprintId("riw", stableHash(sourceVersionKeys))}`,
        semanticMemoryIds: current
          .filter(({ record }) => record.sourceType === "semantic")
          .map(({ record }) => record.sourceId),
        lessonIds: current
          .filter(({ record }) => record.sourceType === "lesson")
          .map(({ record }) => record.sourceId),
        crystalIds: current
          .filter(({ record }) => record.sourceType === "crystal")
          .map(({ record }) => record.sourceId),
        stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
        sourceVersionKeys,
        itemCount: current.length,
        charSize: currentChars,
        ...(project ? { project } : {}),
      });
      current = [];
      currentChars = 0;
    };
    for (const item of items) {
      const size = sourceSize(item.source);
      const wouldExceedItems = current.length >= maxItems;
      const wouldExceedChars = current.length > 0 && currentChars + size > charBudget;
      if (wouldExceedItems || wouldExceedChars) {
        if (current.length >= 3) flush();
      }
      current.push(item);
      currentChars += size;
    }
    flush();
  }
  return {
    success: true,
    windows: [...exceptional, ...windows],
    totalItems: valid.length,
    ...((windows.length === 0 && exceptional.length === 0)
      ? { reason: "fewer than 3 unconsumed supporting items" }
      : {}),
  };
}

async function loadReflectWindowInput(
  options: ReflectInsightWindowOptions,
): Promise<{ cluster: ConceptCluster; sources: ReflectRecoverySource[] }> {
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
  const cluster: ConceptCluster = {
    concepts: concepts.length > 0 ? concepts : ["reflect-full-window"],
    facts: facts.map((f) => ({ fact: f.fact, confidence: f.confidence })),
    lessons: activeLessons.map((l) => ({ content: l.content, confidence: l.confidence })),
    crystalNarratives: activeCrystals.map((c) => c.narrative),
    factIds: facts.map((f) => f.id),
    lessonIds: activeLessons.map((l) => l.id),
    crystalIds: activeCrystals.map((c) => c.id),
  };
  const sourceValues: ReflectSourceValue[] = [
    ...facts.map((value) => ({ sourceType: "semantic" as const, value })),
    ...activeLessons.map((value) => ({ sourceType: "lesson" as const, value })),
    ...activeCrystals.map((value) => ({ sourceType: "crystal" as const, value })),
  ];
  return {
    cluster,
    sources: sourceValues.map((source) => {
      const version = buildReflectInsightSourceVersion(source);
      return {
        sourceType: version.sourceType,
        sourceId: version.sourceId,
        stableSourceId: version.stableSourceId,
        sourceVersionKey: version.sourceVersionKey,
        snapshotHash: version.snapshotHash,
        ...(sourceProject(source) ? { project: sourceProject(source) } : {}),
      };
    }),
  };
}

export function parseReflectInsightResponse(response: string, maxInsights: number): {
  items: Array<{
  id: string;
  title: string;
  content: string;
  confidence: number;
  }>;
  noEffectReason?: "no_novel_insight";
} {
  const root = /^<insights>([\s\S]*)<\/insights>$/.exec(response.trim());
  if (!root) throw new Error("reflect_insight_response_parse_failure");
  if (root[1].trim() === "") return { items: [], noEffectReason: "no_novel_insight" };
  const insightRegex = /<insight confidence="([^"]+)" title="([^"]+)">([\s\S]*?)<\/insight>/g;
  const items: Array<{ id: string; title: string; content: string; confidence: number }> = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = insightRegex.exec(root[1])) !== null) {
    if (root[1].slice(cursor, match.index).trim() !== "") {
      throw new Error("reflect_insight_response_parse_failure");
    }
    const content = match[3].trim();
    const title = match[2].trim();
    const parsedConfidence = parseFloat(match[1]);
    if (
      !content
      || !title
      || !Number.isFinite(parsedConfidence)
      || parsedConfidence < 0
      || parsedConfidence > 1
    ) throw new Error("reflect_insight_response_parse_failure");
    if (items.length < maxInsights) {
      items.push({
        id: fingerprintId("ins", content.toLowerCase()),
        title,
        content,
        confidence: parsedConfidence,
      });
    }
    cursor = match.index + match[0].length;
  }
  if (items.length === 0 || root[1].slice(cursor).trim() !== "") {
    throw new Error("reflect_insight_response_parse_failure");
  }
  return { items };
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

async function requireReflectRecoveryReceipt(
  kv: StateKV,
  identity: NonNullable<ReflectInsightWindowOptions["recoveryIdentity"]>,
): Promise<ReflectRecoveryReceipt> {
  const key = recoveryReceiptKey(identity);
  const receipt = await kv.get<ReflectRecoveryReceipt>(KV.extractionOperationReceipt(key), key);
  if (
    !receipt
    || receipt.status !== "running"
    || receipt.stage !== "reflect_insight"
    || receipt.runId !== identity.runId
    || receipt.unitId !== identity.unitId
    || receipt.inputHash !== identity.inputHash
  ) throw new Error("reflect_insight_recovery_receipt_unavailable");
  return receipt;
}

async function reflectSourcesStillMatch(
  kv: StateKV,
  sources: ReflectRecoverySource[],
): Promise<boolean> {
  const current = await Promise.all(sources.map((source) =>
    readReflectSource(kv, source.sourceType, source.sourceId)));
  return current.every((value, index) => {
    if (!value) return false;
    const version = buildReflectInsightSourceVersion(value);
    return version.stableSourceId === sources[index].stableSourceId
      && version.sourceVersionKey === sources[index].sourceVersionKey
      && version.snapshotHash === sources[index].snapshotHash;
  });
}

async function discardStagedReflectRecovery(
  kv: StateKV,
  identity: NonNullable<ReflectInsightWindowOptions["recoveryIdentity"]>,
): Promise<void> {
  const key = recoveryReceiptKey(identity);
  const receipt = await kv.get<ReflectRecoveryReceipt>(KV.extractionOperationReceipt(key), key);
  if (!receipt?.reflectRecovery) return;
  if (
    receipt.status !== "running"
    || receipt.reflectRecovery.phase !== "staged"
    || !sameRecoveryIdentity(receipt.reflectRecovery.identity, identity)
  ) throw new Error("reflect_insight_contribution_reconciliation_required");
  const { reflectRecovery: _reflectRecovery, ...withoutRecovery } = receipt;
  await kv.set(KV.extractionOperationReceipt(key), key, withoutRecovery);
}

async function enqueueCurrentReflectSources(
  kv: StateKV,
  sources: ReflectRecoverySource[],
): Promise<void> {
  const current = await Promise.all(sources.map((source) =>
    readReflectSource(kv, source.sourceType, source.sourceId)));
  await Promise.all(sources.map((source, index) => current[index]
    ? Promise.resolve()
    : deleteReflectBacklogRecord(kv, {
        sourceVersionKey: source.sourceVersionKey,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
      })));
  const semanticMemoryIds = sources
    .filter((source, index) => current[index] && source.sourceType === "semantic")
    .map((source) => source.sourceId);
  const lessonIds = sources
    .filter((source, index) => current[index] && source.sourceType === "lesson")
    .map((source) => source.sourceId);
  const crystalIds = sources
    .filter((source, index) => current[index] && source.sourceType === "crystal")
    .map((source) => source.sourceId);
  await enqueueReflectInsightBacklog({ kv, semanticMemoryIds, lessonIds, crystalIds });
}

async function replaceDriftedReflectSources(options: {
  kv: StateKV;
  identity: NonNullable<ReflectInsightWindowOptions["recoveryIdentity"]>;
  sources: ReflectRecoverySource[];
  claimedContribution?: { contributionId: string; sourceVersionKeys: string[] } | null;
  staged: boolean;
}): Promise<void> {
  if (options.staged) {
    await discardStagedReflectRecovery(options.kv, options.identity);
  }
  if (options.claimedContribution) {
    await releaseClaimedBatch(options.kv, {
      stage: "reflect_insight",
      stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
      contributionId: options.claimedContribution.contributionId,
      sourceVersionKeys: options.claimedContribution.sourceVersionKeys,
    });
  }
  await enqueueCurrentReflectSources(options.kv, options.sources);
}

function expectedReflectInsight(options: {
  existing: RecoverableInsight | null;
  item: { id: string; title: string; content: string; confidence: number };
  cluster: ConceptCluster;
  project?: string;
  mutationSource: string;
  mutationId: string;
  timestamp: string;
}): RecoverableInsight {
  if (!options.existing || options.existing.deleted) {
    return {
      id: options.item.id,
      title: options.item.title,
      content: options.item.content,
      confidence: options.item.confidence,
      reinforcements: 0,
      sourceConceptCluster: [...options.cluster.concepts],
      sourceMemoryIds: [...options.cluster.factIds],
      sourceLessonIds: [...options.cluster.lessonIds],
      sourceCrystalIds: [...options.cluster.crystalIds],
      project: options.project,
      tags: [...options.cluster.concepts],
      createdAt: options.timestamp,
      updatedAt: options.timestamp,
      decayRate: 0.05,
      sourceMutationWatermarks: { [options.mutationSource]: options.mutationId },
    };
  }
  const expected: RecoverableInsight = {
    ...options.existing,
    sourceConceptCluster: [...new Set([
      ...options.existing.sourceConceptCluster,
      ...options.cluster.concepts,
    ])],
    sourceMemoryIds: [...new Set([
      ...options.existing.sourceMemoryIds,
      ...options.cluster.factIds,
    ])],
    sourceLessonIds: [...new Set([
      ...options.existing.sourceLessonIds,
      ...options.cluster.lessonIds,
    ])],
    sourceCrystalIds: [...new Set([
      ...options.existing.sourceCrystalIds,
      ...options.cluster.crystalIds,
    ])],
    tags: [...new Set([...options.existing.tags, ...options.cluster.concepts])],
    sourceMutationWatermarks: {
      ...options.existing.sourceMutationWatermarks,
      [options.mutationSource]: options.mutationId,
    },
  };
  reinforceInsight(expected, options.timestamp);
  return expected;
}

async function stageReflectRecovery(options: {
  kv: StateKV;
  identity: NonNullable<ReflectInsightWindowOptions["recoveryIdentity"]>;
  cluster: ConceptCluster;
  sources: ReflectRecoverySource[];
  response: string;
  totalItems: number;
  promptChars: number;
  telemetry: ProviderCallTelemetry[];
  metadata: Record<string, unknown>;
  maxInsights: number;
  project?: string;
  contribution?: NonNullable<ReflectRecoveryState["contribution"]>;
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
  const parsed = parseReflectInsightResponse(options.response, options.maxInsights);
  const mutationSource = mutationSourceForIdentity(options.identity);
  const items = await Promise.all(parsed.items.map(async (item): Promise<ReflectRecoveryItem> => {
      const existingInsight = await options.kv.get<RecoverableInsight>(KV.insights, item.id);
      const mutationId = fingerprintId("rimm", JSON.stringify([
        mutationSource,
        item.id,
        stableHash({ title: item.title, content: item.content, confidence: item.confidence }),
      ]));
      const expected = expectedReflectInsight({
        existing: existingInsight,
        item,
        cluster: options.cluster,
        project: options.project,
        mutationSource,
        mutationId,
        timestamp: receipt.startedAt,
      });
      return {
        ...item,
        action: existingInsight && !existingInsight.deleted ? "reinforce" : "create",
        mutationId,
        ...(existingInsight ? { baselineHash: stableHash(existingInsight) } : {}),
        expectedEffectHash: stableHash(expected),
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
    sources: options.sources,
    ...(options.project ? { project: options.project } : {}),
    items,
    totalItems: options.totalItems,
    promptChars: options.promptChars,
    model: {
      responseHash: stableHash(options.response),
      response: options.response,
      telemetry: [...options.telemetry],
      metadata: options.metadata,
    },
    ...(parsed.noEffectReason ? { noEffectReason: parsed.noEffectReason } : {}),
    ...(options.contribution ? { contribution: options.contribution } : {}),
  };
  const staged = { ...receipt, reflectRecovery: recovery };
  await options.kv.set(KV.extractionOperationReceipt(key), key, staged);
  return { receipt: staged, recovery };
}

function mutationSourceForIdentity(identity: ReflectRecoveryState["identity"]): string {
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
      sources: recovery.sources,
      modelResponseHash: recovery.model.responseHash,
      items: recovery.items.map((item) => [item.id, item.mutationId, item.expectedEffectHash]),
      result,
    }),
    identity: recovery.identity,
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
  const source = mutationSourceForIdentity(options.recovery.identity);
  for (const item of options.recovery.items) {
    const existing = await options.kv.get<RecoverableInsight>(KV.insights, item.id);
    const watermark = existing?.sourceMutationWatermarks?.[source];
    if (verifyingCommitted) {
      if (
        !existing
        || watermark !== item.mutationId
        || stableHash(existing) !== item.expectedEffectHash
      ) {
        throw new Error("reflect_insight_source_mutation_conflict");
      }
      continue;
    }
    if (watermark === item.mutationId) {
      if (!existing || stableHash(existing) !== item.expectedEffectHash) {
        throw new Error("reflect_insight_source_mutation_conflict");
      }
      continue;
    }
    if (watermark !== undefined) throw new Error("reflect_insight_source_mutation_conflict");
    if (
      (existing
        ? item.baselineHash !== stableHash(existing)
        : item.baselineHash !== undefined)
      || (item.action === "reinforce" && (!existing || existing.deleted))
      || (item.action === "create" && Boolean(existing && !existing.deleted))
    ) throw new Error("reflect_insight_source_mutation_conflict");
    const expected = expectedReflectInsight({
      existing,
      item,
      cluster: options.recovery.cluster,
      project: options.project ?? options.recovery.project,
      mutationSource: source,
      mutationId: item.mutationId,
      timestamp: options.receipt.startedAt,
    });
    if (stableHash(expected) !== item.expectedEffectHash) {
      throw new Error("reflect_insight_source_mutation_conflict");
    }
    await options.kv.set(KV.insights, expected.id, expected);
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

function reflectNoEffectProof(recovery: ReflectRecoveryState): {
  schema: "reflect-insight-no-effect/v1";
  proposalHash: string;
  reasonCode: "no_novel_insight";
  proofHash: string;
} {
  const proposalHash = stableHash({
    identity: recovery.identity,
    sources: recovery.sources,
    responseHash: recovery.model.responseHash,
  });
  return {
    schema: "reflect-insight-no-effect/v1",
    proposalHash,
    reasonCode: "no_novel_insight",
    proofHash: stableHash({
      schema: "reflect-insight-no-effect/v1",
      proposalHash,
      reasonCode: "no_novel_insight",
    }),
  };
}

function reflectNoEffectEvidence(
  receipt: ReflectRecoveryReceipt,
  recovery: ReflectRecoveryState,
): Record<string, unknown> {
  const proof = reflectNoEffectProof(recovery);
  return {
    kind: "no_effect",
    observation: "business_empty",
    reasonCode: proof.reasonCode,
    identity: recovery.identity,
    proof: {
      kind: "committed_structured_no_effect",
      receiptKey: receipt.key,
      receiptVersion: receipt.version ?? 1,
      ...proof,
    },
  };
}

function reflectContributionFailure(cause: string): Record<string, unknown> {
  return { success: false, status: "failed", failure: { class: "hard", cause } };
}

function sameReflectEffectRefs(
  left: ContributionEffectRef[] | undefined,
  right: ContributionEffectRef[],
): boolean {
  return stableHash(left ?? []) === stableHash(right);
}

async function readReflectContributionEffectRefs(
  kv: StateKV,
  receipt: ReflectRecoveryReceipt,
  recovery: ReflectRecoveryState,
): Promise<ContributionEffectRef[] | null> {
  const committed = await commitReflectRecovery({ kv, receipt, recovery });
  if (committed.phase !== "committed" || !committed.result) return null;
  const audit = await kv.get<AuditEntry>(KV.audit, committed.result.auditId);
  if (!audit) return null;
  const source = mutationSourceForIdentity(committed.identity);
  const insightRefs = await Promise.all(committed.items.map(async (item) => {
    const insight = await kv.get<RecoverableInsight>(KV.insights, item.id);
    if (
      insight?.sourceMutationWatermarks?.[source] !== item.mutationId
      || stableHash(insight) !== item.expectedEffectHash
    ) return null;
    return {
      scope: KV.insights,
      key: item.id,
      effectHash: stableHash(insight),
    } satisfies ContributionEffectRef;
  }));
  if (insightRefs.some((item) => !item)) return null;
  return [
    ...insightRefs.filter((item): item is ContributionEffectRef => Boolean(item)),
    { scope: KV.audit, key: audit.id, effectHash: stableHash(audit) },
  ];
}

async function readVerifiedReflectReceiptAndEffects(options: {
  kv: StateKV;
  operationReceiptRef: ContributionEffectRef;
  expectedSourceVersionKeys: string[];
}): Promise<{
  receipt: ReflectRecoveryReceipt;
  recovery: ReflectRecoveryState;
  effectRefs: ContributionEffectRef[];
  noEffect: boolean;
} | null> {
  const receipt = await options.kv.get<ReflectRecoveryReceipt>(
    options.operationReceiptRef.scope,
    options.operationReceiptRef.key,
  );
  const recovery = receipt?.reflectRecovery;
  if (
    !receipt
    || !recovery
    || options.operationReceiptRef.scope !== KV.extractionOperationReceipt(receipt.key)
    || options.operationReceiptRef.key !== receipt.key
    || receipt.key !== recoveryReceiptKey(recovery.identity)
    || receipt.version !== 1
    || receipt.status !== "succeeded"
    || recovery.schema !== REFLECT_RECOVERY_SCHEMA
    || recovery.phase !== "committed"
    || !recovery.result
    || !recovery.contribution
    || recovery.contribution.stageContractVersion !== REFLECT_INSIGHT_CONTRIBUTION_CONTRACT
    || stableHash([...recovery.contribution.sourceVersionKeys].sort())
      !== stableHash([...options.expectedSourceVersionKeys].sort())
    || stableHash(recovery.sources.map((source) => source.sourceVersionKey).sort())
      !== stableHash([...options.expectedSourceVersionKeys].sort())
  ) return null;
  const response = receipt.response as Record<string, unknown> | undefined;
  const noEffect = recovery.items.length === 0 && recovery.noEffectReason === "no_novel_insight";
  if (
    response?.success !== true
    || response.inputHash !== recovery.identity.inputHash
    || stableHash(response.insightIds) !== stableHash(recovery.result.insightIds)
    || (noEffect
      ? response.status !== "skipped"
        || stableHash(response.reflectRecoveryEvidence)
          !== stableHash(reflectNoEffectEvidence(receipt, recovery))
      : response.status !== "succeeded"
        || stableHash(response.reflectRecoveryEvidence)
          !== stableHash(recoveryResultEvidence(receipt, recovery)))
  ) return null;
  const effectRefs = await readReflectContributionEffectRefs(options.kv, receipt, recovery);
  if (!effectRefs) return null;
  return { receipt, recovery, effectRefs, noEffect };
}

async function verifyTerminalReflectContribution(options: {
  kv: StateKV;
  sourceVersionKeys: string[];
  records: ContributionRecord[];
}): Promise<Record<string, unknown>> {
  const expectedKeys = [...options.sourceVersionKeys].sort();
  const records = [...options.records].sort((left, right) =>
    left.sourceVersionKey.localeCompare(right.sourceVersionKey));
  const first = records[0];
  if (
    !first
    || records.length !== expectedKeys.length
    || records.some((record, index) =>
      record.stage !== "reflect_insight"
      || record.stageContractVersion !== REFLECT_INSIGHT_CONTRIBUTION_CONTRACT
      || record.sourceVersionKey !== expectedKeys[index]
      || (record.state !== "committed" && record.state !== "no_effect")
      || record.state !== first.state
      || record.contributionId !== first.contributionId
      || record.runId !== first.runId
      || record.unitId !== first.unitId
      || record.operationReceiptRef?.scope !== first.operationReceiptRef?.scope
      || record.operationReceiptRef?.key !== first.operationReceiptRef?.key
      || !sameReflectEffectRefs(record.effectRefs, first.effectRefs ?? []))
    || !first.operationReceiptRef
  ) return reflectContributionFailure("reflect_insight_terminal_reconciliation_required");
  const verified = await readVerifiedReflectReceiptAndEffects({
    kv: options.kv,
    operationReceiptRef: first.operationReceiptRef,
    expectedSourceVersionKeys: expectedKeys,
  });
  if (
    !verified
    || verified.noEffect !== (first.state === "no_effect")
    || (first.state === "committed" && !sameReflectEffectRefs(first.effectRefs, verified.effectRefs))
    || (first.state === "no_effect" && (first.effectRefs?.length ?? 0) !== 0)
  ) return reflectContributionFailure("reflect_insight_terminal_reconciliation_required");
  return verified.receipt.response
    ?? reflectContributionFailure("reflect_insight_terminal_reconciliation_required");
}

export async function reconcileReflectInsightContribution(options: {
  kv: StateKV;
  identity: { runId: string; stage: "reflect_insight"; unitId: string; inputHash: string };
  sourceVersionKeys: string[];
  operationReceiptRef: ContributionEffectRef;
}): Promise<Record<string, unknown>> {
  try {
    const sourceVersionKeys = [...options.sourceVersionKeys].sort();
    const scope = KV.extractionContributionRecords(
      "reflect_insight",
      REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
    );
    const records = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      options.kv.get<ContributionRecord>(scope, sourceVersionKey)));
    if (records.some((record) => !record)) {
      return reflectContributionFailure("reflect_insight_contribution_reconciliation_required");
    }
    const claimed = records as ContributionRecord[];
    const first = claimed[0];
    if (
      !first
      || claimed.some((record) =>
        record.contributionId !== first.contributionId
        || record.runId !== options.identity.runId
        || record.unitId !== options.identity.unitId
        || (record.state !== "claimed" && record.state !== "committed" && record.state !== "no_effect"))
    ) return reflectContributionFailure("reflect_insight_contribution_reconciliation_required");
    if (claimed.every((record) => record.state === "committed" || record.state === "no_effect")) {
      return verifyTerminalReflectContribution({ kv: options.kv, sourceVersionKeys, records: claimed });
    }
    const verified = await readVerifiedReflectReceiptAndEffects({
      kv: options.kv,
      operationReceiptRef: options.operationReceiptRef,
      expectedSourceVersionKeys: sourceVersionKeys,
    });
    if (!verified || verified.recovery.contribution?.contributionId !== first.contributionId) {
      return reflectContributionFailure("reflect_insight_contribution_reconciliation_required");
    }
    if (verified.noEffect) {
      await markClaimedBatchNoEffect(options.kv, {
        stage: "reflect_insight",
        stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
        contributionId: first.contributionId,
        sourceVersionKeys,
        operationReceiptRef: options.operationReceiptRef,
        receiptKey: options.operationReceiptRef.key,
        reasonCode: "no_novel_insight",
      });
    } else {
      await commitClaimedBatch(options.kv, {
        stage: "reflect_insight",
        stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
        contributionId: first.contributionId,
        sourceVersionKeys,
        operationReceiptRef: options.operationReceiptRef,
        effectRefs: verified.effectRefs,
      });
    }
    await Promise.all(verified.recovery.sources.map((source) =>
      deleteReflectBacklogRecord(options.kv, {
        sourceVersionKey: source.sourceVersionKey,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
      })));
    const committed = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      options.kv.get<ContributionRecord>(scope, sourceVersionKey)));
    return verifyTerminalReflectContribution({
      kv: options.kv,
      sourceVersionKeys,
      records: committed.filter((record): record is ContributionRecord => Boolean(record)),
    });
  } catch {
    return reflectContributionFailure("reflect_insight_contribution_reconciliation_required");
  }
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

async function loadRelevantExistingInsights(options: {
  kv: StateKV;
  cluster: ConceptCluster;
  project?: string;
}): Promise<Insight[]> {
  const terms = new Set([
    ...options.cluster.concepts,
    ...options.cluster.facts.flatMap((item) => item.fact.toLowerCase().split(/\s+/)),
    ...options.cluster.lessons.flatMap((item) => item.content.toLowerCase().split(/\s+/)),
  ].map((term) => term.toLowerCase()).filter((term) => term.length > 2));
  return (await options.kv.list<Insight>(KV.insights))
    .filter((insight) => !insight.deleted && (!options.project || insight.project === options.project))
    .map((insight) => {
      const text = `${insight.title} ${insight.content} ${insight.tags.join(" ")}`.toLowerCase();
      return {
        insight,
        relevance: [...terms].filter((term) => text.includes(term)).length,
      };
    })
    .filter(({ relevance }) => relevance > 0)
    .sort((left, right) => right.relevance - left.relevance
      || right.insight.confidence - left.insight.confidence
      || left.insight.id.localeCompare(right.insight.id))
    .slice(0, 20)
    .map(({ insight }) => insight);
}

export async function runReflectInsightWindow(
  options: ReflectInsightWindowOptions,
): Promise<Record<string, unknown>> {
  if (options.stageContractVersion === undefined && options.sourceVersionKeys === undefined) {
    return runReflectInsightWindowLegacy(options);
  }
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
  let claimedContribution: {
    contributionId: string;
    sourceVersionKeys: string[];
  } | null = null;
  const recoveryResponse = (
    receipt: ReflectRecoveryReceipt,
    committed: ReflectRecoveryState,
  ): Record<string, unknown> => {
    const persisted = committed.result!;
    const noEffect = committed.items.length === 0
      && committed.noEffectReason === "no_novel_insight";
    return {
      success: true,
      newInsights: persisted.newInsights,
      reinforced: persisted.reinforced,
      totalInsights: persisted.totalInsights,
      insightIds: persisted.insightIds,
      inputHash: committed.identity.inputHash,
      totalItems: committed.totalItems,
      usedFallback: true,
      ...committed.model.metadata,
      status: noEffect ? "skipped" : "succeeded",
      ...(noEffect ? { skipped: true, reason: "no novel insight" } : {}),
      promptChars: committed.promptChars,
      telemetry: committed.model.telemetry,
      parseFailures: 0,
      reflectRecoveryEvidence: noEffect
        ? reflectNoEffectEvidence(receipt, committed)
        : recoveryResultEvidence(receipt, committed),
    };
  };
  if (options.useGraph === true) {
    return {
      success: false,
      error: "useGraph:true is not supported for full reflect insight windows",
      ...responseMetadata("failed"),
    };
  }
  try {
    const identity = options.recoveryIdentity;
    const sourceVersionKeys = options.sourceVersionKeys;
    if (
      !identity
      || options.stageContractVersion !== REFLECT_INSIGHT_CONTRIBUTION_CONTRACT
      || !sourceVersionKeys
      || sourceVersionKeys.length < 3
      || new Set(sourceVersionKeys).size !== sourceVersionKeys.length
    ) return reflectContributionFailure("reflect_insight_source_version_conflict");

    const recovered = await readReflectRecovery(options.kv, identity);
    if (recovered) {
      const contribution = recovered.recovery.contribution;
      if (
        !contribution
        || contribution.stageContractVersion !== REFLECT_INSIGHT_CONTRIBUTION_CONTRACT
        || stableHash([...contribution.sourceVersionKeys].sort())
          !== stableHash([...sourceVersionKeys].sort())
      ) return reflectContributionFailure("reflect_insight_recovery_identity_conflict");
      if (
        recovered.recovery.phase === "staged"
        && !await reflectSourcesStillMatch(options.kv, recovered.recovery.sources)
      ) {
        await replaceDriftedReflectSources({
          kv: options.kv,
          identity,
          sources: recovered.recovery.sources,
          claimedContribution: {
            contributionId: contribution.contributionId,
            sourceVersionKeys: contribution.sourceVersionKeys,
          },
          staged: true,
        });
        return reflectContributionFailure("reflect_insight_source_drifted_before_commit");
      }
      const committed = await commitReflectRecovery({
        kv: options.kv,
        receipt: recovered.receipt,
        recovery: recovered.recovery,
        project: options.project,
      });
      return recoveryResponse(recovered.receipt, committed);
    }
    if (!options.provider?.summarize) {
      return { success: false, error: "provider.summarize is required", ...responseMetadata("failed") };
    }

    const requestedIds = [
      ...(options.semanticMemoryIds ?? []),
      ...(options.lessonIds ?? []),
      ...(options.crystalIds ?? []),
    ];
    if (
      requestedIds.length < 3
      || requestedIds.length !== sourceVersionKeys.length
      || new Set(requestedIds).size !== requestedIds.length
    ) return reflectContributionFailure("reflect_insight_source_version_conflict");
    const { cluster, sources } = await loadReflectWindowInput(options);
    if (
      sources.length !== requestedIds.length
      || stableHash(sources.map((source) => source.sourceVersionKey).sort())
        !== stableHash([...sourceVersionKeys].sort())
    ) {
      await enqueueReflectInsightBacklog({
        kv: options.kv,
        semanticMemoryIds: options.semanticMemoryIds,
        lessonIds: options.lessonIds,
        crystalIds: options.crystalIds,
      });
      return reflectContributionFailure("reflect_insight_source_drifted_before_commit");
    }
    const totalItems = cluster.facts.length + cluster.lessons.length + cluster.crystalNarratives.length;
    if (totalItems < 3) {
      return reflectContributionFailure("reflect_insight_source_version_conflict");
    }

    const existingInsights = await loadRelevantExistingInsights({
      kv: options.kv,
      cluster,
      project: options.project,
    });
    const prompt = buildReflectPrompt(cluster, existingInsights);
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

    const contribution = await claimBatch(options.kv, {
      stage: "reflect_insight",
      stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
      runId: identity.runId,
      unitId: identity.unitId,
      sourceVersionKeys,
    });
    if (contribution.status === "already_committed") {
      return verifyTerminalReflectContribution({
        kv: options.kv,
        sourceVersionKeys,
        records: contribution.records,
      });
    }
    if (contribution.status !== "claimed") {
      const cause = contribution.status === "contract_migration_required"
        ? "reflect_insight_contribution_contract_migration_required"
        : contribution.status === "source_correction_requires_migration"
          ? "reflect_insight_source_correction_requires_migration"
          : "reflect_insight_contribution_reconciliation_required";
      return reflectContributionFailure(cause);
    }
    claimedContribution = {
      contributionId: contribution.records[0]!.contributionId,
      sourceVersionKeys,
    };
    if (!await reflectSourcesStillMatch(options.kv, sources)) {
      await replaceDriftedReflectSources({
        kv: options.kv,
        identity,
        sources,
        claimedContribution,
        staged: false,
      });
      claimedContribution = null;
      return reflectContributionFailure("reflect_insight_source_drifted_before_commit");
    }

    await requireReflectRecoveryReceipt(options.kv, identity);
    const response = await summarizeWithOptions(
      options.provider,
      withOutputLanguagePolicy(REFLECT_SYSTEM, undefined, REFLECT_OUTPUT_CONTRACT),
      prompt,
      options.model,
      telemetry,
      0,
    );
    if (!await reflectSourcesStillMatch(options.kv, sources)) {
      await replaceDriftedReflectSources({
        kv: options.kv,
        identity,
        sources,
        claimedContribution,
        staged: false,
      });
      claimedContribution = null;
      return reflectContributionFailure("reflect_insight_source_drifted_before_commit");
    }
    const staged = await stageReflectRecovery({
      kv: options.kv,
      identity,
      cluster,
      sources,
      response,
      totalItems,
      promptChars: prompt.length,
      telemetry: sortProviderCallTelemetry(telemetry),
      metadata: responseMetadata("succeeded", { charBudget: options.charBudget }),
      maxInsights: options.maxItemsPerWindow ?? 50,
      project: options.project,
      contribution: {
        stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
        contributionId: claimedContribution.contributionId,
        sourceVersionKeys,
      },
    });
    if (!await reflectSourcesStillMatch(options.kv, sources)) {
      await replaceDriftedReflectSources({
        kv: options.kv,
        identity,
        sources,
        claimedContribution,
        staged: true,
      });
      claimedContribution = null;
      return reflectContributionFailure("reflect_insight_source_drifted_before_commit");
    }
    const committed = await commitReflectRecovery({
      kv: options.kv,
      receipt: staged.receipt,
      recovery: staged.recovery,
      project: options.project,
    });
    return recoveryResponse(staged.receipt, committed);
  } catch (err) {
    if (claimedContribution && options.recoveryIdentity) {
      const key = recoveryReceiptKey(options.recoveryIdentity);
      const receipt = await options.kv.get<ReflectRecoveryReceipt>(
        KV.extractionOperationReceipt(key),
        key,
      ).catch(() => null);
      if (!receipt?.reflectRecovery) {
        await releaseClaimedBatch(options.kv, {
          stage: "reflect_insight",
          stageContractVersion: REFLECT_INSIGHT_CONTRIBUTION_CONTRACT,
          contributionId: claimedContribution.contributionId,
          sourceVersionKeys: claimedContribution.sourceVersionKeys,
        }).catch(() => undefined);
      }
    }
    if (isProviderPreflightError(err)) {
      const status = providerPreflightStatus(err);
      return { success: false, error: status, ...responseMetadata(status) };
    }
    const error = err instanceof Error ? err.message : String(err);
    if (error === "reflect_insight_response_parse_failure") {
      return {
        success: false,
        error,
        failure: { class: "unit", cause: error },
        ...responseMetadata("failed"),
      };
    }
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

async function runReflectInsightWindowLegacy(
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
    const loaded = await loadReflectWindowInput(options);
    const { cluster, sources } = loaded;
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
        sources,
        response,
        totalItems,
        promptChars: prompt.length,
        telemetry: sortProviderCallTelemetry(telemetry),
        metadata: responseMetadata("succeeded", {
          charBudget: options.charBudget,
        }),
        maxInsights: options.maxItemsPerWindow ?? 50,
        project: options.project,
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
      semanticMemoryIds?: string[];
      lessonIds?: string[];
      crystalIds?: string[];
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
      stageContractVersion?: string;
      sourceVersionKeys?: string[];
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

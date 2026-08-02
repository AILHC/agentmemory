import type { ISdk } from "iii-sdk";
import { createHash } from "node:crypto";
import type {
  AuditEntry,
  CompressedObservation,
  ContributionRecord,
  ExtractionOperationIdentity,
  ExtractionOperationReceipt,
  Memory,
  MemoryConsolidationBacklogRecord,
  MemoryConsolidationProposal,
  Session,
  MemoryProvider,
  MemoryProviderCallOptions,
} from "../types.js";
import { KV, fingerprintId, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { buildExtractionOperationKey } from "./extraction-operation-receipts.js";
import {
  buildSourceVersionKey,
  claimBatch,
  commitClaimedBatch,
  markClaimedBatchNoEffect,
  releaseClaimedBatch,
} from "./extraction-contributions.js";
import { partitionAdoptedBaselineSessions } from "./extraction-baselines.js";
import {
  resolveOutputLanguage,
  withOutputLanguagePolicy,
} from "../prompts/output-language.js";

export const CONSOLIDATION_SYSTEM = `You are a memory consolidation engine. Given a set of related observations from coding sessions, synthesize them into a single long-term memory.

Output XML:
<memory>
  <type>pattern|preference|architecture|bug|workflow|fact</type>
  <title>Concise memory title (max 80 chars)</title>
  <content>2-4 sentence description of the learned insight</content>
  <concepts>
    <concept>key term</concept>
  </concepts>
  <files>
    <file>relevant/file/path</file>
  </files>
  <strength>1-10 how confident/important this memory is</strength>
</memory>

When the observations contain no durable memory, output exactly:
<no_effect><reason_code>no_durable_memory</reason_code></no_effect>`;

import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { logger } from "../logger.js";
import {
  getMemoryConsolidateCompressTimeoutMs,
  resolveStageModelCallOptions,
  resolveStageModelMetadata,
} from "../config.js";
import {
  callProviderWithTelemetry,
  isProviderPreflightError,
  providerPreflightStatus,
  sortProviderCallTelemetry,
  type ProviderCallTelemetry,
} from "../providers/provider-call-result.js";

export interface ConsolidateObservationWindow {
  windowId: string;
  concept: string;
  observationIds: string[];
  sourceObservationIds: string[];
  sessionIds: string[];
  sourceSessionIds: string[];
  observationCount: number;
  estimatedChars: number;
  observationEstimatedChars?: Record<string, number>;
  observationSessionIds?: Record<string, string>;
  charBudget?: number;
  budgetApplied?: boolean;
  overBudget?: boolean;
  overBudgetReason?: "single_observation";
  inputHash: string;
  stageContractVersion?: string;
  sourceVersionKeys?: string[];
  deltaEvidence?: {
    observationIds: string[];
    sessionIds: string[];
    sourceVersionKeys: string[];
  };
}

export interface ConsolidateObservationWindowOptions {
  kv: StateKV;
  provider: MemoryProvider;
  project?: string;
  concept?: string;
  observationIds?: string[];
  observationSessionIds?: Record<string, string>;
  minObservations?: number;
  minImportance?: number;
  minObservationsPerConcept?: number;
  maxObservationsPerWindow?: number;
  charBudget?: number;
  model?: string;
  operationIdentity?: ExtractionOperationIdentity;
  operationReceiptManaged?: boolean;
  stageContractVersion?: string;
  sourceVersionKeys?: string[];
}

export interface ConsolidationObservationDescriptor {
  id: string;
  sid: string;
  concepts: string[];
  importance: number;
  estimatedChars: number;
  sourceVersionKey?: string;
}

export const MEMORY_CONSOLIDATE_CONTRACT_VERSION = "memory_consolidate/v1";

interface ConsolidationPlanBuffer {
  descriptors: ConsolidationObservationDescriptor[];
  sessionInventoryHash: string;
  totalSessions: number;
  nextSessionOffset: number | null;
  plannerInputHash: string;
  finalizeInputHash?: string;
  planSummary?: Omit<ConsolidationObservationPlan, "windows">;
  windows?: ConsolidateObservationWindow[];
  totalWindows?: number;
  windowBaseOffset?: number;
  nextWindowOffset?: number | null;
  updatedAt: number;
}

type ConsolidationObservationPlan = Awaited<ReturnType<typeof planConsolidateObservationWindows>>;

const CONSOLIDATION_PLAN_BUFFER_TTL_MS = 2 * 60 * 60 * 1000;
const CONSOLIDATION_PLAN_BUFFER_MAX_DESCRIPTORS = 2_000_000;
const consolidationPlanBuffers = new Map<string, ConsolidationPlanBuffer>();

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function modelOptionsFromMemoryConsolidate(model?: string): MemoryProviderCallOptions | undefined {
  return resolveStageModelCallOptions("memory_consolidate", model);
}

function compressWithOptions(
  provider: MemoryProvider,
  systemPrompt: string,
  userPrompt: string,
  callOptions?: MemoryProviderCallOptions,
  telemetry?: ProviderCallTelemetry[],
  callIndex = 0,
): Promise<string> {
  if (!telemetry) {
    return callOptions
      ? provider.compress(systemPrompt, userPrompt, callOptions)
      : provider.compress(systemPrompt, userPrompt);
  }
  return callProviderWithTelemetry({
    provider,
    operation: "compress",
    callRole: "window",
    callIndex,
    systemPrompt,
    userPrompt,
    callOptions,
    telemetry,
  });
}

function parseMemoryXml(
  xml: string,
  sessionIds: string[],
): Omit<Memory, "id" | "createdAt" | "updatedAt"> | null {
  const type = getXmlTag(xml, "type");
  const title = getXmlTag(xml, "title");
  const content = getXmlTag(xml, "content");
  if (!type || !title || !content) return null;

  const validTypes = new Set([
    "pattern",
    "preference",
    "architecture",
    "bug",
    "workflow",
    "fact",
  ]);

  return {
    type: (validTypes.has(type) ? type : "fact") as Memory["type"],
    title,
    content,
    concepts: getXmlChildren(xml, "concepts", "concept"),
    files: getXmlChildren(xml, "files", "file"),
    sessionIds,
    strength: Math.max(
      1,
      Math.min(10, parseInt(getXmlTag(xml, "strength") || "5", 10) || 5),
    ),
    version: 1,
    isLatest: true,
  };
}

export function parseMemoryProviderResponse(
  xml: string,
  sessionIds: string[],
  strictSingleRoot = false,
):
  | { kind: "memory"; parsed: Omit<Memory, "id" | "createdAt" | "updatedAt"> }
  | { kind: "no_effect"; reasonCode: "no_durable_memory" }
  | null {
  if (strictSingleRoot) {
    const trimmed = xml.trim();
    const exactNoEffect = /^<no_effect>\s*<reason_code>\s*no_durable_memory\s*<\/reason_code>\s*<\/no_effect>$/i;
    if (exactNoEffect.test(trimmed)) {
      return { kind: "no_effect", reasonCode: "no_durable_memory" };
    }
    const singleMemoryRoot = /^<memory>[\s\S]*<\/memory>$/i.test(trimmed)
      && (trimmed.match(/<memory>/gi)?.length ?? 0) === 1
      && (trimmed.match(/<\/memory>/gi)?.length ?? 0) === 1
      && !/<\/?no_effect\b/i.test(trimmed)
      && hasWellNestedMemoryXmlTags(trimmed);
    if (!singleMemoryRoot) return null;
    const parsed = parseMemoryXml(trimmed, sessionIds);
    return parsed ? { kind: "memory", parsed } : null;
  }
  const parsed = parseMemoryXml(xml, sessionIds);
  if (parsed) return { kind: "memory", parsed };
  const reasonCode = getXmlTag(xml, "reason_code");
  if (reasonCode === "no_durable_memory" && /<no_effect\b[^>]*>/i.test(xml)) {
    return { kind: "no_effect", reasonCode };
  }
  return null;
}

function hasWellNestedMemoryXmlTags(xml: string): boolean {
  const allowed = new Set([
    "memory", "type", "title", "content", "concepts", "concept",
    "files", "file", "strength",
  ]);
  const stack: string[] = [];
  const tag = /<(\/)?([a-z_][a-z0-9_-]*)\s*>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(xml)) !== null) {
    if (/[<>]/.test(xml.slice(cursor, match.index))) return false;
    const name = match[2].toLowerCase();
    if (!allowed.has(name)) return false;
    if (match[1]) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
    cursor = tag.lastIndex;
  }
  return stack.length === 0 && !/[<>]/.test(xml.slice(cursor));
}

function normalizedObservationHash(obs: CompressedObservation): string {
  return createHash("sha256")
    .update(stableStringify({
      id: obs.id,
      type: obs.type,
      title: obs.title,
      narrative: obs.narrative,
      facts: obs.facts,
      concepts: obs.concepts,
      files: obs.files,
      importance: obs.importance,
    }))
    .digest("hex");
}

function memoryConsolidationSourceVersionKey(obs: CompressedObservation): string {
  return buildSourceVersionKey(
    "memory_consolidate",
    "observation",
    obs.id,
    normalizedObservationHash(obs),
  );
}

export function memoryConsolidationSessionSnapshotHash(
  observations: CompressedObservation[],
): string {
  return stableHash(observations
    .filter((observation) => observation.title && observation.importance >= 5)
    .map(memoryConsolidationSourceVersionKey)
    .sort());
}

async function collectConsolidationObservations(
  kv: StateKV,
  project?: string,
  minImportance = 5,
): Promise<Array<CompressedObservation & { sid: string }>> {
  const sessions = await kv.list<Session>(KV.sessions);
  const scopedProject =
    typeof project === "string" && project.trim().length > 0
      ? project.trim()
      : undefined;
  const filtered = scopedProject
    ? sessions.filter((s) => s.project === scopedProject)
    : sessions;

  const allObs: Array<CompressedObservation & { sid: string }> = [];
  const readConcurrency = 8;
  for (let offset = 0; offset < filtered.length; offset += readConcurrency) {
    const batch = filtered.slice(offset, offset + readConcurrency);
    const observations = await Promise.all(
      batch.map((session) =>
        kv
          .list<CompressedObservation>(KV.observations(session.id))
          .catch(() => [] as CompressedObservation[]),
      ),
    );
    for (let index = 0; index < batch.length; index++) {
      for (const obs of observations[index]) {
        if (obs.title && obs.importance >= minImportance) {
          allObs.push({ ...obs, sid: batch[index].id });
        }
      }
    }
  }
  return allObs;
}

async function collectConsolidationObservationsById(
  kv: StateKV,
  observationIds: string[],
  observationSessionIds: Record<string, string>,
  minImportance: number,
): Promise<Array<CompressedObservation & { sid: string }>> {
  const collected: Array<CompressedObservation & { sid: string }> = [];
  const readConcurrency = 8;
  for (let offset = 0; offset < observationIds.length; offset += readConcurrency) {
    const batch = observationIds.slice(offset, offset + readConcurrency);
    const observations = await Promise.all(
      batch.map((observationId) => {
        const sessionId = observationSessionIds[observationId];
        return kv
          .get<CompressedObservation>(KV.observations(sessionId), observationId)
          .catch(() => null);
      }),
    );
    for (let index = 0; index < batch.length; index++) {
      const obs = observations[index];
      if (obs?.title && obs.importance >= minImportance) {
        collected.push({ ...obs, sid: observationSessionIds[batch[index]] });
      }
    }
  }
  return collected;
}

function groupItemsByConcept<T extends { concepts: string[] }>(
  allObs: T[],
  minGroupSize: number,
): Map<string, T[]> {
  const conceptGroups = new Map<string, T[]>();
  for (const obs of allObs) {
    for (const concept of obs.concepts) {
      const key = concept.toLowerCase();
      if (!conceptGroups.has(key)) conceptGroups.set(key, []);
      conceptGroups.get(key)!.push(obs);
    }
  }
  return new Map(
    [...conceptGroups.entries()]
      .filter(([, group]) => group.length >= minGroupSize)
      .sort((a, b) => b[1].length - a[1].length),
  );
}

function groupObservationsByConcept(
  allObs: Array<CompressedObservation & { sid: string }>,
  minGroupSize: number,
): Map<string, Array<CompressedObservation & { sid: string }>> {
  return groupItemsByConcept(allObs, minGroupSize);
}

const CONSOLIDATION_OBSERVATION_SEPARATOR = "\n\n";

function serializeObservationForConsolidation(obs: CompressedObservation): string {
  return `[${obs.type}] ${obs.title}\n${obs.narrative}\nFiles: ${obs.files.join(", ")}\nImportance: ${obs.importance}`;
}

function serializeConsolidationObservationPrompt(observations: CompressedObservation[]): string {
  return observations.map(serializeObservationForConsolidation).join(CONSOLIDATION_OBSERVATION_SEPARATOR);
}

function estimateObservationChars(obs: CompressedObservation): number {
  return serializeObservationForConsolidation(obs).length;
}

function observationDescriptor(
  obs: CompressedObservation,
  sid: string,
): ConsolidationObservationDescriptor {
  return {
    id: obs.id,
    sid,
    concepts: obs.concepts,
    importance: obs.importance,
    estimatedChars: estimateObservationChars(obs),
    sourceVersionKey: memoryConsolidationSourceVersionKey(obs),
  };
}

async function persistMemoryConsolidationBacklogCandidate(
  kv: StateKV,
  descriptor: ConsolidationObservationDescriptor,
  project?: string,
): Promise<boolean> {
  const sourceVersionKey = descriptor.sourceVersionKey;
  if (!sourceVersionKey) return true;
  const contributionScope = KV.extractionContributionRecords(
    "memory_consolidate",
    MEMORY_CONSOLIDATE_CONTRACT_VERSION,
  );
  const contribution = await kv.get<ContributionRecord>(contributionScope, sourceVersionKey);
  const backlogScope = KV.memoryConsolidationBacklog(project);
  const backlogIndexScope = KV.memoryConsolidationBacklogSourceIndex(project);
  if (contribution) {
    if (contribution.state === "committed" || contribution.state === "no_effect") {
      await kv.delete(backlogScope, sourceVersionKey);
      const indexed = await kv.get<string>(backlogIndexScope, descriptor.id);
      if (indexed === sourceVersionKey) await kv.delete(backlogIndexScope, descriptor.id);
    }
    return false;
  }
  const indexedSourceVersionKey = await kv.get<string>(backlogIndexScope, descriptor.id);
  if (indexedSourceVersionKey && indexedSourceVersionKey !== sourceVersionKey) {
    await kv.delete(backlogScope, indexedSourceVersionKey);
  }
  const existing = await kv.get<MemoryConsolidationBacklogRecord>(backlogScope, sourceVersionKey);
  const now = new Date().toISOString();
  const record: MemoryConsolidationBacklogRecord = {
    sourceVersionKey,
    observationId: descriptor.id,
    sessionId: descriptor.sid,
    normalizedContentHash: sourceVersionKey.split("|").at(-1)!,
    concepts: descriptor.concepts,
    importance: descriptor.importance,
    estimatedChars: descriptor.estimatedChars,
    ...(project ? { project } : {}),
    firstWaitingAt: existing?.firstWaitingAt ?? now,
    updatedAt: now,
  };
  await kv.set(backlogScope, sourceVersionKey, record);
  await kv.set(backlogIndexScope, descriptor.id, sourceVersionKey);
  return true;
}

async function collectMemoryConsolidationBacklogDescriptors(
  kv: StateKV,
  project?: string,
): Promise<ConsolidationObservationDescriptor[]> {
  const backlogScope = KV.memoryConsolidationBacklog(project);
  const backlog = await kv.list<MemoryConsolidationBacklogRecord>(backlogScope);
  const contributionScope = KV.extractionContributionRecords(
    "memory_consolidate",
    MEMORY_CONSOLIDATE_CONTRACT_VERSION,
  );
  const descriptors: ConsolidationObservationDescriptor[] = [];
  for (let offset = 0; offset < backlog.length; offset += 32) {
    const batch = backlog.slice(offset, offset + 32);
    const baseline = await partitionAdoptedBaselineSessions(kv, {
      stage: "memory_consolidate",
      stageContractVersion: MEMORY_CONSOLIDATE_CONTRACT_VERSION,
      sessionIds: [...new Set(batch.map((record) => record.sessionId))],
    });
    const adopted = new Set(baseline.adoptedSessionIds);
    await Promise.all(batch
      .filter((record) => adopted.has(record.sessionId))
      .map((record) => removeMemoryConsolidationBacklogRecord(kv, record, project)));
    const openBatch = batch.filter((record) => !adopted.has(record.sessionId));
    const observations = await Promise.all(openBatch.map((record) =>
      kv.get<CompressedObservation>(KV.observations(record.sessionId), record.observationId),
    ));
    for (let index = 0; index < openBatch.length; index++) {
      const record = openBatch[index];
      const observation = observations[index];
      if (!observation || observation.importance < 5 || !observation.title) {
        await removeMemoryConsolidationBacklogRecord(kv, record, project);
        continue;
      }
      const sourceVersionKey = memoryConsolidationSourceVersionKey(observation);
      const descriptor: ConsolidationObservationDescriptor = {
        id: observation.id,
        sid: record.sessionId,
        concepts: observation.concepts,
        importance: observation.importance,
        estimatedChars: estimateObservationChars(observation),
        sourceVersionKey,
      };
      const contribution = await kv.get<ContributionRecord>(
        contributionScope,
        sourceVersionKey,
      );
      if (contribution) {
        if (contribution.state === "committed" || contribution.state === "no_effect") {
          await removeMemoryConsolidationBacklogRecord(kv, record, project);
          if (sourceVersionKey !== record.sourceVersionKey) {
            await kv.delete(backlogScope, sourceVersionKey);
          }
        }
        continue;
      }
      await persistMemoryConsolidationBacklogCandidate(kv, descriptor, project);
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

async function removeMemoryConsolidationBacklogRecord(
  kv: StateKV,
  record: MemoryConsolidationBacklogRecord,
  project?: string,
): Promise<void> {
  await kv.delete(KV.memoryConsolidationBacklog(project), record.sourceVersionKey);
  const indexScope = KV.memoryConsolidationBacklogSourceIndex(project);
  const indexed = await kv.get<string>(indexScope, record.observationId);
  if (indexed === record.sourceVersionKey) {
    await kv.delete(indexScope, record.observationId);
  }
}

export async function collectConsolidationObservationDescriptorPage(options: {
  kv: StateKV;
  project?: string;
  sessionIds?: string[];
  minImportance?: number;
  sessionOffset?: number;
  sessionLimit?: number;
}): Promise<{
  success: true;
  descriptors: ConsolidationObservationDescriptor[];
  sessionOffset: number;
  nextSessionOffset: number | null;
  totalSessions: number;
  sessionInventoryHash: string;
}> {
  const selectedSessionIds = options.sessionIds
    ? [...new Set(options.sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))]
    : undefined;
  const sessions = selectedSessionIds
    ? selectedSessionIds.map((id) => ({ id } as Session))
    : await options.kv.list<Session>(KV.sessions);
  const scopedProject =
    typeof options.project === "string" && options.project.trim().length > 0
      ? options.project.trim()
      : undefined;
  const filtered = scopedProject && !selectedSessionIds
    ? sessions.filter((session) => session.project === scopedProject)
    : sessions;
  const sessionOffset = Math.max(0, options.sessionOffset ?? 0);
  const sessionLimit = Math.min(8, Math.max(1, options.sessionLimit ?? 8));
  const page = filtered.slice(sessionOffset, sessionOffset + sessionLimit);
  const baseline = await partitionAdoptedBaselineSessions(options.kv, {
    stage: "memory_consolidate",
    stageContractVersion: MEMORY_CONSOLIDATE_CONTRACT_VERSION,
    sessionIds: page.map((session) => session.id),
  });
  const openSessionIds = new Set(baseline.openSessionIds);
  const openPage = page.filter((session) => openSessionIds.has(session.id));
  const observations = await Promise.all(
    openPage.map((session) => {
      const read = options.kv.list<CompressedObservation>(KV.observations(session.id));
      return selectedSessionIds ? read : read.catch(() => [] as CompressedObservation[]);
    }),
  );
  const minImportance = options.minImportance ?? 5;
  const descriptors: ConsolidationObservationDescriptor[] = [];
  for (let index = 0; index < openPage.length; index++) {
    for (const obs of observations[index]) {
      if (obs.title && obs.importance >= minImportance) {
        const descriptor = observationDescriptor(obs, openPage[index].id);
        if (!selectedSessionIds || await persistMemoryConsolidationBacklogCandidate(
          options.kv,
          descriptor,
          scopedProject,
        )) {
          descriptors.push(descriptor);
        }
      }
    }
  }
  const consumed = sessionOffset + page.length;
  return {
    success: true,
    descriptors,
    sessionOffset,
    nextSessionOffset: consumed < filtered.length ? consumed : null,
    totalSessions: filtered.length,
    sessionInventoryHash: stableHash(filtered.map((session) => session.id)),
  };
}

function cleanExpiredConsolidationPlanBuffers(now = Date.now()): void {
  for (const [plannerId, buffer] of consolidationPlanBuffers.entries()) {
    if (now - buffer.updatedAt > CONSOLIDATION_PLAN_BUFFER_TTL_MS) {
      consolidationPlanBuffers.delete(plannerId);
    }
  }
}

async function collectBufferedConsolidationObservationDescriptorPage(options: {
  kv: StateKV;
  plannerId: string;
  project?: string;
  sessionIds?: string[];
  minImportance?: number;
  sessionOffset?: number;
  sessionLimit?: number;
}): Promise<Record<string, unknown>> {
  cleanExpiredConsolidationPlanBuffers();
  const page = await collectConsolidationObservationDescriptorPage(options);
  const plannerInputHash = stableHash({
    project: options.project?.trim() || null,
    sessionIds: options.sessionIds ?? null,
    minImportance: options.minImportance ?? 5,
  });
  const existing = consolidationPlanBuffers.get(options.plannerId);
  if (page.sessionOffset === 0) {
    consolidationPlanBuffers.set(options.plannerId, {
      descriptors: [...page.descriptors],
      sessionInventoryHash: page.sessionInventoryHash,
      totalSessions: page.totalSessions,
      nextSessionOffset: page.nextSessionOffset,
      plannerInputHash,
      updatedAt: Date.now(),
    });
  } else {
    if (
      !existing
      || existing.nextSessionOffset !== page.sessionOffset
      || existing.sessionInventoryHash !== page.sessionInventoryHash
      || existing.totalSessions !== page.totalSessions
      || existing.plannerInputHash !== plannerInputHash
    ) {
      consolidationPlanBuffers.delete(options.plannerId);
      return {
        success: false,
        error: "invalid_consolidation_plan_cursor",
        failure: { class: "hard", cause: "invalid_consolidation_plan_cursor" },
      };
    }
    existing.descriptors.push(...page.descriptors);
    existing.nextSessionOffset = page.nextSessionOffset;
    existing.updatedAt = Date.now();
  }
  const buffer = consolidationPlanBuffers.get(options.plannerId)!;
  if (buffer.descriptors.length > CONSOLIDATION_PLAN_BUFFER_MAX_DESCRIPTORS) {
    consolidationPlanBuffers.delete(options.plannerId);
    return {
      success: false,
      error: "consolidation_plan_descriptor_limit_exceeded",
      failure: { class: "hard", cause: "consolidation_plan_descriptor_limit_exceeded" },
    };
  }
  return {
    ...page,
    plannerId: options.plannerId,
    descriptors: [],
    descriptorCount: page.descriptors.length,
    accumulatedDescriptorCount: buffer.descriptors.length,
  };
}

async function finalizeBufferedConsolidationObservationPlan(options: {
  kv: StateKV;
  plannerId: string;
  project?: string;
  sessionIds?: string[];
  minObservations?: number;
  minImportance?: number;
  minObservationsPerConcept?: number;
  maxObservationsPerWindow?: number;
  charBudget?: number;
  windowOffset?: number;
  windowLimit?: number;
}): Promise<Record<string, unknown>> {
  cleanExpiredConsolidationPlanBuffers();
  const buffer = consolidationPlanBuffers.get(options.plannerId);
  const plannerInputHash = stableHash({
    project: options.project?.trim() || null,
    sessionIds: options.sessionIds ?? null,
    minImportance: options.minImportance ?? 5,
  });
  const finalizeInputHash = stableHash({
    project: options.project?.trim() || null,
    minObservations: options.minObservations ?? null,
    minImportance: options.minImportance ?? 5,
    minObservationsPerConcept: options.minObservationsPerConcept ?? null,
    maxObservationsPerWindow: options.maxObservationsPerWindow ?? null,
    charBudget: options.charBudget ?? null,
  });
  if (
    !buffer
    || buffer.nextSessionOffset !== null
    || buffer.plannerInputHash !== plannerInputHash
    || (buffer.finalizeInputHash !== undefined && buffer.finalizeInputHash !== finalizeInputHash)
  ) {
    consolidationPlanBuffers.delete(options.plannerId);
    return {
      success: false,
      error: "incomplete_consolidation_plan_buffer",
      failure: { class: "hard", cause: "incomplete_consolidation_plan_buffer" },
    };
  }
  const windowOffset = options.windowOffset ?? 0;
  const windowLimit = options.windowLimit ?? 8;
  if (!buffer.planSummary || !buffer.windows) {
    if (windowOffset !== 0) {
      return {
        success: false,
        error: "invalid_consolidation_plan_window_cursor",
        failure: { class: "hard", cause: "invalid_consolidation_plan_window_cursor" },
      };
    }
    const {
      plannerId: _plannerId,
      windowOffset: _windowOffset,
      windowLimit: _windowLimit,
      ...planOptions
    } = options;
    void _plannerId;
    void _windowOffset;
    void _windowLimit;
    const plan = await planConsolidateObservationWindows({
      ...planOptions,
      descriptors: options.sessionIds
        ? await collectMemoryConsolidationBacklogDescriptors(options.kv, options.project)
        : buffer.descriptors,
    });
    const { windows, ...planSummary } = plan;
    buffer.descriptors = [];
    buffer.finalizeInputHash = finalizeInputHash;
    buffer.planSummary = planSummary;
    buffer.windows = windows;
    buffer.totalWindows = windows.length;
    buffer.windowBaseOffset = 0;
    buffer.nextWindowOffset = null;
    buffer.updatedAt = Date.now();
  }

  const baseOffset = buffer.windowBaseOffset ?? 0;
  const expectedNextOffset = buffer.nextWindowOffset;
  if (
    windowOffset < baseOffset
    || (windowOffset !== baseOffset && windowOffset !== expectedNextOffset)
    || windowOffset > (buffer.totalWindows ?? 0)
  ) {
    return {
      success: false,
      error: "invalid_consolidation_plan_window_cursor",
      failure: { class: "hard", cause: "invalid_consolidation_plan_window_cursor" },
    };
  }
  if (windowOffset > baseOffset) {
    buffer.windows = buffer.windows.slice(windowOffset - baseOffset);
    buffer.windowBaseOffset = windowOffset;
  }
  const windows = buffer.windows.slice(0, windowLimit);
  const consumed = windowOffset + windows.length;
  const nextWindowOffset = consumed < (buffer.totalWindows ?? 0) ? consumed : null;
  buffer.nextWindowOffset = nextWindowOffset;
  buffer.updatedAt = Date.now();
  return {
    ...buffer.planSummary,
    plannerId: options.plannerId,
    windows,
    windowOffset,
    nextWindowOffset,
    totalWindows: buffer.totalWindows,
  };
}

function yieldToConsolidationEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function groupItemsByConceptCooperatively<T extends { concepts: string[] }>(
  allObs: T[],
  minGroupSize: number,
): Promise<Map<string, T[]>> {
  const conceptGroups = new Map<string, T[]>();
  for (let index = 0; index < allObs.length; index++) {
    const obs = allObs[index];
    for (const concept of obs.concepts) {
      const key = concept.toLowerCase();
      if (!conceptGroups.has(key)) conceptGroups.set(key, []);
      conceptGroups.get(key)!.push(obs);
    }
    if ((index + 1) % 4_096 === 0) await yieldToConsolidationEventLoop();
  }
  await yieldToConsolidationEventLoop();
  return new Map(
    [...conceptGroups.entries()]
      .filter(([, group]) => group.length >= minGroupSize)
      .sort((a, b) => b[1].length - a[1].length),
  );
}

async function descriptorChunksByBudgetCooperatively(
  descriptors: ConsolidationObservationDescriptor[],
  maxObservationsPerWindow: number,
  charBudget?: number,
): Promise<ConsolidationObservationDescriptor[][]> {
  const chunks: ConsolidationObservationDescriptor[][] = [];
  let current: ConsolidationObservationDescriptor[] = [];
  let currentChars = 0;
  const maxCount = Math.max(1, maxObservationsPerWindow);
  for (let index = 0; index < descriptors.length; index++) {
    const descriptor = descriptors[index];
    const descriptorChars = descriptor.estimatedChars
      + (current.length > 0 ? CONSOLIDATION_OBSERVATION_SEPARATOR.length : 0);
    const wouldExceedCount = current.length >= maxCount;
    const wouldExceedBudget =
      charBudget !== undefined
      && current.length > 0
      && currentChars + descriptorChars > charBudget;
    if (wouldExceedCount || wouldExceedBudget) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(descriptor);
    currentChars += descriptorChars;
    if ((index + 1) % 4_096 === 0) await yieldToConsolidationEventLoop();
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function consolidateWindowFromDescriptors(
  concept: string,
  descriptors: ConsolidationObservationDescriptor[],
  index: number,
  charBudget?: number,
  windowKey = concept,
): ConsolidateObservationWindow {
  const observationIds = descriptors.map((descriptor) => descriptor.id);
  const sourceVersionKeys = descriptors
    .map((descriptor) => descriptor.sourceVersionKey)
    .filter((key): key is string => Boolean(key));
  const sessionIds = [...new Set(descriptors.map((descriptor) => descriptor.sid))];
  const observationEstimatedChars = Object.fromEntries(
    descriptors.map((descriptor) => [descriptor.id, descriptor.estimatedChars]),
  );
  const observationSessionIds = Object.fromEntries(
    descriptors.map((descriptor) => [descriptor.id, descriptor.sid]),
  );
  const estimatedChars = descriptors.reduce(
    (total, descriptor, descriptorIndex) =>
      total
      + descriptor.estimatedChars
      + (descriptorIndex > 0 ? CONSOLIDATION_OBSERVATION_SEPARATOR.length : 0),
    0,
  );
  const budgetApplied = charBudget !== undefined;
  const overBudget = budgetApplied && estimatedChars > charBudget;
  return {
    windowId: `memory-consolidate:${windowKey}:${index + 1}`,
    concept,
    observationIds,
    sourceObservationIds: observationIds,
    sessionIds,
    sourceSessionIds: sessionIds,
    observationCount: descriptors.length,
    estimatedChars,
    observationEstimatedChars,
    observationSessionIds,
    ...(budgetApplied ? { charBudget, budgetApplied } : {}),
    ...(overBudget && descriptors.length === 1
      ? { overBudget: true, overBudgetReason: "single_observation" as const }
      : {}),
    inputHash: stableHash([
      "memory-consolidate",
      concept,
      sourceVersionKeys.length === descriptors.length ? [...sourceVersionKeys].sort() : observationIds,
      sessionIds,
      estimatedChars,
    ]),
    ...(sourceVersionKeys.length === descriptors.length
      ? {
        stageContractVersion: MEMORY_CONSOLIDATE_CONTRACT_VERSION,
        sourceVersionKeys,
        deltaEvidence: {
          observationIds,
          sessionIds,
          sourceVersionKeys,
        },
      }
      : {}),
  };
}

export async function planConsolidateObservationWindows(options: {
  kv: StateKV;
  descriptors?: ConsolidationObservationDescriptor[];
  project?: string;
  sessionIds?: string[];
  minObservations?: number;
  minImportance?: number;
  minObservationsPerConcept?: number;
  maxObservationsPerWindow?: number;
  charBudget?: number;
}): Promise<{
  success: boolean;
  totalObservations: number;
  windows: ConsolidateObservationWindow[];
  reason?: string;
  charBudget?: number;
  budgetApplied: boolean;
  maxWindowEstimatedChars: number;
  overBudgetWindowCount: number;
  plannerConfig: {
    minImportance: number;
    minObservationsPerConcept: number;
    charBudget?: number;
    maxObservationsPerWindow?: number;
  };
  eligibleWindowMaxObservationCount: number;
}> {
  const minObs = options.minObservationsPerConcept ?? options.minObservations ?? 10;
  const minImportance = options.minImportance ?? 5;
  const charBudget = options.charBudget !== undefined ? Math.max(1, options.charBudget) : undefined;
  const budgetApplied = charBudget !== undefined;
  const plannerConfig = {
    minImportance,
    minObservationsPerConcept: minObs,
    ...(charBudget === undefined ? {} : { charBudget }),
    ...(options.maxObservationsPerWindow === undefined
      ? {}
      : { maxObservationsPerWindow: Math.max(1, options.maxObservationsPerWindow) }),
  };
  let descriptors = options.descriptors ?? (await (async () => {
    const collected: ConsolidationObservationDescriptor[] = [];
    let sessionOffset = 0;
    while (true) {
      const page = await collectConsolidationObservationDescriptorPage({
        kv: options.kv,
        project: options.project,
        sessionIds: options.sessionIds,
        minImportance,
        sessionOffset,
        sessionLimit: 8,
      });
      collected.push(...page.descriptors);
      if (page.nextSessionOffset === null) break;
      sessionOffset = page.nextSessionOffset;
    }
    return collected;
  })());
  if (options.sessionIds) {
    const backlogDescriptors = await collectMemoryConsolidationBacklogDescriptors(
      options.kv,
      options.project,
    );
    descriptors = [...new Map(
      [...descriptors, ...backlogDescriptors].map((descriptor) => [
        descriptor.sourceVersionKey ?? `${descriptor.sid}:${descriptor.id}`,
        descriptor,
      ]),
    ).values()];
  }
  if (descriptors.length < minObs) {
    return {
      success: true,
      totalObservations: descriptors.length,
      windows: [],
      reason: "insufficient_observations",
      ...(budgetApplied ? { charBudget } : {}),
      budgetApplied,
      maxWindowEstimatedChars: 0,
      overBudgetWindowCount: 0,
      plannerConfig,
      eligibleWindowMaxObservationCount: 0,
    };
  }

  const groups = await groupItemsByConceptCooperatively(descriptors, minObs);
  const incrementalPlan = Boolean(options.sessionIds);
  const windows: ConsolidateObservationWindow[] = [];
  const coveredObservationIds = new Set<string>();
  for (const [concept, obsGroup] of groups.entries()) {
    const candidates = [...obsGroup].sort((a, b) => b.importance - a.importance);
    const sorted: ConsolidationObservationDescriptor[] = [];
    for (let index = 0; index < candidates.length; index++) {
      const obs = candidates[index];
      if (!coveredObservationIds.has(obs.id)) sorted.push(obs);
      if ((index + 1) % 4_096 === 0) await yieldToConsolidationEventLoop();
    }
    const chunkSize = Math.max(1, options.maxObservationsPerWindow ?? sorted.length);
    const chunks = await descriptorChunksByBudgetCooperatively(sorted, chunkSize, charBudget);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk.length === 0) continue;
      const window = consolidateWindowFromDescriptors(concept, chunk, i, charBudget);
      if (incrementalPlan && window.overBudget) continue;
      for (const obs of chunk) coveredObservationIds.add(obs.id);
      windows.push(window);
      if ((i + 1) % 256 === 0) await yieldToConsolidationEventLoop();
    }
    await yieldToConsolidationEventLoop();
  }
  const remaining: ConsolidationObservationDescriptor[] = [];
  for (let index = 0; index < descriptors.length; index++) {
    const obs = descriptors[index];
    if (!coveredObservationIds.has(obs.id)) remaining.push(obs);
    if ((index + 1) % 4_096 === 0) await yieldToConsolidationEventLoop();
  }
  remaining.sort((a, b) => b.importance - a.importance);
  if (remaining.length > 0 && !incrementalPlan) {
    const chunkSize = Math.max(1, options.maxObservationsPerWindow ?? remaining.length);
    const chunks = await descriptorChunksByBudgetCooperatively(remaining, chunkSize, charBudget);
    for (let i = 0; i < chunks.length; i++) {
      windows.push(consolidateWindowFromDescriptors(
        "remaining-observations",
        chunks[i],
        i,
        charBudget,
        "remaining",
      ));
      if ((i + 1) % 256 === 0) await yieldToConsolidationEventLoop();
    }
  }
  const maxWindowEstimatedChars = windows.reduce(
    (max, window) => Math.max(max, window.estimatedChars),
    0,
  );
  const overBudgetWindowCount = budgetApplied
    ? windows.filter((window) => charBudget !== undefined && window.estimatedChars > charBudget).length
    : 0;
  const eligibleWindowMaxObservationCount = windows.reduce(
    (max, window) => Math.max(max, window.observationCount),
    0,
  );
  return {
    success: true,
    totalObservations: descriptors.length,
    windows,
    ...(budgetApplied ? { charBudget } : {}),
    budgetApplied,
    maxWindowEstimatedChars,
    overBudgetWindowCount,
    plannerConfig,
    eligibleWindowMaxObservationCount,
  };
}

async function persistConsolidatedMemory(
  kv: StateKV,
  parsed: Omit<Memory, "id" | "createdAt" | "updatedAt">,
  existingMemories: Memory[],
  concept: string,
  obsIds: string[],
  scopedProject?: string,
): Promise<{ action: "created" | "evolved"; memoryId: string; parentId?: string }> {
  const existingMatch = existingMemories.find(
    (m) =>
      m.title.toLowerCase() === parsed.title.toLowerCase() &&
      (!scopedProject || !m.project || m.project === scopedProject),
  );
  const now = new Date().toISOString();

  if (existingMatch) {
    existingMatch.isLatest = false;
    await kv.set(KV.memories, existingMatch.id, existingMatch);
    await recordAudit(kv, "evolve", "mem::consolidate", [existingMatch.id], {
      action: "mark_non_latest",
      concept,
    });

    const evolved: Memory = {
      id: generateId("mem"),
      createdAt: now,
      updatedAt: now,
      ...parsed,
      version: (existingMatch.version || 1) + 1,
      parentId: existingMatch.id,
      supersedes: [existingMatch.id, ...(existingMatch.supersedes || [])],
      sourceObservationIds: obsIds,
      isLatest: true,
      ...(scopedProject !== undefined && { project: scopedProject }),
    };
    await kv.set(KV.memories, evolved.id, evolved);
    await recordAudit(kv, "evolve", "mem::consolidate", [evolved.id], {
      action: "evolve_memory",
      oldId: existingMatch.id,
      newId: evolved.id,
      concept,
    });
    return { action: "evolved", memoryId: evolved.id, parentId: existingMatch.id };
  }

  const memory: Memory = {
    id: generateId("mem"),
    createdAt: now,
    updatedAt: now,
    ...parsed,
    sourceObservationIds: obsIds,
    version: 1,
    isLatest: true,
    ...(scopedProject !== undefined && { project: scopedProject }),
  };
  await kv.set(KV.memories, memory.id, memory);
  await recordAudit(kv, "remember", "mem::consolidate", [memory.id], {
    action: "create_memory",
    concept,
  });
  return { action: "created", memoryId: memory.id };
}

function proposalKey(identity: ExtractionOperationIdentity): string {
  return fingerprintId("mcp", JSON.stringify([
    identity.runId,
    identity.stage,
    identity.unitId,
  ]));
}

function proposalResponse(proposal: MemoryConsolidationProposal): Record<string, unknown> {
  return {
    success: true,
    status: proposal.status,
    preparedHandle: proposal.handle,
    proposalHash: proposal.proposalHash,
    inputHash: proposal.inputHash,
    totalObservations: proposal.totalObservations,
    promptChars: proposal.promptChars,
    ...(proposal.charBudget === undefined ? {} : { charBudget: proposal.charBudget }),
    ...(proposal.response || {}),
  };
}

function committedMemoryFailure(cause: string): Record<string, unknown> {
  return {
    success: false,
    status: "failed",
    failure: { class: "hard", cause },
  };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function memoryProposalHash(proposal: Pick<
  MemoryConsolidationProposal,
  "parsed" | "noEffectProof" | "sourceObservationIds" | "project" | "concept"
  | "stageContractVersion" | "contributionId" | "sourceVersionKeys"
  | "historicalContextMemoryIds"
  | "deltaEvidence" | "historicalContext"
>): string {
  const hasIncrementalContract = Boolean(
    proposal.noEffectProof
    || proposal.stageContractVersion
    || proposal.contributionId
    || proposal.sourceVersionKeys
    || proposal.historicalContextMemoryIds
    || proposal.deltaEvidence
    || proposal.historicalContext,
  );
  return createHash("sha256")
    .update(stableStringify(hasIncrementalContract
      ? [
        proposal.parsed,
        proposal.noEffectProof,
        proposal.sourceObservationIds,
        proposal.project,
        proposal.concept,
        proposal.stageContractVersion,
        proposal.contributionId,
        proposal.sourceVersionKeys,
        proposal.historicalContextMemoryIds,
        proposal.deltaEvidence,
        proposal.historicalContext,
      ]
      : [
        proposal.parsed,
        proposal.sourceObservationIds,
        proposal.project,
        proposal.concept,
      ]))
    .digest("hex");
}

async function verifyCommittedMemoryProposal(
  kv: StateKV,
  proposal: MemoryConsolidationProposal,
): Promise<Record<string, unknown> | null> {
  const intent = proposal.commitIntent;
  const response = proposal.response;
  if (proposal.noEffectProof) {
    if (!response) return committedMemoryFailure("memory_consolidate_committed_effect_missing");
    return response.success === true
      && response.status === "skipped"
      && response.consolidated === 0
      && response.memoryIds.length === 0
      ? null
      : committedMemoryFailure("memory_consolidate_committed_effect_conflict");
  }
  if (!intent || !response) {
    return committedMemoryFailure("memory_consolidate_committed_effect_missing");
  }
  const [memory, audit, parent] = await Promise.all([
    kv.get<Memory>(KV.memories, intent.resultId),
    kv.get<AuditEntry>(KV.audit, intent.auditId),
    intent.parentId
      ? kv.get<Memory>(KV.memories, intent.parentId)
      : Promise.resolve(null),
  ]);
  if (!memory || !audit || (intent.parentId && !parent)) {
    return committedMemoryFailure("memory_consolidate_committed_effect_missing");
  }
  const expectedAction = intent.parentId ? "evolved" : "created";
  const expectedAuditOperation = intent.parentId ? "evolve" : "remember";
  const expectedAuditAction = intent.parentId ? "evolve_memory" : "create_memory";
  const parsed = proposal.parsed!;
  const stableFieldsMatch = (
    memory.id === intent.resultId
    && memory.createdAt === intent.createdAt
    && memory.type === parsed.type
    && memory.title === parsed.title
    && memory.content === parsed.content
    && memory.strength === parsed.strength
    && sameJsonValue(memory.concepts, parsed.concepts)
    && sameJsonValue(memory.files, parsed.files)
    && sameJsonValue(memory.sessionIds, parsed.sessionIds)
    && sameJsonValue(memory.sourceObservationIds, proposal.sourceObservationIds)
    && memory.project === proposal.project
    && memory.parentId === intent.parentId
    && (
      intent.parentId
        ? (
          parent?.isLatest === false
          && memory.version === (parent.version || 1) + 1
          && sameJsonValue(memory.supersedes, [intent.parentId, ...(parent.supersedes || [])])
        )
        : (
          memory.version === 1
          && (memory.supersedes === undefined || sameJsonValue(memory.supersedes, []))
        )
    )
  );
  const auditDetails = audit.details as Record<string, unknown> | undefined;
  const auditMatches = (
    audit.id === intent.auditId
    && audit.timestamp === intent.createdAt
    && audit.operation === expectedAuditOperation
    && audit.functionId === "mem::full-memory-consolidate-window-commit"
    && sameJsonValue(audit.targetIds, [intent.resultId])
    && auditDetails?.action === expectedAuditAction
    && auditDetails?.newId === intent.resultId
    && auditDetails?.concept === proposal.concept
    && (
      intent.parentId
        ? auditDetails?.oldId === intent.parentId
        : auditDetails?.oldId === undefined
    )
  );
  const responseMatches = (
    response.success === true
    && response.status === "succeeded"
    && response.memoryId === intent.resultId
    && sameJsonValue(response.memoryIds, [intent.resultId])
    && response.action === expectedAction
    && response.parentId === intent.parentId
  );
  return stableFieldsMatch && auditMatches && responseMatches
    ? null
    : committedMemoryFailure("memory_consolidate_committed_effect_conflict");
}

function memoryDomainEffectEvidence(
  proposal: MemoryConsolidationProposal,
): Record<string, unknown> {
  const intent = proposal.commitIntent!;
  return {
    schema: "memory-consolidate-domain-effect/v1",
    proposalHash: proposal.proposalHash,
    resultId: intent.resultId,
    auditId: intent.auditId,
    effectHash: createHash("sha256")
      .update(JSON.stringify([
        proposal.key,
        proposal.proposalHash,
        intent.resultId,
        intent.auditId,
        intent.createdAt,
      ]))
      .digest("hex"),
  };
}

function memoryNoEffectEvidence(
  proposal: MemoryConsolidationProposal,
): Record<string, unknown> {
  return {
    schema: "memory-consolidate-no-effect/v1",
    proposalHash: proposal.proposalHash,
    reasonCode: proposal.noEffectProof!.reasonCode,
    proofHash: createHash("sha256")
      .update(stableStringify([
        proposal.key,
        proposal.proposalHash,
        proposal.noEffectProof!.reasonCode,
        proposal.sourceVersionKeys ?? [],
      ]))
      .digest("hex"),
  };
}

export async function findMemoryConsolidationProposalResult(
  kv: StateKV,
  identity: ExtractionOperationIdentity,
): Promise<Record<string, unknown> | null> {
  const proposal = await kv.get<MemoryConsolidationProposal>(
    KV.memoryConsolidationProposal(proposalKey(identity)),
    proposalKey(identity),
  );
  if (!proposal) return null;
  if (proposal.inputHash !== identity.inputHash) {
    return {
      success: false,
      status: "failed",
      failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
    };
  }
  const expectedHash = memoryProposalHash(proposal);
  if (
    proposal.key !== proposalKey(identity)
    || proposal.runId !== identity.runId
    || proposal.stage !== identity.stage
    || proposal.unitId !== identity.unitId
    || proposal.proposalHash !== expectedHash
    || proposal.handle !== fingerprintId("mcph", `${proposal.key}:${expectedHash}`)
  ) {
    return committedMemoryFailure("proposal_identity_conflict");
  }
  return proposalResponse(proposal);
}

async function storeMemoryConsolidationProposal(
  options: ConsolidateObservationWindowOptions,
  parsedResult:
    | { kind: "memory"; parsed: Omit<Memory, "id" | "createdAt" | "updatedAt"> }
    | { kind: "no_effect"; reasonCode: "no_durable_memory" },
  concept: string,
  sourceObservationIds: string[],
  totalObservations: number,
  promptChars: number,
  contributionId: string | undefined,
  sourceVersionKeys: string[] | undefined,
  historicalContextMemoryIds: string[],
  historicalContextMemoryVersions: Array<{ memoryId: string; versionHash: string }>,
  deltaSessionIds: string[],
): Promise<Record<string, unknown>> {
  const identity = options.operationIdentity!;
  const key = proposalKey(identity);
  const existing = await options.kv.get<MemoryConsolidationProposal>(
    KV.memoryConsolidationProposal(key),
    key,
  );
  if (existing) {
    if (existing.inputHash !== identity.inputHash) {
      return {
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
      };
    }
    const expectedHash = memoryProposalHash(existing);
    if (
      existing.key !== key
      || existing.runId !== identity.runId
      || existing.stage !== identity.stage
      || existing.unitId !== identity.unitId
      || existing.proposalHash !== expectedHash
      || existing.handle !== fingerprintId("mcph", `${key}:${expectedHash}`)
    ) {
      return committedMemoryFailure("proposal_identity_conflict");
    }
    return proposalResponse(existing);
  }
  const proposalHash = memoryProposalHash({
    ...(parsedResult.kind === "memory"
      ? { parsed: parsedResult.parsed }
      : {
        noEffectProof: {
          kind: "strict_legal_empty" as const,
          reasonCode: parsedResult.reasonCode,
        },
      }),
    sourceObservationIds,
    project: options.project,
    concept,
    ...(contributionId
      ? {
        stageContractVersion: options.stageContractVersion ?? MEMORY_CONSOLIDATE_CONTRACT_VERSION,
        contributionId,
        sourceVersionKeys,
        historicalContextMemoryIds,
        deltaEvidence: {
          observationIds: sourceObservationIds,
          sessionIds: deltaSessionIds,
          sourceVersionKeys: sourceVersionKeys!,
        },
        historicalContext: {
          memoryIds: historicalContextMemoryIds,
          memoryVersions: historicalContextMemoryVersions,
        },
      }
      : {}),
  });
  const proposal: MemoryConsolidationProposal = {
    ...identity,
    key,
    handle: fingerprintId("mcph", `${key}:${proposalHash}`),
    proposalHash,
    status: "prepared",
    preparedAt: new Date().toISOString(),
    ...(options.project === undefined ? {} : { project: options.project }),
    concept,
    sourceObservationIds,
    ...(parsedResult.kind === "memory"
      ? { parsed: parsedResult.parsed }
      : {
        noEffectProof: {
          kind: "strict_legal_empty" as const,
          reasonCode: parsedResult.reasonCode,
        },
      }),
    ...(contributionId
      ? {
        stageContractVersion: options.stageContractVersion ?? MEMORY_CONSOLIDATE_CONTRACT_VERSION,
        contributionId,
        sourceVersionKeys,
        historicalContextMemoryIds,
        deltaEvidence: {
          observationIds: sourceObservationIds,
          sessionIds: deltaSessionIds,
          sourceVersionKeys: sourceVersionKeys!,
        },
        historicalContext: {
          memoryIds: historicalContextMemoryIds,
          memoryVersions: historicalContextMemoryVersions,
        },
      }
      : {}),
    totalObservations,
    promptChars,
    ...(options.charBudget === undefined ? {} : { charBudget: options.charBudget }),
  };
  await options.kv.set(KV.memoryConsolidationProposal(key), key, proposal);
  return proposalResponse(proposal);
}

export async function commitMemoryConsolidationProposal(options: {
  kv: StateKV;
  identity: ExtractionOperationIdentity;
  preparedHandle: string;
  proposalHash?: string;
}): Promise<Record<string, unknown>> {
  const key = proposalKey(options.identity);
  return withKeyedLock("memory-consolidate-commit", async () => {
    const proposal = await options.kv.get<MemoryConsolidationProposal>(
      KV.memoryConsolidationProposal(key),
      key,
    );
    if (!proposal) {
      return { success: false, status: "failed", failure: { class: "hard", cause: "proposal_not_found" } };
    }
    const expectedProposalHash = memoryProposalHash(proposal);
    if (
      proposal.key !== key
      || proposal.runId !== options.identity.runId
      || proposal.unitId !== options.identity.unitId
      || proposal.inputHash !== options.identity.inputHash
      || proposal.handle !== options.preparedHandle
      || proposal.proposalHash !== expectedProposalHash
      || proposal.handle !== fingerprintId("mcph", `${key}:${expectedProposalHash}`)
      || (options.proposalHash !== undefined && proposal.proposalHash !== options.proposalHash)
      || proposal.stage !== "memory_consolidate"
    ) {
      return { success: false, status: "failed", failure: { class: "hard", cause: "proposal_identity_conflict" } };
    }
    const frozenHistoricalContext = proposal.stageContractVersion
      && proposal.status !== "committed"
      && !proposal.commitIntent
      ? await verifyFrozenHistoricalContext(options.kv, proposal)
      : undefined;
    if (proposal.stageContractVersion && proposal.status !== "committed" && !proposal.commitIntent
      && frozenHistoricalContext === null) {
      return committedMemoryFailure("memory_consolidate_historical_context_conflict");
    }
    if (proposal.status === "committed") {
      const verificationFailure = await verifyCommittedMemoryProposal(options.kv, proposal);
      if (verificationFailure) return verificationFailure;
      return proposal.noEffectProof
        ? {
          ...proposalResponse(proposal),
          noEffectEvidence: memoryNoEffectEvidence(proposal),
        }
        : {
          ...proposalResponse(proposal),
          domainEffectEvidence: memoryDomainEffectEvidence(proposal),
        };
    }

    if (proposal.noEffectProof) {
      proposal.status = "committed";
      proposal.response = {
        success: true,
        status: "skipped",
        consolidated: 0,
        totalObservations: proposal.totalObservations,
        memoryIds: [],
      };
      await options.kv.set(KV.memoryConsolidationProposal(key), key, proposal);
      return {
        ...proposalResponse(proposal),
        noEffectEvidence: memoryNoEffectEvidence(proposal),
      };
    }
    const parsed = proposal.parsed;
    if (!parsed) return committedMemoryFailure("memory_consolidate_proposal_missing_parsed_result");

    const deterministicResultId = fingerprintId(
      "mem",
      JSON.stringify([key, proposal.proposalHash]),
    );
    const deterministicAuditId = fingerprintId(
      "aud",
      JSON.stringify([key, proposal.proposalHash]),
    );
    let intent = proposal.commitIntent;
    if (!intent) {
      const recoveredResult = await options.kv.get<Memory>(
        KV.memories,
        deterministicResultId,
      );
      const parent = recoveredResult
        ? null
        : proposal.stageContractVersion
          ? (frozenHistoricalContext ?? []).find((memory) =>
              memory.isLatest === true
              && memory.id !== deterministicResultId
              && memory.title.toLowerCase() === parsed.title.toLowerCase()
              && (!proposal.project || !memory.project || memory.project === proposal.project),
            ) ?? null
          : (await options.kv.list<Memory>(KV.memories)).find(
              (memory) =>
                memory.id !== deterministicResultId
                && memory.title.toLowerCase() === parsed.title.toLowerCase()
                && (!proposal.project || !memory.project || memory.project === proposal.project),
            );
      const parentId = recoveredResult?.parentId ?? parent?.id;
      const createdAt = recoveredResult?.createdAt ?? new Date().toISOString();
      intent = {
        resultId: deterministicResultId,
        ...(parentId ? { parentId } : {}),
        auditId: deterministicAuditId,
        createdAt,
      };
      proposal.status = "committing";
      proposal.commitIntent = intent;
      await options.kv.set(KV.memoryConsolidationProposal(key), key, proposal);
    }

    const parent = intent.parentId
      ? await options.kv.get<Memory>(KV.memories, intent.parentId)
      : null;
    if (parent?.isLatest) {
      parent.isLatest = false;
      parent.updatedAt = intent.createdAt;
      await options.kv.set(KV.memories, parent.id, parent);
    }
    const persistedResult = await options.kv.get<Memory>(KV.memories, intent.resultId);
    const memory: Memory = persistedResult ?? {
      id: intent.resultId,
      createdAt: intent.createdAt,
      updatedAt: intent.createdAt,
      ...parsed,
      version: parent ? (parent.version || 1) + 1 : 1,
      ...(parent ? {
        parentId: parent.id,
        supersedes: [parent.id, ...(parent.supersedes || [])],
      } : {}),
      sourceObservationIds: proposal.sourceObservationIds,
      isLatest: true,
      ...(proposal.project === undefined ? {} : { project: proposal.project }),
    };
    await options.kv.set(KV.memories, memory.id, memory);
    const evolvedParentId = memory.parentId ?? intent.parentId;
    const evolved = Boolean(evolvedParentId);
    const audit: AuditEntry = {
      id: intent.auditId,
      timestamp: intent.createdAt,
      operation: evolved ? "evolve" : "remember",
      functionId: "mem::full-memory-consolidate-window-commit",
      targetIds: [memory.id],
      details: {
        action: evolved ? "evolve_memory" : "create_memory",
        ...(evolvedParentId ? { oldId: evolvedParentId } : {}),
        newId: memory.id,
        concept: proposal.concept,
      },
    };
    await options.kv.set(KV.audit, audit.id, audit);
    proposal.status = "committed";
    proposal.response = {
      success: true,
      status: "succeeded",
      consolidated: 1,
      totalObservations: proposal.totalObservations,
      memoryIds: [memory.id],
      action: evolved ? "evolved" : "created",
      memoryId: memory.id,
      ...(evolvedParentId ? { parentId: evolvedParentId } : {}),
    };
    await options.kv.set(KV.memoryConsolidationProposal(key), key, proposal);
    return await verifyCommittedMemoryProposal(options.kv, proposal)
      ?? {
        ...proposalResponse(proposal),
        domainEffectEvidence: memoryDomainEffectEvidence(proposal),
      };
  });
}

async function relevantHistoricalMemories(
  kv: StateKV,
  concept: string,
  project?: string,
): Promise<Memory[]> {
  const normalizedConcept = concept.toLowerCase();
  return (await kv.list<Memory>(KV.memories))
    .filter((memory) => memory.isLatest)
    .filter((memory) => !project || !memory.project || memory.project === project)
    .filter((memory) =>
      memory.concepts.some((item) => item.toLowerCase() === normalizedConcept)
      || memory.title.toLowerCase().includes(normalizedConcept)
      || memory.content.toLowerCase().includes(normalizedConcept),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);
}

function historicalMemoryVersionHash(memory: Memory): string {
  return createHash("sha256")
    .update(stableStringify({
      id: memory.id,
      type: memory.type,
      title: memory.title,
      content: memory.content,
      concepts: memory.concepts,
      files: memory.files,
      sessionIds: memory.sessionIds,
      strength: memory.strength,
      version: memory.version,
      isLatest: memory.isLatest,
      updatedAt: memory.updatedAt,
      project: memory.project,
      parentId: memory.parentId,
      supersedes: memory.supersedes,
      sourceObservationIds: memory.sourceObservationIds,
    }))
    .digest("hex");
}

function historicalContextMemoryVersions(
  memories: Memory[],
): Array<{ memoryId: string; versionHash: string }> {
  return memories.map((memory) => ({
    memoryId: memory.id,
    versionHash: historicalMemoryVersionHash(memory),
  }));
}

async function verifyFrozenHistoricalContext(
  kv: StateKV,
  proposal: MemoryConsolidationProposal,
): Promise<Memory[] | null> {
  const expectedIds = proposal.historicalContextMemoryIds;
  const expectedVersions = proposal.historicalContext?.memoryVersions;
  if (
    !expectedIds
    || !expectedVersions
    || expectedIds.length !== expectedVersions.length
    || !sameJsonValue(expectedIds, expectedVersions.map((entry) => entry.memoryId))
  ) return null;
  const memories = await Promise.all(expectedIds.map((memoryId) =>
    kv.get<Memory>(KV.memories, memoryId),
  ));
  if (memories.some((memory) => !memory)) return null;
  const present = memories as Memory[];
  return present.every((memory, index) =>
    memory.isLatest === true
    && historicalMemoryVersionHash(memory) === expectedVersions[index].versionHash,
  ) ? present : null;
}

function serializeHistoricalMemoryContext(memories: Memory[]): string {
  if (memories.length === 0) return "(none)";
  return memories.map((memory) =>
    `[${memory.type}] ${memory.title}\n${memory.content}\nVersion: ${memory.version}; Strength: ${memory.strength}`,
  ).join("\n\n");
}

async function terminalMemoryContributionIsVerified(
  kv: StateKV,
  records: ContributionRecord[],
): Promise<boolean> {
  for (const record of records) {
    const key = proposalKey({
      runId: record.runId,
      stage: "memory_consolidate",
      unitId: record.unitId,
      inputHash: "proposal-key-does-not-bind-input-hash",
    });
    const proposal = await kv.get<MemoryConsolidationProposal>(
      KV.memoryConsolidationProposal(key),
      key,
    );
    if (
      !proposal
      || proposal.key !== key
      || proposal.runId !== record.runId
      || proposal.unitId !== record.unitId
      || proposal.stage !== "memory_consolidate"
      || proposal.status !== "committed"
      || proposal.contributionId !== record.contributionId
      || !proposal.sourceVersionKeys?.includes(record.sourceVersionKey)
      || proposal.proposalHash !== memoryProposalHash(proposal)
      || proposal.handle !== fingerprintId("mcph", `${key}:${proposal.proposalHash}`)
      || await verifyCommittedMemoryProposal(kv, proposal)
    ) return false;
    const receiptRef = record.operationReceiptRef;
    if (!receiptRef || receiptRef.scope !== KV.extractionOperationReceipt(receiptRef.key)) {
      return false;
    }
    const receipt = await kv.get<ExtractionOperationReceipt<Record<string, unknown>>>(
      receiptRef.scope,
      receiptRef.key,
    );
    if (receipt?.status !== "succeeded") return false;
    if (record.state === "no_effect") {
      const expectedEvidence = memoryNoEffectEvidence(proposal);
      if (
        !proposal.noEffectProof
        ||
        record.noEffectProof?.kind !== "strict_legal_empty"
        || record.noEffectProof.receiptKey !== receiptRef.key
        || record.noEffectProof.reasonCode !== proposal.noEffectProof.reasonCode
        || receipt.response?.status !== "skipped"
        || receipt.response?.consolidated !== 0
        || !sameJsonValue(receipt.response?.noEffectEvidence, expectedEvidence)
      ) return false;
      continue;
    }
    if (record.state !== "committed" || proposal.noEffectProof || !proposal.commitIntent) return false;
    const effect = record.effectRefs?.find((ref) => ref.scope === KV.memories);
    const receiptEvidence = receipt.response?.domainEffectEvidence;
    const expectedEvidence = memoryDomainEffectEvidence(proposal);
    if (
      !effect
      || !receiptEvidence
      || typeof receiptEvidence !== "object"
      || Array.isArray(receiptEvidence)
      || effect.key !== proposal.commitIntent.resultId
      || effect.effectHash !== expectedEvidence.effectHash
      || !sameJsonValue(receiptEvidence, expectedEvidence)
    ) return false;
  }
  return true;
}

export async function reconcileMemoryConsolidationContribution(
  kv: StateKV,
  prepareIdentity: ExtractionOperationIdentity,
  commitIdentity: ExtractionOperationIdentity,
): Promise<void> {
  const key = proposalKey(prepareIdentity);
  const proposal = await kv.get<MemoryConsolidationProposal>(
    KV.memoryConsolidationProposal(key),
    key,
  );
  if (
    !proposal
    || proposal.status !== "committed"
    || !proposal.stageContractVersion
    || !proposal.contributionId
    || !proposal.sourceVersionKeys?.length
  ) return;
  const failure = await verifyCommittedMemoryProposal(kv, proposal);
  if (failure) throw new Error("memory_consolidate_contribution_effect_conflict");
  const receiptKey = buildExtractionOperationKey(commitIdentity);
  const receiptScope = KV.extractionOperationReceipt(receiptKey);
  const receipt = await kv.get<ExtractionOperationReceipt<Record<string, unknown>>>(
    receiptScope,
    receiptKey,
  );
  if (receipt?.status !== "succeeded") {
    throw new Error("memory_consolidate_contribution_receipt_missing");
  }
  if (proposal.noEffectProof) {
    if (!sameJsonValue(receipt.response?.noEffectEvidence, memoryNoEffectEvidence(proposal))) {
      throw new Error("memory_consolidate_contribution_no_effect_proof_conflict");
    }
    await markClaimedBatchNoEffect(kv, {
      stage: "memory_consolidate",
      stageContractVersion: proposal.stageContractVersion,
      contributionId: proposal.contributionId,
      sourceVersionKeys: proposal.sourceVersionKeys,
      operationReceiptRef: { scope: receiptScope, key: receiptKey },
      receiptKey,
      reasonCode: proposal.noEffectProof.reasonCode,
    });
  } else {
    const evidence = memoryDomainEffectEvidence(proposal);
    await commitClaimedBatch(kv, {
      stage: "memory_consolidate",
      stageContractVersion: proposal.stageContractVersion,
      contributionId: proposal.contributionId,
      sourceVersionKeys: proposal.sourceVersionKeys,
      operationReceiptRef: { scope: receiptScope, key: receiptKey },
      effectRefs: [{
        scope: KV.memories,
        key: proposal.commitIntent!.resultId,
        effectHash: String(evidence.effectHash),
      }],
    });
  }
  await Promise.all(proposal.sourceVersionKeys.flatMap((sourceVersionKey) => [
    kv.delete(KV.memoryConsolidationBacklog(proposal.project), sourceVersionKey),
    kv.delete(
      KV.memoryConsolidationBacklogSourceIndex(proposal.project),
      decodeURIComponent(sourceVersionKey.split("|")[2]),
    ),
  ]));
}

export async function runConsolidateObservationWindow(
  options: ConsolidateObservationWindowOptions,
): Promise<Record<string, unknown>> {
  const startMs = Date.now();
  const telemetry: ProviderCallTelemetry[] = [];
  let nextCallIndex = 0;
  const stageMetadata = resolveStageModelMetadata("memory_consolidate", options.provider, options.model);
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
    stageContractVersion: string;
  } | undefined;
  let proposalPersisted = false;
  try {
    resolveOutputLanguage();
    if (!options.provider?.compress) {
      return { success: false, error: "provider.compress is required", ...responseMetadata("failed") };
    }
    if (options.operationIdentity && !options.operationReceiptManaged) {
      const receipt = await options.kv.get<ExtractionOperationReceipt<Record<string, unknown>>>(
        KV.extractionOperationReceipt(buildExtractionOperationKey(options.operationIdentity)),
        buildExtractionOperationKey(options.operationIdentity),
      );
      if (receipt && receipt.inputHash !== options.operationIdentity.inputHash) {
        return {
          success: false,
          status: "failed",
          failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
        };
      }
      if (receipt?.status === "running") {
        return {
          success: false,
          status: "failed",
          failure: { class: "transient_runtime", cause: "extraction_operation_reconciliation_required" },
        };
      }
      if (receipt?.status === "failed") {
        return {
          success: false,
          status: "failed",
          failure: receipt.failure ?? { class: "unit", cause: "extraction_operation_failed" },
        };
      }
      if (receipt?.status === "succeeded" && receipt.response) {
        return {
          ...receipt.response,
          success: true,
          status: typeof receipt.response.status === "string"
            ? receipt.response.status
            : "succeeded",
          replayed: true,
        };
      }
      const existing = await options.kv.get<MemoryConsolidationProposal>(
        KV.memoryConsolidationProposal(proposalKey(options.operationIdentity)),
        proposalKey(options.operationIdentity),
      );
      if (existing) {
        if (existing.inputHash !== options.operationIdentity.inputHash) {
          return {
            success: false,
            status: "failed",
            failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
          };
        }
        return proposalResponse(existing);
      }
    }

    const hasExplicitObservationIds = (options.observationIds?.length ?? 0) > 0;
    const minObs = options.minObservations ?? (hasExplicitObservationIds ? 1 : 3);
    const scopedProject =
      typeof options.project === "string" && options.project.trim().length > 0
        ? options.project.trim()
        : undefined;
    const selectedIds = new Set(options.observationIds ?? []);
    const hasCompleteSessionMap =
      selectedIds.size > 0
      && options.observationSessionIds !== undefined
      && [...selectedIds].every((observationId) =>
        typeof options.observationSessionIds?.[observationId] === "string"
        && options.observationSessionIds[observationId].trim().length > 0);
    const allObs = hasCompleteSessionMap
      ? await collectConsolidationObservationsById(
        options.kv,
        [...selectedIds],
        options.observationSessionIds!,
        options.minImportance ?? 5,
      )
      : await collectConsolidationObservations(
        options.kv,
        scopedProject,
        options.minImportance ?? 5,
      );
    let obsGroup = selectedIds.size > 0
      ? allObs.filter((obs) => selectedIds.has(obs.id))
      : [];

    const concept = options.concept?.trim().toLowerCase();
    if (obsGroup.length === 0 && concept) {
      const groups = groupObservationsByConcept(allObs, minObs);
      obsGroup = groups.get(concept) ?? [];
    }

    if (obsGroup.length < minObs) {
      return {
        success: true,
        consolidated: 0,
        reason: "insufficient_observations",
        totalObservations: obsGroup.length,
        ...responseMetadata("skipped"),
      };
    }

    const sorted = [...obsGroup].sort((a, b) => b.importance - a.importance);
    const sessionIds = [...new Set(sorted.map((o) => o.sid))];
    const baseline = await partitionAdoptedBaselineSessions(options.kv, {
      stage: "memory_consolidate",
      stageContractVersion: MEMORY_CONSOLIDATE_CONTRACT_VERSION,
      sessionIds,
    });
    if (baseline.adoptedSessionIds.length > 0) {
      return {
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "memory_consolidate_source_adopted_baseline" },
      };
    }
    const prompt = serializeConsolidationObservationPrompt(sorted);
    const computedSourceVersionKeys = sorted.map(memoryConsolidationSourceVersionKey).sort();
    const incrementalContributionRequested = Boolean(
      options.stageContractVersion || options.sourceVersionKeys?.length,
    );
    const requestedSourceVersionKeys = [...(options.sourceVersionKeys ?? computedSourceVersionKeys)].sort();
    if (!sameJsonValue(computedSourceVersionKeys, requestedSourceVersionKeys)) {
      return {
        success: false,
        status: "failed",
        failure: { class: "hard", cause: "memory_consolidate_source_version_conflict" },
      };
    }
    if (options.operationIdentity) {
      const sourceObservationIds = sorted.map((observation) => observation.id);
      const plannedInputHash = stableHash([
        "memory-consolidate",
        concept ?? "observation-window",
        options.sourceVersionKeys?.length ? requestedSourceVersionKeys : sourceObservationIds,
        sessionIds,
        prompt.length,
      ]);
      const splitInputHash = stableHash({
        unitId: options.operationIdentity.unitId,
        sourceIds: sourceObservationIds,
      });
      if (
        options.operationIdentity.inputHash !== plannedInputHash
        && options.operationIdentity.inputHash !== splitInputHash
      ) {
        return {
          success: false,
          error: "memory_consolidate_input_hash_conflict",
          failure: { class: "hard", cause: "extraction_operation_input_hash_conflict" },
          ...responseMetadata("failed", {
            promptChars: prompt.length,
            charBudget: options.charBudget,
            parseFailures: 0,
          }),
        };
      }
    }
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
    if (options.operationIdentity && incrementalContributionRequested) {
      const stageContractVersion = options.stageContractVersion
        ?? MEMORY_CONSOLIDATE_CONTRACT_VERSION;
      const claim = await claimBatch(options.kv, {
        stage: "memory_consolidate",
        stageContractVersion,
        runId: options.operationIdentity.runId,
        unitId: options.operationIdentity.unitId,
        sourceVersionKeys: requestedSourceVersionKeys,
      });
      if (claim.status === "already_committed") {
        if (!await terminalMemoryContributionIsVerified(options.kv, claim.records)) {
          return {
            success: false,
            failure: {
              class: "hard",
              cause: "memory_consolidate_contribution_effect_reconciliation_required",
            },
            ...responseMetadata("failed"),
          };
        }
        return {
          success: true,
          consolidated: 0,
          reason: "already_contributed",
          totalObservations: sorted.length,
          replayed: true,
          ...responseMetadata("skipped"),
        };
      }
      if (claim.status === "claimed_by_other") {
        return {
          success: false,
          failure: {
            class: "transient_runtime",
            cause: "extraction_operation_reconciliation_required",
          },
          ...responseMetadata("failed"),
        };
      }
      if (claim.status === "contract_migration_required") {
        return {
          success: false,
          failure: {
            class: "hard",
            cause: "memory_consolidate_contract_migration_required",
          },
          ...responseMetadata("failed"),
        };
      }
      claimedContribution = {
        contributionId: claim.records[0].contributionId,
        sourceVersionKeys: requestedSourceVersionKeys,
        stageContractVersion,
      };
    }
    const historicalContext = incrementalContributionRequested
      ? await relevantHistoricalMemories(
        options.kv,
        concept ?? "observation-window",
        scopedProject,
      )
      : [];
    const callOptions = modelOptionsFromMemoryConsolidate(options.model);
    const timeoutMs = getMemoryConsolidateCompressTimeoutMs();
    const callIndex = nextCallIndex++;
    const callStartMs = Date.now();
    let response: string;
    try {
      response = await Promise.race([
        compressWithOptions(
          options.provider,
          withOutputLanguagePolicy(CONSOLIDATION_SYSTEM),
          incrementalContributionRequested
            ? `Concept: "${concept ?? "observation-window"}"\n\nDelta evidence (the only new contribution):\n${prompt}\n\nHistorical context (read-only; do not count as new evidence):\n${serializeHistoricalMemoryContext(historicalContext)}`
            : `Concept: "${concept ?? "observation-window"}"\n\nObservations:\n${prompt}`,
          callOptions,
          telemetry,
          callIndex,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`compress timeout after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
    } catch (error) {
      if (!telemetry.some((item) => item.callIndex === callIndex)) {
        telemetry.push({
          operation: "compress",
          callRole: "window",
          callIndex,
          durationMs: Date.now() - callStartMs,
          metadataStatus: "unsupported",
        });
      }
      throw error;
    }
    const parsedResult = parseMemoryProviderResponse(
      response,
      sessionIds,
      incrementalContributionRequested,
    );
    if (!parsedResult) {
      if (claimedContribution) {
        await releaseClaimedBatch(options.kv, {
          stage: "memory_consolidate",
          ...claimedContribution,
        });
        claimedContribution = undefined;
      }
      return {
        success: false,
        error: "failed to parse memory XML",
        totalObservations: sorted.length,
        ...responseMetadata("failed", {
          promptChars: prompt.length,
          charBudget: options.charBudget,
          parseFailures: 1,
        }),
      };
    }

    if (options.operationIdentity) {
      const stored = await storeMemoryConsolidationProposal(
        options,
        parsedResult,
        concept ?? "observation-window",
        [...new Set(sorted.map((o) => o.id))],
        sorted.length,
        prompt.length,
        claimedContribution?.contributionId,
        claimedContribution?.sourceVersionKeys,
        historicalContext.map((memory) => memory.id),
        historicalContextMemoryVersions(historicalContext),
        sessionIds,
      );
      proposalPersisted = stored.success === true;
      return stored;
    }
    if (parsedResult.kind === "no_effect") {
      return {
        success: true,
        consolidated: 0,
        reason: parsedResult.reasonCode,
        totalObservations: sorted.length,
        ...responseMetadata("skipped"),
      };
    }
    const existingMemories = await options.kv.list<Memory>(KV.memories);
    const persisted = await persistConsolidatedMemory(
      options.kv,
      parsedResult.parsed,
      existingMemories,
      concept ?? "observation-window",
      [...new Set(sorted.map((o) => o.id))],
      scopedProject,
    );
    return {
      success: true,
      consolidated: 1,
      totalObservations: sorted.length,
      memoryIds: [persisted.memoryId],
      ...persisted,
      ...responseMetadata("succeeded", {
        promptChars: prompt.length,
        charBudget: options.charBudget,
        parseFailures: 0,
      }),
    };
  } catch (err) {
    if (claimedContribution && !proposalPersisted && options.operationIdentity) {
      try {
        proposalPersisted = Boolean(await options.kv.get<MemoryConsolidationProposal>(
          KV.memoryConsolidationProposal(proposalKey(options.operationIdentity)),
          proposalKey(options.operationIdentity),
        ));
      } catch {
        proposalPersisted = true;
      }
    }
    if (claimedContribution && !proposalPersisted) {
      try {
        await releaseClaimedBatch(options.kv, {
          stage: "memory_consolidate",
          ...claimedContribution,
        });
      } catch {
        return {
          success: false,
          failure: {
            class: "transient_runtime",
            cause: "extraction_operation_reconciliation_required",
          },
          ...responseMetadata("failed"),
        };
      }
    }
    if (isProviderPreflightError(err)) {
      const status = providerPreflightStatus(err);
      return { success: false, error: status, ...responseMetadata(status) };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Full consolidation window failed", { error: msg });
    return { success: false, error: msg, ...responseMetadata("failed") };
  }
}

export function registerConsolidateFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::full-memory-consolidate-windows-plan",
    async (data: {
      plannerId?: string;
      project?: string;
      sessionIds?: string[];
      descriptors?: ConsolidationObservationDescriptor[];
      minImportance?: number;
      minObservationsPerConcept?: number;
      maxObservationsPerWindow?: number;
      charBudget?: number;
      windowOffset?: number;
      windowLimit?: number;
    }) => data.plannerId
      ? finalizeBufferedConsolidationObservationPlan({ kv, ...data, plannerId: data.plannerId })
      : planConsolidateObservationWindows({ kv, ...data }),
  );

  sdk.registerFunction(
    "mem::full-memory-consolidate-observations-page",
    async (data: {
      plannerId?: string;
      project?: string;
      sessionIds?: string[];
      minImportance?: number;
      sessionOffset?: number;
      sessionLimit?: number;
    }) => data.plannerId
      ? collectBufferedConsolidationObservationDescriptorPage({ kv, ...data, plannerId: data.plannerId })
      : collectConsolidationObservationDescriptorPage({ kv, ...data }),
  );

  sdk.registerFunction(
    "mem::full-memory-consolidate-window",
    async (data: {
      project?: string;
      concept?: string;
      observationIds?: string[];
      observationSessionIds?: Record<string, string>;
      minObservations?: number;
      charBudget?: number;
      model?: string;
      stageContractVersion?: string;
      sourceVersionKeys?: string[];
    }) => withKeyedLock(
      "memory-consolidate-commit",
      () => runConsolidateObservationWindow({ kv, provider, ...data }),
    ),
  );

  sdk.registerFunction(
    "mem::full-memory-consolidate-window-prepare",
    async (data: {
      identity: ExtractionOperationIdentity;
      project?: string;
      concept?: string;
      observationIds?: string[];
      observationSessionIds?: Record<string, string>;
      minObservations?: number;
      charBudget?: number;
      model?: string;
      operationReceiptManaged?: boolean;
      stageContractVersion?: string;
      sourceVersionKeys?: string[];
    }) => withKeyedLock(
      `memory-consolidate-prepare:${proposalKey(data.identity)}`,
      () => runConsolidateObservationWindow({
        kv,
        provider,
        ...data,
        operationIdentity: data.identity,
      }),
    ),
  );

  sdk.registerFunction(
    "mem::full-memory-consolidate-window-commit",
    async (data: {
      identity: ExtractionOperationIdentity;
      preparedHandle: string;
      proposalHash?: string;
    }) => commitMemoryConsolidationProposal({ kv, ...data }),
  );

  sdk.registerFunction("mem::consolidate", 
    async (data: { project?: string; minObservations?: number; model?: string }) => {
      resolveOutputLanguage();
      const minObs = data.minObservations ?? 10;

      const allObs = await collectConsolidationObservations(kv, data.project);

      if (allObs.length < minObs) {
        return { consolidated: 0, reason: "insufficient_observations" };
      }

      const conceptGroups = groupObservationsByConcept(allObs, 3);

      let consolidated = 0;
      const existingMemories = await kv.list<Memory>(KV.memories);
      const MAX_LLM_CALLS = 10;
      let llmCallCount = 0;
      const telemetry: ProviderCallTelemetry[] = [];
      let nextCallIndex = 0;
      const callOptions = modelOptionsFromMemoryConsolidate(data.model);

      const sortedGroups = [...conceptGroups.entries()]
        .filter(([, g]) => g.length >= 3)
        .sort((a, b) => b[1].length - a[1].length);

      for (const [concept, obsGroup] of sortedGroups) {
        if (llmCallCount >= MAX_LLM_CALLS) break;

        const top = obsGroup
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 8);
        const sessionIds = [...new Set(top.map((o) => o.sid))];

        const prompt = top
          .map(
            (o) =>
              `[${o.type}] ${o.title}\n${o.narrative}\nFiles: ${o.files.join(", ")}\nImportance: ${o.importance}`,
          )
          .join("\n\n");

        const callIndex = nextCallIndex++;
        const callStartMs = Date.now();
        try {
          const response = await Promise.race([
            compressWithOptions(
              provider,
              withOutputLanguagePolicy(CONSOLIDATION_SYSTEM),
              `Concept: "${concept}"\n\nObservations:\n${prompt}`,
              callOptions,
              telemetry,
              callIndex,
            ),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`compress timeout after ${getMemoryConsolidateCompressTimeoutMs()}ms`)),
                getMemoryConsolidateCompressTimeoutMs(),
              ),
            ),
          ]);
          llmCallCount++;
          const parsed = parseMemoryXml(response, sessionIds);
          if (!parsed) continue;

          const obsIds = [...new Set(top.map((o) => o.id))];
          const scopedProject =
            typeof data.project === "string" && data.project.trim().length > 0
              ? data.project.trim()
              : undefined;

          // A scoped consolidation run must only evolve memories that belong
          // to the same project. Without this guard, two projects that happen
          // to consolidate observations into an identically-titled memory would
          // cause one project's memory to silently evolve the other's — the
          // exact class of cross-project corruption this fix is designed to
          // prevent. An unscoped run (no data.project, background cron path)
          // preserves the pre-existing behavior and may evolve any memory.
          await persistConsolidatedMemory(
            kv,
            parsed,
            existingMemories,
            concept,
            obsIds,
            scopedProject,
          );
          consolidated++;
        } catch (err) {
          if (!telemetry.some((item) => item.callIndex === nextCallIndex - 1)) {
            telemetry.push({
              operation: "compress",
              callRole: "window",
              callIndex: nextCallIndex - 1,
              durationMs: Date.now() - callStartMs,
              metadataStatus: "unsupported",
            });
          }
          logger.warn("Consolidation failed for concept", {
            concept,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info("Consolidation complete", {
        consolidated,
        totalObs: allObs.length,
      });
      return {
        consolidated,
        totalObservations: allObs.length,
        telemetry: sortProviderCallTelemetry(telemetry),
      };
    },
  );
}

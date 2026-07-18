import type { ISdk } from "iii-sdk";
import { createHash } from "node:crypto";
import type {
  CompressedObservation,
  Memory,
  Session,
  MemoryProvider,
  MemoryProviderCallOptions,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import {
  resolveOutputLanguage,
  withOutputLanguagePolicy,
} from "../prompts/output-language.js";

const CONSOLIDATION_SYSTEM = `You are a memory consolidation engine. Given a set of related observations from coding sessions, synthesize them into a single long-term memory.

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
</memory>`;

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
}

export interface ConsolidationObservationDescriptor {
  id: string;
  sid: string;
  concepts: string[];
  importance: number;
  estimatedChars: number;
}

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
  };
}

export async function collectConsolidationObservationDescriptorPage(options: {
  kv: StateKV;
  project?: string;
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
  const sessions = await options.kv.list<Session>(KV.sessions);
  const scopedProject =
    typeof options.project === "string" && options.project.trim().length > 0
      ? options.project.trim()
      : undefined;
  const filtered = scopedProject
    ? sessions.filter((session) => session.project === scopedProject)
    : sessions;
  const sessionOffset = Math.max(0, options.sessionOffset ?? 0);
  const sessionLimit = Math.min(8, Math.max(1, options.sessionLimit ?? 8));
  const page = filtered.slice(sessionOffset, sessionOffset + sessionLimit);
  const observations = await Promise.all(
    page.map((session) =>
      options.kv
        .list<CompressedObservation>(KV.observations(session.id))
        .catch(() => [] as CompressedObservation[]),
    ),
  );
  const minImportance = options.minImportance ?? 5;
  const descriptors: ConsolidationObservationDescriptor[] = [];
  for (let index = 0; index < page.length; index++) {
    for (const obs of observations[index]) {
      if (obs.title && obs.importance >= minImportance) {
        descriptors.push(observationDescriptor(obs, page[index].id));
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
  minImportance?: number;
  sessionOffset?: number;
  sessionLimit?: number;
}): Promise<Record<string, unknown>> {
  cleanExpiredConsolidationPlanBuffers();
  const page = await collectConsolidationObservationDescriptorPage(options);
  const plannerInputHash = stableHash({
    project: options.project?.trim() || null,
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
      descriptors: buffer.descriptors,
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

function descriptorChunksByBudget(
  descriptors: ConsolidationObservationDescriptor[],
  maxObservationsPerWindow: number,
  charBudget?: number,
): ConsolidationObservationDescriptor[][] {
  const chunks: ConsolidationObservationDescriptor[][] = [];
  let current: ConsolidationObservationDescriptor[] = [];
  let currentChars = 0;
  const maxCount = Math.max(1, maxObservationsPerWindow);
  for (const descriptor of descriptors) {
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
    inputHash: stableHash(["memory-consolidate", concept, observationIds, sessionIds, estimatedChars]),
  };
}

export async function planConsolidateObservationWindows(options: {
  kv: StateKV;
  descriptors?: ConsolidationObservationDescriptor[];
  project?: string;
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
  const descriptors = options.descriptors ?? (await (async () => {
    const collected: ConsolidationObservationDescriptor[] = [];
    let sessionOffset = 0;
    while (true) {
      const page = await collectConsolidationObservationDescriptorPage({
        kv: options.kv,
        project: options.project,
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
      for (const obs of chunk) coveredObservationIds.add(obs.id);
      windows.push(consolidateWindowFromDescriptors(concept, chunk, i, charBudget));
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
  if (remaining.length > 0) {
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
  try {
    resolveOutputLanguage();
    if (!options.provider?.compress) {
      return { success: false, error: "provider.compress is required", ...responseMetadata("failed") };
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
    const prompt = serializeConsolidationObservationPrompt(sorted);
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
          `Concept: "${concept ?? "observation-window"}"\n\nObservations:\n${prompt}`,
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
    const parsed = parseMemoryXml(response, sessionIds);
    if (!parsed) {
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

    const existingMemories = await options.kv.list<Memory>(KV.memories);
    const persisted = await persistConsolidatedMemory(
      options.kv,
      parsed,
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
    }) => runConsolidateObservationWindow({ kv, provider, ...data }),
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

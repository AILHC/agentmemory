import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type {
  SemanticMemory,
  ProceduralMemory,
  SessionSummary,
  Memory,
  MemoryProvider,
  MemoryProviderCallOptions,
  ExtractionOperationReceipt,
  ConsolidationProceduralBacklogRecord,
  ContributionEffectRef,
  ContributionRecord,
  AuditEntry,
} from "../types.js";
import { KV, fingerprintId, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  SEMANTIC_MERGE_SYSTEM,
  buildSemanticMergePrompt,
  PROCEDURAL_EXTRACTION_SYSTEM,
  buildProceduralExtractionPrompt,
  SEMANTIC_MERGE_OUTPUT_CONTRACT,
} from "../prompts/consolidation.js";
import {
  resolveOutputLanguage,
  withOutputLanguagePolicy,
} from "../prompts/output-language.js";
import {
  parseFactResponse,
  type ParsedSemanticFact,
} from "../prompts/facts.js";
import {
  AUDIT_ENTRY_CONFLICT,
  AUDIT_ENTRY_MISSING,
  recordAudit,
} from "./audit.js";
import {
  getConsolidationDecayDays,
  isConsolidationEnabled,
  resolveStageModelCallOptions,
  resolveStageModelMetadata,
} from "../config.js";
import { logger } from "../logger.js";
import {
  callProviderWithTelemetry,
  isProviderPreflightError,
  providerPreflightStatus,
  sortProviderCallTelemetry,
  type ProviderCallTelemetry,
} from "../providers/provider-call-result.js";
import { buildExtractionOperationKey } from "./extraction-operation-receipts.js";
import {
  buildSourceVersionKey,
  claimBatch,
  commitClaimedBatch,
  inspectContributionCandidates,
  markClaimedBatchNoEffect,
  releaseClaimedBatch,
} from "./extraction-contributions.js";

export const CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT =
  "consolidation_procedural/v1";

export interface ConsolidationProceduralWindow {
  windowId: string;
  memoryIds: string[];
  stageContractVersion: typeof CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT;
  sourceVersionKeys: string[];
  patternCount: number;
  project?: string;
  isolateReason?: string;
  blockReason?: string;
}

export interface ConsolidationProceduralWindowOptions {
  kv: StateKV;
  provider: MemoryProvider;
  memoryIds?: string[];
  project?: string;
  maxItemsPerWindow?: number;
  model?: string;
  stageContractVersion?: string;
  sourceVersionKeys?: string[];
  recoveryIdentity?: { runId: string; unitId: string; inputHash: string };
}

const PROCEDURAL_RECOVERY_SCHEMA = "consolidation-procedural-recovery/v1";
const PROCEDURAL_RECOVERY_COMMIT_LOCK =
  "recovery-effect-commit:consolidation-procedural";
const PROCEDURAL_RECOVERY_HARD_FAILURES = new Set([
  "consolidation_procedural_recovery_identity_conflict",
  "consolidation_procedural_recovery_receipt_unavailable",
  "consolidation_procedural_source_mutation_conflict",
  "consolidation_procedural_committed_result_missing",
  "consolidation_procedural_committed_result_conflict",
  "consolidation_procedural_audit_conflict",
  "consolidation_procedural_committed_audit_missing",
  "consolidation_procedural_contribution_reconciliation_required",
  "consolidation_procedural_contribution_contract_migration_required",
  "consolidation_procedural_source_correction_requires_migration",
  "consolidation_procedural_source_version_conflict",
  "consolidation_procedural_source_drifted_before_commit",
  "consolidation_procedural_terminal_reconciliation_required",
]);

interface ProceduralRecoverySourcePattern {
  memoryId: string;
  sourceVersionKey: string;
  snapshotHash: string;
  content: string;
  frequency: number;
  updatedAt: string;
  project?: string;
}

interface ProceduralRecoveryItem {
  id: string;
  name: string;
  steps: string[];
  triggerCondition: string;
  action: "create" | "reinforce";
  mutationId: string;
  effectUpdatedAt?: string;
  baselineEffectHash?: string;
  expectedEffectHash?: string;
  baselineUpdatedAt?: string;
  baselineFrequency?: number;
  baselineStrength?: number;
}

interface ProceduralRecoveryState {
  schema: typeof PROCEDURAL_RECOVERY_SCHEMA;
  identity: { runId: string; unitId: string; inputHash: string };
  phase: "staged" | "committed";
  sourcePatterns: ProceduralRecoverySourcePattern[];
  contribution?: {
    stageContractVersion: typeof CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT;
    contributionId: string;
    sourceVersionKeys: string[];
  };
  promptChars: number;
  noEffectReason?: "no_reusable_procedure";
  items: ProceduralRecoveryItem[];
  model: {
    responseHash: string;
    response: string;
    telemetry: ProviderCallTelemetry[];
    metadata: Record<string, unknown>;
  };
  result?: {
    newProcedures: number;
    patternsAnalyzed: number;
    proceduralMemoryIds: string[];
    auditId: string;
  };
}

type RecoverableProceduralMemory = ProceduralMemory & {
  sourceMutationWatermarks?: Record<string, string>;
};

type ProceduralRecoveryReceipt = ExtractionOperationReceipt<Record<string, unknown>> & {
  proceduralRecovery?: ProceduralRecoveryState;
};

function hasChinese(input: string): boolean {
  return /[\u4e00-\u9fff]/.test(input);
}

function collectLanguageViolations(facts: ParsedSemanticFact[]): string[] {
  return facts.filter((entry) => !hasChinese(entry.fact)).map((entry) => entry.fact);
}

function buildSemanticRetryContractPrompt(): string {
  return [
    SEMANTIC_MERGE_OUTPUT_CONTRACT.semantic?.[0] ?? "每个 <fact> 内容必须使用简体中文。",
    "若仍有非中文 fact，先保留语义与关键技术名词，再补充可读中文句子；保持 XML 与属性不变。",
  ].join("\n");
}

function applyDecay(
  items: Array<{
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
  }>,
  decayDays: number,
): void {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return;
  const now = Date.now();
  for (const item of items) {
    const lastAccess = item.lastAccessedAt || item.updatedAt;
    const daysSince =
      (now - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > decayDays) {
      const decayPeriods = Math.floor(daysSince / decayDays);
      item.strength = Math.max(
        0.1,
        item.strength * Math.pow(0.9, decayPeriods),
      );
    }
  }
}

function eligibleProceduralPatterns(memories: Memory[], project?: string): Memory[] {
  return memories
    .filter((m) => m.isLatest && m.type === "pattern")
    .filter((m) => !project || !m.project || m.project === project)
    .filter((m) => (m.sessionIds.length || 1) >= 2);
}

export function buildConsolidationProceduralSourceSnapshot(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    type: memory.type,
    title: memory.title,
    content: memory.content,
    concepts: [...memory.concepts].sort(),
    files: [...memory.files].sort(),
    sessionIds: [...memory.sessionIds].sort(),
    sourceObservationIds: [...(memory.sourceObservationIds ?? [])].sort(),
    version: memory.version,
    parentId: memory.parentId ?? null,
    isLatest: memory.isLatest,
    project: memory.project ?? null,
    updatedAt: memory.updatedAt,
  };
}

export function buildConsolidationProceduralSourceVersion(memory: Memory): {
  snapshot: Record<string, unknown>;
  snapshotHash: string;
  sourceVersionKey: string;
} {
  const snapshot = buildConsolidationProceduralSourceSnapshot(memory);
  const snapshotHash = stableHash(snapshot);
  return {
    snapshot,
    snapshotHash,
    sourceVersionKey: buildSourceVersionKey(
      "consolidation_procedural",
      "memory",
      memory.id,
      snapshotHash,
    ),
  };
}

function isEligibleProceduralPattern(memory: Memory | null): memory is Memory {
  return Boolean(
    memory
    && memory.isLatest
    && memory.type === "pattern"
    && (memory.sessionIds.length || 1) >= 2,
  );
}

async function deleteProceduralBacklogRecord(
  kv: StateKV,
  record: Pick<ConsolidationProceduralBacklogRecord, "sourceVersionKey" | "memoryId">,
): Promise<void> {
  const indexed = await kv.get<string>(
    KV.consolidationProceduralBacklogSourceIndex,
    record.memoryId,
  );
  await kv.delete(KV.consolidationProceduralBacklog, record.sourceVersionKey);
  if (indexed === record.sourceVersionKey) {
    await kv.delete(KV.consolidationProceduralBacklogSourceIndex, record.memoryId);
  }
}

export async function enqueueConsolidationProceduralBacklog(options: {
  kv: StateKV;
  memoryIds: string[];
  upstreamReceiptRef?: ContributionEffectRef;
}): Promise<{
  success: true;
  enqueued: string[];
  terminal: string[];
  ineligible: string[];
}> {
  const memoryIds = [...new Set(options.memoryIds)];
  if (memoryIds.length !== options.memoryIds.length || memoryIds.some((id) => !id)) {
    throw new Error("invalid_consolidation_procedural_backlog_sources");
  }
  const memories = await Promise.all(memoryIds.map((id) => options.kv.get<Memory>(KV.memories, id)));
  const enqueued: string[] = [];
  const terminal: string[] = [];
  const ineligible: string[] = [];
  for (let index = 0; index < memoryIds.length; index += 1) {
    const memoryId = memoryIds[index];
    const memory = memories[index];
    if (!isEligibleProceduralPattern(memory)) {
      ineligible.push(memoryId);
      continue;
    }
    const source = buildConsolidationProceduralSourceVersion(memory);
    const indexedSourceVersionKey = await options.kv.get<string>(
      KV.consolidationProceduralBacklogSourceIndex,
      memory.id,
    );
    if (indexedSourceVersionKey && indexedSourceVersionKey !== source.sourceVersionKey) {
      const oldContribution = await options.kv.get<ContributionRecord>(
        KV.extractionContributionRecords(
          "consolidation_procedural",
          CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
        ),
        indexedSourceVersionKey,
      );
      if (oldContribution?.state === "claimed") {
        throw new Error("consolidation_procedural_contribution_reconciliation_required");
      }
      await options.kv.delete(KV.consolidationProceduralBacklog, indexedSourceVersionKey);
    }
    const [candidate] = await inspectContributionCandidates(options.kv, {
      stage: "consolidation_procedural",
      stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
      sourceVersionKeys: [source.sourceVersionKey],
    });
    if (candidate.state === "terminal") {
      await deleteProceduralBacklogRecord(options.kv, {
        sourceVersionKey: source.sourceVersionKey,
        memoryId: memory.id,
      });
      terminal.push(memory.id);
      continue;
    }
    const existing = await options.kv.get<ConsolidationProceduralBacklogRecord>(
      KV.consolidationProceduralBacklog,
      source.sourceVersionKey,
    );
    const now = new Date().toISOString();
    const record: ConsolidationProceduralBacklogRecord = {
      sourceVersionKey: source.sourceVersionKey,
      memoryId: memory.id,
      normalizedContentHash: source.snapshotHash,
      ...(memory.project ? { project: memory.project } : {}),
      firstWaitingAt: existing?.firstWaitingAt ?? now,
      updatedAt: now,
      ...(options.upstreamReceiptRef
        ? { upstreamReceiptRef: options.upstreamReceiptRef }
        : existing?.upstreamReceiptRef
          ? { upstreamReceiptRef: existing.upstreamReceiptRef }
          : {}),
    };
    await options.kv.set(KV.consolidationProceduralBacklog, record.sourceVersionKey, record);
    await options.kv.set(
      KV.consolidationProceduralBacklogSourceIndex,
      memory.id,
      record.sourceVersionKey,
    );
    enqueued.push(memory.id);
  }
  return { success: true, enqueued, terminal, ineligible };
}

export async function planConsolidationProceduralWindows(options: {
  kv: StateKV;
  project?: string;
  maxItemsPerWindow?: number;
  memoryIds?: string[];
}): Promise<{ success: boolean; windows: ConsolidationProceduralWindow[]; totalPatterns: number; reason?: string }> {
  if (options.memoryIds?.length) {
    await enqueueConsolidationProceduralBacklog({
      kv: options.kv,
      memoryIds: options.memoryIds,
    });
  }
  const backlog = (await options.kv.list<ConsolidationProceduralBacklogRecord>(
    KV.consolidationProceduralBacklog,
  ))
    .filter((record) => !options.project || !record.project || record.project === options.project)
    .sort((left, right) => left.firstWaitingAt.localeCompare(right.firstWaitingAt)
      || left.sourceVersionKey.localeCompare(right.sourceVersionKey));
  const memories = await Promise.all(
    backlog.map((record) => options.kv.get<Memory>(KV.memories, record.memoryId)),
  );
  const valid: Array<{
    record: ConsolidationProceduralBacklogRecord;
    memory: Memory;
  }> = [];
  const exceptional: ConsolidationProceduralWindow[] = [];
  for (let index = 0; index < backlog.length; index += 1) {
    const record = backlog[index];
    const memory = memories[index];
    if (!isEligibleProceduralPattern(memory)) {
      await deleteProceduralBacklogRecord(options.kv, record);
      continue;
    }
    const source = buildConsolidationProceduralSourceVersion(memory);
    if (
      source.sourceVersionKey !== record.sourceVersionKey
      || source.snapshotHash !== record.normalizedContentHash
    ) {
      try {
        await enqueueConsolidationProceduralBacklog({ kv: options.kv, memoryIds: [memory.id] });
        const replacementKey = await options.kv.get<string>(
          KV.consolidationProceduralBacklogSourceIndex,
          memory.id,
        );
        const replacement = replacementKey
          ? await options.kv.get<ConsolidationProceduralBacklogRecord>(
              KV.consolidationProceduralBacklog,
              replacementKey,
            )
          : null;
        if (replacement && replacement.sourceVersionKey === source.sourceVersionKey) {
          valid.push({ record: replacement, memory });
        }
      } catch (error) {
        if (
          error instanceof Error
          && error.message === "consolidation_procedural_contribution_reconciliation_required"
        ) {
          exceptional.push({
            windowId: `procedural:${fingerprintId("cpw", record.sourceVersionKey)}`,
            memoryIds: [memory.id],
            stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
            sourceVersionKeys: [record.sourceVersionKey],
            patternCount: 1,
            ...(memory.project ? { project: memory.project } : {}),
            blockReason: error.message,
          });
          continue;
        }
        throw error;
      }
      continue;
    }
    valid.push({ record, memory });
  }
  const candidates = valid.length > 0
    ? await inspectContributionCandidates(options.kv, {
        stage: "consolidation_procedural",
        stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
        sourceVersionKeys: valid.map(({ record }) => record.sourceVersionKey),
      })
    : [];
  const eligible: typeof valid = [];
  for (let index = 0; index < valid.length; index += 1) {
    const item = valid[index];
    const candidate = candidates[index];
    if (candidate.state === "terminal") {
      await deleteProceduralBacklogRecord(options.kv, item.record);
      continue;
    }
    if (candidate.state === "eligible") {
      eligible.push(item);
      continue;
    }
    const reason = candidate.state === "source_correction_requires_migration"
      ? "consolidation_procedural_source_correction_requires_migration"
      : "consolidation_procedural_contribution_reconciliation_required";
    exceptional.push({
      windowId: `procedural:${fingerprintId("cpw", candidate.sourceVersionKey)}`,
      memoryIds: [item.memory.id],
      stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
      sourceVersionKeys: [item.record.sourceVersionKey],
      patternCount: 1,
      ...(item.memory.project ? { project: item.memory.project } : {}),
      ...(candidate.state === "source_correction_requires_migration"
        ? { isolateReason: reason }
        : { blockReason: reason }),
    });
  }

  const chunkSize = Math.max(2, options.maxItemsPerWindow ?? 50);
  const windows: ConsolidationProceduralWindow[] = [];
  const byProject = new Map<string, typeof valid>();
  for (const item of eligible) {
    const project = item.memory.project ?? "";
    const items = byProject.get(project) ?? [];
    items.push(item);
    byProject.set(project, items);
  }
  for (const [project, items] of [...byProject.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    for (let index = 0; index < items.length; index += chunkSize) {
      const chunk = items.slice(index, index + chunkSize);
      if (chunk.length < 2) continue;
      const sourceVersionKeys = chunk.map(({ record }) => record.sourceVersionKey);
      windows.push({
        windowId: `procedural:${fingerprintId("cpw", stableHash(sourceVersionKeys))}`,
        memoryIds: chunk.map(({ memory }) => memory.id),
        stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
        sourceVersionKeys,
        patternCount: chunk.length,
        ...(project ? { project } : {}),
      });
    }
  }

  return {
    success: true,
    windows: [...exceptional, ...windows],
    totalPatterns: valid.length,
    ...((windows.length === 0 && exceptional.length === 0)
      ? { reason: "fewer than 2 unconsumed recurring patterns" }
      : {}),
  };
}

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

function recoveryReceiptKey(
  identity: NonNullable<ConsolidationProceduralWindowOptions["recoveryIdentity"]>,
): string {
  return buildExtractionOperationKey({
    runId: identity.runId,
    stage: "consolidation_procedural",
    unitId: identity.unitId,
  });
}

function sameRecoveryIdentity(
  left: ProceduralRecoveryState["identity"],
  right: NonNullable<ConsolidationProceduralWindowOptions["recoveryIdentity"]>,
): boolean {
  return left.runId === right.runId
    && left.unitId === right.unitId
    && left.inputHash === right.inputHash;
}

async function readProceduralRecovery(
  kv: StateKV,
  identity: NonNullable<ConsolidationProceduralWindowOptions["recoveryIdentity"]>,
): Promise<{ receipt: ProceduralRecoveryReceipt; recovery: ProceduralRecoveryState } | null> {
  const key = recoveryReceiptKey(identity);
  const receipt = await kv.get<ProceduralRecoveryReceipt>(KV.extractionOperationReceipt(key), key);
  const recovery = receipt?.proceduralRecovery;
  if (!recovery) return null;
  const validReceiptStatus = receipt.status === "running"
    || (receipt.status === "succeeded" && recovery.phase === "committed");
  if (
    recovery.schema !== PROCEDURAL_RECOVERY_SCHEMA
    || receipt.key !== key
    || receipt.stage !== "consolidation_procedural"
    || receipt.runId !== identity.runId
    || receipt.unitId !== identity.unitId
    || receipt.inputHash !== identity.inputHash
    || !validReceiptStatus
    || !sameRecoveryIdentity(recovery.identity, identity)
    || !["staged", "committed"].includes(recovery.phase)
  ) {
    throw new Error("consolidation_procedural_recovery_identity_conflict");
  }
  return { receipt, recovery };
}

async function requireProceduralRecoveryReceipt(
  kv: StateKV,
  identity: NonNullable<ConsolidationProceduralWindowOptions["recoveryIdentity"]>,
): Promise<ProceduralRecoveryReceipt> {
  const key = recoveryReceiptKey(identity);
  const receipt = await kv.get<ProceduralRecoveryReceipt>(KV.extractionOperationReceipt(key), key);
  if (
    !receipt
    || receipt.status !== "running"
    || receipt.stage !== "consolidation_procedural"
    || receipt.runId !== identity.runId
    || receipt.unitId !== identity.unitId
    || receipt.inputHash !== identity.inputHash
  ) {
    throw new Error("consolidation_procedural_recovery_receipt_unavailable");
  }
  return receipt;
}

async function proceduralSourcesStillMatch(
  kv: StateKV,
  sourcePatterns: ProceduralRecoverySourcePattern[],
): Promise<boolean> {
  const memories = await Promise.all(sourcePatterns.map((pattern) =>
    kv.get<Memory>(KV.memories, pattern.memoryId)));
  return memories.every((memory, index) => {
    if (!isEligibleProceduralPattern(memory)) return false;
    const current = buildConsolidationProceduralSourceVersion(memory);
    const expected = sourcePatterns[index];
    return current.sourceVersionKey === expected.sourceVersionKey
      && current.snapshotHash === expected.snapshotHash;
  });
}

async function discardStagedProceduralRecovery(
  kv: StateKV,
  identity: NonNullable<ConsolidationProceduralWindowOptions["recoveryIdentity"]>,
): Promise<void> {
  const key = recoveryReceiptKey(identity);
  const receipt = await kv.get<ProceduralRecoveryReceipt>(
    KV.extractionOperationReceipt(key),
    key,
  );
  if (!receipt?.proceduralRecovery) return;
  if (
    receipt.status !== "running"
    || receipt.proceduralRecovery.phase !== "staged"
    || !sameRecoveryIdentity(receipt.proceduralRecovery.identity, identity)
  ) {
    throw new Error("consolidation_procedural_contribution_reconciliation_required");
  }
  const { proceduralRecovery: _proceduralRecovery, ...withoutRecovery } = receipt;
  await kv.set(KV.extractionOperationReceipt(key), key, withoutRecovery);
}

async function replaceDriftedProceduralSources(options: {
  kv: StateKV;
  identity: NonNullable<ConsolidationProceduralWindowOptions["recoveryIdentity"]>;
  memoryIds: string[];
  sourceVersionKeys: string[];
  claimedContribution?: {
    contributionId: string;
    sourceVersionKeys: string[];
  } | null;
  staged: boolean;
}): Promise<void> {
  if (options.staged) {
    await discardStagedProceduralRecovery(options.kv, options.identity);
  }
  if (options.claimedContribution) {
    await releaseClaimedBatch(options.kv, {
      stage: "consolidation_procedural",
      stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
      contributionId: options.claimedContribution.contributionId,
      sourceVersionKeys: options.claimedContribution.sourceVersionKeys,
    });
  }
  await Promise.all(options.sourceVersionKeys.map((sourceVersionKey, index) =>
    deleteProceduralBacklogRecord(options.kv, {
      sourceVersionKey,
      memoryId: options.memoryIds[index],
    })));
  await enqueueConsolidationProceduralBacklog({
    kv: options.kv,
    memoryIds: options.memoryIds,
  });
}

export function parseProceduralRecoveryResponse(response: string): {
  candidates: Array<{
  name: string;
  steps: string[];
  triggerCondition: string;
  }>;
  noEffect: boolean;
} | null {
  const root = response.trim().match(/^<procedures>\s*([\s\S]*?)\s*<\/procedures>$/);
  if (!root) return null;
  const body = root[1];
  const procRegex = /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
  const candidates = new Map<string, { name: string; steps: string[]; triggerCondition: string }>();
  let match: RegExpExecArray | null;
  let cursor = 0;
  while ((match = procRegex.exec(body)) !== null) {
    if (body.slice(cursor, match.index).trim()) return null;
    const steps: string[] = [];
    const stepRegex = /<step>([^<]+)<\/step>/g;
    let stepMatch: RegExpExecArray | null;
    while ((stepMatch = stepRegex.exec(match[3])) !== null) steps.push(stepMatch[1].trim());
    const name = match[1].trim();
    const triggerCondition = match[2].trim();
    if (!name || !triggerCondition || steps.length === 0 || steps.some((step) => !step)) return null;
    const stepsOnly = match[3].replace(/<step>[^<]+<\/step>/g, "").trim();
    if (stepsOnly) return null;
    const candidate = { name, steps, triggerCondition };
    candidates.set(name.toLowerCase(), candidate);
    cursor = procRegex.lastIndex;
  }
  if (body.slice(cursor).trim()) return null;
  return { candidates: [...candidates.values()], noEffect: candidates.size === 0 };
}

async function stageProceduralRecovery(options: {
  kv: StateKV;
  identity: NonNullable<ConsolidationProceduralWindowOptions["recoveryIdentity"]>;
  sourcePatterns: ProceduralRecoverySourcePattern[];
  response: string;
  promptChars: number;
  telemetry: ProviderCallTelemetry[];
  metadata: Record<string, unknown>;
  contribution?: NonNullable<ProceduralRecoveryState["contribution"]>;
}): Promise<{ receipt: ProceduralRecoveryReceipt; recovery: ProceduralRecoveryState }> {
  const existing = await readProceduralRecovery(options.kv, options.identity);
  if (existing) return existing;
  const receipt = await requireProceduralRecoveryReceipt(options.kv, options.identity);
  const existingProcedures = await options.kv.list<RecoverableProceduralMemory>(KV.procedural);
  const mutationSource = fingerprintId("cpmsrc", JSON.stringify(options.identity));
  const parsed = parseProceduralRecoveryResponse(options.response);
  if (!parsed) throw new Error("consolidation_procedural_response_parse_failure");
  const items = parsed.candidates.map((candidate) => {
    const existingProcedure = existingProcedures.find(
      (procedure) => procedure.name.toLowerCase() === candidate.name.toLowerCase(),
    );
    const id = existingProcedure?.id ?? generateId("proc");
    const mutationId = fingerprintId("cpmm", JSON.stringify([
      mutationSource,
      id,
      stableHash(candidate),
    ]));
    const effectUpdatedAt = receipt.startedAt;
    const expectedProcedure: RecoverableProceduralMemory = existingProcedure
      ? {
          ...existingProcedure,
          frequency: existingProcedure.frequency + 1,
          strength: Math.min(1, existingProcedure.strength + 0.1),
          updatedAt: effectUpdatedAt,
          sourceMutationWatermarks: {
            ...existingProcedure.sourceMutationWatermarks,
            [mutationSource]: mutationId,
          },
        }
      : {
          id,
          name: candidate.name,
          steps: candidate.steps,
          triggerCondition: candidate.triggerCondition,
          frequency: 1,
          sourceSessionIds: [],
          strength: 0.5,
          createdAt: effectUpdatedAt,
          updatedAt: effectUpdatedAt,
          sourceMutationWatermarks: { [mutationSource]: mutationId },
        };
    return {
      ...candidate,
      id,
      action: existingProcedure ? "reinforce" as const : "create" as const,
      mutationId,
      effectUpdatedAt,
      ...(existingProcedure ? { baselineEffectHash: stableHash(existingProcedure) } : {}),
      expectedEffectHash: stableHash(expectedProcedure),
      ...(existingProcedure ? {
        baselineUpdatedAt: existingProcedure.updatedAt,
        baselineFrequency: existingProcedure.frequency,
        baselineStrength: existingProcedure.strength,
      } : {}),
    };
  });
  const recovery: ProceduralRecoveryState = {
    schema: PROCEDURAL_RECOVERY_SCHEMA,
    identity: options.identity,
    phase: "staged",
    sourcePatterns: options.sourcePatterns,
    ...(options.contribution ? { contribution: options.contribution } : {}),
    ...(parsed.noEffect ? { noEffectReason: "no_reusable_procedure" as const } : {}),
    promptChars: options.promptChars,
    items,
    model: {
      responseHash: stableHash(options.response),
      response: options.response,
      telemetry: options.telemetry,
      metadata: options.metadata,
    },
  };
  const staged = { ...receipt, proceduralRecovery: recovery };
  await options.kv.set(KV.extractionOperationReceipt(receipt.key), receipt.key, staged);
  return { receipt: staged, recovery };
}

function proceduralMutationSource(identity: ProceduralRecoveryState["identity"]): string {
  return fingerprintId("cpmsrc", JSON.stringify(identity));
}

function proceduralAuditId(recovery: ProceduralRecoveryState): string {
  return fingerprintId("aud", JSON.stringify([
    recoveryReceiptKey(recovery.identity),
    stableHash(recovery.items.map((item) => [item.id, item.mutationId])),
  ]));
}

async function recordProceduralRecoveryAudit(options: {
  kv: StateKV;
  receipt: ProceduralRecoveryReceipt;
  recovery: ProceduralRecoveryState;
  result: NonNullable<ProceduralRecoveryState["result"]>;
  requireExisting: boolean;
}): Promise<void> {
  try {
    await recordAudit(
      options.kv,
      "consolidate",
      "mem::consolidate-procedural-window",
      options.result.proceduralMemoryIds,
      {
        runId: options.recovery.identity.runId,
        unitId: options.recovery.identity.unitId,
        inputHash: options.recovery.identity.inputHash,
        newProcedures: options.result.newProcedures,
        patternsAnalyzed: options.result.patternsAnalyzed,
      },
      undefined,
      undefined,
      {
        id: options.result.auditId,
        timestamp: options.receipt.startedAt,
        requireExisting: options.requireExisting,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === AUDIT_ENTRY_CONFLICT) {
      throw new Error("consolidation_procedural_audit_conflict");
    }
    if (message === AUDIT_ENTRY_MISSING) {
      throw new Error("consolidation_procedural_committed_audit_missing");
    }
    throw error;
  }
}

type ProceduralRecoveryCommitOptions = {
  kv: StateKV;
  receipt: ProceduralRecoveryReceipt;
  recovery: ProceduralRecoveryState;
};

async function commitProceduralRecovery(
  options: ProceduralRecoveryCommitOptions,
): Promise<ProceduralRecoveryState> {
  return withKeyedLock(
    PROCEDURAL_RECOVERY_COMMIT_LOCK,
    () => commitProceduralRecoveryLocked(options),
  );
}

async function commitProceduralRecoveryLocked(
  options: ProceduralRecoveryCommitOptions,
): Promise<ProceduralRecoveryState> {
  const verifyingCommitted = options.recovery.phase === "committed";
  if (verifyingCommitted && !options.recovery.result) {
    throw new Error("consolidation_procedural_committed_result_missing");
  }
  const source = proceduralMutationSource(options.recovery.identity);
  for (const item of options.recovery.items) {
    const existing = await options.kv.get<RecoverableProceduralMemory>(KV.procedural, item.id);
    const watermark = existing?.sourceMutationWatermarks?.[source];
    if (verifyingCommitted) {
      if (
        !existing
        || watermark !== item.mutationId
        || (item.expectedEffectHash !== undefined
          && stableHash(existing) !== item.expectedEffectHash)
      ) {
        throw new Error("consolidation_procedural_source_mutation_conflict");
      }
      continue;
    }
    if (watermark === item.mutationId) {
      if (
        item.expectedEffectHash !== undefined
        && stableHash(existing) !== item.expectedEffectHash
      ) throw new Error("consolidation_procedural_source_mutation_conflict");
      continue;
    }
    if (watermark !== undefined) throw new Error("consolidation_procedural_source_mutation_conflict");
    if (item.action === "create") {
      if (existing) throw new Error("consolidation_procedural_source_mutation_conflict");
      const now = item.effectUpdatedAt ?? new Date().toISOString();
      const procedure: RecoverableProceduralMemory = {
        id: item.id,
        name: item.name,
        steps: item.steps,
        triggerCondition: item.triggerCondition,
        frequency: 1,
        sourceSessionIds: [],
        strength: 0.5,
        createdAt: now,
        updatedAt: now,
        sourceMutationWatermarks: { [source]: item.mutationId },
      };
      if (
        item.expectedEffectHash !== undefined
        && stableHash(procedure) !== item.expectedEffectHash
      ) throw new Error("consolidation_procedural_source_mutation_conflict");
      await options.kv.set(KV.procedural, procedure.id, procedure);
      continue;
    }
    if (
      !existing
      || (item.baselineEffectHash !== undefined
        && stableHash(existing) !== item.baselineEffectHash)
      || existing.updatedAt !== item.baselineUpdatedAt
      || existing.frequency !== item.baselineFrequency
      || existing.strength !== item.baselineStrength
    ) throw new Error("consolidation_procedural_source_mutation_conflict");
    existing.frequency++;
    existing.strength = Math.min(1, existing.strength + 0.1);
    existing.updatedAt = item.effectUpdatedAt ?? new Date().toISOString();
    existing.sourceMutationWatermarks = {
      ...existing.sourceMutationWatermarks,
      [source]: item.mutationId,
    };
    if (
      item.expectedEffectHash !== undefined
      && stableHash(existing) !== item.expectedEffectHash
    ) throw new Error("consolidation_procedural_source_mutation_conflict");
    await options.kv.set(KV.procedural, existing.id, existing);
  }
  const result = {
    newProcedures: options.recovery.items.filter((item) => item.action === "create").length,
    patternsAnalyzed: options.recovery.sourcePatterns.length,
    proceduralMemoryIds: options.recovery.items.map((item) => item.id),
    auditId: proceduralAuditId(options.recovery),
  };
  if (verifyingCommitted) {
    if (stableHash(options.recovery.result) !== stableHash(result)) {
      throw new Error("consolidation_procedural_committed_result_conflict");
    }
    await recordProceduralRecoveryAudit({
      ...options,
      result,
      requireExisting: true,
    });
    return options.recovery;
  }
  await recordProceduralRecoveryAudit({
    ...options,
    result,
    requireExisting: false,
  });
  const committed: ProceduralRecoveryState = {
    ...options.recovery,
    phase: "committed",
    result,
  };
  const receipt = { ...options.receipt, proceduralRecovery: committed };
  await options.kv.set(KV.extractionOperationReceipt(receipt.key), receipt.key, receipt);
  return committed;
}

function proceduralRecoveryEvidence(
  receipt: ProceduralRecoveryReceipt,
  recovery: ProceduralRecoveryState,
): Record<string, unknown> {
  return {
    schema: "consolidation-procedural-commit/v1",
    kind: "committed",
    receiptKey: receipt.key,
    receiptVersion: receipt.version ?? 1,
    resultRef: `procedural-recoveries:${recoveryReceiptKey(recovery.identity)}`,
    effectHash: stableHash({
      identity: recovery.identity,
      sourcePatterns: recovery.sourcePatterns,
      modelResponseHash: recovery.model.responseHash,
      items: recovery.items.map((item) => [item.id, item.mutationId]),
      result: recovery.result,
    }),
    identity: recovery.identity,
  };
}

function proceduralNoEffectProof(recovery: ProceduralRecoveryState): {
  schema: "consolidation-procedural-no-effect/v1";
  proposalHash: string;
  reasonCode: "no_reusable_procedure";
  proofHash: string;
} {
  const proposalHash = stableHash({
    identity: recovery.identity,
    sourcePatterns: recovery.sourcePatterns,
    responseHash: recovery.model.responseHash,
  });
  return {
    schema: "consolidation-procedural-no-effect/v1",
    proposalHash,
    reasonCode: "no_reusable_procedure",
    proofHash: stableHash({
      schema: "consolidation-procedural-no-effect/v1",
      proposalHash,
      reasonCode: "no_reusable_procedure",
    }),
  };
}

function proceduralNoEffectEvidence(
  receipt: ProceduralRecoveryReceipt,
  recovery: ProceduralRecoveryState,
): Record<string, unknown> {
  const proof = proceduralNoEffectProof(recovery);
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

function proceduralContributionFailure(cause: string): Record<string, unknown> {
  return { success: false, status: "failed", failure: { class: "hard", cause } };
}

function sameEffectRefs(
  left: ContributionEffectRef[] | undefined,
  right: ContributionEffectRef[],
): boolean {
  return stableHash(left ?? []) === stableHash(right);
}

async function readProceduralContributionEffectRefs(
  kv: StateKV,
  receipt: ProceduralRecoveryReceipt,
  recovery: ProceduralRecoveryState,
): Promise<ContributionEffectRef[] | null> {
  const committed = await commitProceduralRecovery({ kv, receipt, recovery });
  if (committed.phase !== "committed" || !committed.result) return null;
  const audit = await kv.get<AuditEntry>(KV.audit, committed.result.auditId);
  if (!audit) return null;
  const source = proceduralMutationSource(committed.identity);
  const procedureRefs = await Promise.all(committed.items.map(async (item) => {
    const procedure = await kv.get<RecoverableProceduralMemory>(KV.procedural, item.id);
    if (procedure?.sourceMutationWatermarks?.[source] !== item.mutationId) return null;
    return {
      scope: KV.procedural,
      key: item.id,
      effectHash: stableHash(procedure),
    } satisfies ContributionEffectRef;
  }));
  if (procedureRefs.some((item) => !item)) return null;
  return [
    ...procedureRefs.filter((item): item is ContributionEffectRef => Boolean(item)),
    { scope: KV.audit, key: audit.id, effectHash: stableHash(audit) },
  ];
}

async function readVerifiedProceduralReceiptAndEffects(options: {
  kv: StateKV;
  operationReceiptRef: ContributionEffectRef;
  expectedSourceVersionKeys: string[];
}): Promise<{
  receipt: ProceduralRecoveryReceipt;
  recovery: ProceduralRecoveryState;
  effectRefs: ContributionEffectRef[];
  noEffect: boolean;
} | null> {
  const receipt = await options.kv.get<ProceduralRecoveryReceipt>(
    options.operationReceiptRef.scope,
    options.operationReceiptRef.key,
  );
  const recovery = receipt?.proceduralRecovery;
  if (
    !receipt
    || !recovery
    || options.operationReceiptRef.scope !== KV.extractionOperationReceipt(receipt.key)
    || options.operationReceiptRef.key !== receipt.key
    || receipt.key !== recoveryReceiptKey(recovery.identity)
    || receipt.version !== 1
    || receipt.status !== "succeeded"
    || recovery.schema !== PROCEDURAL_RECOVERY_SCHEMA
    || recovery.phase !== "committed"
    || !recovery.result
    || !recovery.contribution
    || recovery.contribution.stageContractVersion
      !== CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT
    || stableHash([...recovery.contribution.sourceVersionKeys].sort())
      !== stableHash([...options.expectedSourceVersionKeys].sort())
    || stableHash(recovery.sourcePatterns.map((pattern) => pattern.sourceVersionKey).sort())
      !== stableHash([...options.expectedSourceVersionKeys].sort())
  ) return null;
  const response = receipt.response as Record<string, unknown> | undefined;
  const noEffect = recovery.items.length === 0 && recovery.noEffectReason === "no_reusable_procedure";
  if (
    response?.success !== true
    || response.inputHash !== recovery.identity.inputHash
    || stableHash(response.proceduralMemoryIds)
      !== stableHash(recovery.result.proceduralMemoryIds)
    || (noEffect
      ? response.status !== "skipped"
        || stableHash(response.proceduralRecoveryEvidence)
          !== stableHash(proceduralNoEffectEvidence(receipt, recovery))
      : response.status !== "succeeded"
        || stableHash(response.proceduralRecoveryEvidence)
          !== stableHash(proceduralRecoveryEvidence(receipt, recovery)))
  ) return null;
  const effectRefs = await readProceduralContributionEffectRefs(
    options.kv,
    receipt,
    recovery,
  );
  if (!effectRefs) return null;
  return { receipt, recovery, effectRefs, noEffect };
}

async function verifyTerminalProceduralContribution(options: {
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
      record.stage !== "consolidation_procedural"
      || record.stageContractVersion !== CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT
      || record.sourceVersionKey !== expectedKeys[index]
      || (record.state !== "committed" && record.state !== "no_effect")
      || record.state !== first.state
      || record.contributionId !== first.contributionId
      || record.runId !== first.runId
      || record.unitId !== first.unitId
      || record.operationReceiptRef?.scope !== first.operationReceiptRef?.scope
      || record.operationReceiptRef?.key !== first.operationReceiptRef?.key
      || !sameEffectRefs(record.effectRefs, first.effectRefs ?? []))
    || !first.operationReceiptRef
  ) return proceduralContributionFailure(
    "consolidation_procedural_terminal_reconciliation_required",
  );
  const verified = await readVerifiedProceduralReceiptAndEffects({
    kv: options.kv,
    operationReceiptRef: first.operationReceiptRef,
    expectedSourceVersionKeys: expectedKeys,
  });
  if (
    !verified
    || verified.noEffect !== (first.state === "no_effect")
    || (first.state === "committed" && !sameEffectRefs(first.effectRefs, verified.effectRefs))
    || (first.state === "no_effect" && (first.effectRefs?.length ?? 0) !== 0)
  ) return proceduralContributionFailure(
    "consolidation_procedural_terminal_reconciliation_required",
  );
  return verified.receipt.response ?? proceduralContributionFailure(
    "consolidation_procedural_terminal_reconciliation_required",
  );
}

export async function reconcileConsolidationProceduralContribution(options: {
  kv: StateKV;
  identity: { runId: string; stage: "consolidation_procedural"; unitId: string; inputHash: string };
  sourceVersionKeys: string[];
  operationReceiptRef: ContributionEffectRef;
}): Promise<Record<string, unknown>> {
  try {
    const sourceVersionKeys = [...options.sourceVersionKeys].sort();
    const scope = KV.extractionContributionRecords(
      "consolidation_procedural",
      CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
    );
    const records = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      options.kv.get<ContributionRecord>(scope, sourceVersionKey)));
    if (records.some((record) => !record)) {
      return proceduralContributionFailure(
        "consolidation_procedural_contribution_reconciliation_required",
      );
    }
    const claimed = records as ContributionRecord[];
    const first = claimed[0];
    if (
      !first
      || claimed.some((record) =>
        record.contributionId !== first.contributionId
        || record.runId !== options.identity.runId
        || record.unitId !== options.identity.unitId
        || (record.state !== "claimed"
          && record.state !== "committed"
          && record.state !== "no_effect"))
    ) return proceduralContributionFailure(
      "consolidation_procedural_contribution_reconciliation_required",
    );
    if (claimed.every((record) => record.state === "committed" || record.state === "no_effect")) {
      return verifyTerminalProceduralContribution({
        kv: options.kv,
        sourceVersionKeys,
        records: claimed,
      });
    }
    const verified = await readVerifiedProceduralReceiptAndEffects({
      kv: options.kv,
      operationReceiptRef: options.operationReceiptRef,
      expectedSourceVersionKeys: sourceVersionKeys,
    });
    if (!verified || verified.recovery.contribution?.contributionId !== first.contributionId) {
      return proceduralContributionFailure(
        "consolidation_procedural_contribution_reconciliation_required",
      );
    }
    if (verified.noEffect) {
      await markClaimedBatchNoEffect(options.kv, {
        stage: "consolidation_procedural",
        stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
        contributionId: first.contributionId,
        sourceVersionKeys,
        operationReceiptRef: options.operationReceiptRef,
        receiptKey: options.operationReceiptRef.key,
        reasonCode: "no_reusable_procedure",
      });
    } else {
      await commitClaimedBatch(options.kv, {
        stage: "consolidation_procedural",
        stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
        contributionId: first.contributionId,
        sourceVersionKeys,
        operationReceiptRef: options.operationReceiptRef,
        effectRefs: verified.effectRefs,
      });
    }
    await Promise.all(verified.recovery.sourcePatterns.map((pattern) =>
      deleteProceduralBacklogRecord(options.kv, {
        sourceVersionKey: pattern.sourceVersionKey,
        memoryId: pattern.memoryId,
      })));
    const committed = await Promise.all(sourceVersionKeys.map((sourceVersionKey) =>
      options.kv.get<ContributionRecord>(scope, sourceVersionKey)));
    return verifyTerminalProceduralContribution({
      kv: options.kv,
      sourceVersionKeys,
      records: committed.filter((record): record is ContributionRecord => Boolean(record)),
    });
  } catch {
    return proceduralContributionFailure(
      "consolidation_procedural_contribution_reconciliation_required",
    );
  }
}

async function extractProceduralMemories(
  kv: StateKV,
  provider: MemoryProvider,
  patterns: Array<{ content: string; frequency: number }>,
  callOptions?: MemoryProviderCallOptions,
  telemetry: ProviderCallTelemetry[] = [],
  callIndex = 0,
): Promise<{
  newProcedures: number;
  patternsAnalyzed: number;
  proceduralMemoryIds: string[];
  telemetry: ProviderCallTelemetry[];
}> {
  const prompt = buildProceduralExtractionPrompt(patterns);
  const response = await callProviderWithTelemetry({
    provider,
    operation: "summarize",
    callRole: "window",
    callIndex,
    systemPrompt: withOutputLanguagePolicy(PROCEDURAL_EXTRACTION_SYSTEM),
    userPrompt: prompt,
    callOptions,
    telemetry,
  });

  const procRegex =
    /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
  let match;
  let newProcs = 0;
  const now = new Date().toISOString();
  const existingProcs = await kv.list<ProceduralMemory>(KV.procedural);
  const proceduralMemoryIds: string[] = [];

  while ((match = procRegex.exec(response)) !== null) {
    const name = match[1];
    const trigger = match[2];
    const stepsBlock = match[3];
    const steps: string[] = [];

    const stepRegex = /<step>([^<]+)<\/step>/g;
    let stepMatch;
    while ((stepMatch = stepRegex.exec(stepsBlock)) !== null) {
      steps.push(stepMatch[1].trim());
    }

    const existing = existingProcs.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      existing.frequency++;
      existing.updatedAt = now;
      existing.strength = Math.min(1, existing.strength + 0.1);
      await kv.set(KV.procedural, existing.id, existing);
      if (!proceduralMemoryIds.includes(existing.id)) proceduralMemoryIds.push(existing.id);
    } else {
      const proc: ProceduralMemory = {
        id: generateId("proc"),
        name,
        steps,
        triggerCondition: trigger,
        frequency: 1,
        sourceSessionIds: [],
        strength: 0.5,
        createdAt: now,
        updatedAt: now,
      };
      await kv.set(KV.procedural, proc.id, proc);
      proceduralMemoryIds.push(proc.id);
      newProcs++;
    }
  }

  return {
    newProcedures: newProcs,
    patternsAnalyzed: patterns.length,
    proceduralMemoryIds,
    telemetry: sortProviderCallTelemetry(telemetry),
  };
}

export async function runConsolidationProceduralWindow(
  options: ConsolidationProceduralWindowOptions,
): Promise<Record<string, unknown>> {
  const startMs = Date.now();
  const telemetry: ProviderCallTelemetry[] = [];
  const stageMetadata = resolveStageModelMetadata("procedural", options.provider, options.model);
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
    receipt: ProceduralRecoveryReceipt,
    committed: ProceduralRecoveryState,
  ): Record<string, unknown> => {
    const persisted = committed.result!;
    const noEffect = committed.items.length === 0
      && committed.noEffectReason === "no_reusable_procedure";
    return {
      success: true,
      ...persisted,
      inputHash: committed.identity.inputHash,
      usedFallback: true,
      ...committed.model.metadata,
      status: noEffect ? "skipped" : "succeeded",
      ...(noEffect ? { skipped: true, reason: "no reusable procedure" } : {}),
      promptChars: committed.promptChars,
      telemetry: committed.model.telemetry,
      parseFailures: 0,
      proceduralRecoveryEvidence: noEffect
        ? proceduralNoEffectEvidence(receipt, committed)
        : proceduralRecoveryEvidence(receipt, committed),
    };
  };
  try {
    resolveOutputLanguage();
    if (options.recoveryIdentity) {
      const recovered = await readProceduralRecovery(options.kv, options.recoveryIdentity);
      if (recovered) {
        if (
          recovered.recovery.contribution
          && (
            options.stageContractVersion
              !== recovered.recovery.contribution.stageContractVersion
            || stableHash([...(options.sourceVersionKeys ?? [])].sort())
              !== stableHash([...recovered.recovery.contribution.sourceVersionKeys].sort())
          )
        ) {
          return proceduralContributionFailure(
            "consolidation_procedural_recovery_identity_conflict",
          );
        }
        const committed = await commitProceduralRecovery({
          kv: options.kv,
          receipt: recovered.receipt,
          recovery: recovered.recovery,
        });
        return recoveryResponse(recovered.receipt, committed);
      }
    }
    const selectedIds = new Set(options.memoryIds ?? []);
    const sourceMemories = selectedIds.size > 0
      ? (await Promise.all([...selectedIds].map((id) => options.kv.get<Memory>(KV.memories, id))))
          .filter((memory): memory is Memory => Boolean(memory))
      : await options.kv.list<Memory>(KV.memories);
    const eligible = eligibleProceduralPatterns(sourceMemories, options.project);
    const maxItems = selectedIds.size > 0
      ? eligible.length
      : options.maxItemsPerWindow ?? eligible.length;
    const selected = eligible.slice(0, maxItems);
    const patterns = selected
      .map((m) => ({
        content: m.content,
        frequency: m.sessionIds.length || 1,
      }));
    const sourcePatterns = selected.map((memory) => {
      const source = buildConsolidationProceduralSourceVersion(memory);
      return {
        memoryId: memory.id,
        sourceVersionKey: source.sourceVersionKey,
        snapshotHash: source.snapshotHash,
        content: memory.content,
        frequency: memory.sessionIds.length || 1,
        updatedAt: memory.updatedAt,
        ...(memory.project ? { project: memory.project } : {}),
      };
    });
    const suppliedContributionFields = [options.stageContractVersion, options.sourceVersionKeys]
      .filter((value) => value !== undefined).length;
    const formalContribution = suppliedContributionFields === 2 && options.recoveryIdentity
      ? {
          stageContractVersion: options.stageContractVersion!,
          sourceVersionKeys: options.sourceVersionKeys!,
        }
      : null;
    if (
      suppliedContributionFields === 1
      || (suppliedContributionFields > 0 && !options.recoveryIdentity)
      || (formalContribution && (
        formalContribution.stageContractVersion
          !== CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT
        || selectedIds.size === 0
        || formalContribution.sourceVersionKeys.length !== selectedIds.size
        || new Set(formalContribution.sourceVersionKeys).size
          !== formalContribution.sourceVersionKeys.length
      ))
    ) {
      return proceduralContributionFailure("consolidation_procedural_source_version_conflict");
    }
    if (
      formalContribution
      && (
        selectedIds.size !== sourceMemories.length
        || selectedIds.size !== selected.length
        || stableHash(formalContribution.sourceVersionKeys)
          !== stableHash(sourcePatterns.map((pattern) => pattern.sourceVersionKey))
      )
    ) {
      await replaceDriftedProceduralSources({
        kv: options.kv,
        identity: options.recoveryIdentity!,
        memoryIds: [...selectedIds],
        sourceVersionKeys: formalContribution.sourceVersionKeys,
        staged: false,
      });
      return proceduralContributionFailure(
        "consolidation_procedural_source_drifted_before_commit",
      );
    }

    if (patterns.length < 2) {
      const receipt = options.recoveryIdentity
        ? await requireProceduralRecoveryReceipt(options.kv, options.recoveryIdentity)
        : undefined;
      return {
        success: true,
        skipped: true,
        reason: "fewer than 2 recurring patterns",
        patternsAnalyzed: patterns.length,
        ...responseMetadata("skipped", { parseFailures: 0 }),
        ...(receipt && options.recoveryIdentity ? {
          inputHash: options.recoveryIdentity.inputHash,
          proceduralRecoveryEvidence: {
            kind: "no_effect",
            observation: "business_empty",
            reasonCode: "fewer_than_2_recurring_patterns",
            identity: options.recoveryIdentity,
            proof: {
              kind: "receipt_before_formal_effect",
              receiptKey: receipt.key,
              receiptVersion: receipt.version ?? 1,
              phase: "candidate_staging",
              commitPlanAbsent: true,
            },
          },
        } : {}),
      };
    }

    if (!options.provider?.summarize) {
      return { success: false, error: "provider.summarize is required", ...responseMetadata("failed") };
    }
    if (formalContribution) {
      const contribution = await claimBatch(options.kv, {
        stage: "consolidation_procedural",
        stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
        runId: options.recoveryIdentity!.runId,
        unitId: options.recoveryIdentity!.unitId,
        sourceVersionKeys: formalContribution.sourceVersionKeys,
      });
      if (contribution.status === "already_committed") {
        return verifyTerminalProceduralContribution({
          kv: options.kv,
          sourceVersionKeys: formalContribution.sourceVersionKeys,
          records: contribution.records,
        });
      }
      if (contribution.status !== "claimed") {
        const cause = contribution.status === "contract_migration_required"
          ? "consolidation_procedural_contribution_contract_migration_required"
          : contribution.status === "source_correction_requires_migration"
            ? "consolidation_procedural_source_correction_requires_migration"
            : "consolidation_procedural_contribution_reconciliation_required";
        return proceduralContributionFailure(cause);
      }
      claimedContribution = {
        contributionId: contribution.records[0]!.contributionId,
        sourceVersionKeys: formalContribution.sourceVersionKeys,
      };
      if (!await proceduralSourcesStillMatch(options.kv, sourcePatterns)) {
        await replaceDriftedProceduralSources({
          kv: options.kv,
          identity: options.recoveryIdentity!,
          memoryIds: sourcePatterns.map((pattern) => pattern.memoryId),
          sourceVersionKeys: formalContribution.sourceVersionKeys,
          claimedContribution,
          staged: false,
        });
        claimedContribution = null;
        return proceduralContributionFailure(
          "consolidation_procedural_source_drifted_before_commit",
        );
      }
    }
    const existingProcedures = await options.kv.list<ProceduralMemory>(KV.procedural);
    const prompt = buildProceduralExtractionPrompt(patterns, existingProcedures);
    const promptChars = prompt.length;
    if (options.recoveryIdentity) {
      await requireProceduralRecoveryReceipt(options.kv, options.recoveryIdentity);
      const response = await callProviderWithTelemetry({
        provider: options.provider,
        operation: "summarize",
        callRole: "window",
        callIndex: 0,
        systemPrompt: withOutputLanguagePolicy(PROCEDURAL_EXTRACTION_SYSTEM),
        userPrompt: prompt,
        callOptions: resolveStageModelCallOptions("procedural", options.model),
        telemetry,
      });
      if (
        formalContribution
        && !await proceduralSourcesStillMatch(options.kv, sourcePatterns)
      ) {
        await replaceDriftedProceduralSources({
          kv: options.kv,
          identity: options.recoveryIdentity,
          memoryIds: sourcePatterns.map((pattern) => pattern.memoryId),
          sourceVersionKeys: formalContribution.sourceVersionKeys,
          claimedContribution,
          staged: false,
        });
        claimedContribution = null;
        return proceduralContributionFailure(
          "consolidation_procedural_source_drifted_before_commit",
        );
      }
      const staged = await stageProceduralRecovery({
        kv: options.kv,
        identity: options.recoveryIdentity,
        sourcePatterns,
        response,
        promptChars,
        telemetry: sortProviderCallTelemetry(telemetry),
        metadata: responseMetadata("succeeded"),
        ...(formalContribution && claimedContribution ? {
          contribution: {
            stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
            contributionId: claimedContribution.contributionId,
            sourceVersionKeys: formalContribution.sourceVersionKeys,
          },
        } : {}),
      });
      if (
        formalContribution
        && !await proceduralSourcesStillMatch(options.kv, sourcePatterns)
      ) {
        await replaceDriftedProceduralSources({
          kv: options.kv,
          identity: options.recoveryIdentity,
          memoryIds: sourcePatterns.map((pattern) => pattern.memoryId),
          sourceVersionKeys: formalContribution.sourceVersionKeys,
          claimedContribution,
          staged: true,
        });
        claimedContribution = null;
        return proceduralContributionFailure(
          "consolidation_procedural_source_drifted_before_commit",
        );
      }
      const committed = await commitProceduralRecovery({
        kv: options.kv,
        receipt: staged.receipt,
        recovery: staged.recovery,
      });
      return recoveryResponse(staged.receipt, committed);
    }
    const result = await extractProceduralMemories(
      options.kv,
      options.provider,
      patterns,
      resolveStageModelCallOptions("procedural", options.model),
      telemetry,
      0,
    );
    return {
      success: true,
      ...result,
      ...responseMetadata("succeeded", {
        promptChars,
        parseFailures: result.proceduralMemoryIds.length > 0 ? 0 : 1,
      }),
    };
  } catch (err) {
    if (claimedContribution && options.recoveryIdentity) {
      const receiptKey = recoveryReceiptKey(options.recoveryIdentity);
      const receipt = await options.kv.get<ProceduralRecoveryReceipt>(
        KV.extractionOperationReceipt(receiptKey),
        receiptKey,
      ).catch(() => null);
      if (!receipt?.proceduralRecovery) {
        await releaseClaimedBatch(options.kv, {
          stage: "consolidation_procedural",
          stageContractVersion: CONSOLIDATION_PROCEDURAL_CONTRIBUTION_CONTRACT,
          contributionId: claimedContribution.contributionId,
          sourceVersionKeys: claimedContribution.sourceVersionKeys,
        }).catch(() => undefined);
      }
    }
    if (isProviderPreflightError(err)) {
      const status = providerPreflightStatus(err);
      return { success: false, error: status, ...responseMetadata(status) };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Full procedural extraction failed", { error: msg });
    if (msg === "consolidation_procedural_response_parse_failure") {
      return {
        success: false,
        error: msg,
        failure: { class: "unit", cause: msg },
        ...responseMetadata("failed"),
      };
    }
    if (PROCEDURAL_RECOVERY_HARD_FAILURES.has(msg)) {
      return {
        success: false,
        error: msg,
        failure: { class: "hard", cause: msg },
        ...responseMetadata("failed"),
      };
    }
    return { success: false, error: msg, ...responseMetadata("failed") };
  }
}

export function registerConsolidationPipelineFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::full-consolidation-procedural-windows-plan",
    async (data: { project?: string; maxItemsPerWindow?: number; memoryIds?: string[] }) =>
      planConsolidationProceduralWindows({ kv, ...data }),
  );

  sdk.registerFunction(
    "mem::full-consolidation-procedural-window",
    async (data: {
      project?: string;
      memoryIds?: string[];
      maxItemsPerWindow?: number;
      model?: string;
      stageContractVersion?: string;
      sourceVersionKeys?: string[];
      recoveryIdentity?: { runId: string; unitId: string; inputHash: string };
    }) =>
      runConsolidationProceduralWindow({ kv, provider, ...data }),
  );

  sdk.registerFunction("mem::consolidate-pipeline", 
    async (data?: { tier?: string; force?: boolean; project?: string; model?: string }) => {
      resolveOutputLanguage();
      if (!data?.force && !isConsolidationEnabled()) {
        return { success: false, skipped: true, reason: "Consolidation disabled: set CONSOLIDATION_ENABLED=true or configure an LLM provider (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / MINIMAX_API_KEY / OPENAI_BASE_URL / AGENTMEMORY_PROVIDER=agent-sdk)" };
      }
      const tier = data?.tier || "all";
      const decayDays = getConsolidationDecayDays();
      const results: Record<string, unknown> = {};
      const callOptions = resolveStageModelCallOptions(
        "memory_consolidate",
        data?.model,
      );
      const proceduralCallOptions = resolveStageModelCallOptions(
        "procedural",
        data?.model,
      );

      if (tier === "all" || tier === "semantic") {
        const summaries = await kv.list<SessionSummary>(KV.summaries);
        const existingSemantic = await kv.list<SemanticMemory>(KV.semantic);

        if (summaries.length >= 5) {
          const recentSummaries = summaries
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .slice(0, 20);

          const prompt = buildSemanticMergePrompt(
            recentSummaries.map((s) => ({
              title: s.title,
              narrative: s.narrative,
              concepts: s.concepts,
            })),
          );
          const semanticTelemetry: ProviderCallTelemetry[] = [];

          try {
            const outputLanguage = resolveOutputLanguage();
            const baseSystem = withOutputLanguagePolicy(
              SEMANTIC_MERGE_SYSTEM,
              undefined,
              SEMANTIC_MERGE_OUTPUT_CONTRACT,
            );
            const parseResponse = (response: string) => {
              const parsed = parseFactResponse(response);
              const languageViolations = outputLanguage === "zh-CN"
                ? collectLanguageViolations(parsed)
                : [];
              return { parsed, languageViolations };
            };

            let parsedResult = parseResponse(
              await callProviderWithTelemetry({
                provider,
                operation: "summarize",
                callRole: "window",
                callIndex: 0,
                systemPrompt: baseSystem,
                userPrompt: prompt,
                callOptions,
                telemetry: semanticTelemetry,
              }),
            );

            if (outputLanguage === "zh-CN" && parsedResult.languageViolations.length > 0) {
              logger.warn("Semantic merge language contract may be violated", {
                violations: parsedResult.languageViolations.length,
              });
              const strictSystem = withOutputLanguagePolicy(
                SEMANTIC_MERGE_SYSTEM,
                undefined,
                {
                  semantic: [
                    ...(SEMANTIC_MERGE_OUTPUT_CONTRACT.semantic ?? []),
                    buildSemanticRetryContractPrompt(),
                  ],
                },
              );
              try {
                parsedResult = parseResponse(
                  await callProviderWithTelemetry({
                    provider,
                    operation: "summarize",
                    callRole: "window",
                    callIndex: 1,
                    systemPrompt: strictSystem,
                    userPrompt: prompt,
                    callOptions,
                    telemetry: semanticTelemetry,
                  }),
                );
              } catch (retryErr) {
                logger.warn("Semantic merge retry failed; keep first extraction", {
                  error: retryErr instanceof Error ? retryErr.message : String(retryErr),
                });
              }
            }

            const facts = parsedResult.parsed;
            const languageViolations = parsedResult.languageViolations;
            let newFacts = 0;
            const now = new Date().toISOString();

            for (const { fact, confidence } of facts) {
              const existing = existingSemantic.find(
                (s) => s.fact.toLowerCase() === fact.toLowerCase(),
              );
              if (existing) {
                existing.accessCount++;
                existing.lastAccessedAt = now;
                existing.updatedAt = now;
                existing.confidence = Math.max(existing.confidence, confidence);
                await kv.set(KV.semantic, existing.id, existing);
              } else {
                const sem: SemanticMemory = {
                  id: generateId("sem"),
                  fact,
                  confidence,
                  sourceSessionIds: recentSummaries.map((s) => s.sessionId),
                  sourceMemoryIds: [],
                  accessCount: 1,
                  lastAccessedAt: now,
                  strength: confidence,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.semantic, sem.id, sem);
                newFacts++;
              }
            }

            results.semantic = {
              newFacts,
              totalSummaries: summaries.length,
              ...(languageViolations.length > 0 ? { languageViolations } : {}),
              telemetry: sortProviderCallTelemetry(semanticTelemetry),
            };
            if (languageViolations.length > 0) {
              logger.warn("Semantic merge kept non-Chinese facts after retry", {
                count: languageViolations.length,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Semantic consolidation failed", { error: msg });
            const status = isProviderPreflightError(err) ? providerPreflightStatus(err) : "failed";
            results.semantic = {
              error: msg,
              status,
              telemetry: sortProviderCallTelemetry(semanticTelemetry),
            };
          }
        } else {
          results.semantic = {
            skipped: true,
            reason: "fewer than 5 summaries",
          };
        }
      }

      if (tier === "all" || tier === "reflect") {
        try {
          const reflectResult = await sdk.trigger({ function_id: "mem::reflect", payload: {
            maxClusters: 10,
            project: data?.project,
          } });
          results.reflect = reflectResult;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Reflect tier failed", { error: msg });
          results.reflect = { error: msg };
        }
      }

      if (tier === "all" || tier === "procedural") {
        const memories = await kv.list<Memory>(KV.memories);
        const patterns = eligibleProceduralPatterns(memories, data?.project).map((m) => ({
          content: m.content,
          frequency: m.sessionIds.length || 1,
        }));

        if (patterns.length >= 2) {
          const proceduralTelemetry: ProviderCallTelemetry[] = [];
          try {
            results.procedural = await extractProceduralMemories(
              kv,
              provider,
              patterns,
              proceduralCallOptions,
              proceduralTelemetry,
              0,
            );
          } catch (err) {
            if (isProviderPreflightError(err)) {
              const status = providerPreflightStatus(err);
              return {
                success: false,
                error: status,
                status,
                telemetry: sortProviderCallTelemetry(proceduralTelemetry),
              };
            }
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Procedural extraction failed", { error: msg });
            results.procedural = {
              error: msg,
              telemetry: sortProviderCallTelemetry(proceduralTelemetry),
            };
          }
        } else {
          results.procedural = {
            skipped: true,
            reason: "fewer than 2 recurring patterns",
          };
        }
      }

      if (tier === "all" || tier === "decay") {
        const semantic = await kv.list<SemanticMemory>(KV.semantic);
        applyDecay(semantic, decayDays);
        for (const s of semantic) {
          await kv.set(KV.semantic, s.id, s);
        }

        const procedural = await kv.list<ProceduralMemory>(KV.procedural);
        applyDecay(procedural, decayDays);
        for (const p of procedural) {
          await kv.set(KV.procedural, p.id, p);
        }

        results.decay = {
          semantic: semantic.length,
          procedural: procedural.length,
        };
      }

      if (process.env["OBSIDIAN_AUTO_EXPORT"] === "true") {
        try {
          await sdk.trigger({ function_id: "mem::obsidian-export", payload: {} });
          results.obsidianExport = { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Obsidian auto-export failed", { error: msg });
          results.obsidianExport = { success: false, error: msg };
        }
      }

      await recordAudit(kv, "consolidate", "mem::consolidate-pipeline", [], {
        tier,
        results,
      });

      logger.info("Consolidation pipeline complete", { tier, results });
      return { success: true, results };
    },
  );
}

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

export interface ConsolidationProceduralWindow {
  windowId: string;
  memoryIds: string[];
  patternCount: number;
}

export interface ConsolidationProceduralWindowOptions {
  kv: StateKV;
  provider: MemoryProvider;
  memoryIds?: string[];
  project?: string;
  maxItemsPerWindow?: number;
  model?: string;
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
]);

interface ProceduralRecoverySourcePattern {
  memoryId: string;
  content: string;
  frequency: number;
  updatedAt: string;
}

interface ProceduralRecoveryItem {
  id: string;
  name: string;
  steps: string[];
  triggerCondition: string;
  action: "create" | "reinforce";
  mutationId: string;
  baselineUpdatedAt?: string;
  baselineFrequency?: number;
  baselineStrength?: number;
}

interface ProceduralRecoveryState {
  schema: typeof PROCEDURAL_RECOVERY_SCHEMA;
  identity: { runId: string; unitId: string; inputHash: string };
  phase: "staged" | "committed";
  sourcePatterns: ProceduralRecoverySourcePattern[];
  promptChars: number;
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

export async function planConsolidationProceduralWindows(options: {
  kv: StateKV;
  project?: string;
  maxItemsPerWindow?: number;
}): Promise<{ success: boolean; windows: ConsolidationProceduralWindow[]; totalPatterns: number; reason?: string }> {
  const memories = await options.kv.list<Memory>(KV.memories);
  const patterns = eligibleProceduralPatterns(memories, options.project);
  if (patterns.length < 2) {
    return {
      success: true,
      windows: [],
      totalPatterns: patterns.length,
      reason: "fewer than 2 recurring patterns",
    };
  }

  const chunkSize = Math.max(2, options.maxItemsPerWindow ?? patterns.length);
  const windows: ConsolidationProceduralWindow[] = [];
  for (let i = 0; i < patterns.length; i += chunkSize) {
    const chunk = patterns.slice(i, i + chunkSize);
    if (chunk.length < 2) continue;
    windows.push({
      windowId: `procedural:${windows.length + 1}`,
      memoryIds: chunk.map((memory) => memory.id),
      patternCount: chunk.length,
    });
  }

  return { success: true, windows, totalPatterns: patterns.length };
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

function parseProceduralRecoveryCandidates(response: string): Array<{
  name: string;
  steps: string[];
  triggerCondition: string;
}> {
  const procRegex = /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
  const candidates = new Map<string, { name: string; steps: string[]; triggerCondition: string }>();
  let match: RegExpExecArray | null;
  while ((match = procRegex.exec(response)) !== null) {
    const steps: string[] = [];
    const stepRegex = /<step>([^<]+)<\/step>/g;
    let stepMatch: RegExpExecArray | null;
    while ((stepMatch = stepRegex.exec(match[3])) !== null) steps.push(stepMatch[1].trim());
    const name = match[1].trim();
    const triggerCondition = match[2].trim();
    if (!name || !triggerCondition) continue;
    const candidate = { name, steps, triggerCondition };
    candidates.set(name.toLowerCase(), candidate);
  }
  return [...candidates.values()];
}

async function stageProceduralRecovery(options: {
  kv: StateKV;
  identity: NonNullable<ConsolidationProceduralWindowOptions["recoveryIdentity"]>;
  sourcePatterns: ProceduralRecoverySourcePattern[];
  response: string;
  promptChars: number;
  telemetry: ProviderCallTelemetry[];
  metadata: Record<string, unknown>;
}): Promise<{ receipt: ProceduralRecoveryReceipt; recovery: ProceduralRecoveryState }> {
  const existing = await readProceduralRecovery(options.kv, options.identity);
  if (existing) return existing;
  const receipt = await requireProceduralRecoveryReceipt(options.kv, options.identity);
  const existingProcedures = await options.kv.list<RecoverableProceduralMemory>(KV.procedural);
  const mutationSource = fingerprintId("cpmsrc", JSON.stringify(options.identity));
  const items = parseProceduralRecoveryCandidates(options.response).map((candidate) => {
    const existingProcedure = existingProcedures.find(
      (procedure) => procedure.name.toLowerCase() === candidate.name.toLowerCase(),
    );
    const id = existingProcedure?.id ?? generateId("proc");
    return {
      ...candidate,
      id,
      action: existingProcedure ? "reinforce" as const : "create" as const,
      mutationId: fingerprintId("cpmm", JSON.stringify([
        mutationSource,
        id,
        stableHash(candidate),
      ])),
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
      if (!existing || watermark !== item.mutationId) {
        throw new Error("consolidation_procedural_source_mutation_conflict");
      }
      continue;
    }
    if (watermark === item.mutationId) continue;
    if (watermark !== undefined) throw new Error("consolidation_procedural_source_mutation_conflict");
    if (item.action === "create") {
      if (existing) throw new Error("consolidation_procedural_source_mutation_conflict");
      const now = new Date().toISOString();
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
      await options.kv.set(KV.procedural, procedure.id, procedure);
      continue;
    }
    if (
      !existing
      || existing.updatedAt !== item.baselineUpdatedAt
      || existing.frequency !== item.baselineFrequency
      || existing.strength !== item.baselineStrength
    ) throw new Error("consolidation_procedural_source_mutation_conflict");
    existing.frequency++;
    existing.strength = Math.min(1, existing.strength + 0.1);
    existing.updatedAt = new Date().toISOString();
    existing.sourceMutationWatermarks = {
      ...existing.sourceMutationWatermarks,
      [source]: item.mutationId,
    };
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
  try {
    resolveOutputLanguage();
    if (options.recoveryIdentity) {
      const recovered = await readProceduralRecovery(options.kv, options.recoveryIdentity);
      if (recovered) {
        const committed = await commitProceduralRecovery({
          kv: options.kv,
          receipt: recovered.receipt,
          recovery: recovered.recovery,
        });
        const persisted = committed.result!;
        return {
          success: true,
          ...persisted,
          inputHash: committed.identity.inputHash,
          usedFallback: true,
          ...committed.model.metadata,
          promptChars: committed.promptChars,
          telemetry: committed.model.telemetry,
          parseFailures: persisted.proceduralMemoryIds.length > 0 ? 0 : 1,
          proceduralRecoveryEvidence: proceduralRecoveryEvidence(recovered.receipt, committed),
        };
      }
    }
    const allMemories = await options.kv.list<Memory>(KV.memories);
    const selectedIds = new Set(options.memoryIds ?? []);
    const sourceMemories = selectedIds.size > 0
      ? allMemories.filter((memory) => selectedIds.has(memory.id))
      : allMemories;
    const eligible = eligibleProceduralPatterns(sourceMemories, options.project);
    const maxItems = options.maxItemsPerWindow ?? eligible.length;
    const patterns = eligible
      .slice(0, maxItems)
      .map((m) => ({
        content: m.content,
        frequency: m.sessionIds.length || 1,
      }));
    const sourcePatterns = eligible
      .slice(0, maxItems)
      .map((memory) => ({
        memoryId: memory.id,
        content: memory.content,
        frequency: memory.sessionIds.length || 1,
        updatedAt: memory.updatedAt,
      }));

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

    const promptChars = buildProceduralExtractionPrompt(patterns).length;
    if (options.recoveryIdentity) {
      if (!options.provider?.summarize) {
        return { success: false, error: "provider.summarize is required", ...responseMetadata("failed") };
      }
      await requireProceduralRecoveryReceipt(options.kv, options.recoveryIdentity);
      const prompt = buildProceduralExtractionPrompt(patterns);
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
      const staged = await stageProceduralRecovery({
        kv: options.kv,
        identity: options.recoveryIdentity,
        sourcePatterns,
        response,
        promptChars,
        telemetry: sortProviderCallTelemetry(telemetry),
        metadata: responseMetadata("succeeded"),
      });
      const committed = await commitProceduralRecovery({
        kv: options.kv,
        receipt: staged.receipt,
        recovery: staged.recovery,
      });
      const persisted = committed.result!;
      return {
        success: true,
        ...persisted,
        inputHash: committed.identity.inputHash,
        usedFallback: true,
        ...committed.model.metadata,
        promptChars: committed.promptChars,
        telemetry: committed.model.telemetry,
        parseFailures: persisted.proceduralMemoryIds.length > 0 ? 0 : 1,
        proceduralRecoveryEvidence: proceduralRecoveryEvidence(staged.receipt, committed),
      };
    }
    if (!options.provider?.summarize) {
      return { success: false, error: "provider.summarize is required", ...responseMetadata("failed") };
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
    if (isProviderPreflightError(err)) {
      const status = providerPreflightStatus(err);
      return { success: false, error: status, ...responseMetadata(status) };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Full procedural extraction failed", { error: msg });
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
    async (data: { project?: string; maxItemsPerWindow?: number }) =>
      planConsolidationProceduralWindows({ kv, ...data }),
  );

  sdk.registerFunction(
    "mem::full-consolidation-procedural-window",
    async (data: {
      project?: string;
      memoryIds?: string[];
      maxItemsPerWindow?: number;
      model?: string;
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

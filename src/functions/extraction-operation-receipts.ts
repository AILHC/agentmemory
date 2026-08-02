import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type {
  ExtractionOperationIdentity,
  ExtractionOperationReceipt,
  ResumableSummaryActiveRun,
  ResumableSummaryPartial,
  ResumableSummaryRun,
  StageFailure,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

export const EXTRACTION_OPERATION_RECEIPT_VERSION = 1;

export interface ExtractionOperationResult<T> {
  replayed: boolean;
  response?: T;
  failure?: StageFailure;
  receipt?: ExtractionOperationReceipt<T>;
  receiptAbsence?: ExtractionOperationReceiptAbsence;
}

export interface ExtractionOperationReceiptAbsence extends ExtractionOperationIdentity {
  schema: "extraction-operation-receipt-absence/v1";
  key: string;
  observedAt: string;
}

export type ExtractionOperationReceiptAbsenceProjection =
  ExtractionOperationReceiptAbsence & { runnerInputHash: string };

export interface FailedExtractionOperationRetryAuthorization {
  receiptInputHash: string;
  retryEpoch: number;
  failureClass: "transient_provider" | "transient_runtime";
  failureCause: string;
  failurePhase: "provider_call" | "before_final_persistence";
  lastSafeFailure: {
    errorClass: "transient_provider" | "transient_runtime";
    cause: string;
    phase: "provider_call" | "before_final_persistence";
    timestamp: string;
  };
}

export interface ExtractionOperationReceiptOptions {
  requireExisting?: boolean;
  /** 缺失 receipt 探测返回的服务端 input hash；漂移时不得创建或执行新 operation。 */
  expectedInputHash?: string;
  /** 仅在调用方已确认未持久化结果时启用，允许失败重开同一 receipt。 */
  retryFailed?: boolean;
  failedRetryAuthorization?: FailedExtractionOperationRetryAuthorization;
  allowLegacyLessonFailedRetry?: boolean;
}

/** 表示回调失去确定性时，最终结果可能已经持久化。 */
export class ExtractionOperationResultUncertainError extends Error {
  constructor() {
    super("extraction_operation_result_uncertain");
    this.name = "ExtractionOperationResultUncertainError";
  }
}

const RECEIPT_FAILURE_PHASES = new Set([
  "provider_preflight",
  "provider_call",
  "before_final_persistence",
  "final_result_persistence",
]);
const PROVIDER_ERROR_CODES = new Set([
  "model_not_found", "rate_limited", "timeout", "provider_rejected", "auth_failed",
  "network_error", "server_error", "unknown",
]);
const PROVIDER_STOP_REASONS = new Set(["stop", "max_tokens", "tool_use", "error", "aborted"]);

export function normalizeFailedExtractionOperationRetryAuthorization(
  value: unknown,
): FailedExtractionOperationRetryAuthorization | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const authorization = value as Record<string, unknown>;
  if (
    Object.keys(authorization).sort().join(",")
      !== "failureCause,failureClass,failurePhase,lastSafeFailure,receiptInputHash,retryEpoch"
  ) return null;
  const lastSafeValue = authorization.lastSafeFailure;
  if (!lastSafeValue || typeof lastSafeValue !== "object" || Array.isArray(lastSafeValue)) {
    return null;
  }
  const lastSafeFailure = lastSafeValue as Record<string, unknown>;
  if (Object.keys(lastSafeFailure).sort().join(",") !== "cause,errorClass,phase,timestamp") {
    return null;
  }
  if (
    typeof authorization.receiptInputHash !== "string"
    || !/^[0-9a-f]{64}$/.test(authorization.receiptInputHash)
    || !Number.isSafeInteger(authorization.retryEpoch)
    || Number(authorization.retryEpoch) < 0
    || !["transient_provider", "transient_runtime"].includes(String(authorization.failureClass))
    || typeof authorization.failureCause !== "string"
    || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(authorization.failureCause)
    || !["provider_call", "before_final_persistence"].includes(String(authorization.failurePhase))
    || lastSafeFailure.errorClass !== authorization.failureClass
    || lastSafeFailure.cause !== authorization.failureCause
    || lastSafeFailure.phase !== authorization.failurePhase
    || typeof lastSafeFailure.timestamp !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(lastSafeFailure.timestamp)
  ) {
    return null;
  }
  return {
    receiptInputHash: authorization.receiptInputHash,
    retryEpoch: Number(authorization.retryEpoch),
    failureClass: authorization.failureClass as FailedExtractionOperationRetryAuthorization["failureClass"],
    failureCause: authorization.failureCause,
    failurePhase: authorization.failurePhase as FailedExtractionOperationRetryAuthorization["failurePhase"],
    lastSafeFailure: {
      errorClass: lastSafeFailure.errorClass as FailedExtractionOperationRetryAuthorization["lastSafeFailure"]["errorClass"],
      cause: lastSafeFailure.cause as string,
      phase: lastSafeFailure.phase as FailedExtractionOperationRetryAuthorization["lastSafeFailure"]["phase"],
      timestamp: lastSafeFailure.timestamp,
    },
  };
}

const COMMON_RECEIPT_RESPONSE_KEYS = new Set([
  "success", "status", "stage", "provider", "providerName", "provider_name",
  "model", "modelSource", "model_source", "source", "modelApplied", "model_applied",
  "providerModelOverride", "provider_model_override", "promptChars", "prompt_chars",
  "charBudget", "char_budget", "maxPromptChars", "max_prompt_chars", "durationMs",
  "duration_ms", "parseFailures", "parse_failures", "inputHash", "input_hash",
  "runId", "run_id", "windowId", "window_id", "mark", "kind", "reused", "skipped",
  "dryRun", "dry_run",
  "attemptId", "attempt_id", "resumableRunId", "resumable_run_id",
  "completedChunks", "completed_chunks", "totalChunks", "total_chunks",
  "skippedChunks", "skipped_chunks", "advanced", "resultRef",
]);

const STAGE_RECEIPT_RESPONSE_KEYS: Record<ExtractionOperationIdentity["stage"], Set<string>> = {
  summary: new Set(),
  lessons: new Set(["runs"]),
  semantic_rollup: new Set([
    "semanticMemoryIds", "semantic_memory_ids",
    "semanticMemoryCharSizes", "semantic_memory_char_sizes",
    "configHash", "config_hash", "semanticRecoveryEvidence", "semantic_recovery_evidence",
  ]),
  skill_extract: new Set([
    "skillIds", "skill_ids", "proceduralMemoryIds", "procedural_memory_ids",
    "memoryIds", "memory_ids", "extracted", "reinforced",
    "preparedHandle", "prepared_handle", "proposalHash", "proposal_hash",
    "domainEffectEvidence", "domain_effect_evidence",
  ]),
  memory_consolidate: new Set([
    "memoryIds", "memory_ids", "consolidated", "totalObservations", "total_observations",
    "preparedHandle", "prepared_handle", "proposalHash", "proposal_hash",
    "domainEffectEvidence", "domain_effect_evidence",
    "noEffectEvidence", "no_effect_evidence",
  ]),
  consolidation_procedural: new Set([
    "proceduralMemoryIds", "procedural_memory_ids", "memoryIds", "memory_ids",
    "patternsAnalyzed", "patterns_analyzed",
    "newProcedures", "new_procedures", "proceduralRecoveryEvidence", "procedural_recovery_evidence",
  ]),
  reflect_insight: new Set([
    "insightIds", "insight_ids", "memoryIds", "memory_ids", "newInsights", "new_insights",
    "reinforced", "totalInsights", "total_insights", "totalItems", "total_items",
    "usedFallback", "used_fallback", "reflectRecoveryEvidence", "reflect_recovery_evidence",
  ]),
  crystal: new Set([
    "crystalIds", "crystal_ids", "groupCount", "group_count", "groups", "items",
    "crystalRecoveryEvidence", "crystal_recovery_evidence",
  ]),
};

function safeLessonRun(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of ["id", "sessionId", "status", "inputHash", "configHash", "attempts", "createdAt", "updatedAt", "finishedAt", "runningLeaseUntil"]) {
    const safe = safePrimitive(record[key]);
    if (safe !== undefined) projected[key] = safe;
  }
  for (const key of ["createdLessonIds", "replacedLessonIds"]) {
    const safe = safeStringArray(record[key]);
    if (safe !== undefined) projected[key] = safe;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

const UNIT_RECEIPT_KEYS = new Set([
  "unitId", "unit_id", "groupId", "group_id", "windowId", "window_id", "status", "stage",
  "project", "kind", "inputHash", "input_hash", "actionIds", "action_ids", "sourceIds",
  "source_ids", "observationIds", "observation_ids", "memoryIds", "memory_ids",
  "proceduralMemoryIds", "procedural_memory_ids", "semanticMemoryIds", "semantic_memory_ids",
  "lessonIds", "lesson_ids", "crystalIds", "crystal_ids", "insightIds", "insight_ids",
  "actionUpdatedAts", "action_updated_ats", "actionCount", "action_count", "itemCount",
  "item_count", "provider", "model", "promptChars", "prompt_chars",
]);

function safePrimitive(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function safeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function safeCharSizes(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([id, size]) => id.length > 0 && typeof size === "number" && Number.isFinite(size)),
  ) as Record<string, number>;
}

function safeHashRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length === 0
    || entries.some(([key, hash]) => !key || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
  ) return undefined;
  return Object.fromEntries(
    entries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, hash]) => [key, hash as string]),
  );
}

function safeResultRef(value: unknown): Record<string, string | number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const scope = typeof record.scope === "string" ? record.scope.trim() : "";
  const key = typeof record.key === "string" ? record.key.trim() : "";
  if (!scope || !key) return undefined;
  const projected: Record<string, string | number> = { scope, key };
  if (typeof record.chunkIndex === "number" && Number.isSafeInteger(record.chunkIndex) && record.chunkIndex >= 0) {
    projected.chunkIndex = record.chunkIndex;
  }
  return projected;
}

function safeSemanticRecoveryEvidence(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const identity = record.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return undefined;
  const rawIdentity = identity as Record<string, unknown>;
  const projectedIdentity = Object.fromEntries(
    [
      "runId",
      "unitId",
      "receiptInputHash",
      "runnerInputHash",
      "extractionRunId",
      "extractionWindowId",
      "inputHash",
      "configHash",
    ]
      .filter((key) => typeof rawIdentity[key] === "string" && rawIdentity[key])
      .map((key) => [key, rawIdentity[key]]),
  );
  const sourceSummaryHashes = safeHashRecord(record.sourceSummaryHashes);
  if (
    record.schema !== "semantic-rollup-recovery/v1"
    || record.phase !== "committed"
    || Object.keys(projectedIdentity).length !== 8
    || !sourceSummaryHashes
    || typeof record.receiptKey !== "string"
    || !record.receiptKey
    || record.receiptVersion !== 1
    || typeof record.resultRef !== "string"
    || !record.resultRef
    || typeof record.effectHash !== "string"
    || !/^[0-9a-f]{64}$/.test(record.effectHash)
  ) return undefined;
  return {
    schema: record.schema,
    phase: record.phase,
    receiptKey: record.receiptKey,
    receiptVersion: record.receiptVersion,
    resultRef: record.resultRef,
    effectHash: record.effectHash,
    identity: projectedIdentity,
    sourceSummaryHashes,
  };
}

function safeReflectRecoveryEvidence(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const identity = record.identity;
  const rawIdentity = identity && typeof identity === "object" && !Array.isArray(identity)
    ? identity as Record<string, unknown>
    : null;
  const projectedIdentity = rawIdentity
    ? Object.fromEntries(
        ["runId", "unitId", "inputHash"]
          .filter((key) => typeof rawIdentity[key] === "string" && rawIdentity[key])
          .map((key) => [key, rawIdentity[key]]),
      )
    : null;
  const validIdentity = projectedIdentity && Object.keys(projectedIdentity).length === 3
    ? projectedIdentity
    : null;
  if (
    record.kind === "committed"
    && record.schema === "reflect-insight-commit/v1"
    && typeof record.receiptKey === "string" && record.receiptKey
    && record.receiptVersion === 1
    && typeof record.resultRef === "string" && record.resultRef
    && typeof record.effectHash === "string" && /^[0-9a-f]{64}$/.test(record.effectHash)
  ) {
    return {
      schema: record.schema,
      kind: record.kind,
      receiptKey: record.receiptKey,
      receiptVersion: record.receiptVersion,
      resultRef: record.resultRef,
      effectHash: record.effectHash,
      ...(validIdentity ? { identity: validIdentity } : {}),
    };
  }
  const proof = record.proof;
  if (
    validIdentity
    && record.kind === "no_effect"
    && record.observation === "business_empty"
    && record.reasonCode === "no_novel_insight"
    && proof && typeof proof === "object" && !Array.isArray(proof)
    && Object.keys(proof).sort().join(",")
      === "kind,proofHash,proposalHash,reasonCode,receiptKey,receiptVersion,schema"
    && (proof as Record<string, unknown>).kind === "committed_structured_no_effect"
    && typeof (proof as Record<string, unknown>).receiptKey === "string"
    && (proof as Record<string, unknown>).receiptKey
    && (proof as Record<string, unknown>).receiptVersion === 1
    && (proof as Record<string, unknown>).schema === "reflect-insight-no-effect/v1"
    && typeof (proof as Record<string, unknown>).proposalHash === "string"
    && /^[0-9a-f]{64}$/.test((proof as Record<string, unknown>).proposalHash as string)
    && (proof as Record<string, unknown>).reasonCode === record.reasonCode
    && typeof (proof as Record<string, unknown>).proofHash === "string"
    && /^[0-9a-f]{64}$/.test((proof as Record<string, unknown>).proofHash as string)
  ) {
    return {
      kind: record.kind,
      observation: record.observation,
      reasonCode: record.reasonCode,
      identity: validIdentity,
      proof: {
        kind: "committed_structured_no_effect",
        receiptKey: (proof as Record<string, unknown>).receiptKey,
        receiptVersion: 1,
        schema: (proof as Record<string, unknown>).schema,
        proposalHash: (proof as Record<string, unknown>).proposalHash,
        reasonCode: (proof as Record<string, unknown>).reasonCode,
        proofHash: (proof as Record<string, unknown>).proofHash,
      },
    };
  }
  if (
    record.kind === "no_effect"
    && record.observation === "business_empty"
    && record.reasonCode === "insufficient_supporting_items"
    && proof && typeof proof === "object" && !Array.isArray(proof)
    && (proof as Record<string, unknown>).kind === "receipt_before_formal_effect"
    && typeof (proof as Record<string, unknown>).receiptKey === "string"
    && (proof as Record<string, unknown>).receiptVersion === 1
    && (proof as Record<string, unknown>).phase === "candidate_staging"
    && (proof as Record<string, unknown>).commitPlanAbsent === true
  ) {
    return {
      kind: record.kind,
      observation: record.observation,
      reasonCode: record.reasonCode,
      ...(validIdentity ? { identity: validIdentity } : {}),
      proof: {
        kind: "receipt_before_formal_effect",
        receiptKey: (proof as Record<string, unknown>).receiptKey,
        receiptVersion: 1,
        phase: "candidate_staging",
        commitPlanAbsent: true,
      },
    };
  }
  return undefined;
}

function safeProceduralRecoveryEvidence(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const identity = record.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return undefined;
  const rawIdentity = identity as Record<string, unknown>;
  const projectedIdentity = Object.fromEntries(
    ["runId", "unitId", "inputHash"]
      .filter((key) => typeof rawIdentity[key] === "string" && rawIdentity[key])
      .map((key) => [key, rawIdentity[key]]),
  );
  if (Object.keys(projectedIdentity).length !== 3) return undefined;
  if (
    record.schema === "consolidation-procedural-commit/v1"
    && record.kind === "committed"
    && typeof record.receiptKey === "string"
    && record.receiptKey
    && record.receiptVersion === 1
    && typeof record.resultRef === "string"
    && record.resultRef
    && typeof record.effectHash === "string"
    && /^[0-9a-f]{64}$/.test(record.effectHash)
  ) {
    return {
      schema: record.schema,
      kind: record.kind,
      receiptKey: record.receiptKey,
      receiptVersion: record.receiptVersion,
      resultRef: record.resultRef,
      effectHash: record.effectHash,
      identity: projectedIdentity,
    };
  }
  const proof = record.proof;
  if (
    record.kind === "no_effect"
    && record.observation === "business_empty"
    && record.reasonCode === "no_reusable_procedure"
    && proof && typeof proof === "object" && !Array.isArray(proof)
    && Object.keys(proof).sort().join(",")
      === "kind,proofHash,proposalHash,reasonCode,receiptKey,receiptVersion,schema"
    && (proof as Record<string, unknown>).kind === "committed_structured_no_effect"
    && typeof (proof as Record<string, unknown>).receiptKey === "string"
    && (proof as Record<string, unknown>).receiptKey
    && (proof as Record<string, unknown>).receiptVersion === 1
    && (proof as Record<string, unknown>).schema === "consolidation-procedural-no-effect/v1"
    && typeof (proof as Record<string, unknown>).proposalHash === "string"
    && /^[0-9a-f]{64}$/.test((proof as Record<string, unknown>).proposalHash as string)
    && (proof as Record<string, unknown>).reasonCode === record.reasonCode
    && typeof (proof as Record<string, unknown>).proofHash === "string"
    && /^[0-9a-f]{64}$/.test((proof as Record<string, unknown>).proofHash as string)
  ) {
    return {
      kind: record.kind,
      observation: record.observation,
      reasonCode: record.reasonCode,
      identity: projectedIdentity,
      proof: {
        kind: "committed_structured_no_effect",
        receiptKey: (proof as Record<string, unknown>).receiptKey,
        receiptVersion: 1,
        schema: (proof as Record<string, unknown>).schema,
        proposalHash: (proof as Record<string, unknown>).proposalHash,
        reasonCode: (proof as Record<string, unknown>).reasonCode,
        proofHash: (proof as Record<string, unknown>).proofHash,
      },
    };
  }
  if (
    record.kind === "no_effect"
    && record.observation === "business_empty"
    && record.reasonCode === "fewer_than_2_recurring_patterns"
    && proof && typeof proof === "object" && !Array.isArray(proof)
    && (proof as Record<string, unknown>).kind === "receipt_before_formal_effect"
    && typeof (proof as Record<string, unknown>).receiptKey === "string"
    && (proof as Record<string, unknown>).receiptVersion === 1
    && (proof as Record<string, unknown>).phase === "candidate_staging"
    && (proof as Record<string, unknown>).commitPlanAbsent === true
  ) {
    return {
      kind: record.kind,
      observation: record.observation,
      reasonCode: record.reasonCode,
      identity: projectedIdentity,
      proof: {
        kind: "receipt_before_formal_effect",
        receiptKey: (proof as Record<string, unknown>).receiptKey,
        receiptVersion: 1,
        phase: "candidate_staging",
        commitPlanAbsent: true,
      },
    };
  }
  return undefined;
}

function safeCrystalRecoveryEvidence(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const identity = record.identity;
  const group = record.group;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return undefined;
  if (!group || typeof group !== "object" || Array.isArray(group)) return undefined;
  const rawIdentity = identity as Record<string, unknown>;
  const rawGroup = group as Record<string, unknown>;
  const projectedIdentity = Object.fromEntries(
    ["runId", "unitId", "inputHash"]
      .filter((key) => typeof rawIdentity[key] === "string" && rawIdentity[key])
      .map((key) => [key, rawIdentity[key]]),
  );
  const groupId = typeof rawGroup.groupId === "string" ? rawGroup.groupId : "";
  const actionIds = safeStringArray(rawGroup.actionIds);
  const actionUpdatedAts = safeStringArray(rawGroup.actionUpdatedAts);
  if (
    Object.keys(projectedIdentity).length !== 3
    || record.schema !== "crystal-recovery/v1"
    || record.phase !== "committed"
    || typeof record.receiptKey !== "string"
    || !record.receiptKey
    || record.receiptVersion !== 1
    || !groupId
    || !actionIds
    || actionIds.length === 0
    || !actionUpdatedAts
    || actionUpdatedAts.length !== actionIds.length
    || typeof record.resultRef !== "string"
    || !record.resultRef
    || typeof record.effectHash !== "string"
    || !/^[0-9a-f]{64}$/.test(record.effectHash)
  ) return undefined;
  return {
    schema: record.schema,
    phase: record.phase,
    receiptKey: record.receiptKey,
    receiptVersion: record.receiptVersion,
    resultRef: record.resultRef,
    effectHash: record.effectHash,
    identity: projectedIdentity,
    group: {
      groupId,
      actionIds,
      actionUpdatedAts,
    },
  };
}

function safeUnitResponse(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!UNIT_RECEIPT_KEYS.has(key)) continue;
    const safe = key.endsWith("Ids") || key.endsWith("_ids") || key === "actionUpdatedAts" || key === "action_updated_ats"
      ? safeStringArray(raw)
      : safePrimitive(raw);
    if (safe !== undefined) projected[key] = safe;
  }
  return projected;
}

function safeDomainEffectEvidence(
  stage: ExtractionOperationIdentity["stage"],
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    (stage !== "memory_consolidate" && stage !== "skill_extract")
    || !value
    || typeof value !== "object"
    || Array.isArray(value)
  ) return undefined;
  const record = value as Record<string, unknown>;
  const expectedSchema = stage === "memory_consolidate"
    ? "memory-consolidate-domain-effect/v1"
    : "skill-extract-domain-effect/v1";
  if (
    Object.keys(record).sort().join(",") !== "auditId,effectHash,proposalHash,resultId,schema"
    || record.schema !== expectedSchema
    || typeof record.proposalHash !== "string"
    || record.proposalHash.length === 0
    || typeof record.resultId !== "string"
    || record.resultId.length === 0
    || typeof record.auditId !== "string"
    || record.auditId.length === 0
    || typeof record.effectHash !== "string"
    || !/^[0-9a-f]{64}$/.test(record.effectHash)
  ) return undefined;
  return {
    schema: record.schema,
    proposalHash: record.proposalHash,
    resultId: record.resultId,
    auditId: record.auditId,
    effectHash: record.effectHash,
  };
}

function safeMemoryNoEffectEvidence(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "proofHash,proposalHash,reasonCode,schema"
    || record.schema !== "memory-consolidate-no-effect/v1"
    || typeof record.proposalHash !== "string"
    || record.proposalHash.length === 0
    || record.reasonCode !== "no_durable_memory"
    || typeof record.proofHash !== "string"
    || !/^[0-9a-f]{64}$/.test(record.proofHash)
  ) return undefined;
  return {
    schema: record.schema,
    proposalHash: record.proposalHash,
    reasonCode: record.reasonCode,
    proofHash: record.proofHash,
  };
}

function safeResponse<T>(stage: ExtractionOperationIdentity["stage"], response: T): T {
  if (!response || typeof response !== "object" || Array.isArray(response)) return {} as T;
  const allowed = STAGE_RECEIPT_RESPONSE_KEYS[stage];
  const projected: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(response as Record<string, unknown>)) {
    if (!COMMON_RECEIPT_RESPONSE_KEYS.has(key) && !allowed.has(key)) continue;
    let safe: unknown;
    if (key === "resultRef") {
      safe = safeResultRef(raw);
    } else if (key === "runs" && stage === "lessons") {
      safe = Array.isArray(raw)
        ? raw.map((item) => safeLessonRun(item)).filter((item) => item !== undefined)
        : undefined;
    } else if (key === "semanticMemoryCharSizes" || key === "semantic_memory_char_sizes") {
      safe = safeCharSizes(raw);
    } else if (key === "semanticRecoveryEvidence" || key === "semantic_recovery_evidence") {
      safe = safeSemanticRecoveryEvidence(raw);
    } else if (key === "reflectRecoveryEvidence" || key === "reflect_recovery_evidence") {
      safe = safeReflectRecoveryEvidence(raw);
    } else if (key === "proceduralRecoveryEvidence" || key === "procedural_recovery_evidence") {
      safe = safeProceduralRecoveryEvidence(raw);
    } else if (key === "crystalRecoveryEvidence" || key === "crystal_recovery_evidence") {
      safe = safeCrystalRecoveryEvidence(raw);
    } else if (key === "domainEffectEvidence" || key === "domain_effect_evidence") {
      safe = safeDomainEffectEvidence(stage, raw);
    } else if (key === "noEffectEvidence" || key === "no_effect_evidence") {
      safe = stage === "memory_consolidate" ? safeMemoryNoEffectEvidence(raw) : undefined;
    } else if (key === "groups" || key === "items") {
      safe = Array.isArray(raw)
        ? raw.map((item) => safeUnitResponse(item)).filter((item) => item !== undefined)
        : undefined;
    } else if (key.endsWith("Ids") || key.endsWith("_ids")) {
      safe = safeStringArray(raw);
    } else {
      safe = safePrimitive(raw);
    }
    if (safe !== undefined) projected[key] = safe;
  }
  return projected as T;
}

function causeFromError(error: unknown): StageFailure {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (/pi_auth_missing|pi_auth_failed|pi_model_not_found|pi_sdk_import_failed/.test(normalized)) {
    const cause = normalized.match(/pi_(?:auth_missing|auth_failed|model_not_found|sdk_import_failed)/)?.[0]
      ?? "provider_contract_error";
    return { class: "hard", cause };
  }
  if (normalized.includes("circuit_breaker_open")) {
    return { class: "transient_provider", cause: "circuit_breaker_open" };
  }
  if (normalized.includes("pi_stream_failed")) {
    return { class: "transient_provider", cause: "pi_stream_failed" };
  }
  return { class: "transient_runtime", cause: "extraction_operation_interrupted" };
}

function safeFailureDiagnostics(value: unknown): StageFailure["diagnostics"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    (raw.requestPhase !== "chunk" && raw.requestPhase !== "reduce")
    || typeof raw.providerErrorCode !== "string"
    || !PROVIDER_ERROR_CODES.has(raw.providerErrorCode)
    || !Number.isSafeInteger(raw.elapsedMs) || Number(raw.elapsedMs) < 0
    || !Number.isSafeInteger(raw.inputChars) || Number(raw.inputChars) < 0
    || !Number.isSafeInteger(raw.maxOutputTokens) || Number(raw.maxOutputTokens) < 0
    || typeof raw.responseStarted !== "boolean"
  ) return undefined;
  const statusCode = Number.isSafeInteger(raw.statusCode) && Number(raw.statusCode) >= 0
    ? Number(raw.statusCode) : undefined;
  const retryAfterMs = Number.isSafeInteger(raw.retryAfterMs) && Number(raw.retryAfterMs) >= 0
    ? Number(raw.retryAfterMs) : undefined;
  const responseModel = typeof raw.responseModel === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(raw.responseModel.trim())
    ? raw.responseModel.trim() : undefined;
  const stopReason = typeof raw.stopReason === "string" && PROVIDER_STOP_REASONS.has(raw.stopReason)
    ? raw.stopReason : undefined;
  return {
    requestPhase: raw.requestPhase as NonNullable<StageFailure["diagnostics"]>["requestPhase"],
    providerErrorCode: raw.providerErrorCode as NonNullable<StageFailure["diagnostics"]>["providerErrorCode"],
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    elapsedMs: Number(raw.elapsedMs),
    inputChars: Number(raw.inputChars),
    maxOutputTokens: Number(raw.maxOutputTokens),
    responseStarted: raw.responseStarted,
    ...(responseModel ? { responseModel } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

function retryableFailureFromResponse(response: unknown, failure: StageFailure): boolean {
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const retryable = (response as Record<string, unknown>).retryableReceiptFailure;
  return retryable === true
    && (failure.class === "transient_provider" || failure.class === "transient_runtime")
    && (failure.phase === "provider_call" || failure.phase === "before_final_persistence");
}

function canReopenFailedReceipt(receipt: ExtractionOperationReceipt): boolean {
  const failure = receipt.failure;
  const safeFailure = receipt.retry?.lastSafeFailure;
  return Boolean(
    safeFailure
    && failure
    && (failure.class === "transient_provider" || failure.class === "transient_runtime")
    && (failure.phase === "provider_call" || failure.phase === "before_final_persistence")
    && safeFailure.errorClass === failure.class
    && safeFailure.cause === failure.cause
    && safeFailure.phase === failure.phase,
  );
}

function freshReceiptStartedAt(receipt: ExtractionOperationReceipt): string {
  const priorBoundaries = [
    receipt.startedAt,
    receipt.completedAt,
    receipt.reconciliation?.at,
  ]
    .map((value) => typeof value === "string" ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  const nextBoundary = priorBoundaries.length > 0
    ? Math.max(...priorBoundaries) + 1
    : Date.now();
  return new Date(Math.max(Date.now(), nextBoundary)).toISOString();
}

function retryAuthorizationMatches(
  identity: ExtractionOperationIdentity,
  receipt: ExtractionOperationReceipt,
  authorization: FailedExtractionOperationRetryAuthorization,
): boolean {
  const failure = receipt.failure;
  const retry = receipt.retry;
  const lastSafeFailure = retry?.lastSafeFailure;
  return Boolean(
    failure
    && retry
    && lastSafeFailure
    && authorization.receiptInputHash === identity.inputHash
    && authorization.receiptInputHash === receipt.inputHash
    && authorization.retryEpoch === retry.epoch
    && authorization.failureClass === failure.class
    && authorization.failureCause === failure.cause
    && authorization.failurePhase === failure.phase
    && authorization.lastSafeFailure.errorClass === lastSafeFailure.errorClass
    && authorization.lastSafeFailure.cause === lastSafeFailure.cause
    && authorization.lastSafeFailure.phase === lastSafeFailure.phase
    && authorization.lastSafeFailure.timestamp === lastSafeFailure.timestamp
  );
}

function legacyLessonRetryAuthorizationMatches(
  identity: ExtractionOperationIdentity,
  receipt: ExtractionOperationReceipt,
  authorization: FailedExtractionOperationRetryAuthorization,
): boolean {
  const failure = receipt.failure;
  const lastSafeFailure = authorization.lastSafeFailure;
  return Boolean(
    identity.stage === "lessons"
    && receipt.stage === "lessons"
    && receipt.status === "failed"
    && failure
    && failure.phase === undefined
    && receipt.retry === undefined
    && authorization.receiptInputHash === identity.inputHash
    && authorization.receiptInputHash === receipt.inputHash
    && authorization.retryEpoch === 0
    && authorization.failureClass === failure.class
    && authorization.failureCause === failure.cause
    && authorization.failurePhase === "provider_call"
    && lastSafeFailure.errorClass === authorization.failureClass
    && lastSafeFailure.cause === authorization.failureCause
    && lastSafeFailure.phase === authorization.failurePhase
  );
}

function retryAuthorizationFailure<T>(
  receipt: ExtractionOperationReceipt<T> | null | undefined,
): ExtractionOperationResult<T> {
  return {
    replayed: true,
    failure: {
      class: "hard",
      cause: "extraction_operation_retry_authorization_drifted",
    },
    ...(receipt ? { receipt } : {}),
  };
}

function failureFromResponse(response: unknown): StageFailure | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const record = response as Record<string, unknown>;
  if (record.success !== false && record.status !== "failed") return null;
  const failure = record.failure;
  if (failure && typeof failure === "object" && !Array.isArray(failure)) {
    const candidate = failure as Record<string, unknown>;
    if (
      ["transient_provider", "transient_runtime", "unit", "hard"].includes(String(candidate.class))
      && typeof candidate.cause === "string"
      && candidate.cause.trim()
    ) {
      const diagnostics = safeFailureDiagnostics(candidate.diagnostics);
      return {
        class: candidate.class as StageFailure["class"],
        cause: candidate.cause.trim(),
        ...(typeof candidate.phase === "string" && RECEIPT_FAILURE_PHASES.has(candidate.phase)
          ? { phase: candidate.phase as StageFailure["phase"] }
          : {}),
        ...(diagnostics
          ? { diagnostics }
          : {}),
      };
    }
  }
  return causeFromError(record.error ?? "operation failed");
}

function failedReceipt<T>(
  identity: ExtractionOperationIdentity,
  key: string,
  startedAt: string,
  failure: StageFailure,
  retry: ExtractionOperationReceipt<T>["retry"] | undefined,
): ExtractionOperationReceipt<T> {
  return {
    ...identity,
    key,
    version: EXTRACTION_OPERATION_RECEIPT_VERSION,
    status: "failed",
    startedAt,
    completedAt: new Date().toISOString(),
    failure,
    ...(retry ? { retry } : {}),
  };
}

function completedReceipt<T>(
  identity: ExtractionOperationIdentity,
  key: string,
  startedAt: string,
  response: T,
  retry: ExtractionOperationReceipt<T>["retry"] | undefined = undefined,
  stageRecovery: Record<string, unknown> = {},
): ExtractionOperationReceipt<T> {
  return {
    ...identity,
    key,
    version: EXTRACTION_OPERATION_RECEIPT_VERSION,
    status: "succeeded",
    startedAt,
    completedAt: new Date().toISOString(),
    response,
    ...(retry ? { retry } : {}),
    ...stageRecovery,
  };
}

export function buildExtractionOperationKey(
  identity: Pick<ExtractionOperationIdentity, "runId" | "stage" | "unitId">,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([identity.runId, identity.stage, identity.unitId]))
    .digest("hex");
  return `xop_${hash.slice(0, 32)}`;
}

type ReceiptWithStageRecovery = ExtractionOperationReceipt & {
  semanticRecovery?: { schema?: unknown; phase?: unknown; identity?: unknown };
  crystalRecovery?: { schema?: unknown; phase?: unknown; identity?: unknown };
  reflectRecovery?: { schema?: unknown; phase?: unknown; identity?: unknown };
  proceduralRecovery?: { schema?: unknown; phase?: unknown; identity?: unknown };
};

const DOMAIN_REVERIFICATION_STAGES = new Set<ExtractionOperationIdentity["stage"]>([
  "memory_consolidate",
  "semantic_rollup",
  "skill_extract",
  "crystal",
  "reflect_insight",
  "consolidation_procedural",
]);
const PROPOSAL_REVERIFICATION_STAGES = new Set<ExtractionOperationIdentity["stage"]>([
  "memory_consolidate",
  "skill_extract",
]);

function recoveryIdentityMatchesReceipt(
  receipt: ExtractionOperationReceipt,
  recovery: { identity?: unknown },
  inputHashKey: "inputHash" | "receiptInputHash" = "inputHash",
): boolean {
  if (!recovery.identity || typeof recovery.identity !== "object" || Array.isArray(recovery.identity)) {
    return false;
  }
  const identity = recovery.identity as Record<string, unknown>;
  return identity.runId === receipt.runId
    && identity.unitId === receipt.unitId
    && identity[inputHashKey] === receipt.inputHash;
}

function hasResumableStageRecovery(receipt: ExtractionOperationReceipt): boolean {
  const recoveries = receipt as ReceiptWithStageRecovery;
  if (receipt.stage === "semantic_rollup") {
    return recoveries.semanticRecovery?.schema === "semantic-rollup-recovery/v1"
      && (recoveries.semanticRecovery.phase === "staged" || recoveries.semanticRecovery.phase === "committed")
      && recoveryIdentityMatchesReceipt(receipt, recoveries.semanticRecovery, "receiptInputHash");
  }
  if (receipt.stage === "crystal") {
    return recoveries.crystalRecovery?.schema === "crystal-recovery/v1"
      && (recoveries.crystalRecovery.phase === "staged" || recoveries.crystalRecovery.phase === "committed")
      && recoveryIdentityMatchesReceipt(receipt, recoveries.crystalRecovery);
  }
  const recovery = receipt.stage === "reflect_insight"
    ? recoveries.reflectRecovery
    : receipt.stage === "consolidation_procedural"
      ? recoveries.proceduralRecovery
      : undefined;
  const schema = receipt.stage === "reflect_insight"
    ? "reflect-insight-recovery/v1"
    : receipt.stage === "consolidation_procedural"
      ? "consolidation-procedural-recovery/v1"
      : null;
  return schema !== null
    && recovery?.schema === schema
    && (recovery.phase === "staged" || recovery.phase === "committed")
    && recoveryIdentityMatchesReceipt(receipt, recovery);
}

function stageRecoveryFields(receipt: ExtractionOperationReceipt | null | undefined): Record<string, unknown> {
  if (!receipt) return {};
  const recoveries = receipt as ReceiptWithStageRecovery;
  if (receipt.stage === "semantic_rollup" && recoveries.semanticRecovery !== undefined) {
    return { semanticRecovery: recoveries.semanticRecovery };
  }
  if (receipt.stage === "crystal" && recoveries.crystalRecovery !== undefined) {
    return { crystalRecovery: recoveries.crystalRecovery };
  }
  if (receipt.stage === "reflect_insight" && recoveries.reflectRecovery !== undefined) {
    return { reflectRecovery: recoveries.reflectRecovery };
  }
  if (
    receipt.stage === "consolidation_procedural"
    && recoveries.proceduralRecovery !== undefined
  ) {
    return { proceduralRecovery: recoveries.proceduralRecovery };
  }
  return {};
}

function requiresDomainReverification(
  receipt: ExtractionOperationReceipt,
  options: { requireExisting?: boolean },
): boolean {
  return options.requireExisting === true
    && receipt.status === "succeeded"
    && DOMAIN_REVERIFICATION_STAGES.has(receipt.stage);
}

function reconciliationRequired<T>(
  receipt?: ExtractionOperationReceipt<T>,
  receiptAbsence?: ExtractionOperationReceiptAbsence,
): ExtractionOperationResult<T> {
  return {
    replayed: true,
    failure: {
      class: "transient_runtime",
      cause: "extraction_operation_reconciliation_required",
    },
    ...(receipt ? { receipt } : {}),
    ...(receiptAbsence ? { receiptAbsence } : {}),
  };
}

export function createExtractionOperationReceiptAbsence(
  identity: ExtractionOperationIdentity,
  observedAt = new Date().toISOString(),
): ExtractionOperationReceiptAbsence {
  return {
    schema: "extraction-operation-receipt-absence/v1",
    ...identity,
    key: buildExtractionOperationKey(identity),
    observedAt,
  };
}

export function projectExtractionOperationReceiptAbsence(
  receiptAbsence: ExtractionOperationReceiptAbsence | undefined,
  runnerInputHash: string,
): ExtractionOperationReceiptAbsenceProjection | undefined {
  return receiptAbsence
    ? { ...receiptAbsence, runnerInputHash }
    : undefined;
}

function failedReverificationResult<T>(
  failure: StageFailure,
  receipt: ExtractionOperationReceipt<T>,
): ExtractionOperationResult<T> {
  return {
    replayed: true,
    failure,
    receipt,
  };
}

function isSucceededDomainReverification(
  receipt: ExtractionOperationReceipt | null | undefined,
  options: { requireExisting?: boolean },
): boolean {
  return Boolean(receipt && requiresDomainReverification(receipt, options));
}

function canReverifySucceededReceipt(receipt: ExtractionOperationReceipt): boolean {
  return PROPOSAL_REVERIFICATION_STAGES.has(receipt.stage)
    || hasResumableStageRecovery(receipt);
}

function latestReceiptForCompletion<T>(
  latest: ExtractionOperationReceipt<T> | null,
  fallback: ExtractionOperationReceipt<T>,
): ExtractionOperationReceipt<T> {
  return latest && latest.inputHash === fallback.inputHash ? latest : fallback;
}

function hasValidRecoveryAfterVerification(receipt: ExtractionOperationReceipt): boolean {
  return !DOMAIN_REVERIFICATION_STAGES.has(receipt.stage)
    || PROPOSAL_REVERIFICATION_STAGES.has(receipt.stage)
    || hasResumableStageRecovery(receipt);
}

export async function withExtractionOperationReceipt<T>(
  kv: StateKV,
  identity: ExtractionOperationIdentity,
  execute: () => Promise<T>,
  options: ExtractionOperationReceiptOptions = {},
): Promise<ExtractionOperationResult<T>> {
  if (
    options.expectedInputHash !== undefined
    && options.expectedInputHash !== identity.inputHash
  ) {
    return {
      replayed: false,
      failure: {
        class: "hard",
        cause: "extraction_operation_input_hash_drifted_after_absence",
      },
    };
  }
  const key = buildExtractionOperationKey(identity);
  return withKeyedLock(`extraction-operation:${key}`, async () => {
    let existing = await kv.get<ExtractionOperationReceipt<T>>(
      KV.extractionOperationReceipt(key),
      key,
    );
    if (existing && existing.inputHash !== identity.inputHash) {
      const failure: StageFailure = {
        class: "hard",
        cause: "extraction_operation_input_hash_conflict",
      };
      return { replayed: true, failure, receipt: existing };
    }
    const succeededReverification = isSucceededDomainReverification(existing, options);
    if (existing?.status === "succeeded" && existing.response !== undefined) {
      if (!succeededReverification) {
        return { replayed: true, response: existing.response, receipt: existing };
      }
      if (!canReverifySucceededReceipt(existing)) {
        return reconciliationRequired(existing);
      }
    }
    const resumableRunning = existing?.status === "running"
      && hasResumableStageRecovery(existing);
    if (existing?.status === "running" && !resumableRunning) {
      const failure: StageFailure = {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      };
      return { replayed: true, failure, receipt: existing };
    }
    const failedRetryAuthorizationMatches = Boolean(
      options.failedRetryAuthorization
      && existing?.status === "failed"
      && (
        retryAuthorizationMatches(identity, existing, options.failedRetryAuthorization)
        || (
          options.allowLegacyLessonFailedRetry === true
          && legacyLessonRetryAuthorizationMatches(
            identity,
            existing,
            options.failedRetryAuthorization,
          )
        )
      ),
    );
    if (options.failedRetryAuthorization) {
      if (
        existing?.status !== "failed"
        || !failedRetryAuthorizationMatches
      ) {
        if (existing?.status === "failed" && canReopenFailedReceipt(existing)) {
          const failure = existing.failure ?? {
            class: "unit" as const,
            cause: "extraction_operation_failed",
          };
          return { replayed: true, failure, receipt: existing };
        }
        return retryAuthorizationFailure(existing);
      }
    }
    let reopened = false;
    if (existing?.status === "failed") {
      if (
        options.retryFailed
        && options.requireExisting
        && (canReopenFailedReceipt(existing) || failedRetryAuthorizationMatches)
      ) {
        const retryEpoch = existing.retry?.epoch
          ?? options.failedRetryAuthorization?.retryEpoch
          ?? 0;
        const lastSafeFailure = existing.retry?.lastSafeFailure
          ?? options.failedRetryAuthorization?.lastSafeFailure;
        const running: ExtractionOperationReceipt<T> = {
          ...existing,
          version: existing.version ?? EXTRACTION_OPERATION_RECEIPT_VERSION,
          status: "running",
          completedAt: undefined,
          response: undefined,
          failure: undefined,
          retry: {
            ...existing.retry,
            epoch: retryEpoch + 1,
            ...(lastSafeFailure ? { lastSafeFailure } : {}),
          },
        };
        await kv.set(KV.extractionOperationReceipt(key), key, running);
        existing = running;
        reopened = true;
      } else {
        const failure = existing.failure ?? {
          class: "unit" as const,
          cause: "extraction_operation_failed",
        };
        return { replayed: true, failure, receipt: existing };
      }
    }
    if (
      options.requireExisting
      && !reopened
      && !resumableRunning
      && !succeededReverification
    ) {
      return reconciliationRequired(
        undefined,
        createExtractionOperationReceiptAbsence(identity),
      );
    }

    let startedAt: string;
    let running: ExtractionOperationReceipt<T>;
    if (existing?.status === "reconciled") {
      startedAt = freshReceiptStartedAt(existing);
      running = {
        runId: existing.runId,
        stage: existing.stage,
        unitId: existing.unitId,
        inputHash: existing.inputHash,
        key: existing.key,
        version: existing.version ?? EXTRACTION_OPERATION_RECEIPT_VERSION,
        status: "running",
        startedAt,
        ...(existing.retry ? { retry: existing.retry } : {}),
      };
      await kv.set(KV.extractionOperationReceipt(key), key, running);
    } else {
      startedAt = existing?.startedAt ?? new Date().toISOString();
      running = existing ?? {
        ...identity,
        key,
        version: EXTRACTION_OPERATION_RECEIPT_VERSION,
        status: "running",
        startedAt,
      };
      if (!existing) await kv.set(KV.extractionOperationReceipt(key), key, running);
    }
    let rawResponse: T;
    try {
      rawResponse = await execute();
    } catch (error) {
      const latest = latestReceiptForCompletion(
        await kv.get<ExtractionOperationReceipt<T>>(KV.extractionOperationReceipt(key), key),
        running,
      );
      if (succeededReverification) {
        const failure = error instanceof ExtractionOperationResultUncertainError
          ? {
            class: "transient_runtime" as const,
            cause: "extraction_operation_reconciliation_required",
            phase: "final_result_persistence" as const,
          }
          : causeFromError(error);
        return failedReverificationResult(failure, latest);
      }
      if (error instanceof ExtractionOperationResultUncertainError) {
        const timestamp = new Date().toISOString();
        const failure: StageFailure = {
          class: "transient_runtime",
          cause: "extraction_operation_reconciliation_required",
          phase: "final_result_persistence",
        };
        const uncertain: ExtractionOperationReceipt<T> = {
          ...latest,
          failure,
          uncertainty: {
            phase: "final_result_persistence",
            errorClass: "transient_runtime",
            cause: "extraction_operation_reconciliation_required",
            timestamp,
          },
        };
        await kv.set(KV.extractionOperationReceipt(key), key, uncertain);
        return { replayed: false, failure, receipt: uncertain };
      }
      const failure: StageFailure = {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      };
      return { replayed: false, failure, receipt: latest };
    }
    const responseFailure = failureFromResponse(rawResponse);
    if (responseFailure) {
      const latest = latestReceiptForCompletion(
        await kv.get<ExtractionOperationReceipt<T>>(KV.extractionOperationReceipt(key), key),
        running,
      );
      if (succeededReverification) {
        return failedReverificationResult(responseFailure, latest);
      }
      if (
        responseFailure.class !== "hard"
        && latest.status === "running"
        && hasResumableStageRecovery(latest)
      ) {
        return reconciliationRequired(latest);
      }
      const retry = retryableFailureFromResponse(rawResponse, responseFailure)
        ? {
          epoch: latest.retry?.epoch ?? 0,
          lastSafeFailure: {
            errorClass: responseFailure.class,
            cause: responseFailure.cause,
            timestamp: new Date().toISOString(),
            ...(responseFailure.phase ? { phase: responseFailure.phase } : {}),
            ...(responseFailure.diagnostics ? { diagnostics: responseFailure.diagnostics } : {}),
          },
        }
        : latest.retry;
      const failed = {
        ...failedReceipt<T>(identity, key, startedAt, responseFailure, retry),
        ...stageRecoveryFields(latest),
      };
      await kv.set(KV.extractionOperationReceipt(key), key, failed);
      return { replayed: false, failure: responseFailure, receipt: failed };
    }
    const latest = latestReceiptForCompletion(
      await kv.get<ExtractionOperationReceipt<T>>(KV.extractionOperationReceipt(key), key),
      running,
    );
    if (succeededReverification && !hasValidRecoveryAfterVerification(latest)) {
      return reconciliationRequired(existing!);
    }
    const response = safeResponse(identity.stage, rawResponse);
    const succeeded = completedReceipt(
      identity,
      key,
      startedAt,
      response,
      latest.retry,
      stageRecoveryFields(latest),
    );
    await kv.set(KV.extractionOperationReceipt(key), key, succeeded);
    return { replayed: succeededReverification, response, receipt: succeeded };
  });
}

export async function completeModelOperationFromVerifiedResult<T>(
  kv: StateKV,
  identity: ExtractionOperationIdentity,
  verifiedResponse: T,
  options: { allowMissing?: boolean } = {},
): Promise<ExtractionOperationResult<T>> {
  const key = buildExtractionOperationKey(identity);
  return withKeyedLock(`extraction-operation:${key}`, async () => {
    const existing = await kv.get<ExtractionOperationReceipt<T>>(
      KV.extractionOperationReceipt(key),
      key,
    );
    if (!existing && options.allowMissing === true) {
      const response = safeResponse(identity.stage, verifiedResponse);
      const succeeded = completedReceipt(
        identity,
        key,
        new Date().toISOString(),
        response,
      );
      await kv.set(KV.extractionOperationReceipt(key), key, succeeded);
      return { replayed: true, response, receipt: succeeded };
    }
    if (!existing || existing.inputHash !== identity.inputHash) {
      const failure: StageFailure = {
        class: "hard",
        cause: existing
          ? "extraction_operation_input_hash_conflict"
          : "extraction_operation_receipt_not_running",
      };
      return {
        replayed: true,
        failure,
        receipt: existing ?? {
          ...identity,
          key,
          version: EXTRACTION_OPERATION_RECEIPT_VERSION,
          status: "failed",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          failure,
        },
      };
    }
    if (existing.status === "succeeded" && existing.response !== undefined) {
      return { replayed: true, response: existing.response, receipt: existing };
    }
    if (existing.status === "failed") {
      return {
        replayed: true,
        failure: existing.failure ?? { class: "unit", cause: "extraction_operation_failed" },
        receipt: existing,
      };
    }
    const response = safeResponse(identity.stage, verifiedResponse);
    const succeeded = completedReceipt(identity, key, existing.startedAt, response);
    await kv.set(KV.extractionOperationReceipt(key), key, succeeded);
    return { replayed: true, response, receipt: succeeded };
  });
}

export async function withIdempotentCommitReceipt<T>(
  kv: StateKV,
  identity: ExtractionOperationIdentity,
  executeCommit: () => Promise<T>,
  options: { requireExisting?: boolean; expectedInputHash?: string } = {},
): Promise<ExtractionOperationResult<T>> {
  if (
    options.expectedInputHash !== undefined
    && options.expectedInputHash !== identity.inputHash
  ) {
    return {
      replayed: false,
      failure: {
        class: "hard",
        cause: "extraction_operation_input_hash_drifted_after_absence",
      },
    };
  }
  const key = buildExtractionOperationKey(identity);
  return withKeyedLock(`extraction-operation:${key}`, async () => {
    const existing = await kv.get<ExtractionOperationReceipt<T>>(
      KV.extractionOperationReceipt(key),
      key,
    );
    if (existing && existing.inputHash !== identity.inputHash) {
      const failure: StageFailure = {
        class: "hard",
        cause: "extraction_operation_input_hash_conflict",
      };
      return { replayed: true, failure, receipt: existing };
    }
    const succeededReverification = isSucceededDomainReverification(existing, options);
    if (existing?.status === "succeeded" && existing.response !== undefined) {
      if (!succeededReverification) {
        return { replayed: true, response: existing.response, receipt: existing };
      }
      if (!canReverifySucceededReceipt(existing)) {
        return reconciliationRequired(existing);
      }
    }
    if (existing?.status === "failed") {
      return {
        replayed: true,
        failure: existing.failure ?? { class: "unit", cause: "extraction_operation_failed" },
        receipt: existing,
      };
    }
    if (
      existing?.status === "running"
      && existing.stage === "crystal"
      && !hasResumableStageRecovery(existing)
    ) {
      return reconciliationRequired(existing);
    }
    if (!existing && options.requireExisting) {
      return reconciliationRequired(
        undefined,
        createExtractionOperationReceiptAbsence(identity),
      );
    }

    const startedAt = existing?.startedAt ?? new Date().toISOString();
    if (!existing) {
      await kv.set<ExtractionOperationReceipt<T>>(KV.extractionOperationReceipt(key), key, {
        ...identity,
        key,
        version: EXTRACTION_OPERATION_RECEIPT_VERSION,
        status: "running",
        startedAt,
      });
    }

    let rawResponse: T;
    try {
      rawResponse = await executeCommit();
    } catch (error) {
      const failure = causeFromError(error);
      const fallback = existing ?? {
        ...identity,
        key,
        version: EXTRACTION_OPERATION_RECEIPT_VERSION,
        status: "running" as const,
        startedAt,
      };
      const latest = latestReceiptForCompletion(
        await kv.get<ExtractionOperationReceipt<T>>(KV.extractionOperationReceipt(key), key),
        fallback,
      );
      if (succeededReverification) {
        return failedReverificationResult(failure, latest);
      }
      return { replayed: Boolean(existing), failure, receipt: latest };
    }
    const responseFailure = failureFromResponse(rawResponse);
    if (responseFailure) {
      const fallback = existing ?? {
        ...identity,
        key,
        version: EXTRACTION_OPERATION_RECEIPT_VERSION,
        status: "running" as const,
        startedAt,
      };
      const latest = latestReceiptForCompletion(
        await kv.get<ExtractionOperationReceipt<T>>(KV.extractionOperationReceipt(key), key),
        fallback,
      );
      if (succeededReverification) {
        return failedReverificationResult(responseFailure, latest);
      }
      if (
        responseFailure.class !== "hard"
        && latest.status === "running"
        && hasResumableStageRecovery(latest)
      ) {
        return reconciliationRequired(latest);
      }
      const failed = {
        ...failedReceipt<T>(identity, key, startedAt, responseFailure, undefined),
        ...stageRecoveryFields(latest),
      };
      await kv.set(KV.extractionOperationReceipt(key), key, failed);
      return { replayed: Boolean(existing), failure: responseFailure, receipt: failed };
    }
    const fallback = existing ?? {
      ...identity,
      key,
      version: EXTRACTION_OPERATION_RECEIPT_VERSION,
      status: "running" as const,
      startedAt,
    };
    const latest = latestReceiptForCompletion(
      await kv.get<ExtractionOperationReceipt<T>>(KV.extractionOperationReceipt(key), key),
      fallback,
    );
    if (succeededReverification && !hasValidRecoveryAfterVerification(latest)) {
      return reconciliationRequired(existing!);
    }
    const response = safeResponse(identity.stage, rawResponse);
    const succeeded = completedReceipt(
      identity,
      key,
      startedAt,
      response,
      latest.retry,
      stageRecoveryFields(latest),
    );
    await kv.set(KV.extractionOperationReceipt(key), key, succeeded);
    return { replayed: Boolean(existing), response, receipt: succeeded };
  });
}

export interface ExtractionOperationReconciliationVerifiers {
  findMemoryProposal?: (
    kv: StateKV,
    identity: ExtractionOperationIdentity,
  ) => Promise<Record<string, unknown> | null>;
  findSkillProposal?: (
    kv: StateKV,
    identity: ExtractionOperationIdentity,
  ) => Promise<Record<string, unknown> | null>;
  verifyLessonResult?: (
    kv: StateKV,
    identity: ExtractionOperationIdentity,
    runnerInputHash: string,
  ) => Promise<"absent" | "present" | "drifted">;
}

export function registerExtractionOperationReceiptFunctions(
  sdk: ISdk,
  kv: StateKV,
  reconciliationVerifiers: ExtractionOperationReconciliationVerifiers = {},
): void {
  sdk.registerFunction(
    "mem::extraction-operation-receipt-get",
    async (value: unknown) => {
      const lookup = normalizeExtractionOperationLookup(value);
      if (!lookup) {
        return {
          success: false,
          failure: {
            class: "hard",
            cause: "invalid_extraction_operation_identity",
          },
        };
      }
      const key = buildExtractionOperationKey(lookup);
      const receipt = await kv.get<ExtractionOperationReceipt>(
        KV.extractionOperationReceipt(key),
        key,
      );
      if (receipt && lookup.inputHash && receipt.inputHash !== lookup.inputHash) {
        return {
          success: false,
          failure: {
            class: "hard",
            cause: "extraction_operation_input_hash_conflict",
          },
        };
      }
      return {
        success: true,
        operation: receipt
          ? {
              runId: receipt.runId,
              stage: receipt.stage,
              unitId: receipt.unitId,
              inputHash: receipt.inputHash,
            }
          : lookup,
        receipt: receipt ? sanitizeExtractionOperationReceipt(receipt) : null,
      };
    },
  );

  sdk.registerFunction(
    "mem::extraction-operation-receipt-reconcile-orphan",
    async (value: unknown) => {
      const input = normalizeOrphanReconciliation(value);
      if (!input) {
        return orphanReconciliationFailure("invalid_orphan_reconciliation_identity");
      }
      const key = buildExtractionOperationKey(input.operation);
      return withKeyedLock(`extraction-operation:${key}`, async () => {
        const receipt = await kv.get<ExtractionOperationReceipt>(
          KV.extractionOperationReceipt(key),
          key,
        );
        const reconciliationId = orphanReconciliationId(input);
        if (
          !receipt
          || receipt.runId !== input.operation.runId
          || receipt.stage !== input.operation.stage
          || receipt.unitId !== input.operation.unitId
          || receipt.inputHash !== input.operation.inputHash
          || receipt.startedAt !== input.operation.expectedStartedAt
          || !["running", "reconciled"].includes(receipt.status)
          || (
            receipt.status === "reconciled"
            && receipt.reconciliation?.id !== reconciliationId
          )
        ) {
          return orphanReconciliationFailure("orphan_reconciliation_evidence_drifted");
        }

        if (input.result.kind === "summary_resumable_run") {
          const mapPrefix = `${input.result.sessionId}:map:`;
          const mapIndexText = input.operation.unitId.startsWith(mapPrefix)
            ? input.operation.unitId.slice(mapPrefix.length)
            : null;
          const mapIndex = mapIndexText !== null && /^(?:0|[1-9]\d*)$/.test(mapIndexText)
            ? Number(mapIndexText)
            : null;
          const [run, activeRun, persistedSummary, persistedMapPartial] = await Promise.all([
            kv.get<ResumableSummaryRun>(
              KV.summaryResumableRuns,
              input.result.resumableRunId,
            ),
            kv.get<ResumableSummaryActiveRun>(
              KV.summaryResumableActiveRuns,
              input.result.sessionId,
            ),
            kv.get(KV.summaries, input.result.sessionId),
            mapIndex === null
              ? Promise.resolve(null)
              : kv.get<ResumableSummaryPartial>(
                  KV.summaryResumablePartials(input.result.resumableRunId),
                  String(mapIndex),
                ),
          ]);
          if (
            (persistedSummary !== null && persistedSummary !== undefined)
            || run?.summary !== undefined
          ) {
            return orphanReconciliationFailure("orphan_reconciliation_result_present");
          }
          if (
            !run
            || !activeRun
            || run.id !== input.result.resumableRunId
            || run.sessionId !== input.result.sessionId
            || run.status !== "in_progress"
            || run.inputHash !== input.result.serviceInputHash
            || run.attemptId !== input.operation.runId
            || run.attemptInputHash !== input.result.runnerInputHash
            || run.generationConfigHash !== input.result.generationConfigHash
            || activeRun.sessionId !== input.result.sessionId
            || activeRun.runId !== input.result.resumableRunId
            || activeRun.inputHash !== input.result.serviceInputHash
            || (
              mapIndex !== null
              && (
                !Number.isSafeInteger(run.totalChunks)
                || mapIndex >= run.totalChunks
              )
            )
          ) {
            return orphanReconciliationFailure("orphan_reconciliation_result_binding_drifted");
          }
          if (mapIndex !== null && persistedMapPartial !== null && persistedMapPartial !== undefined) {
            if (
              persistedMapPartial.runId !== run.id
              || persistedMapPartial.chunkIndex !== mapIndex
              || persistedMapPartial.status !== "completed"
              || !persistedMapPartial.summary
            ) {
              return orphanReconciliationFailure(
                "orphan_reconciliation_result_binding_drifted",
              );
            }
            return orphanReconciliationFailure("orphan_reconciliation_result_present");
          }
        } else {
          if (hasResumableStageRecovery(receipt)) {
            return orphanReconciliationFailure("orphan_reconciliation_result_present");
          }
          if (input.operation.stage === "lessons") {
            const verifyLessonResult = reconciliationVerifiers.verifyLessonResult;
            if (!verifyLessonResult) {
              return orphanReconciliationFailure(
                "orphan_reconciliation_result_binding_drifted",
              );
            }
            const lessonIdentity: ExtractionOperationIdentity = {
              runId: input.operation.runId,
              stage: "lessons",
              unitId: input.operation.unitId,
              inputHash: input.operation.inputHash,
            };
            const lessonResult = await verifyLessonResult(
              kv,
              lessonIdentity,
              input.result.runnerInputHash,
            );
            if (lessonResult !== "absent") {
              return orphanReconciliationFailure(
                lessonResult === "present"
                  ? "orphan_reconciliation_result_present"
                  : "orphan_reconciliation_result_binding_drifted",
              );
            }
          }
          if (
            input.operation.stage === "memory_consolidate"
            || input.operation.stage === "skill_extract"
          ) {
            const findProposal = input.operation.stage === "memory_consolidate"
              ? reconciliationVerifiers.findMemoryProposal
              : reconciliationVerifiers.findSkillProposal;
            if (!findProposal) {
              return orphanReconciliationFailure(
                "orphan_reconciliation_result_binding_drifted",
              );
            }
            const prepareIdentity: ExtractionOperationIdentity = {
              runId: input.result.phase === "prepare"
                ? input.operation.runId
                : input.result.prepareRunId!,
              stage: input.operation.stage,
              unitId: input.operation.unitId,
              inputHash: input.result.phase === "prepare"
                ? input.result.runnerInputHash
                : input.result.prepareInputHash!,
            };
            const proposal = await findProposal(kv, prepareIdentity);
            if (
              input.result.phase === "prepare"
                ? proposal !== null
                : (
                    proposal === null
                    || proposal.success !== true
                    || proposal.status !== "prepared"
                  )
            ) {
              return orphanReconciliationFailure(
                proposal === null
                  ? "orphan_reconciliation_result_binding_drifted"
                  : "orphan_reconciliation_result_present",
              );
            }
          }
        }

        let reconciled = receipt;
        const replayed = receipt.status === "reconciled";
        if (!replayed) {
          const at = new Date().toISOString();
          reconciled = {
            ...receipt,
            status: "reconciled",
            completedAt: at,
            response: undefined,
            failure: {
              class: "transient_runtime",
              cause: "orphaned_operation_result_absent",
            },
            reconciliation: {
              id: reconciliationId,
              at,
              resultStatus: "absent",
              proofKind: input.result.kind,
              phase: input.result.phase,
              ...(input.result.kind === "summary_resumable_run"
                ? { resumableRunId: input.result.resumableRunId }
                : {}),
            },
          };
          await kv.set(KV.extractionOperationReceipt(key), key, reconciled);
        }

        return {
          success: true,
          replayed,
          operation: {
            runId: reconciled.runId,
            stage: reconciled.stage,
            unitId: reconciled.unitId,
            inputHash: reconciled.inputHash,
          },
          receipt: sanitizeExtractionOperationReceipt(reconciled),
          reconciliation: {
            id: reconciled.reconciliation!.id,
            at: reconciled.reconciliation!.at,
            resultStatus: "absent",
          },
        };
      });
    },
  );
}

const EXTRACTION_OPERATION_STAGES = new Set<ExtractionOperationIdentity["stage"]>([
  "summary",
  "lessons",
  "memory_consolidate",
  "semantic_rollup",
  "skill_extract",
  "crystal",
  "consolidation_procedural",
  "reflect_insight",
]);

const EXTRACTION_OPERATION_RECEIPT_STATUSES = new Set([
  "running",
  "succeeded",
  "failed",
  "reconciled",
]);

const STAGE_FAILURE_CLASSES = new Set([
  "transient_provider",
  "transient_runtime",
  "unit",
  "hard",
]);

function normalizeExtractionOperationLookup(value: unknown): (
  Pick<ExtractionOperationIdentity, "runId" | "stage" | "unitId">
  & Partial<Pick<ExtractionOperationIdentity, "inputHash">>
) | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const runId = typeof record.runId === "string" ? record.runId.trim() : "";
  const stage = typeof record.stage === "string" ? record.stage.trim() : "";
  const unitId = typeof record.unitId === "string" ? record.unitId.trim() : "";
  const inputHash = record.inputHash === undefined
    ? undefined
    : typeof record.inputHash === "string"
      ? record.inputHash.trim()
      : "";
  if (
    !runId
    || !unitId
    || inputHash === ""
    || !EXTRACTION_OPERATION_STAGES.has(stage as ExtractionOperationIdentity["stage"])
  ) {
    return null;
  }
  return {
    runId,
    stage: stage as ExtractionOperationIdentity["stage"],
    unitId,
    ...(inputHash ? { inputHash } : {}),
  };
}

function sanitizeExtractionOperationReceipt(receipt: ExtractionOperationReceipt): {
  version?: number;
  status: ExtractionOperationReceipt["status"];
  startedAt: string;
  completedAt?: string;
  failure?: {
    class: StageFailure["class"];
    cause: string;
    phase?: StageFailure["phase"];
  };
  retry?: {
    epoch: number;
    lastSafeFailure: {
      errorClass: StageFailure["class"];
      cause: string;
      phase: StageFailure["phase"];
      timestamp: string;
    };
  };
} {
  if (
    !EXTRACTION_OPERATION_RECEIPT_STATUSES.has(receipt.status)
    || typeof receipt.startedAt !== "string"
    || !receipt.startedAt
  ) {
    throw new Error("invalid_extraction_operation_receipt");
  }
  const failure = receipt.failure;
  const safeFailure = failure
    && STAGE_FAILURE_CLASSES.has(failure.class)
    && typeof failure.cause === "string"
    && /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(failure.cause)
    ? {
      class: failure.class,
      cause: failure.cause,
      ...(failure.phase && RECEIPT_FAILURE_PHASES.has(failure.phase)
        ? { phase: failure.phase }
        : {}),
    }
    : undefined;
  const retry = receipt.retry;
  const lastSafeFailure = retry?.lastSafeFailure;
  const safeRetry = retry
    && Number.isSafeInteger(retry.epoch)
    && retry.epoch >= 0
    && lastSafeFailure
    && STAGE_FAILURE_CLASSES.has(lastSafeFailure.errorClass)
    && typeof lastSafeFailure.cause === "string"
    && /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(lastSafeFailure.cause)
    && lastSafeFailure.phase
    && RECEIPT_FAILURE_PHASES.has(lastSafeFailure.phase)
    && typeof lastSafeFailure.timestamp === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(lastSafeFailure.timestamp)
    ? {
      epoch: retry.epoch,
      lastSafeFailure: {
        errorClass: lastSafeFailure.errorClass,
        cause: lastSafeFailure.cause,
        phase: lastSafeFailure.phase,
        timestamp: lastSafeFailure.timestamp,
      },
    }
    : undefined;
  return {
    ...(Number.isSafeInteger(receipt.version) && receipt.version! > 0
      ? { version: receipt.version }
      : {}),
    status: receipt.status,
    startedAt: receipt.startedAt,
    ...(typeof receipt.completedAt === "string" && receipt.completedAt
      ? { completedAt: receipt.completedAt }
      : {}),
    ...(safeFailure ? { failure: safeFailure } : {}),
    ...(safeRetry ? { retry: safeRetry } : {}),
  };
}

type OrphanReconciliationOperation = ExtractionOperationIdentity & {
  expectedStatus: "running";
  expectedStartedAt: string;
};

type OrphanSummaryReconciliationInput = {
  operation: OrphanReconciliationOperation;
  result: {
    kind: "summary_resumable_run";
    phase: "execute";
    sessionId: string;
    resumableRunId: string;
    serviceInputHash: string;
    runnerInputHash: string;
    generationConfigHash: string;
  };
};

type OrphanProtocolReconciliationInput = {
  operation: OrphanReconciliationOperation;
  result: {
    kind: "protocol_state";
    phase: "execute" | "prepare" | "commit";
    runnerInputHash: string;
    prepareRunId?: string;
    prepareInputHash?: string;
  };
};

type OrphanReconciliationInput =
  | OrphanSummaryReconciliationInput
  | OrphanProtocolReconciliationInput;

const ORPHAN_RECONCILIATION_OPERATION_KEYS = new Set([
  "runId",
  "stage",
  "unitId",
  "inputHash",
  "expectedStatus",
  "expectedStartedAt",
]);
const ORPHAN_RECONCILIATION_RESULT_KEYS = new Set([
  "kind",
  "phase",
  "sessionId",
  "resumableRunId",
  "serviceInputHash",
  "runnerInputHash",
  "generationConfigHash",
]);
const ORPHAN_RECONCILIATION_LEGACY_RESULT_KEYS = new Set([
  "sessionId",
  "resumableRunId",
  "serviceInputHash",
  "runnerInputHash",
  "generationConfigHash",
]);
const ORPHAN_PROTOCOL_RESULT_BASE_KEYS = new Set([
  "kind",
  "phase",
  "runnerInputHash",
]);
const ORPHAN_PROTOCOL_COMMIT_RESULT_KEYS = new Set([
  ...ORPHAN_PROTOCOL_RESULT_BASE_KEYS,
  "prepareRunId",
  "prepareInputHash",
]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const RESUMABLE_SUMMARY_RUN_ID = /^sumr_[0-9a-f]{24}$/;

function exactObjectKeys(value: unknown, allowed: Set<string>): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every((key) => allowed.has(key))
    && Object.keys(value as Record<string, unknown>).length === allowed.size;
}

function normalizeOrphanReconciliation(
  value: unknown,
): OrphanReconciliationInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!exactObjectKeys(input.operation, ORPHAN_RECONCILIATION_OPERATION_KEYS)) return null;
  const operation = input.operation;
  const result = input.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  let resultRecord = result as Record<string, unknown>;
  const legacySummaryResult = operation.stage === "summary"
    && exactObjectKeys(result, ORPHAN_RECONCILIATION_LEGACY_RESULT_KEYS);
  if (legacySummaryResult) {
    resultRecord = {
      ...resultRecord,
      kind: "summary_resumable_run",
      phase: "execute",
    };
  }
  const summaryResult = resultRecord.kind === "summary_resumable_run";
  if (
    summaryResult
      ? (
          !legacySummaryResult
          && !exactObjectKeys(result, ORPHAN_RECONCILIATION_RESULT_KEYS)
        )
      : !exactObjectKeys(
          result,
          resultRecord.phase === "commit"
            ? ORPHAN_PROTOCOL_COMMIT_RESULT_KEYS
            : ORPHAN_PROTOCOL_RESULT_BASE_KEYS,
        )
  ) return null;
  if (
    operation.expectedStatus !== "running"
    || !EXTRACTION_OPERATION_STAGES.has(
      operation.stage as ExtractionOperationIdentity["stage"],
    )
    || !SHA256_HEX.test(String(operation.runId))
    || !SHA256_HEX.test(String(operation.inputHash))
    || typeof operation.unitId !== "string"
    || !operation.unitId
    || typeof operation.expectedStartedAt !== "string"
    || Number.isNaN(Date.parse(operation.expectedStartedAt))
  ) return null;
  if (!summaryResult) {
    const stage = operation.stage as ExtractionOperationIdentity["stage"];
    const phase = resultRecord.phase;
    const twoPhase = stage === "memory_consolidate" || stage === "skill_extract";
    if (
      resultRecord.kind !== "protocol_state"
      || !SHA256_HEX.test(String(resultRecord.runnerInputHash))
      || (twoPhase ? !["prepare", "commit"].includes(String(phase)) : phase !== "execute")
      || stage === "summary"
      || (
        phase === "commit"
        && (
          !SHA256_HEX.test(String(resultRecord.prepareRunId))
          || !SHA256_HEX.test(String(resultRecord.prepareInputHash))
        )
      )
    ) return null;
    return {
      operation: operation as OrphanProtocolReconciliationInput["operation"],
      result: resultRecord as OrphanProtocolReconciliationInput["result"],
    };
  }
  const strings = [...ORPHAN_RECONCILIATION_OPERATION_KEYS, ...ORPHAN_RECONCILIATION_RESULT_KEYS]
    .filter((key) => !["expectedStatus", "stage", "kind", "phase"].includes(key))
    .map((key) => (
      Object.prototype.hasOwnProperty.call(operation, key) ? operation[key] : resultRecord[key]
    ));
  if (strings.some((item) => typeof item !== "string" || !item.trim())) return null;
  if (
    operation.stage !== "summary"
    || resultRecord.phase !== "execute"
    || !SHA256_HEX.test(String(result.serviceInputHash))
    || !SHA256_HEX.test(String(result.runnerInputHash))
    || !SHA256_HEX.test(String(result.generationConfigHash))
    || !RESUMABLE_SUMMARY_RUN_ID.test(String(result.resumableRunId))
    || !(
      operation.unitId === `${result.sessionId}:reduce`
      || new RegExp(`^${escapeRegExp(String(result.sessionId))}:map:(?:0|[1-9]\\d*)$`)
        .test(String(operation.unitId))
    )
  ) {
    return null;
  }
  return {
    operation: operation as OrphanSummaryReconciliationInput["operation"],
    result: resultRecord as OrphanSummaryReconciliationInput["result"],
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function orphanReconciliationId(input: OrphanReconciliationInput): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([
      input.operation.runId,
      input.operation.stage,
      input.operation.unitId,
      input.operation.inputHash,
      input.operation.expectedStartedAt,
      input.result.kind,
      input.result.phase,
      ...(
        input.result.kind === "summary_resumable_run"
          ? [
              input.result.sessionId,
              input.result.resumableRunId,
              input.result.serviceInputHash,
              input.result.runnerInputHash,
              input.result.generationConfigHash,
            ]
          : [
              input.result.runnerInputHash,
              input.result.prepareRunId,
              input.result.prepareInputHash,
            ]
      ),
    ]))
    .digest("hex");
  return `xrec_${hash.slice(0, 32)}`;
}

function orphanReconciliationFailure(cause: string) {
  return {
    success: false,
    failure: {
      class: "hard" as const,
      cause,
    },
  };
}

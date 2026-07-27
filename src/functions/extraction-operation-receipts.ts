import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type {
  ExtractionOperationIdentity,
  ExtractionOperationReceipt,
  ResumableSummaryActiveRun,
  ResumableSummaryRun,
  StageFailure,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

export interface ExtractionOperationResult<T> {
  replayed: boolean;
  response?: T;
  failure?: StageFailure;
  receipt?: ExtractionOperationReceipt<T>;
}

export interface ExtractionOperationReceiptOptions {
  requireExisting?: boolean;
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
  ]),
  skill_extract: new Set([
    "skillIds", "skill_ids", "proceduralMemoryIds", "procedural_memory_ids",
    "memoryIds", "memory_ids", "extracted", "reinforced",
    "preparedHandle", "prepared_handle", "proposalHash", "proposal_hash",
  ]),
  memory_consolidate: new Set([
    "memoryIds", "memory_ids", "consolidated", "totalObservations", "total_observations",
    "preparedHandle", "prepared_handle", "proposalHash", "proposal_hash",
  ]),
  consolidation_procedural: new Set([
    "proceduralMemoryIds", "procedural_memory_ids", "memoryIds", "memory_ids",
    "patternsAnalyzed", "patterns_analyzed",
  ]),
  reflect_insight: new Set([
    "insightIds", "insight_ids", "memoryIds", "memory_ids", "newInsights", "new_insights",
    "reinforced", "totalInsights", "total_insights", "totalItems", "total_items",
    "usedFallback", "used_fallback",
  ]),
  crystal: new Set([
    "crystalIds", "crystal_ids", "groupCount", "group_count", "groups", "items",
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
      return {
        class: candidate.class as StageFailure["class"],
        cause: candidate.cause.trim(),
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
): ExtractionOperationReceipt<T> {
  return {
    ...identity,
    key,
    status: "failed",
    startedAt,
    completedAt: new Date().toISOString(),
    failure,
  };
}

function completedReceipt<T>(
  identity: ExtractionOperationIdentity,
  key: string,
  startedAt: string,
  response: T,
): ExtractionOperationReceipt<T> {
  return {
    ...identity,
    key,
    status: "succeeded",
    startedAt,
    completedAt: new Date().toISOString(),
    response,
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

export async function withExtractionOperationReceipt<T>(
  kv: StateKV,
  identity: ExtractionOperationIdentity,
  execute: () => Promise<T>,
  options: ExtractionOperationReceiptOptions = {},
): Promise<ExtractionOperationResult<T>> {
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
    if (existing?.status === "succeeded" && existing.response !== undefined) {
      return { replayed: true, response: existing.response, receipt: existing };
    }
    if (existing?.status === "failed") {
      const failure = existing.failure ?? {
        class: "unit" as const,
        cause: "extraction_operation_failed",
      };
      return { replayed: true, failure, receipt: existing };
    }
    if (existing?.status === "running") {
      const failure: StageFailure = {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      };
      return { replayed: true, failure, receipt: existing };
    }
    if (options.requireExisting) {
      const failure: StageFailure = {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      };
      return { replayed: true, failure };
    }

    const startedAt = new Date().toISOString();
    const running: ExtractionOperationReceipt<T> = {
      ...identity,
      key,
      status: "running",
      startedAt,
    };
    await kv.set(KV.extractionOperationReceipt(key), key, running);
    let rawResponse: T;
    try {
      rawResponse = await execute();
    } catch {
      const failure: StageFailure = {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      };
      return { replayed: false, failure, receipt: running };
    }
    const responseFailure = failureFromResponse(rawResponse);
    if (responseFailure) {
      const failed = failedReceipt<T>(identity, key, startedAt, responseFailure);
      await kv.set(KV.extractionOperationReceipt(key), key, failed);
      return { replayed: false, failure: responseFailure, receipt: failed };
    }
    const response = safeResponse(identity.stage, rawResponse);
    const succeeded = completedReceipt(identity, key, startedAt, response);
    await kv.set(KV.extractionOperationReceipt(key), key, succeeded);
    return { replayed: false, response, receipt: succeeded };
  });
}

export async function completeModelOperationFromVerifiedResult<T>(
  kv: StateKV,
  identity: ExtractionOperationIdentity,
  verifiedResponse: T,
): Promise<ExtractionOperationResult<T>> {
  const key = buildExtractionOperationKey(identity);
  return withKeyedLock(`extraction-operation:${key}`, async () => {
    const existing = await kv.get<ExtractionOperationReceipt<T>>(
      KV.extractionOperationReceipt(key),
      key,
    );
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
): Promise<ExtractionOperationResult<T>> {
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
    if (existing?.status === "succeeded" && existing.response !== undefined) {
      return { replayed: true, response: existing.response, receipt: existing };
    }
    if (existing?.status === "failed") {
      return {
        replayed: true,
        failure: existing.failure ?? { class: "unit", cause: "extraction_operation_failed" },
        receipt: existing,
      };
    }

    const startedAt = existing?.startedAt ?? new Date().toISOString();
    if (!existing) {
      await kv.set<ExtractionOperationReceipt<T>>(KV.extractionOperationReceipt(key), key, {
        ...identity,
        key,
        status: "running",
        startedAt,
      });
    }

    let rawResponse: T;
    try {
      rawResponse = await executeCommit();
    } catch (error) {
      const failure = causeFromError(error);
      const running: ExtractionOperationReceipt<T> = {
        ...identity,
        key,
        status: "running",
        startedAt,
      };
      return { replayed: Boolean(existing), failure, receipt: running };
    }
    const responseFailure = failureFromResponse(rawResponse);
    if (responseFailure) {
      const failed = failedReceipt<T>(identity, key, startedAt, responseFailure);
      await kv.set(KV.extractionOperationReceipt(key), key, failed);
      return { replayed: Boolean(existing), failure: responseFailure, receipt: failed };
    }
    const response = safeResponse(identity.stage, rawResponse);
    const succeeded = completedReceipt(identity, key, startedAt, response);
    await kv.set(KV.extractionOperationReceipt(key), key, succeeded);
    return { replayed: Boolean(existing), response, receipt: succeeded };
  });
}

export function registerExtractionOperationReceiptFunctions(
  sdk: ISdk,
  kv: StateKV,
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
      const input = normalizeOrphanSummaryReconciliation(value);
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

        const [run, activeRun, persistedSummary] = await Promise.all([
          kv.get<ResumableSummaryRun>(
            KV.summaryResumableRuns,
            input.result.resumableRunId,
          ),
          kv.get<ResumableSummaryActiveRun>(
            KV.summaryResumableActiveRuns,
            input.result.sessionId,
          ),
          kv.get(KV.summaries, input.result.sessionId),
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
        ) {
          return orphanReconciliationFailure("orphan_reconciliation_result_binding_drifted");
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
              resumableRunId: input.result.resumableRunId,
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
  status: ExtractionOperationReceipt["status"];
  startedAt: string;
  completedAt?: string;
  failure?: {
    class: StageFailure["class"];
    cause: string;
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
    ? { class: failure.class, cause: failure.cause }
    : undefined;
  return {
    status: receipt.status,
    startedAt: receipt.startedAt,
    ...(typeof receipt.completedAt === "string" && receipt.completedAt
      ? { completedAt: receipt.completedAt }
      : {}),
    ...(safeFailure ? { failure: safeFailure } : {}),
  };
}

type OrphanSummaryReconciliationInput = {
  operation: ExtractionOperationIdentity & {
    expectedStatus: "running";
    expectedStartedAt: string;
  };
  result: {
    sessionId: string;
    resumableRunId: string;
    serviceInputHash: string;
    runnerInputHash: string;
    generationConfigHash: string;
  };
};

const ORPHAN_RECONCILIATION_OPERATION_KEYS = new Set([
  "runId",
  "stage",
  "unitId",
  "inputHash",
  "expectedStatus",
  "expectedStartedAt",
]);
const ORPHAN_RECONCILIATION_RESULT_KEYS = new Set([
  "sessionId",
  "resumableRunId",
  "serviceInputHash",
  "runnerInputHash",
  "generationConfigHash",
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

function normalizeOrphanSummaryReconciliation(
  value: unknown,
): OrphanSummaryReconciliationInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    !exactObjectKeys(input.operation, ORPHAN_RECONCILIATION_OPERATION_KEYS)
    || !exactObjectKeys(input.result, ORPHAN_RECONCILIATION_RESULT_KEYS)
  ) {
    return null;
  }
  const operation = input.operation;
  const result = input.result;
  const strings = [...ORPHAN_RECONCILIATION_OPERATION_KEYS, ...ORPHAN_RECONCILIATION_RESULT_KEYS]
    .filter((key) => key !== "expectedStatus" && key !== "stage")
    .map((key) => (
      Object.prototype.hasOwnProperty.call(operation, key) ? operation[key] : result[key]
    ));
  if (strings.some((item) => typeof item !== "string" || !item.trim())) return null;
  if (
    operation.stage !== "summary"
    || operation.expectedStatus !== "running"
    || !SHA256_HEX.test(String(operation.runId))
    || !SHA256_HEX.test(String(operation.inputHash))
    || !SHA256_HEX.test(String(result.serviceInputHash))
    || !SHA256_HEX.test(String(result.runnerInputHash))
    || !SHA256_HEX.test(String(result.generationConfigHash))
    || !RESUMABLE_SUMMARY_RUN_ID.test(String(result.resumableRunId))
    || operation.unitId !== `${result.sessionId}:reduce`
  ) {
    return null;
  }
  return {
    operation: operation as OrphanSummaryReconciliationInput["operation"],
    result: result as OrphanSummaryReconciliationInput["result"],
  };
}

function orphanReconciliationId(input: OrphanSummaryReconciliationInput): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([
      input.operation.runId,
      input.operation.stage,
      input.operation.unitId,
      input.operation.inputHash,
      input.operation.expectedStartedAt,
      input.result.sessionId,
      input.result.resumableRunId,
      input.result.serviceInputHash,
      input.result.runnerInputHash,
      input.result.generationConfigHash,
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

import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type {
  ExtractionOperationIdentity,
  ExtractionOperationReceipt,
  StageFailure,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

export interface ExtractionOperationResult<T> {
  replayed: boolean;
  response?: T;
  failure?: StageFailure;
  receipt: ExtractionOperationReceipt<T>;
}

const COMMON_RECEIPT_RESPONSE_KEYS = new Set([
  "success", "status", "stage", "provider", "providerName", "provider_name",
  "model", "modelSource", "model_source", "source", "modelApplied", "model_applied",
  "providerModelOverride", "provider_model_override", "promptChars", "prompt_chars",
  "charBudget", "char_budget", "maxPromptChars", "max_prompt_chars", "durationMs",
  "duration_ms", "parseFailures", "parse_failures", "inputHash", "input_hash",
  "runId", "run_id", "windowId", "window_id", "mark", "kind", "reused", "skipped",
  "dryRun", "dry_run",
]);

const STAGE_RECEIPT_RESPONSE_KEYS: Record<ExtractionOperationIdentity["stage"], Set<string>> = {
  semantic_rollup: new Set([
    "semanticMemoryIds", "semantic_memory_ids",
    "semanticMemoryCharSizes", "semantic_memory_char_sizes",
  ]),
  skill_extract: new Set([
    "skillIds", "skill_ids", "proceduralMemoryIds", "procedural_memory_ids",
    "memoryIds", "memory_ids", "extracted", "reinforced",
  ]),
  memory_consolidate: new Set([
    "memoryIds", "memory_ids", "consolidated", "totalObservations", "total_observations",
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
    if (key === "semanticMemoryCharSizes" || key === "semantic_memory_char_sizes") {
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

export function buildExtractionOperationKey(identity: ExtractionOperationIdentity): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([identity.runId, identity.stage, identity.unitId]))
    .digest("hex");
  return `xop_${hash.slice(0, 32)}`;
}

export async function withExtractionOperationReceipt<T>(
  kv: StateKV,
  identity: ExtractionOperationIdentity,
  execute: () => Promise<T>,
): Promise<ExtractionOperationResult<T>> {
  const key = buildExtractionOperationKey(identity);
  return withKeyedLock(`extraction-operation:${key}`, async () => {
    const existing = await kv.get<ExtractionOperationReceipt<T>>(
      KV.extractionOperationReceipts,
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
    if (existing?.status === "running") {
      const failure: StageFailure = {
        class: "transient_runtime",
        cause: "extraction_operation_reconciliation_required",
      };
      return { replayed: true, failure, receipt: existing };
    }

    const startedAt = new Date().toISOString();
    const running: ExtractionOperationReceipt<T> = {
      ...identity,
      key,
      status: "running",
      startedAt,
    };
    await kv.set(KV.extractionOperationReceipts, key, running);
    let rawResponse: T;
    try {
      rawResponse = await execute();
    } catch (error) {
      const failure = causeFromError(error);
      const failed = failedReceipt<T>(identity, key, startedAt, failure);
      await kv.set(KV.extractionOperationReceipts, key, failed);
      return { replayed: false, failure, receipt: failed };
    }
    const responseFailure = failureFromResponse(rawResponse);
    if (responseFailure) {
      const failed = failedReceipt<T>(identity, key, startedAt, responseFailure);
      await kv.set(KV.extractionOperationReceipts, key, failed);
      return { replayed: false, failure: responseFailure, receipt: failed };
    }
    const response = safeResponse(identity.stage, rawResponse);
    const succeeded = completedReceipt(identity, key, startedAt, response);
    await kv.set(KV.extractionOperationReceipts, key, succeeded);
    return { replayed: false, response, receipt: succeeded };
  });
}

export function registerExtractionOperationReceiptFunctions(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction(
    "mem::extraction-operation-receipt-get",
    async (value: unknown) => {
      const identity = normalizeExtractionOperationIdentity(value);
      if (!identity) {
        return {
          success: false,
          failure: {
            class: "hard",
            cause: "invalid_extraction_operation_identity",
          },
        };
      }
      const key = buildExtractionOperationKey(identity);
      const receipt = await kv.get<ExtractionOperationReceipt>(
        KV.extractionOperationReceipts,
        key,
      );
      if (receipt && receipt.inputHash !== identity.inputHash) {
        return {
          success: false,
          failure: {
            class: "hard",
            cause: "extraction_operation_input_hash_conflict",
          },
        };
      }
      return { success: true, receipt };
    },
  );
}

const EXTRACTION_OPERATION_STAGES = new Set<ExtractionOperationIdentity["stage"]>([
  "memory_consolidate",
  "semantic_rollup",
  "skill_extract",
  "crystal",
  "consolidation_procedural",
  "reflect_insight",
]);

function normalizeExtractionOperationIdentity(value: unknown): ExtractionOperationIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const runId = typeof record.runId === "string" ? record.runId.trim() : "";
  const stage = typeof record.stage === "string" ? record.stage.trim() : "";
  const unitId = typeof record.unitId === "string" ? record.unitId.trim() : "";
  const inputHash = typeof record.inputHash === "string" ? record.inputHash.trim() : "";
  if (!runId || !unitId || !inputHash || !EXTRACTION_OPERATION_STAGES.has(stage as ExtractionOperationIdentity["stage"])) {
    return null;
  }
  return {
    runId,
    stage: stage as ExtractionOperationIdentity["stage"],
    unitId,
    inputHash,
  };
}

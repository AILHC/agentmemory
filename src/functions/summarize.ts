import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  SessionSummary,
  MemoryProvider,
  Session,
  MemoryProviderCallOptions,
  ResumableSummaryRun,
  ResumableSummaryPartial,
  ResumableSummaryActiveRun,
  LessonFailureDiagnostics,
  LessonParseFailureDiagnostics,
  StageFailure,
  StageFailureDiagnostics,
  SummaryAdvanceKind,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  SUMMARY_SYSTEM,
  buildSummaryPrompt,
  REDUCE_SYSTEM,
  buildReducePrompt,
  SUMMARY_OUTPUT_CONTRACT,
} from "../prompts/summary.js";
import { withOutputLanguagePolicy } from "../prompts/output-language.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { SummaryOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreSummary } from "../eval/quality.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { safeAudit } from "./audit.js";
import { logger } from "../logger.js";
import {
  getContextPreflightPolicy,
  getSummaryExperimentTreatment,
  getSummarizeRuntimeConfig,
  resolveStageModelCallOptions,
  resolveStageModelMetadata,
  type SummaryExperimentTreatment,
} from "../config.js";
import {
  callProviderWithTelemetry,
  isProviderPreflightError,
  providerPreflightStatus,
  sortProviderCallTelemetry,
  type ProviderPreflightError,
  type ProviderCallIndex,
  type ProviderCallRole,
  type ProviderCallTelemetry,
} from "../providers/provider-call-result.js";

// Bail on the merged summary if more than this fraction of chunks fail
// to parse — a half-blind narrative is worse than a clean error.
const MAX_SKIP_RATIO = 0.5;
const TRANSIENT_RETRY_BASE_DELAY_MS = 31_000;
const TRANSIENT_RETRY_JITTER_MS = 5_000;

type SummaryFailureCause =
  | "parse_failed"
  | "pi_stream_failed"
  | "circuit_breaker_open"
  | "network_error"
  | "provider_failure"
  | "pi_auth_missing"
  | "pi_auth_failed"
  | "pi_model_not_found"
  | "pi_sdk_import_failed";

type SummaryRetryOptions = {
  sleep?: (delayMs: number) => Promise<void>;
  cooldownMs?: (sessionId: string) => number;
};

const PROVIDER_ERROR_CODES = new Set([
  "model_not_found",
  "rate_limited",
  "timeout",
  "provider_rejected",
  "auth_failed",
  "network_error",
  "server_error",
  "unknown",
]);
const PROVIDER_STOP_REASONS = new Set([
  "stop",
  "max_tokens",
  "tool_use",
  "error",
  "aborted",
]);

function safeNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function safeResponseModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(normalized)
    ? normalized
    : undefined;
}

export function sanitizeStageFailureDiagnostics(
  value: unknown,
  requestPhase?: StageFailureDiagnostics["requestPhase"],
): StageFailureDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const phase = requestPhase ?? source.requestPhase;
  const elapsedMs = safeNonNegativeInteger(source.elapsedMs);
  const inputChars = safeNonNegativeInteger(source.inputChars);
  const maxOutputTokens = safeNonNegativeInteger(source.maxOutputTokens);
  if (
    (phase !== "chunk" && phase !== "reduce")
    || typeof source.providerErrorCode !== "string"
    || !PROVIDER_ERROR_CODES.has(source.providerErrorCode)
    || elapsedMs === undefined
    || inputChars === undefined
    || maxOutputTokens === undefined
    || typeof source.responseStarted !== "boolean"
  ) {
    return undefined;
  }
  const statusCode = safeNonNegativeInteger(source.statusCode);
  const retryAfterMs = safeNonNegativeInteger(source.retryAfterMs);
  const responseModel = safeResponseModel(source.responseModel);
  const stopReason = typeof source.stopReason === "string"
    && PROVIDER_STOP_REASONS.has(source.stopReason)
    ? source.stopReason as StageFailureDiagnostics["stopReason"]
    : undefined;
  return {
    requestPhase: phase,
    providerErrorCode: source.providerErrorCode as StageFailureDiagnostics["providerErrorCode"],
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    elapsedMs,
    inputChars,
    maxOutputTokens,
    responseStarted: source.responseStarted,
    ...(responseModel ? { responseModel } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

const LESSON_PARSE_ERROR_CODES = new Set([
  "lesson_missing_root",
  "lesson_no_blocks",
  "lesson_no_valid_items",
  "lesson_validation_failed",
  "lesson_parse_failed",
  "empty_response",
]);

export function sanitizeLessonFailureDiagnostics(
  value: unknown,
): LessonFailureDiagnostics | undefined {
  const providerDiagnostics = sanitizeStageFailureDiagnostics(value);
  if (providerDiagnostics) return providerDiagnostics;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const chunkIndex = safeNonNegativeInteger(source.chunkIndex);
  const attempt = safeNonNegativeInteger(source.attempt);
  const responseChars = safeNonNegativeInteger(source.responseChars);
  if (
    source.requestPhase !== "chunk"
    || typeof source.parseErrorCode !== "string"
    || !LESSON_PARSE_ERROR_CODES.has(source.parseErrorCode)
    || chunkIndex === undefined
    || attempt === undefined
    || attempt < 1
    || responseChars === undefined
  ) {
    return undefined;
  }
  return {
    requestPhase: "chunk",
    parseErrorCode: source.parseErrorCode as LessonParseFailureDiagnostics["parseErrorCode"],
    chunkIndex,
    attempt,
    responseChars,
  };
}

function diagnosticsFromProviderError(
  error: unknown,
  requestPhase: StageFailureDiagnostics["requestPhase"],
): StageFailureDiagnostics | undefined {
  return sanitizeStageFailureDiagnostics(
    (error as { metadata?: unknown } | null)?.metadata,
    requestPhase,
  );
}

function resumableCallIndex(
  run: ResumableSummaryRun,
  phase: "map" | "reduce",
  ordinal: number,
  attempt: number,
  invocationMarker: string,
): string {
  return `${run.id}:${invocationMarker}:${phase}:${ordinal}:${attempt}`;
}

function resumableInvocationMarker(run: ResumableSummaryRun): string {
  return `${run.updatedAt}:${run.completedChunks}:${run.skippedChunks}`;
}

type SummaryLineageInput = {
  lineage?: Session["lineage"];
  parentSessionId?: string;
};

type SummaryChunkPlan = {
  chunks: CompressedObservation[][];
  oversizedAtomicChunkIndexes: number[];
};

type SummaryChunkTelemetry = ProviderCallTelemetry & {
  oversizedAtomicChunk?: boolean;
  chunkObservationCount?: number;
};

type SummaryChunkTelemetryMarker = {
  oversizedAtomicChunk: boolean;
  chunkObservationCount: number;
};

type ResumableSummaryResponse = {
  success: boolean;
  status: "in_progress" | "succeeded" | "failed" | "infeasible" | "preflight_unavailable";
  completedChunks: number;
  totalChunks: number;
  skippedChunks: number;
  advanced: SummaryAdvanceKind;
  summary?: SessionSummary;
  error?: string;
  failureCause?: SummaryFailureCause;
  failure?: StageFailure;
  telemetry?: ProviderCallTelemetry[];
};

function summaryFailureCause(error: unknown): SummaryFailureCause {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  for (const cause of [
    "pi_auth_missing",
    "pi_auth_failed",
    "pi_model_not_found",
    "pi_sdk_import_failed",
  ] as const) {
    if (normalized.includes(cause)) return cause;
  }
  const providerErrorCode = (error as { metadata?: { providerErrorCode?: unknown } } | null)
    ?.metadata?.providerErrorCode;
  if (["401", "403", "auth", "authentication"].includes(String(providerErrorCode).toLowerCase())) {
    return "pi_auth_failed";
  }
  if (normalized.includes("circuit_breaker_open")) return "circuit_breaker_open";
  if (normalized.includes("pi_stream_failed")) return "pi_stream_failed";
  if (providerErrorCode === "timeout"
    || /fetch failed|network|econnreset|etimedout|timed out|timeout|socket/.test(normalized)) {
    return "network_error";
  }
  return "provider_failure";
}

function summaryStageFailure(
  cause: SummaryFailureCause,
  diagnostics?: StageFailureDiagnostics,
): StageFailure {
  const detail = diagnostics ? { diagnostics } : {};
  if (
    cause === "pi_auth_missing"
    || cause === "pi_auth_failed"
    || cause === "pi_model_not_found"
    || cause === "pi_sdk_import_failed"
  ) {
    return { class: "hard", cause, ...detail };
  }
  if (transientSummaryFailure(cause)) {
    return { class: "transient_provider", cause, ...detail };
  }
  return { class: "unit", cause, ...detail };
}

function summaryPreflightFailure(error: ProviderPreflightError): StageFailure {
  return {
    class: "hard",
    cause: error.telemetry.reason?.trim() || providerPreflightStatus(error),
  };
}

function transientSummaryFailure(cause: SummaryFailureCause): boolean {
  return cause === "pi_stream_failed"
    || cause === "circuit_breaker_open"
    || cause === "network_error";
}

function defaultSummaryRetryCooldownMs(sessionId: string): number {
  const hashPrefix = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  return TRANSIENT_RETRY_BASE_DELAY_MS
    + (Number.parseInt(hashPrefix, 16) % (TRANSIENT_RETRY_JITTER_MS + 1));
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function summarizeWithOptions(
  provider: MemoryProvider,
  systemPrompt: string,
  userPrompt: string,
  callOptions?: MemoryProviderCallOptions,
  telemetry?: ProviderCallTelemetry[],
  callRole: ProviderCallRole = "single",
  callIndex: ProviderCallIndex = 0,
): Promise<string> {
  const contextStrategyIsNotSummary =
    process.env.AGENTMEMORY_EVALUATION_MODE === "context-strategy"
    && process.env.AGENTMEMORY_CONTEXT_STRATEGY_TARGET_STAGE !== "summary";
  if (!telemetry || contextStrategyIsNotSummary) {
    return callOptions
      ? provider.summarize(systemPrompt, userPrompt, callOptions)
      : provider.summarize(systemPrompt, userPrompt);
  }
  return callProviderWithTelemetry({
    provider,
    operation: "summarize",
    callRole,
    callIndex,
    systemPrompt,
    userPrompt,
    callOptions,
    telemetry,
  });
}

function markChunkTelemetry(
  telemetry: ProviderCallTelemetry[] | undefined,
  callIndex: ProviderCallIndex,
  marker: SummaryChunkTelemetryMarker | undefined,
): void {
  if (!telemetry || !marker) return;
  const record = telemetry.find((item) => item.callIndex === callIndex) as SummaryChunkTelemetry | undefined;
  if (!record) return;
  record.oversizedAtomicChunk = marker.oversizedAtomicChunk;
  record.chunkObservationCount = marker.chunkObservationCount;
}

function rememberChunkFailure(
  failure: { cause?: SummaryFailureCause; diagnostics?: StageFailureDiagnostics } | undefined,
  cause: SummaryFailureCause,
  diagnostics?: StageFailureDiagnostics,
): void {
  if (!failure) return;
  if (!failure.cause) {
    failure.cause = cause;
    failure.diagnostics = diagnostics;
    return;
  }
  if (failure.cause === cause && !failure.diagnostics && diagnostics) {
    failure.diagnostics = diagnostics;
  }
}

// One chunk call with retry-once. Returns null when both attempts fail —
// whether by parse failure, provider 4xx (content rejected by upstream
// filters), or transient network/5xx errors that didn't recover on retry.
// All failure modes are equivalent at this layer: the chunk is unusable,
// skip it and let the caller decide via the skip-ratio bailout whether
// the overall summary is still trustworthy. Errors that affect every
// chunk (auth, model down) will trip the bailout naturally.
async function summarizeChunkWithRetry(
  provider: MemoryProvider,
  chunk: CompressedObservation[],
  sessionId: string,
  project: string,
  idx: number,
  total: number,
  lineageContext: SummaryLineageInput,
  callOptions?: MemoryProviderCallOptions,
  telemetry?: ProviderCallTelemetry[],
  nextCallIndex?: (attempt: number) => ProviderCallIndex,
  chunkTelemetry?: SummaryChunkTelemetryMarker,
  retryOptions: SummaryRetryOptions = {},
  failure?: { cause?: SummaryFailureCause; diagnostics?: StageFailureDiagnostics },
): Promise<SessionSummary | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const callIndex = nextCallIndex?.(attempt) ?? 0;
    try {
      const xml = await summarizeWithOptions(
        provider,
        withOutputLanguagePolicy(SUMMARY_SYSTEM, undefined, SUMMARY_OUTPUT_CONTRACT),
        buildSummaryPrompt(chunk, lineageContext),
        callOptions,
        telemetry,
        "map",
        callIndex,
      );
      markChunkTelemetry(telemetry, callIndex, chunkTelemetry);
      const parsed = parseSummaryXml(xml, sessionId, project, chunk.length);
      if (parsed) return parsed;
      rememberChunkFailure(failure, "parse_failed");
      logger.warn("Summarize chunk parse failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
      });
      continue;
    } catch (err) {
      markChunkTelemetry(telemetry, callIndex, chunkTelemetry);
      if (isProviderPreflightError(err)) throw err;
      const cause = summaryFailureCause(err);
      rememberChunkFailure(failure, cause, diagnosticsFromProviderError(err, "chunk"));
      logger.warn("Summarize chunk LLM call failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt === 1) {
        if (transientSummaryFailure(cause)) {
          const cooldownMs = retryOptions.cooldownMs?.(sessionId)
            ?? defaultSummaryRetryCooldownMs(sessionId);
          await (retryOptions.sleep ?? sleep)(Math.max(0, cooldownMs));
        }
        continue;
      }
      return null;
    }
  }
  return null;
}

function startsNewUserTurn(obs: CompressedObservation): boolean {
  const maybeRaw = obs as CompressedObservation & {
    hookType?: unknown;
    userPrompt?: unknown;
  };
  return (
    maybeRaw.hookType === "prompt_submit" ||
    (typeof maybeRaw.userPrompt === "string" && maybeRaw.userPrompt.trim().length > 0)
  );
}

function splitRecognizedSummaryTurns(
  compressed: CompressedObservation[],
): CompressedObservation[][] | null {
  if (!compressed.some(startsNewUserTurn)) return null;
  const segments: CompressedObservation[][] = [];
  let currentSegment: CompressedObservation[] = [];
  for (const obs of compressed) {
    if (startsNewUserTurn(obs) && currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [];
    }
    currentSegment.push(obs);
  }
  if (currentSegment.length > 0) segments.push(currentSegment);
  return segments;
}

export function buildTurnAwareSummaryChunks(
  compressed: CompressedObservation[],
  chunkSize: number,
): CompressedObservation[][] {
  if (chunkSize <= 0) return [compressed];

  const segments = splitRecognizedSummaryTurns(compressed);
  if (!segments) {
    const fixedChunks: CompressedObservation[][] = [];
    for (let i = 0; i < compressed.length; i += chunkSize) {
      fixedChunks.push(compressed.slice(i, i + chunkSize));
    }
    return fixedChunks;
  }

  const chunks: CompressedObservation[][] = [];
  let currentChunk: CompressedObservation[] = [];
  const flushCurrentChunk = () => {
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
    }
  };

  for (const segment of segments) {
    if (segment.length > chunkSize) {
      flushCurrentChunk();
      for (let i = 0; i < segment.length; i += chunkSize) {
        chunks.push(segment.slice(i, i + chunkSize));
      }
      continue;
    }

    if (currentChunk.length > 0 && currentChunk.length + segment.length > chunkSize) {
      flushCurrentChunk();
    }
    currentChunk.push(...segment);
  }
  flushCurrentChunk();

  return chunks;
}

export function buildSummaryExperimentChunks(
  compressed: CompressedObservation[],
  chunkSize: number,
  treatment: SummaryExperimentTreatment,
  estimateInputTokens?: (chunk: CompressedObservation[]) => number,
): SummaryChunkPlan {
  if (chunkSize <= 0) throw new Error("summary_chunk_size_invalid");
  if (treatment.inputTarget.kind === "observation-count") {
    if (treatment.inputTarget.targetObservations !== chunkSize) {
      throw new Error("summary_target_observations_must_match_chunk_size");
    }
    if (treatment.boundaryPolicy === "current-turn-aware") {
      return {
        chunks: buildTurnAwareSummaryChunks(compressed, chunkSize),
        oversizedAtomicChunkIndexes: [],
      };
    }
  } else if (treatment.boundaryPolicy !== "atomic-turn") {
    throw new Error("summary_token_target_requires_atomic_turn");
  } else if (
    !Number.isSafeInteger(treatment.inputTarget.targetInputTokens)
    || treatment.inputTarget.targetInputTokens <= 0
  ) {
    throw new Error("summary_targetInputTokens_invalid");
  }

  const turns = splitRecognizedSummaryTurns(compressed);
  if (!turns) {
    return {
      chunks: buildTurnAwareSummaryChunks(compressed, chunkSize),
      oversizedAtomicChunkIndexes: [],
    };
  }

  const chunks: CompressedObservation[][] = [];
  const oversizedAtomicChunkIndexes: number[] = [];
  let currentChunk: CompressedObservation[] = [];
  const appendAtomicChunk = (chunk: CompressedObservation[], oversized: boolean) => {
    chunks.push(chunk);
    if (oversized) oversizedAtomicChunkIndexes.push(chunks.length - 1);
  };
  const flushCurrentChunk = () => {
    if (currentChunk.length > 0) {
      appendAtomicChunk(currentChunk, false);
      currentChunk = [];
    }
  };

  for (const turn of turns) {
    if (treatment.inputTarget.kind === "observation-count") {
      if (turn.length > chunkSize) {
        flushCurrentChunk();
        appendAtomicChunk(turn, true);
        continue;
      }
      if (currentChunk.length > 0 && currentChunk.length + turn.length > chunkSize) {
        flushCurrentChunk();
      }
      currentChunk.push(...turn);
      continue;
    }

    if (!estimateInputTokens) throw new Error("summary_token_estimator_missing");
    const targetInputTokens = treatment.inputTarget.targetInputTokens;
    const turnTokens = estimateInputTokens(turn);
    if (turnTokens > targetInputTokens) {
      flushCurrentChunk();
      appendAtomicChunk(turn, true);
      continue;
    }
    if (
      currentChunk.length > 0
      && estimateInputTokens([...currentChunk, ...turn]) > targetInputTokens
    ) {
      flushCurrentChunk();
    }
    currentChunk.push(...turn);
  }
  flushCurrentChunk();
  return { chunks, oversizedAtomicChunkIndexes };
}

// Returns the final summary XML string. For sessions ≤ chunk size, this is
// a single LLM call (legacy behavior). For larger sessions, observations
// are split into chunks processed in parallel batches, each chunk retried
// once on parse failure, persistently-bad chunks skipped, and remaining
// partials merged via a reduce call.
async function produceSummaryXml(
  provider: MemoryProvider,
  compressed: CompressedObservation[],
  sessionId: string,
  project: string,
  lineageContext: SummaryLineageInput,
  callOptions?: MemoryProviderCallOptions,
  telemetry?: ProviderCallTelemetry[],
  nextCallIndex?: () => ProviderCallIndex,
): Promise<{
  response: string;
  mode: "single" | "chunked";
  chunks: number;
  skipped?: number;
  promptChars: number;
}> {
  const runtimeConfig = getSummarizeRuntimeConfig();
  const chunkSize = runtimeConfig.chunkSize;
  const summarySystem = withOutputLanguagePolicy(
    SUMMARY_SYSTEM,
    undefined,
    SUMMARY_OUTPUT_CONTRACT,
  );
  const treatment = getSummaryExperimentTreatment();
  const contextPolicy = treatment?.inputTarget.kind === "token-target"
    ? getContextPreflightPolicy()
    : undefined;
  if (treatment?.inputTarget.kind === "token-target" && !contextPolicy) {
    throw new Error("summary_token_target_requires_preflight_policy");
  }
  const chunkPlan = treatment
    ? buildSummaryExperimentChunks(
      compressed,
      chunkSize,
      treatment,
      contextPolicy
        ? (chunk) => Math.ceil(
          (summarySystem.length + buildSummaryPrompt(chunk, lineageContext).length)
          * contextPolicy.worstTokensPerChar
          * (1 + contextPolicy.proportionalReserve)
          + contextPolicy.fixedTokens,
        )
        : undefined,
    )
    : {
      chunks: buildTurnAwareSummaryChunks(compressed, chunkSize),
      oversizedAtomicChunkIndexes: [],
    };
  const chunks = chunkPlan.chunks;
  if (chunks.length === 1) {
    const userPrompt = buildSummaryPrompt(chunks[0], lineageContext);
    const callIndex = nextCallIndex?.() ?? 0;
    const marker: SummaryChunkTelemetryMarker | undefined = treatment
      ? {
        oversizedAtomicChunk: chunkPlan.oversizedAtomicChunkIndexes.includes(0),
        chunkObservationCount: chunks[0].length,
      }
      : undefined;
    try {
      const response = await summarizeWithOptions(
        provider,
        summarySystem,
        userPrompt,
        callOptions,
        telemetry,
        "single",
        callIndex,
      );
      markChunkTelemetry(telemetry, callIndex, marker);
      return { response, mode: "single", chunks: 1, promptChars: userPrompt.length };
    } catch (error) {
      markChunkTelemetry(telemetry, callIndex, marker);
      throw error;
    }
  }
  const chunkStartOffsets: number[] = [];
  let nextOffset = 0;
  for (const chunk of chunks) {
    chunkStartOffsets.push(nextOffset);
    nextOffset += chunk.length;
  }
  const concurrency = runtimeConfig.chunkConcurrency;
  logger.info("Summarize chunking session", {
    sessionId,
    chunks: chunks.length,
    chunkSize,
    concurrency,
    totalObservations: compressed.length,
  });

  // Sparse array preserves chunk → index mapping after parallel resolution,
  // so the reduce step sees partials in chronological order even when some
  // were skipped.
  const partialByIdx: Array<SessionSummary | null> = new Array(chunks.length).fill(null);
  for (let batchStart = 0; batchStart < chunks.length; batchStart += concurrency) {
    const batch = chunks.slice(batchStart, batchStart + concurrency);
    await Promise.all(
      batch.map(async (chunk, j) => {
        const idx = batchStart + j;
        partialByIdx[idx] = await summarizeChunkWithRetry(
          provider,
          chunk,
          sessionId,
          project,
          idx,
          chunks.length,
          lineageContext,
          callOptions,
          telemetry,
          nextCallIndex,
          treatment
            ? {
              oversizedAtomicChunk: chunkPlan.oversizedAtomicChunkIndexes.includes(idx),
              chunkObservationCount: chunk.length,
            }
            : undefined,
        );
      }),
    );
  }

  const skipped = partialByIdx.filter((p) => p === null).length;
  const partials = partialByIdx.filter((p): p is SessionSummary => p !== null);

  if (skipped > Math.floor(chunks.length * MAX_SKIP_RATIO)) {
    throw new Error(
      `too_many_chunks_skipped: ${skipped}/${chunks.length} chunks failed to parse after retry`,
    );
  }
  if (skipped > 0) {
    logger.warn("Summarize chunks partially skipped", {
      sessionId,
      skipped,
      total: chunks.length,
    });
  }

  const reduceInput = partials.map((p) => {
    const originalIdx = partialByIdx.indexOf(p);
    return {
      title: p.title,
      narrative: p.narrative,
      keyDecisions: p.keyDecisions,
      filesModified: p.filesModified,
      concepts: p.concepts,
      obsRangeStart: chunkStartOffsets[originalIdx] + 1,
      obsRangeEnd: chunkStartOffsets[originalIdx] + chunks[originalIdx].length,
    };
  });
  const reducePrompt = buildReducePrompt(reduceInput);
  const response = await summarizeWithOptions(
    provider,
    withOutputLanguagePolicy(REDUCE_SYSTEM, undefined, SUMMARY_OUTPUT_CONTRACT),
    reducePrompt,
    callOptions,
    telemetry,
    "reduce",
    nextCallIndex?.() ?? 0,
  );
  const chunkPromptChars = chunks.reduce(
    (sum, chunk) => sum + buildSummaryPrompt(chunk, lineageContext).length,
    0,
  );
  return {
    response,
    mode: "chunked",
    chunks: chunks.length,
    skipped,
    promptChars: chunkPromptChars + reducePrompt.length,
  };
}

// #783: many LLMs (DeepSeek, GPT variants, some Anthropic responses)
// wrap structured XML in markdown code fences or add conversational
// text before/after. Strip those wrappers before the tag regex so a
// well-formed summary doesn't get silently dropped as parse_failed.
function stripXmlWrappers(raw: string): string {
  if (!raw) return "";
  let cleaned = raw.trim();
  // ```xml ... ``` or ``` ... ``` fences (anywhere in the payload).
  cleaned = cleaned.replace(/```\s*xml\s*\n?/gi, "");
  cleaned = cleaned.replace(/```/g, "");
  cleaned = cleaned.trim();
  // If preamble / postamble surrounds the XML root, peel it off.
  const rootMatch = cleaned.match(
    /(<[a-zA-Z_][a-zA-Z0-9_-]*>[\s\S]*<\/[a-zA-Z_][a-zA-Z0-9_-]*>)/,
  );
  if (rootMatch && rootMatch[1]) return rootMatch[1].trim();
  return cleaned;
}

function parseSummaryXml(
  xml: string,
  sessionId: string,
  project: string,
  obsCount: number,
): SessionSummary | null {
  const cleaned = stripXmlWrappers(xml);
  const title = getXmlTag(cleaned, "title");
  if (!title) return null;

  return {
    sessionId,
    project,
    createdAt: new Date().toISOString(),
    title,
    narrative: getXmlTag(cleaned, "narrative"),
    keyDecisions: getXmlChildren(cleaned, "decisions", "decision"),
    filesModified: getXmlChildren(cleaned, "files", "file"),
    concepts: getXmlChildren(cleaned, "concepts", "concept"),
    observationCount: obsCount,
  };
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function resumableSummaryInputHash(
  session: Session,
  compressed: CompressedObservation[],
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        project: session.project,
        lineage: session.lineage,
        parentSessionId: session.parentSessionId,
        observations: compressed,
      }),
    )
    .digest("hex");
}

function resumableSummaryRunId(
  sessionId: string,
  inputHash: string,
  chunkSize: number,
  treatment?: SummaryExperimentTreatment,
): string {
  const binding = treatment
    ? {
      sessionId,
      inputHash,
      chunkSize,
      chunkingKey: stableStringify(treatment),
    }
    : { sessionId, inputHash, chunkSize };
  const bindingHash = createHash("sha256")
    .update(stableStringify(binding))
    .digest("hex");
  return `sumr_${bindingHash.slice(0, 24)}`;
}

function summaryChunkObservationCounts(
  chunks: CompressedObservation[][],
): number[] {
  return chunks.map((chunk) => chunk.length);
}

function selectBoundSummaryObservations(
  observations: CompressedObservation[],
  observationIds: string[],
): CompressedObservation[] | null {
  const observationById = new Map(
    observations.map((observation) => [observation.id, observation]),
  );
  const bound = observationIds.map((id) => observationById.get(id));
  return bound.every(
    (observation): observation is CompressedObservation => Boolean(observation),
  )
    ? bound
    : null;
}

function rebuildBoundSummaryChunks(
  compressed: CompressedObservation[],
  chunkObservationCounts: number[],
): CompressedObservation[][] | null {
  const chunks: CompressedObservation[][] = [];
  let offset = 0;
  for (const count of chunkObservationCounts) {
    if (!Number.isInteger(count) || count <= 0) return null;
    const chunk = compressed.slice(offset, offset + count);
    if (chunk.length !== count) return null;
    chunks.push(chunk);
    offset += count;
  }
  return offset === compressed.length ? chunks : null;
}

function isRecoverableLegacySummaryRun(run: ResumableSummaryRun): boolean {
  return (
    run.status === "failed" &&
    run.lastError?.startsWith("too_many_chunks_skipped:") === true
  );
}

async function clearActiveSummaryRun(
  kv: StateKV,
  run: ResumableSummaryRun,
): Promise<void> {
  const active = await kv.get<ResumableSummaryActiveRun>(
    KV.summaryResumableActiveRuns,
    run.sessionId,
  );
  if (active?.runId === run.id) {
    await kv.delete(KV.summaryResumableActiveRuns, run.sessionId);
  }
}

function resumableResponse(
  status: ResumableSummaryResponse["status"],
  completedChunks: number,
  totalChunks: number,
  skippedChunks: number,
  options: {
    summary?: SessionSummary;
    error?: string;
    failureCause?: SummaryFailureCause;
    failure?: StageFailure;
    advanced?: SummaryAdvanceKind;
    telemetry?: ProviderCallTelemetry[];
  } = {},
): ResumableSummaryResponse {
  const failure = options.failure
    ?? (options.failureCause ? summaryStageFailure(options.failureCause) : undefined);
  return {
    success: status === "in_progress" || status === "succeeded",
    status,
    advanced: options.advanced ?? "none",
    completedChunks,
    totalChunks,
    skippedChunks,
    ...(status === "succeeded" && options.summary
      ? { summary: options.summary }
      : {}),
    ...(options.error ? { error: options.error } : {}),
    ...(options.failureCause ? { failureCause: options.failureCause } : {}),
    ...(failure ? { failure } : {}),
    ...(options.telemetry
      ? { telemetry: sortProviderCallTelemetry(options.telemetry) }
      : {}),
  };
}

function validateFinalSummary(summary: SessionSummary): string | null {
  const validation = validateOutput(
    SummaryOutputSchema,
    {
      title: summary.title,
      narrative: summary.narrative,
      keyDecisions: summary.keyDecisions,
      filesModified: summary.filesModified,
      concepts: summary.concepts,
    },
    "mem::summarize-resumable",
  );
  return validation.valid ? null : "validation_failed";
}

async function persistResumableSummary(
  kv: StateKV,
  run: ResumableSummaryRun,
  summary: SessionSummary,
  completedChunks: number,
  skippedChunks: number,
  telemetry?: ProviderCallTelemetry[],
  advanced: SummaryAdvanceKind = "none",
): Promise<ResumableSummaryResponse> {
  const updatedAt = new Date().toISOString();
  const succeededRun: ResumableSummaryRun = {
    ...run,
    status: "succeeded",
    completedChunks,
    skippedChunks,
    summary,
    lastError: undefined,
    updatedAt,
  };
  await kv.set(KV.summaryResumableRuns, run.id, succeededRun);
  await kv.set(KV.summaries, run.sessionId, summary);
  await clearActiveSummaryRun(kv, succeededRun);
  await safeAudit(kv, "compress", "mem::summarize-resumable", [run.sessionId], {
    title: summary.title,
    observationCount: summary.observationCount,
    resumableRunId: run.id,
  });
  return resumableResponse(
    "succeeded",
    completedChunks,
    run.totalChunks,
    skippedChunks,
    { summary, advanced, ...(telemetry ? { telemetry } : {}) },
  );
}

async function runResumableSummaryStep(
  data: { sessionId: string; model?: string } | undefined,
  kv: StateKV,
  provider: MemoryProvider,
  retryOptions: SummaryRetryOptions = {},
): Promise<ResumableSummaryResponse> {
  if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
    return resumableResponse("failed", 0, 0, 0, {
      error: "sessionId is required",
    });
  }
  const sessionId = data.sessionId.trim();

  return withKeyedLock(`summarize-resumable:${sessionId}`, async () => {
    let completedChunks = 0;
    let totalChunks = 0;
    let skippedChunks = 0;
    const telemetry: ProviderCallTelemetry[] = [];

    try {
      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!session) {
        return resumableResponse("failed", 0, 0, 0, {
          error: "session_not_found",
        });
      }

      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const now = new Date().toISOString();
      const configuredChunkSize = getSummarizeRuntimeConfig().chunkSize;
      const treatment = getSummaryExperimentTreatment();
      const contextPolicy = treatment?.inputTarget.kind === "token-target"
        ? getContextPreflightPolicy()
        : undefined;
      if (treatment?.inputTarget.kind === "token-target" && !contextPolicy) {
        throw new Error("summary_token_target_requires_preflight_policy");
      }
      let chunkSize = configuredChunkSize;
      let compressed: CompressedObservation[] = [];
      let chunks: CompressedObservation[][] = [];
      let oversizedAtomicChunkIndexes: number[] = [];
      let inputHash = "";
      let runId = "";
      let run: ResumableSummaryRun | null = null;
      let active = await kv.get<ResumableSummaryActiveRun>(
        KV.summaryResumableActiveRuns,
        sessionId,
      );

      if (active?.sessionId === sessionId) {
        const activeRun = await kv.get<ResumableSummaryRun>(
          KV.summaryResumableRuns,
          active.runId,
        );
        if (
          activeRun &&
          active.inputHash === activeRun.inputHash &&
          Array.isArray(activeRun.observationIds) &&
          activeRun.observationIds.every((id) => typeof id === "string") &&
          Array.isArray(activeRun.chunkObservationCounts)
        ) {
          const bound = selectBoundSummaryObservations(
            observations,
            activeRun.observationIds,
          );
          const rebuilt = bound
            ? rebuildBoundSummaryChunks(
                bound,
                activeRun.chunkObservationCounts,
              )
            : null;
          if (
            bound &&
            rebuilt &&
            resumableSummaryInputHash(session, bound) === activeRun.inputHash
          ) {
            run = activeRun;
            runId = activeRun.id;
            inputHash = activeRun.inputHash;
            chunkSize = activeRun.chunkSize;
            compressed = bound;
            chunks = rebuilt;
          }
        }
      }

      if (active && !run) {
        await kv.delete(KV.summaryResumableActiveRuns, sessionId);
        active = null;
      }

      if (!run) {
        compressed = observations.filter((observation) => observation.title);
        if (compressed.length === 0) {
          return resumableResponse("failed", 0, 0, 0, {
            error: "no_observations",
          });
        }
        chunkSize = configuredChunkSize;
        const lineageContext = {
          lineage: session.lineage,
          parentSessionId: session.parentSessionId,
        };
        const summarySystem = withOutputLanguagePolicy(
          SUMMARY_SYSTEM,
          undefined,
          SUMMARY_OUTPUT_CONTRACT,
        );
        const chunkPlan = treatment
          ? buildSummaryExperimentChunks(
            compressed,
            chunkSize,
            treatment,
            contextPolicy
              ? (chunk) => Math.ceil(
                (summarySystem.length + buildSummaryPrompt(chunk, lineageContext).length)
                * contextPolicy.worstTokensPerChar
                * (1 + contextPolicy.proportionalReserve)
                + contextPolicy.fixedTokens,
              )
              : undefined,
          )
          : {
            chunks: buildTurnAwareSummaryChunks(compressed, chunkSize),
            oversizedAtomicChunkIndexes: [],
          };
        chunks = chunkPlan.chunks;
        oversizedAtomicChunkIndexes = chunkPlan.oversizedAtomicChunkIndexes;
        inputHash = resumableSummaryInputHash(session, compressed);
        runId = resumableSummaryRunId(
          sessionId,
          inputHash,
          chunkSize,
          treatment,
        );
        run = await kv.get<ResumableSummaryRun>(
          KV.summaryResumableRuns,
          runId,
        );
      }
      totalChunks = chunks.length;

      if (
        run &&
        (run.sessionId !== sessionId ||
          run.inputHash !== inputHash ||
          run.chunkSize !== chunkSize ||
          run.totalChunks !== totalChunks)
      ) {
        return resumableResponse("failed", 0, totalChunks, 0, {
          error: "run_binding_mismatch",
        });
      }

      if (!run) {
        run = {
          id: runId,
          sessionId,
          inputHash,
          chunkSize,
          totalChunks,
          observationIds: compressed.map((observation) => observation.id),
          chunkObservationCounts: summaryChunkObservationCounts(chunks),
          completedChunks: 0,
          skippedChunks: 0,
          status: "in_progress",
          createdAt: now,
          updatedAt: now,
        };
        await kv.set(KV.summaryResumableRuns, runId, run);
      } else if (
        !Array.isArray(run.observationIds) ||
        !Array.isArray(run.chunkObservationCounts)
      ) {
        run = {
          ...run,
          observationIds: compressed.map((observation) => observation.id),
          chunkObservationCounts: summaryChunkObservationCounts(chunks),
          updatedAt: now,
        };
        await kv.set(KV.summaryResumableRuns, runId, run);
      }

      if (isRecoverableLegacySummaryRun(run)) {
        run = {
          ...run,
          status: "in_progress",
          lastError: undefined,
          updatedAt: now,
        };
        await kv.set(KV.summaryResumableRuns, runId, run);
      }

      if (
        run.status === "failed" &&
        run.totalChunks === 1 &&
        run.lastError === "validation_failed"
      ) {
        await kv.delete(KV.summaryResumablePartials(runId), "0");
        run = {
          ...run,
          status: "in_progress",
          completedChunks: 0,
          skippedChunks: 0,
          lastError: undefined,
          updatedAt: now,
        };
        await kv.set(KV.summaryResumableRuns, runId, run);
      }

      if (run.status !== "succeeded") {
        const activeRun: ResumableSummaryActiveRun = {
          sessionId,
          runId,
          inputHash,
          createdAt: active?.runId === runId ? active.createdAt : now,
          updatedAt: now,
        };
        await kv.set(KV.summaryResumableActiveRuns, sessionId, activeRun);
        active = activeRun;
      }

      completedChunks = run.completedChunks;
      skippedChunks = run.skippedChunks;

      if (run.status === "succeeded") {
        if (!run.summary) {
          return resumableResponse(
            "failed",
            completedChunks,
            totalChunks,
            skippedChunks,
            { error: "completed_summary_missing" },
          );
        }
        await kv.set(KV.summaries, sessionId, run.summary);
        await clearActiveSummaryRun(kv, run);
        return resumableResponse(
          "succeeded",
          completedChunks,
          totalChunks,
          skippedChunks,
          { summary: run.summary },
        );
      }

      if (run.status === "failed") {
        return resumableResponse(
          "failed",
          completedChunks,
          totalChunks,
          skippedChunks,
          { error: run.lastError ?? "summary_run_failed" },
        );
      }

      if (provider.name === "noop") {
        return resumableResponse(
          "failed",
          completedChunks,
          totalChunks,
          skippedChunks,
          { error: "no_provider" },
        );
      }

      const partials = await kv.list<ResumableSummaryPartial>(
        KV.summaryResumablePartials(runId),
      );
      const partialByIndex = new Map(
        partials
          .filter(
            (partial) =>
              partial.runId === runId &&
              Number.isInteger(partial.chunkIndex) &&
              partial.chunkIndex >= 0 &&
              partial.chunkIndex < totalChunks,
          )
          .map((partial) => [partial.chunkIndex, partial]),
      );
      completedChunks = Array.from(partialByIndex.values()).filter(
        (partial) => partial.status === "completed" && partial.summary,
      ).length;
      skippedChunks = Array.from(partialByIndex.values()).filter(
        (partial) => partial.status === "skipped",
      ).length;

      if (
        completedChunks !== run.completedChunks ||
        skippedChunks !== run.skippedChunks
      ) {
        run = {
          ...run,
          completedChunks,
          skippedChunks,
          updatedAt: new Date().toISOString(),
        };
        await kv.set(KV.summaryResumableRuns, runId, run);
      }

      const persistedSinglePartial = partialByIndex.get(0);
      if (
        totalChunks === 1 &&
        persistedSinglePartial?.status === "completed" &&
        persistedSinglePartial.summary
      ) {
        const validationError = validateFinalSummary(
          persistedSinglePartial.summary,
        );
        if (validationError) {
          await kv.delete(KV.summaryResumablePartials(runId), "0");
          run = {
            ...run,
            status: "in_progress",
            completedChunks: 0,
            skippedChunks: 0,
            lastError: validationError,
            updatedAt: new Date().toISOString(),
          };
          await kv.set(KV.summaryResumableRuns, runId, run);
          return resumableResponse(
            "failed",
            completedChunks,
            totalChunks,
            skippedChunks,
            {
              error: validationError,
              failureCause: "parse_failed",
              telemetry,
            },
          );
        }
        return persistResumableSummary(
          kv,
          run,
          persistedSinglePartial.summary,
          completedChunks,
          skippedChunks,
          telemetry,
        );
      }

      const nextChunkIndex = chunks.findIndex(
        (_chunk, index) => {
          const partial = partialByIndex.get(index);
          return !partial || partial.status === "skipped";
        },
      );
      if (nextChunkIndex >= 0) {
        const previousPartial = partialByIndex.get(nextChunkIndex);
        const callOptions = resolveStageModelCallOptions("summary", data.model);
        const invocationMarker = resumableInvocationMarker(run);
        const failure: {
          cause?: SummaryFailureCause;
          diagnostics?: StageFailureDiagnostics;
        } = {};
        const summary = await summarizeChunkWithRetry(
          provider,
          chunks[nextChunkIndex],
          sessionId,
          session.project,
          nextChunkIndex,
          totalChunks,
          {
            lineage: session.lineage,
            parentSessionId: session.parentSessionId,
          },
          callOptions,
          telemetry,
          (attempt) =>
            resumableCallIndex(
              run!,
              "map",
              nextChunkIndex,
              attempt - 1,
              invocationMarker,
            ),
          treatment
            ? {
              oversizedAtomicChunk: oversizedAtomicChunkIndexes.includes(nextChunkIndex),
              chunkObservationCount: chunks[nextChunkIndex].length,
            }
            : undefined,
          retryOptions,
          failure,
        );
        if (totalChunks === 1 && summary) {
          const validationError = validateFinalSummary(summary);
          if (validationError) {
            run = {
              ...run,
              status: "in_progress",
              completedChunks,
              skippedChunks,
              lastError: validationError,
              updatedAt: new Date().toISOString(),
            };
            await kv.set(KV.summaryResumableRuns, runId, run);
            return resumableResponse(
              "failed",
              completedChunks,
              totalChunks,
              skippedChunks,
              {
                error: validationError,
                failureCause: "parse_failed",
                telemetry,
              },
            );
          }
        }
        const partial: ResumableSummaryPartial = {
          runId,
          chunkIndex: nextChunkIndex,
          status: summary ? "completed" : "skipped",
          ...(summary ? { summary } : {}),
          createdAt: new Date().toISOString(),
        };
        await kv.set(
          KV.summaryResumablePartials(runId),
          String(nextChunkIndex),
          partial,
        );
        partialByIndex.set(nextChunkIndex, partial);
        if (previousPartial?.status === "skipped") skippedChunks -= 1;
        completedChunks += summary ? 1 : 0;
        skippedChunks += summary ? 0 : 1;

        if (skippedChunks > Math.floor(totalChunks * MAX_SKIP_RATIO)) {
          const failureCause = failure.cause ?? "provider_failure";
          const error = `too_many_chunks_skipped: ${skippedChunks}/${totalChunks} chunks unavailable after retry; failure_cause=${failureCause}`;
          run = {
            ...run,
            status: "in_progress",
            completedChunks,
            skippedChunks,
            lastError: error,
            updatedAt: new Date().toISOString(),
          };
          await kv.set(KV.summaryResumableRuns, runId, run);
          return resumableResponse(
            "failed",
            completedChunks,
            totalChunks,
            skippedChunks,
            {
              error,
              failureCause,
              failure: summaryStageFailure(failureCause, failure.diagnostics),
              advanced: "skipped",
              telemetry,
            },
          );
        }

        if (totalChunks === 1 && summary) {
          return persistResumableSummary(
            kv,
            run,
            summary,
            completedChunks,
            skippedChunks,
            telemetry,
            "completed",
          );
        }

        run = {
          ...run,
          completedChunks,
          skippedChunks,
          lastError: undefined,
          updatedAt: new Date().toISOString(),
        };
        await kv.set(KV.summaryResumableRuns, runId, run);
        return resumableResponse(
          "in_progress",
          completedChunks,
          totalChunks,
          skippedChunks,
          {
            advanced: summary ? "completed" : "skipped",
            ...(!summary && failure.cause
              ? {
                failureCause: failure.cause,
                failure: summaryStageFailure(failure.cause, failure.diagnostics),
              }
              : {}),
            telemetry,
          },
        );
      }

      const chunkStartOffsets: number[] = [];
      let nextOffset = 0;
      for (const chunk of chunks) {
        chunkStartOffsets.push(nextOffset);
        nextOffset += chunk.length;
      }
      const successfulPartials = Array.from(partialByIndex.values())
        .filter(
          (partial): partial is ResumableSummaryPartial & { summary: SessionSummary } =>
            partial.status === "completed" && Boolean(partial.summary),
        )
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      const reducePrompt = buildReducePrompt(
        successfulPartials.map((partial) => ({
          title: partial.summary.title,
          narrative: partial.summary.narrative,
          keyDecisions: partial.summary.keyDecisions,
          filesModified: partial.summary.filesModified,
          concepts: partial.summary.concepts,
          obsRangeStart: chunkStartOffsets[partial.chunkIndex] + 1,
          obsRangeEnd:
            chunkStartOffsets[partial.chunkIndex] + chunks[partial.chunkIndex].length,
        })),
      );

      const persistReduceFailure = async (
        message: string,
        failureCause: SummaryFailureCause,
        diagnostics?: StageFailureDiagnostics,
      ): Promise<ResumableSummaryResponse> => {
        run = {
          ...run,
          status: "in_progress",
          completedChunks,
          skippedChunks,
          lastError: message,
          updatedAt: new Date().toISOString(),
        };
        await kv.set(KV.summaryResumableRuns, runId, run);
        return resumableResponse(
          "failed",
          completedChunks,
          totalChunks,
          skippedChunks,
          {
            error: message,
            failureCause,
            failure: summaryStageFailure(failureCause, diagnostics),
            telemetry,
          },
        );
      };

      let response: string;
      try {
        response = await summarizeWithOptions(
          provider,
          withOutputLanguagePolicy(
            REDUCE_SYSTEM,
            undefined,
            SUMMARY_OUTPUT_CONTRACT,
          ),
          reducePrompt,
          resolveStageModelCallOptions("summary", data.model),
          telemetry,
          "reduce",
          resumableCallIndex(
            run!,
            "reduce",
            totalChunks,
            0,
            resumableInvocationMarker(run!),
          ),
        );
      } catch (error) {
        if (isProviderPreflightError(error)) {
          const status = providerPreflightStatus(error);
          return resumableResponse(
            status,
            completedChunks,
            totalChunks,
            skippedChunks,
            { error: status, failure: summaryPreflightFailure(error), telemetry },
          );
        }
        const failureCause = summaryFailureCause(error);
        return persistReduceFailure(
          failureCause,
          failureCause,
          diagnosticsFromProviderError(error, "reduce"),
        );
      }
      if (!response || !response.trim()) {
        return persistReduceFailure("empty_provider_response", "provider_failure");
      }
      const summary = parseSummaryXml(
        response,
        sessionId,
        session.project,
        compressed.length,
      );
      if (!summary) return persistReduceFailure("parse_failed", "parse_failed");
      const validationError = validateFinalSummary(summary);
      if (validationError) return persistReduceFailure(validationError, "parse_failed");
      return await persistResumableSummary(
        kv,
        run,
        summary,
        completedChunks,
        skippedChunks,
        telemetry,
        "reduced",
      );
    } catch (error) {
      if (isProviderPreflightError(error)) {
        const status = providerPreflightStatus(error);
        return resumableResponse(
          status,
          completedChunks,
          totalChunks,
          skippedChunks,
          { error: status, failure: summaryPreflightFailure(error), telemetry },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Resumable summarize step failed", {
        sessionId,
        error: message,
      });
      return resumableResponse(
        "failed",
        completedChunks,
        totalChunks,
        skippedChunks,
        { error: message, telemetry },
      );
    }
  });
}

export function registerSummarizeFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
  retryOptions: SummaryRetryOptions = {},
): void {
  sdk.registerFunction("mem::summarize", 
    async (data: { sessionId: string; model?: string } | undefined) => {
      const startMs = Date.now();
      if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
        return { success: false, error: "sessionId is required" };
      }
      const sessionId = data.sessionId.trim();

      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!session) {
        logger.warn("Session not found for summarize", {
          sessionId,
        });
        return { success: false, error: "session_not_found" };
      }

      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const compressed = observations.filter((o) => o.title);

      if (compressed.length === 0) {
        logger.info("No observations to summarize", {
          sessionId,
        });
        return { success: false, error: "no_observations" };
      }

      if (provider.name === "noop") {
        logger.info("Summarize skipped — no LLM provider configured", {
          sessionId,
        });
        return {
          success: false,
          error: "no_provider",
          reason:
            "No LLM provider key set; Summarize is a no-op. Set ANTHROPIC_API_KEY (or GEMINI/OPENROUTER/MINIMAX) in ~/.agentmemory/.env to enable.",
        };
      }

      const telemetry: ProviderCallTelemetry[] = [];
      const stageMetadata = resolveStageModelMetadata("summary", provider, data.model);
      try {
        const callOptions = resolveStageModelCallOptions("summary", data.model);
        let nextCallIndex = 0;
        // #783: chunk-level produceSummaryXml retries internally, but
        // the final merge used to parse once and bail. Wrap the
        // produce-and-parse pair in the same 2-attempt loop so a
        // markdown-wrapped or otherwise wrapped response gets a
        // second roll-of-the-dice instead of dropping the summary.
        let summary: SessionSummary | null = null;
        let response = "";
        let mode = "single";
        let chunks = 1;
        let promptChars = 0;
        let parseFailures = 0;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const produced = await produceSummaryXml(
            provider,
            compressed,
            sessionId,
            session.project,
            {
              lineage: session.lineage,
              parentSessionId: session.parentSessionId,
            },
            callOptions,
            telemetry,
            () => nextCallIndex++,
          );
          response = produced.response;
          mode = produced.mode;
          chunks = produced.chunks;
          promptChars = produced.promptChars;
          if (!response || !response.trim()) {
            logger.warn("Empty provider response on summarize", {
              sessionId,
              provider: provider.name,
              mode,
              chunks,
              observationCount: compressed.length,
              attempt,
            });
            continue;
          }
          summary = parseSummaryXml(
            response,
            sessionId,
            session.project,
            compressed.length,
          );
          if (summary) break;
          parseFailures++;
          logger.warn("Failed to parse summary XML", { sessionId, attempt });
        }

        if (!response || !response.trim()) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return {
            success: false,
            error: "empty_provider_response",
            status: "failed",
            ...stageMetadata,
            promptChars,
            durationMs: latencyMs,
            parseFailures,
            telemetry: sortProviderCallTelemetry(telemetry),
          };
        }

        if (!summary) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return {
            success: false,
            error: "parse_failed",
            status: "failed",
            ...stageMetadata,
            promptChars,
            durationMs: latencyMs,
            parseFailures,
            telemetry: sortProviderCallTelemetry(telemetry),
          };
        }

        const summaryForValidation = {
          title: summary.title,
          narrative: summary.narrative,
          keyDecisions: summary.keyDecisions,
          filesModified: summary.filesModified,
          concepts: summary.concepts,
        };
        const validation = validateOutput(
          SummaryOutputSchema,
          summaryForValidation,
          "mem::summarize",
        );

        if (!validation.valid) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          logger.warn("Summary validation failed", {
            sessionId,
            errors: validation.result.errors,
          });
          return {
            success: false,
            error: "validation_failed",
            status: "failed",
            ...stageMetadata,
            promptChars,
            durationMs: latencyMs,
            parseFailures,
            telemetry: sortProviderCallTelemetry(telemetry),
          };
        }

        const qualityScore = scoreSummary(summaryForValidation);

        await kv.set(KV.summaries, sessionId, summary);
        await safeAudit(kv, "compress", "mem::summarize", [sessionId], {
          title: summary.title,
          observationCount: compressed.length,
        });

        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record(
            "mem::summarize",
            latencyMs,
            true,
            qualityScore,
          );
        }

        logger.info("Session summarized", {
          sessionId,
          title: summary.title,
          decisions: summary.keyDecisions.length,
          qualityScore,
          valid: validation.valid,
        });

        return {
          success: true,
          summary,
          qualityScore,
          status: "succeeded",
          ...stageMetadata,
          promptChars,
          durationMs: latencyMs,
          parseFailures,
          telemetry: sortProviderCallTelemetry(telemetry),
        };
      } catch (err) {
        if (isProviderPreflightError(err)) {
          const status = providerPreflightStatus(err);
          return {
            success: false,
            error: status,
            status,
            ...stageMetadata,
            telemetry: sortProviderCallTelemetry(telemetry),
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record("mem::summarize", latencyMs, false);
        }
        logger.error("Summarize failed", {
          sessionId,
          error: msg,
        });
        return {
          success: false,
          error: msg,
          telemetry: sortProviderCallTelemetry(telemetry),
        };
      }
    },
  );

  sdk.registerFunction(
    "mem::summarize-resumable",
    async (data: { sessionId: string; model?: string } | undefined) =>
      runResumableSummaryStep(data, kv, provider, retryOptions),
  );
}

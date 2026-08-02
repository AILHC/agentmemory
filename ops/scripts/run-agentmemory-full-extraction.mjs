import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdaptiveProviderLimiter } from './lib/adaptive-provider-limiter.mjs';
import {
  exactExtractionOperationReceiptAbsence,
  executeReceiptAwareRequest,
  extractionOperationReconciliationBinding,
  runV2RemainingStages,
} from './lib/full-extraction-stage-adapters-v2.mjs';
import {
  runSinglePhaseStage,
  runTwoPhaseStage,
  validateSinglePhaseStage,
} from './lib/recoverable-stage-v2.mjs';
import { RunStateStore } from './lib/run-state-store.mjs';
import {
  reduceRunControlLifecycle,
  RunStateJournalV2,
} from './lib/run-state-journal-v2.mjs';
import {
  RECOVERY_POLICY_HASH,
  RECOVERY_POLICY_VERSION,
} from './lib/recovery-policy-v1.mjs';
import { reduceRecoveryJournal } from './lib/recovery-journal-reducer-v1.mjs';
import { inspectRecoveryMigrationGate } from './lib/recovery-migration-contract-v1.mjs';
import {
  EFFECT_STATE_RECOVERY_STAGES,
} from './lib/effect-state-recovery-stage-catalog-v1.mjs';
import { adaptSummaryOperationEvidence } from './lib/summary-recovery-adapter-v1.mjs';
import { adaptLessonOperationEvidence } from './lib/lesson-recovery-adapter-v1.mjs';
import { runStagePipeline } from './lib/stage-pipeline.mjs';
import { assertV1ReleaseGate } from './lib/v2-release-gate.mjs';

export const SCHEMA_VERSION = 1;
export const DEFAULT_MARK = 'agentmemory-full-extraction';

const TERMINAL_STATUSES = new Set(['succeeded', 'skipped', 'failed']);
export const ENABLED_STAGES = [
  'summary',
  'lessons',
  'memory_consolidate_windows',
  'semantic_windows',
  'skill_extract',
  'crystal_groups',
  'consolidation_procedural_windows',
  'reflect_insight_windows',
];
export const FULL_STAGE_CONTAINERS = [
  'memory_consolidate_windows',
  'skill_extract',
  'crystal_groups',
  'consolidation_procedural_windows',
  'reflect_insight_windows',
];
const FORBIDDEN_STATE_KEYS = [
  'corpus_windows',
  'corpus_rollup',
  'consolidation_semantic_windows',
];
const SENSITIVE_KEY_PATTERN = /token|secret|provider[_-]?key|api[_-]?key|authorization/i;
const MAX_STATE_ERROR_CHARS = 2000;
const DEFAULT_REQUEST_TIMEOUT_MS = 360000;
const DEFAULT_LESSON_TIMEOUT_MS = 360000;
const DEFAULT_STAGE_CHAR_BUDGET = 64000;
const SUMMARY_RESUMABLE_PATH = '/agentmemory/summarize/resumable';
const EXTRACTION_BASELINE_PATH = '/agentmemory/full/extraction-baseline';
const SUMMARY_SESSION_POLL_ATTEMPTS = 5;
const SUMMARY_ADVANCE_MIN_CALL_LIMIT = 20;
const SUMMARY_ADVANCE_MAX_CALL_LIMIT = 10000;
const SUMMARY_CONTENT_KEYS = new Set([
  'summary',
  'data',
  'narrative',
  'keyDecisions',
  'decisions',
  'filesModified',
  'files',
  'concepts',
]);
const SUMMARY_FAILURE_CAUSES = new Set([
  'parse_failed',
  'pi_stream_failed',
  'circuit_breaker_open',
  'network_error',
  'provider_failure',
]);
const RUN_FRESHNESS_CLOCK_SKEW_MS = 2000;
const STATE_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];
const RETRYABLE_STATE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const stateWriteTails = new Map();
const ORCHESTRATION_POLICY = Object.freeze({
  version: 1,
  provider_backoff_seconds: [60, 120, 240, 300],
  provider_probe_concurrency: 1,
  unit_extra_attempts_per_epoch: 2,
  runtime_unhealthy_confirmations: 2,
});
const STAGE_FAILURE_PHASES = new Set([
  'provider_preflight',
  'provider_call',
  'before_final_persistence',
  'final_result_persistence',
]);
const STAGE_FAILURE_CLASSES = new Set(['transient_provider', 'transient_runtime', 'unit', 'hard']);
const PROVIDER_FAILURE_CAUSES = new Set([
  'pi_stream_failed',
  'circuit_breaker_open',
  'rate_limited',
  'timeout',
  'network_error',
  'server_error',
]);
const BREAKER_ELIGIBLE_PROVIDER_CODES = new Set(['rate_limited', 'timeout', 'network_error', 'server_error']);
const HARD_PROVIDER_CODES = new Set(['auth_failed', 'model_not_found']);
const UNIT_PROVIDER_CODES = new Set(['provider_rejected', 'unknown']);
const LESSON_UNIT_FAILURE_CAUSES = new Set([
  'lesson_missing_root',
  'lesson_no_blocks',
  'lesson_no_valid_items',
  'lesson_parse_failed',
  'lesson_validation_failed',
  'lesson_persist_failed',
  'empty_response',
]);
const PROVIDER_FAILURE_WINDOW_MS = 60_000;
const PROVIDER_FAILURE_THRESHOLD = 3;
const MAX_PROVIDER_RETRY_AFTER_MS = 300_000;
const HARD_FAILURE_CAUSES = new Set([
  'pi_auth_missing',
  'pi_auth_failed',
  'pi_model_not_found',
  'pi_sdk_import_failed',
  'auth_failed',
  'model_not_found',
  'extraction_operation_input_hash_conflict',
  'invalid_extraction_operation_identity',
]);
const PROVIDER_ERROR_CODES = new Set([
  'model_not_found',
  'rate_limited',
  'timeout',
  'provider_rejected',
  'auth_failed',
  'network_error',
  'server_error',
  'unknown',
]);
const PROVIDER_STOP_REASONS = new Set(['stop', 'max_tokens', 'tool_use', 'error', 'aborted']);
const FAILURE_REQUEST_PHASES = new Set(['chunk', 'reduce']);
const LESSON_PARSE_ERROR_CODES = new Set([
  'lesson_missing_root',
  'lesson_no_blocks',
  'lesson_no_valid_items',
  'lesson_validation_failed',
  'lesson_parse_failed',
  'empty_response',
]);

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function safeResponseModel(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(normalized) ? normalized : undefined;
}

export function sanitizeFailureDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const chunkIndex = safeNonNegativeInteger(value.chunkIndex);
  const attempt = safeNonNegativeInteger(value.attempt);
  const responseChars = safeNonNegativeInteger(value.responseChars);
  if (
    value.requestPhase === 'chunk'
    && LESSON_PARSE_ERROR_CODES.has(value.parseErrorCode)
    && chunkIndex !== undefined
    && attempt !== undefined
    && attempt >= 1
    && responseChars !== undefined
  ) {
    return {
      requestPhase: 'chunk',
      parseErrorCode: value.parseErrorCode,
      chunkIndex,
      attempt,
      responseChars,
    };
  }
  const elapsedMs = safeNonNegativeInteger(value.elapsedMs);
  const inputChars = safeNonNegativeInteger(value.inputChars);
  const maxOutputTokens = safeNonNegativeInteger(value.maxOutputTokens);
  if (
    !FAILURE_REQUEST_PHASES.has(value.requestPhase)
    || !PROVIDER_ERROR_CODES.has(value.providerErrorCode)
    || elapsedMs === undefined
    || inputChars === undefined
    || maxOutputTokens === undefined
    || typeof value.responseStarted !== 'boolean'
  ) {
    return undefined;
  }
  const statusCode = safeNonNegativeInteger(value.statusCode);
  const rawRetryAfterMs = safeNonNegativeInteger(value.retryAfterMs);
  const retryAfterMs = rawRetryAfterMs === undefined
    ? undefined
    : Math.min(rawRetryAfterMs, MAX_PROVIDER_RETRY_AFTER_MS);
  const responseModel = safeResponseModel(value.responseModel);
  const stopReason = PROVIDER_STOP_REASONS.has(value.stopReason) ? value.stopReason : undefined;
  return {
    requestPhase: value.requestPhase,
    providerErrorCode: value.providerErrorCode,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    elapsedMs,
    inputChars,
    maxOutputTokens,
    responseStarted: value.responseStarted,
    ...(responseModel ? { responseModel } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

function providerFailureClass(providerErrorCode) {
  if (HARD_PROVIDER_CODES.has(providerErrorCode)) return 'hard';
  if (BREAKER_ELIGIBLE_PROVIDER_CODES.has(providerErrorCode)) return 'transient_provider';
  if (UNIT_PROVIDER_CODES.has(providerErrorCode)) return 'unit';
  return null;
}

function normalizeFailureClassification(failure) {
  if (!failure || typeof failure !== 'object') return null;
  const diagnostics = sanitizeFailureDiagnostics(failure.diagnostics);
  const classification = providerFailureClass(diagnostics?.providerErrorCode)
    || providerFailureClass(failure.cause)
    || failure.class;
  if (!STAGE_FAILURE_CLASSES.has(classification)) return null;
  return {
    class: classification,
    cause: nonEmptyString(failure.cause) || 'stage_failed',
    ...(STAGE_FAILURE_PHASES.has(failure.phase) ? { phase: failure.phase } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export function stageFailureFromState(unit) {
  if (!unit || !STAGE_FAILURE_CLASSES.has(unit.failure_class) || !nonEmptyString(unit.failure_cause)) {
    return null;
  }
  return normalizeFailureClassification({
    class: unit.failure_class,
    cause: unit.failure_cause.trim(),
    diagnostics: unit.failure_diagnostics,
  });
}

function failureStateMetadata(failure) {
  const diagnostics = sanitizeFailureDiagnostics(failure?.diagnostics);
  return {
    failure_class: failure.class,
    failure_cause: failure.cause,
    ...(diagnostics ? { failure_diagnostics: diagnostics } : {}),
  };
}

function applyFailureState(target, failure) {
  Object.assign(target, failureStateMetadata(failure));
  if (!sanitizeFailureDiagnostics(failure?.diagnostics)) delete target.failure_diagnostics;
  return target;
}

export function buildFormalOperationBody(body, options = {}) {
  if (options.plan === true || options.dryRun === true) return body;
  const runId = nonEmptyString(options.state?.run_id);
  const stage = nonEmptyString(options.stage);
  const unitId = nonEmptyString(options.unitId);
  const inputHash = nonEmptyString(options.inputHash);
  if (!runId || !stage || !unitId || !inputHash) {
    throw new Error('formal write operation identity is incomplete');
  }
  return { ...body, runId, stage, unitId, inputHash };
}

export function classifyStageResponse(response = {}) {
  const data = response.data || {};
  const structured = data?.failure;
  if (
    structured
    && STAGE_FAILURE_CLASSES.has(structured.class)
    && nonEmptyString(structured.cause)
  ) {
    return normalizeFailureClassification(structured);
  }
  const cause = nonEmptyString(data?.failureCause || data?.failure_cause);
  const providerClass = providerFailureClass(cause);
  if (cause && providerClass) return { class: providerClass, cause };
  if (cause && PROVIDER_FAILURE_CAUSES.has(cause)) {
    return { class: 'transient_provider', cause };
  }
  if (cause && HARD_FAILURE_CAUSES.has(cause)) {
    return { class: 'hard', cause };
  }
  if (cause === 'parse_failed' || cause === 'provider_failure') {
    return { class: 'unit', cause };
  }
  const legacyError = nonEmptyString(data?.error);
  if (legacyError) {
    for (const legacyCause of HARD_FAILURE_CAUSES) {
      if (legacyError.includes(legacyCause)) return { class: 'hard', cause: legacyCause };
    }
    for (const legacyCause of PROVIDER_FAILURE_CAUSES) {
      if (legacyError.includes(legacyCause)) {
        return { class: 'transient_provider', cause: legacyCause };
      }
    }
  }
  const statusCode = Number(response.status_code ?? response.statusCode ?? 0);
  if (statusCode === 0) return { class: 'transient_runtime', cause: 'request_transport_failed' };
  if (statusCode >= 500) return { class: 'transient_runtime', cause: `http_${statusCode}` };
  if (statusCode >= 400) return { class: 'hard', cause: `http_${statusCode}` };
  return { class: 'unit', cause: cause || 'stage_response_failed' };
}

export async function classifyPlanFailure(response, runtimeDiagnostics) {
  const failure = classifyStageResponse(response);
  if (failure.cause !== 'http_404' || typeof runtimeDiagnostics !== 'function') return failure;
  try {
    const diagnostics = await runtimeDiagnostics();
    if (diagnostics?.runtime_healthy === false) {
      return { class: 'transient_runtime', cause: 'http_404' };
    }
  } catch {
    // Keep the deterministic HTTP classification when the diagnostic backend itself fails.
  }
  return failure;
}

export function backfillOrchestrationPolicy(state, now = new Date().toISOString()) {
  if (!state || typeof state !== 'object') throw new Error('state is required');
  state.orchestration_policy_version ??= ORCHESTRATION_POLICY.version;
  state.orchestration_policy_hash ??= stableHash(ORCHESTRATION_POLICY);
  state.scheduler_epoch ??= 1;
  state.next_retry_at ??= null;
  state.last_failure_cause ??= null;
  state.stage_work_queues ??= {};
  state.orchestration_policy_backfilled_at ??= now;
  return state;
}

export function beginResumeSchedulerEpoch(state, now = new Date().toISOString()) {
  backfillOrchestrationPolicy(state, now);
  state.scheduler_epoch += 1;
  state.scheduler_resumed_at = now;
  return state.scheduler_epoch;
}

function orchestrationMigrationEntries(state) {
  const entries = [];
  for (const [sessionId, session] of Object.entries(state.sessions || {})) {
    if (session?.summary) entries.push({ stage: 'summary', id: sessionId, target: session.summary });
    if (session?.lessons_extract) entries.push({ stage: 'lessons', id: sessionId, target: session.lessons_extract });
  }
  for (const [id, target] of Object.entries(state.semantic_windows || {})) {
    entries.push({ stage: 'semantic_rollup', id, target });
  }
  for (const [stage, containerKey] of Object.entries({
    memory_consolidate: 'memory_consolidate_windows',
    skill_extract: 'skill_extract',
    crystal: 'crystal_groups',
    consolidation_procedural: 'consolidation_procedural_windows',
    reflect_insight: 'reflect_insight_windows',
  })) {
    for (const [id, target] of Object.entries(state[containerKey] || {})) {
      entries.push({ stage, id, target });
    }
  }
  return entries;
}

function classifyHistoricalFailure(target) {
  const cause = nonEmptyString(target?.failure_cause || target?.failureCause);
  const explicitClass = STAGE_FAILURE_CLASSES.has(target?.failure_class) ? target.failure_class : null;
  if (!cause) return { class: 'unit', cause: 'historical_stage_failure' };
  const diagnostics = sanitizeFailureDiagnostics(target?.failure_diagnostics);
  const providerClass = providerFailureClass(diagnostics?.providerErrorCode) || providerFailureClass(cause);
  if (providerClass) return { class: providerClass, cause, ...(diagnostics ? { diagnostics } : {}) };
  if (explicitClass) return { class: explicitClass, cause, ...(diagnostics ? { diagnostics } : {}) };
  if (PROVIDER_FAILURE_CAUSES.has(cause)) return { class: 'transient_provider', cause };
  if (HARD_FAILURE_CAUSES.has(cause)) return { class: 'hard', cause };
  return { class: 'unit', cause };
}

function freshStageScheduler(epoch) {
  return {
    epoch,
    provider_attempt: 0,
    runtime_attempt: 0,
    runtime_unhealthy_confirmations: 0,
    unit_attempts: {},
    provider_recovery_ids: [],
    runtime_recovery_ids: [],
    next_retry_at: null,
    retry_kind: null,
  };
}

export function migrateOrchestrationPolicy(state, now = new Date().toISOString()) {
  if (!state || typeof state !== 'object') throw new Error('state is required');
  const fromVersion = state.orchestration_policy_version === undefined
    ? 0
    : state.orchestration_policy_version;
  if (!Number.isInteger(fromVersion) || ![0, ORCHESTRATION_POLICY.version].includes(fromVersion)) {
    throw new Error(`unsupported orchestration policy version: ${String(fromVersion)}`);
  }
  if (fromVersion === ORCHESTRATION_POLICY.version) {
    backfillOrchestrationPolicy(state, now);
    return {
      migrated: false,
      from_version: fromVersion,
      to_version: ORCHESTRATION_POLICY.version,
      provider_recovery_units: 0,
      runtime_recovery_units: 0,
      unit_failure_units: 0,
      hard_failure_units: 0,
    };
  }

  const originalConfigHash = state.config_hash;
  state.orchestration_policy_version = ORCHESTRATION_POLICY.version;
  state.orchestration_policy_hash = stableHash(ORCHESTRATION_POLICY);
  state.scheduler_epoch = 1;
  state.next_retry_at = null;
  state.last_failure_cause = null;
  state.stage_work_queues = {};
  state.orchestration_policy_backfilled_at = now;
  const report = {
    migrated: true,
    from_version: fromVersion,
    to_version: ORCHESTRATION_POLICY.version,
    provider_recovery_units: 0,
    runtime_recovery_units: 0,
    unit_failure_units: 0,
    hard_failure_units: 0,
  };

  for (const { stage, id, target } of orchestrationMigrationEntries(state)) {
    if (!target || (target.status !== 'failed' && !target.record_pending)) continue;
    const scheduler = state.stage_work_queues[stage] ??= freshStageScheduler(1);
    if (target.record_pending) {
      scheduler.runtime_recovery_ids.push(id);
      report.runtime_recovery_units += 1;
    }
    if (target.status !== 'failed') continue;

    const failure = classifyHistoricalFailure(target);
    target.failure_class = failure.class;
    target.failure_cause = failure.cause;
    if (failure.class === 'transient_provider') {
      if (!target.record_pending) {
        scheduler.provider_recovery_ids.push(id);
        report.provider_recovery_units += 1;
        state.last_failure_cause ||= failure.cause;
      }
    } else if (failure.class === 'transient_runtime') {
      if (!target.record_pending) {
        scheduler.runtime_recovery_ids.push(id);
        report.runtime_recovery_units += 1;
      }
    } else if (failure.class === 'hard') {
      report.hard_failure_units += 1;
    } else {
      report.unit_failure_units += 1;
    }
  }
  for (const scheduler of Object.values(state.stage_work_queues)) {
    scheduler.provider_recovery_ids.sort();
    scheduler.runtime_recovery_ids.sort();
  }
  state.orchestration_migration = {
    ...report,
    migrated_at: now,
  };
  if (state.config_hash !== originalConfigHash) {
    throw new Error('orchestration migration changed config_hash');
  }
  return report;
}

function cancellationError(signal) {
  const reason = signal?.reason;
  const detail = reason instanceof Error ? reason.message : String(reason || 'cancelled');
  const error = new Error(`cancelled: ${detail}`);
  error.name = 'AbortError';
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError(signal);
}

export function createCancellationController(signalSource = process) {
  const controller = new AbortController();
  const cancel = (signalName) => {
    if (!controller.signal.aborted) controller.abort(new Error(`received ${signalName}`));
  };
  const onSigint = () => cancel('SIGINT');
  const onSigterm = () => cancel('SIGTERM');
  signalSource.on('SIGINT', onSigint);
  signalSource.on('SIGTERM', onSigterm);
  return {
    controller,
    signal: controller.signal,
    dispose() {
      signalSource.off('SIGINT', onSigint);
      signalSource.off('SIGTERM', onSigterm);
    },
  };
}

function normalizeStageOutcome(value) {
  if (value && typeof value === 'object' && typeof value.status === 'string') {
    return {
      ...value,
      failure: normalizeFailureClassification(value.failure),
    };
  }
  if (value === 'succeeded' || value === 'skipped') return { status: value, failure: null };
  if (value === 'retry_planned') return { status: 'retry_planned', failure: null };
  if (value === 'in_progress') return { status: 'in_progress', failure: null };
  if (value === 'failed') return { status: 'failed', failure: { class: 'unit', cause: 'legacy_stage_failure' } };
  throw new Error(`invalid StageOutcome: ${String(value)}`);
}

function defaultJitter(delayMs) {
  const spread = Math.min(5000, Math.floor(delayMs * 0.05));
  return Math.floor(Math.random() * (spread + 1));
}

function nextProviderBackoffMs(attempt) {
  const seconds = ORCHESTRATION_POLICY.provider_backoff_seconds[
    Math.min(attempt, ORCHESTRATION_POLICY.provider_backoff_seconds.length - 1)
  ];
  return seconds * 1000;
}

function queueItemId(item, options) {
  return typeof options.itemId === 'function' ? String(options.itemId(item)) : String(item);
}

export function freezeMemoryConsolidateOrder(state, units) {
  const unitIds = units.map((unit) => String(unit.unit_id || ''));
  if (unitIds.length === 0) return units;
  if (unitIds.some((unitId) => !unitId) || new Set(unitIds).size !== unitIds.length) {
    throw new Error('memory_consolidate_order_invalid');
  }
  const existing = state.memory_consolidate_order;
  if (!existing) {
    state.memory_consolidate_order = {
      unit_ids: unitIds,
      order_hash: stableHash(unitIds),
      frozen_at: new Date().toISOString(),
    };
    return units;
  }
  if (
    !Array.isArray(existing.unit_ids)
    || existing.order_hash !== stableHash(existing.unit_ids)
  ) {
    throw new Error('memory_consolidate_order_drift');
  }
  const unitById = new Map(units.map((unit) => [unit.unit_id, unit]));
  const frozenIds = new Set(existing.unit_ids);
  const hasUnexpectedUnit = unitIds.some((unitId) => !frozenIds.has(unitId));
  const persistedUnits = state.memory_consolidate_windows || {};
  const omittedUnitsAreTerminal = existing.unit_ids.every((unitId) => {
    if (unitById.has(unitId)) return true;
    const persisted = persistedUnits[unitId];
    return terminalStageStatus(persisted?.status)
      && persisted.record_pending !== true;
  });
  if (hasUnexpectedUnit || !omittedUnitsAreTerminal) {
    throw new Error('memory_consolidate_order_drift');
  }
  return existing.unit_ids
    .map((unitId) => unitById.get(unitId))
    .filter(Boolean);
}

export function validateDrainRequest(request, stateLock, now = Date.now()) {
  if (
    !request
    || request.run_id !== stateLock.runId
    || request.owner_id !== stateLock.ownerId
  ) {
    throw new Error('drain_request_lock_owner_mismatch');
  }
  const requestedAt = Date.parse(request.requested_at || '');
  const lockCreatedAt = Date.parse(stateLock.createdAt || '');
  if (
    !Number.isFinite(requestedAt)
    || !Number.isFinite(lockCreatedAt)
    || requestedAt < lockCreatedAt
    || requestedAt > now + 5 * 60 * 1000
  ) {
    throw new Error('drain_request_timestamp_invalid');
  }
  return true;
}

export function selectDrainCommitUnits(state, containerKey, units) {
  return units.filter((unit) => {
    const current = state[containerKey]?.[unit.unit_id];
    return current?.status === 'prepared'
      || current?.status === 'committing'
      || current?.record_pending === true;
  });
}

export async function runStageWorkQueue(stage, state, statePath, work, options = {}) {
  backfillOrchestrationPolicy(state);
  const signal = options.signal;
  const writeState = options.writeState || writeStateAtomically;
  const sleepFn = options.sleep || ((ms) => sleep(ms, { signal }));
  const jitter = options.jitter || defaultJitter;
  const configuredConcurrency = Math.max(1, Number(options.concurrency || 1));
  const currentConcurrency = () => Math.max(
    1,
    Number(typeof options.getConcurrency === 'function'
      ? options.getConcurrency()
      : configuredConcurrency) || 1,
  );
  const nowMs = () => {
    const value = Number(typeof options.now === 'function' ? options.now() : Date.now());
    return Number.isFinite(value) ? value : Date.now();
  };
  const scheduler = state.stage_work_queues[stage] ??= {
    epoch: state.scheduler_epoch,
    provider_attempt: 0,
    runtime_attempt: 0,
    runtime_unhealthy_confirmations: 0,
    unit_attempts: {},
    provider_recovery_ids: [],
    runtime_recovery_ids: [],
    next_retry_at: null,
    retry_kind: null,
  };
  if (scheduler.epoch !== state.scheduler_epoch) {
    Object.assign(scheduler, {
      epoch: state.scheduler_epoch,
      provider_attempt: Number(scheduler.provider_attempt || 0),
      runtime_attempt: Number(scheduler.runtime_attempt || 0),
      runtime_unhealthy_confirmations: Number(scheduler.runtime_unhealthy_confirmations || 0),
      unit_attempts: {},
      provider_recovery_ids: [...(scheduler.provider_recovery_ids || [])],
      runtime_recovery_ids: [...(scheduler.runtime_recovery_ids || [])],
      next_retry_at: scheduler.next_retry_at || null,
      retry_kind: scheduler.retry_kind || null,
    });
  }
  scheduler.unit_attempts ??= {};
  scheduler.provider_recovery_ids ??= [];
  scheduler.runtime_recovery_ids ??= [];
  const itemById = new Map(work.map((item) => [queueItemId(item, options), item]));
  const queue = [];
  const providerRecovery = [];
  const runtimeRecovery = [];
  const unresolved = [];
  let blockedFailure = null;
  let providerGateOpen = false;
  let circuitGateOpen = false;
  let providerRetryReady = false;
  let recoveryRanLastRound = false;
  const breakerEligibleFailures = new Map();

  const addUnique = (target, item) => {
    const id = queueItemId(item, options);
    if (!target.some((entry) => queueItemId(entry, options) === id)) target.push(item);
  };

  for (const item of work) {
    const id = queueItemId(item, options);
    const initial = typeof options.initialOutcome === 'function'
      ? options.initialOutcome(item)
      : null;
    const normalized = initial ? normalizeStageOutcome(initial) : null;
    if (normalized?.failure?.cause) state.last_failure_cause = normalized.failure.cause;
    if (
      normalized
      && !normalized.failure
      && (normalized.status === 'succeeded' || normalized.status === 'skipped')
    ) {
      delete scheduler.unit_attempts[id];
      scheduler.provider_recovery_ids = scheduler.provider_recovery_ids.filter((entry) => entry !== id);
      scheduler.runtime_recovery_ids = scheduler.runtime_recovery_ids.filter((entry) => entry !== id);
    } else if (scheduler.provider_recovery_ids.includes(id) || normalized?.failure?.class === 'transient_provider') {
      addUnique(providerRecovery, item);
    } else if (scheduler.runtime_recovery_ids.includes(id) || normalized?.failure?.class === 'transient_runtime') {
      addUnique(runtimeRecovery, item);
    } else if (normalized?.failure?.class === 'hard') {
      blockedFailure ||= normalized.failure;
    } else if (
      normalized?.failure?.class === 'unit'
      && Number(scheduler.unit_attempts[id] || 0) > ORCHESTRATION_POLICY.unit_extra_attempts_per_epoch
    ) {
      unresolved.push({ id, item, failure: normalized.failure });
    } else {
      queue.push(item);
    }
  }
  for (const id of scheduler.provider_recovery_ids) {
    const item = itemById.get(id);
    if (item) addUnique(providerRecovery, item);
  }
  for (const id of scheduler.runtime_recovery_ids) {
    const item = itemById.get(id);
    if (item) addUnique(runtimeRecovery, item);
  }

  const refreshCoverage = () => {
    state.coverage = computeCoverage(state);
    return state.coverage;
  };

  const persistScheduler = async () => {
    scheduler.provider_recovery_ids = providerRecovery.map((item) => queueItemId(item, options));
    scheduler.runtime_recovery_ids = runtimeRecovery.map((item) => queueItemId(item, options));
    state.next_retry_at = scheduler.next_retry_at || null;
    refreshCoverage();
    state.updated_at = new Date().toISOString();
    await writeState(statePath, state);
  };

  const cancelAndThrow = async () => {
    state.cancelled_at = new Date().toISOString();
    state.health ??= {};
    state.health.last_error = 'cancelled';
    await persistScheduler();
    throw cancellationError(signal);
  };

  const isolateUnit = async (item, outcome) => {
    const id = queueItemId(item, options);
    unresolved.push({ id, item, failure: outcome.failure });
    if (typeof options.markIsolated === 'function') await options.markIsolated(item, outcome);
  };

  const providerRetryAfterMs = (failure) => Number(
    sanitizeFailureDiagnostics(failure?.diagnostics)?.retryAfterMs || 0,
  );

  const configuredProviderRetryAt = () => {
    const value = typeof options.getProviderRetryAt === 'function'
      ? options.getProviderRetryAt()
      : null;
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };

  const scheduleProviderRetry = (failure, options = {}) => {
    const attempt = Number(scheduler.provider_attempt || 0);
    const baseDelayMs = nextProviderBackoffMs(attempt);
    const delayMs = Math.max(
      0,
      baseDelayMs + Number(jitter(baseDelayMs, attempt) || 0),
      providerRetryAfterMs(failure),
    );
    const current = scheduler.retry_kind === 'provider'
      ? Date.parse(scheduler.next_retry_at || '')
      : Number.NaN;
    let retryAt = current;
    if (options.force === true || !Number.isFinite(current)) {
      retryAt = nowMs() + delayMs;
      providerRetryReady = false;
    } else if (providerRetryAfterMs(failure) > 0) {
      retryAt = Math.max(current, nowMs() + providerRetryAfterMs(failure));
      providerRetryReady = retryAt <= nowMs();
    }
    const limiterRetryAt = configuredProviderRetryAt();
    if (Number.isFinite(limiterRetryAt)) retryAt = Math.max(retryAt, limiterRetryAt);
    scheduler.retry_kind = 'provider';
    scheduler.next_retry_at = new Date(retryAt).toISOString();
  };

  const providerRetryDue = () => {
    if (providerRecovery.length === 0 || scheduler.retry_kind !== 'provider') return false;
    const retryAt = Date.parse(scheduler.next_retry_at || '');
    return providerRetryReady || (Number.isFinite(retryAt) && retryAt <= nowMs());
  };

  const clearProviderRetryIfIdle = () => {
    if (providerRecovery.length > 0 || scheduler.retry_kind !== 'provider') return;
    scheduler.provider_attempt = 0;
    scheduler.next_retry_at = null;
    scheduler.retry_kind = null;
    providerRetryReady = false;
  };

  const isBreakerEligibleFailure = (failure) => {
    const diagnostics = sanitizeFailureDiagnostics(failure?.diagnostics);
    if (diagnostics) return BREAKER_ELIGIBLE_PROVIDER_CODES.has(diagnostics.providerErrorCode);
    return failure?.class === 'transient_provider'
      && BREAKER_ELIGIBLE_PROVIDER_CODES.has(failure.cause);
  };

  const recordProviderSignal = (item, outcome, context = {}) => {
    if (!outcome.failure) {
      breakerEligibleFailures.clear();
      if (context.probe === true) {
        providerGateOpen = false;
        circuitGateOpen = false;
      } else if (!circuitGateOpen) {
        providerGateOpen = false;
      }
      return;
    }
    if (outcome.failure.cause === 'circuit_breaker_open') {
      providerGateOpen = true;
      circuitGateOpen = true;
      return;
    }
    if (!isBreakerEligibleFailure(outcome.failure)) return;
    const current = context.settledAt ?? nowMs();
    for (const [id, failedAt] of breakerEligibleFailures) {
      if (current - failedAt > PROVIDER_FAILURE_WINDOW_MS) breakerEligibleFailures.delete(id);
    }
    breakerEligibleFailures.set(queueItemId(item, options), current);
    if (breakerEligibleFailures.size >= PROVIDER_FAILURE_THRESHOLD) providerGateOpen = true;
  };

  const routeOutcome = async (item, outcome) => {
    const id = queueItemId(item, options);
    state.last_failure_cause = outcome.failure?.cause || state.last_failure_cause;
    if (!outcome.failure) {
      delete scheduler.unit_attempts[id];
      if (outcome.status === 'in_progress') queue.push(item);
      if (typeof options.expand === 'function') queue.push(...(options.expand(item, outcome) || []));
      return;
    }
    if (outcome.failure.class === 'transient_provider') {
      addUnique(providerRecovery, item);
      scheduleProviderRetry(outcome.failure);
      return;
    }
    if (outcome.failure.class === 'transient_runtime') {
      addUnique(runtimeRecovery, item);
      return;
    }
    if (outcome.failure.class === 'hard') {
      blockedFailure ||= outcome.failure;
      return;
    }
    const attempts = Number(scheduler.unit_attempts[id] || 0) + 1;
    scheduler.unit_attempts[id] = attempts;
    if (attempts <= ORCHESTRATION_POLICY.unit_extra_attempts_per_epoch) queue.push(item);
    else await isolateUnit(item, outcome);
  };

  let settlementSequence = 0;
  const settleCall = async (item, probe) => {
    try {
      const value = await options.run(item, { probe, signal });
      return {
        status: 'fulfilled',
        value,
        settledAt: nowMs(),
        sequence: settlementSequence++,
      };
    } catch (reason) {
      return {
        status: 'rejected',
        reason,
        settledAt: nowMs(),
        sequence: settlementSequence++,
      };
    }
  };

  const settleProbe = async (item) => {
    const settled = await settleCall(item, true);
    if (settled.status === 'rejected') throw settled.reason;
    const outcome = normalizeStageOutcome(settled.value);
    if (typeof options.onOutcome === 'function') {
      await options.onOutcome(item, outcome, {
        probe: true,
        settledAt: settled.settledAt,
      });
    }
    return outcome;
  };

  const waitForGate = async (kind, attempt, failureCause) => {
    const existingRetry = scheduler.retry_kind === kind ? Date.parse(scheduler.next_retry_at || '') : Number.NaN;
    const baseDelayMs = nextProviderBackoffMs(attempt);
    const delayMs = Number.isFinite(existingRetry) && existingRetry > nowMs()
      ? existingRetry - nowMs()
      : Math.max(0, baseDelayMs + Number(jitter(baseDelayMs, attempt) || 0));
    scheduler.retry_kind = kind;
    scheduler.next_retry_at = new Date(nowMs() + delayMs).toISOString();
    state.last_failure_cause = failureCause;
    await persistScheduler();
    await sleepFn(delayMs, { signal });
    if (signal?.aborted) await cancelAndThrow();
    scheduler.next_retry_at = null;
    scheduler.retry_kind = null;
  };

  const waitForProviderRetry = async () => {
    if (scheduler.retry_kind !== 'provider' || !Number.isFinite(Date.parse(scheduler.next_retry_at || ''))) {
      scheduleProviderRetry(null);
    }
    const retryAt = Date.parse(scheduler.next_retry_at);
    const delayMs = Math.max(0, retryAt - nowMs());
    await persistScheduler();
    if (delayMs > 0) await sleepFn(delayMs, { signal });
    if (signal?.aborted) await cancelAndThrow();
    providerRetryReady = true;
  };

  const settleProviderRecovery = async (item) => {
    const settled = await settleCall(item, true);
    if (settled.status === 'rejected') throw settled.reason;
    const outcome = normalizeStageOutcome(settled.value);
    recordProviderSignal(item, outcome, { probe: true, settledAt: settled.settledAt });
    if (typeof options.onOutcome === 'function') {
      await options.onOutcome(item, outcome, {
        probe: true,
        settledAt: settled.settledAt,
      });
    }
    if (outcome.failure?.class === 'transient_provider') {
      scheduler.provider_attempt = Number(scheduler.provider_attempt || 0) + 1;
      state.last_failure_cause = outcome.failure.cause;
      if (providerRecovery.length > 1) providerRecovery.push(providerRecovery.shift());
      scheduleProviderRetry(outcome.failure, { force: true });
      return outcome;
    }
    providerRecovery.shift();
    scheduler.provider_attempt = 0;
    await routeOutcome(item, outcome);
    clearProviderRetryIfIdle();
    return outcome;
  };

  if (providerRecovery.length > 0 && scheduler.retry_kind !== 'provider') {
    scheduleProviderRetry(null);
  }

  while ((queue.length > 0 || providerRecovery.length > 0 || runtimeRecovery.length > 0) && !blockedFailure) {
    if (signal?.aborted) await cancelAndThrow();
    if (typeof options.requiresProviderProbe === 'function' && options.requiresProviderProbe()) {
      providerGateOpen = true;
    }
    if (typeof options.shouldDrain === 'function' && await options.shouldDrain()) {
      await persistScheduler();
      return {
        status: 'drained',
        failure: null,
        unresolved,
      };
    }

    if (providerGateOpen && providerRecovery.length > 0) {
      if (!providerRetryDue()) await waitForProviderRetry();
      await settleProviderRecovery(providerRecovery[0]);
      await persistScheduler();
      continue;
    }

    if (runtimeRecovery.length > 0) {
      const diagnostics = typeof options.runtimeDiagnostics === 'function'
        ? await options.runtimeDiagnostics({ stage, item: runtimeRecovery[0], signal })
        : { runtime_healthy: true, doctor_healthy: null };
      if (diagnostics?.runtime_healthy === false) {
        scheduler.runtime_unhealthy_confirmations = Number(scheduler.runtime_unhealthy_confirmations || 0) + 1;
      } else {
        scheduler.runtime_unhealthy_confirmations = 0;
      }
      if (scheduler.runtime_unhealthy_confirmations >= ORCHESTRATION_POLICY.runtime_unhealthy_confirmations) {
        blockedFailure = { class: 'hard', cause: 'runtime_unhealthy_confirmed' };
        await persistScheduler();
        continue;
      }
      const item = runtimeRecovery[0];
      await waitForGate('runtime', Number(scheduler.runtime_attempt || 0), state.last_failure_cause || 'runtime_recovery');
      const outcome = await settleProbe(item);
      if (outcome.failure?.class === 'transient_runtime') {
        scheduler.runtime_attempt = Number(scheduler.runtime_attempt || 0) + 1;
        state.last_failure_cause = outcome.failure.cause;
        await persistScheduler();
        continue;
      }
      runtimeRecovery.shift();
      const released = runtimeRecovery.splice(0);
      scheduler.runtime_attempt = 0;
      scheduler.runtime_unhealthy_confirmations = 0;
      await routeOutcome(item, outcome);
      queue.unshift(...released);
      await persistScheduler();
      continue;
    }

    if (providerRecovery.length > 0 && scheduler.retry_kind !== 'provider') scheduleProviderRetry(null);
    if (queue.length === 0 && providerRecovery.length > 0 && !providerRetryDue()) {
      await waitForProviderRetry();
    }

    const concurrency = currentConcurrency();
    const includeRecovery = providerRetryDue()
      && providerRecovery.length > 0
      && (concurrency > 1 || !recoveryRanLastRound || queue.length === 0);
    const recoveryItem = includeRecovery ? providerRecovery[0] : null;
    const normalCapacity = includeRecovery ? concurrency - 1 : concurrency;
    const batch = queue.splice(0, normalCapacity);
    recoveryRanLastRound = concurrency === 1 && includeRecovery && queue.length > 0;
    if (!includeRecovery) recoveryRanLastRound = false;
    const calls = [
      ...(recoveryItem ? [{ item: recoveryItem, probe: true }] : []),
      ...batch.map((item) => ({ item, probe: false })),
    ];
    if (calls.length === 0) continue;
    const settled = await Promise.all(calls.map(({ item, probe }) => settleCall(item, probe)));
    const unexpected = settled.find((entry) => entry.status === 'rejected');
    if (unexpected) throw unexpected.reason;
    const normalizedSettlements = settled.map((entry, index) => ({
      ...calls[index],
      outcome: normalizeStageOutcome(entry.value),
      settledAt: entry.settledAt,
      sequence: entry.sequence,
    }));
    for (const entry of [...normalizedSettlements].sort((a, b) => a.sequence - b.sequence)) {
      recordProviderSignal(entry.item, entry.outcome, {
        probe: entry.probe,
        settledAt: entry.settledAt,
      });
      if (typeof options.onOutcome === 'function') {
        await options.onOutcome(entry.item, entry.outcome, {
          probe: entry.probe,
          settledAt: entry.settledAt,
        });
      }
    }
    let settledIndex = 0;
    if (recoveryItem) {
      const outcome = normalizedSettlements[settledIndex].outcome;
      if (outcome.failure?.class === 'transient_provider') {
        scheduler.provider_attempt = Number(scheduler.provider_attempt || 0) + 1;
        state.last_failure_cause = outcome.failure.cause;
        if (providerRecovery.length > 1) providerRecovery.push(providerRecovery.shift());
        scheduleProviderRetry(outcome.failure, { force: true });
      } else {
        providerRecovery.shift();
        scheduler.provider_attempt = 0;
        await routeOutcome(recoveryItem, outcome);
        clearProviderRetryIfIdle();
      }
      settledIndex += 1;
    }
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const outcome = normalizedSettlements[settledIndex + index].outcome;
      const id = queueItemId(item, options);
      logProgress(stage, 'item', {
        id,
        status: outcome.status,
        failure: outcome.failure,
        ...(outcome.timing ? { timing: outcome.timing } : {}),
        coverage: computeCoverage(state),
      });
      await routeOutcome(item, outcome);
    }
    await persistScheduler();
    const normalDelay = Math.max(0, Number(options.delayMs ?? state.config?.delay_ms ?? 0));
    if (normalDelay > 0 && queue.length > 0 && providerRecovery.length === 0 && runtimeRecovery.length === 0) {
      await sleepFn(normalDelay, { signal });
    }
  }

  if (signal?.aborted) await cancelAndThrow();
  if (blockedFailure) {
    state.health ??= {};
    state.health.last_error = blockedFailure.cause;
    await persistScheduler();
    return { status: 'blocked', failure: blockedFailure, unresolved };
  }
  return {
    status: unresolved.length > 0 ? 'completed_with_failures' : 'completed',
    failure: null,
    unresolved,
  };
}

export function hasUnresolvedStageFailures(state, containerKey) {
  return Object.values(state?.[containerKey] || {}).some((unit) =>
    unit?.status === 'failed' || unit?.record_pending === true,
  );
}

const HELP_TEXT = [
  '用法: node --env-file=<agentmemory.env> ops/scripts/run-agentmemory-full-extraction.mjs --base-url <url> --state-dir <dir> [options]',
  '',
  '--base-url <url>                         AgentMemory REST 地址。',
  '--state-dir <dir>                        extraction run 状态目录。',
  '--run-id <id>                            run 标识；默认按当前时间生成。',
  '--agent-id <id>                          session 盘点 agentId；默认 *。',
  '--mark <text>                            写入 semantic/extraction index 的 mark。',
  '--semantic-window-size <n>               summary session 分窗大小。',
  '--semantic-rollup-target-prompt-chars <n> summary semantic window 规划估算 prompt 字符预算，默认 64000；不作为服务端 charBudget。',
  '--semantic-char-budget <n>               兼容别名，同 --semantic-rollup-target-prompt-chars。',
  '--memory-consolidate-char-budget <n>     memory_consolidate 窗口服务端 charBudget，默认 64000。',
  '--reflect-insight-char-budget <n>        reflect_insight 窗口服务端 charBudget，默认 64000。',
  '--default-stage-char-budget <n>          有真实 charBudget 入口的阶段默认预算；stage-specific CLI 优先。',
  '--delay-ms <n>                           LLM 写操作之间的延迟毫秒数。',
  '--session-concurrency <n>                summary/lessons session 并行数，默认 1，上限 3。',
  '--request-timeout-ms <n>                 编排器 HTTP 请求超时毫秒数，默认 360000。',
  '--doctor-script <path>                   运行前执行 readiness doctor 脚本；formal console 用 doctor-agentmemory-console.ps1。',
  '--doctor-ok <diagnosis>                  期望 diagnosis 行；默认 diagnosis=OK_FORMAL_CONSOLE_OWNS_AGENTMEMORY_PORTS。',
  '--stop-after-consecutive-failures <n>    已废弃；仅兼容解析并保留配置哈希，不再控制停止。',
  '--exclude-record <path>                  从 selector 记录 JSON 排除 session，可重复传；用于排除已提炼批次。',
  '--allow-summarize-concurrency <n>        显式允许非 1 的 summarize chunk 并发。',
  '--summary-model <model>                  本次 run 的 summary 阶段模型显式覆盖。',
  '--lesson-model <model>                   本次 run 的 lesson 阶段模型显式覆盖。',
  '--memory-consolidate-model <model>       本次 run 的 memory_consolidate 阶段模型显式覆盖。',
  '--semantic-rollup-model <model>          本次 run 的 semantic_rollup 阶段模型显式覆盖。',
  '--skill-extract-model <model>            本次 run 的 skill_extract 阶段模型显式覆盖。',
  '--procedural-model <model>               本次 run 的 consolidation_procedural 阶段模型显式覆盖。',
  '--crystal-model <model>                  本次 run 的 action-chain crystal 阶段模型显式覆盖。',
  '--reflect-insight-model <model>          本次 run 的 reflect_insight 阶段模型显式覆盖。',
  '--default-stage-model <model>            本次 run 的阶段模型默认显式覆盖；stage-specific CLI 优先。',
  '--max-units-per-resume <n>               v2 受控恢复本次最多推进的未决单元数；不改变业务配置。',
  '--pending-policy <wait|exit>              v2 遇到安全 pending 时保持写锁轮询或返回 75；默认 wait。',
  '--pending-poll-ms <n>                    v2 pending 轮询间隔毫秒数；默认 30000。',
  '--reset-drifted-units                    resume 时重置漂移单元。',
  '--run-state-format <v1|v2>               状态格式；默认 v2，旧 run 恢复时可显式使用 v1。',
  '--dry-run                                只盘点和写计划状态，不调用提炼写接口。',
  '--resume                                 从现有状态文件恢复。',
  '--help                                   显示帮助。',
].join('\n');

export function parseArgs(argv) {
  const result = {
    baseUrl: '',
    stateDir: '',
    runId: '',
    agentId: '*',
    mark: DEFAULT_MARK,
    semanticWindowSize: 20,
    semanticCharBudget: DEFAULT_STAGE_CHAR_BUDGET,
    semanticRollupTargetPromptChars: DEFAULT_STAGE_CHAR_BUDGET,
    memoryConsolidateCharBudget: null,
    reflectInsightCharBudget: null,
    defaultStageCharBudget: null,
    delayMs: 1500,
    sessionConcurrency: 1,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    doctorScript: '',
    doctorOk: 'diagnosis=OK_FORMAL_CONSOLE_OWNS_AGENTMEMORY_PORTS',
    stopAfterConsecutiveFailures: 3,
    excludeRecords: [],
    allowSummarizeConcurrency: null,
    summaryModel: '',
    lessonModel: '',
    memoryConsolidateModel: '',
    semanticRollupModel: '',
    skillExtractModel: '',
    proceduralModel: '',
    crystalModel: '',
    reflectInsightModel: '',
    defaultStageModel: '',
    maxUnitsPerResume: null,
    pendingPolicy: 'wait',
    pendingPollMs: 30_000,
    resetDriftedUnits: false,
    runStateFormat: 'v2',
    dryRun: false,
    resume: false,
    help: false,
  };

  const requireValue = (items, index, name) => {
    const value = items[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`);
    return value;
  };
  const requirePositiveSafeInteger = (items, index, name) => {
    const value = requireValue(items, index, name);
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} 必须是正整数`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${name} 必须是安全正整数`);
    return parsed;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--base-url') {
      result.baseUrl = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--state-dir') {
      result.stateDir = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--run-id') {
      result.runId = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--agent-id') {
      result.agentId = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--mark') {
      result.mark = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--semantic-window-size') {
      result.semanticWindowSize = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--semantic-char-budget' || arg === '--semantic-rollup-target-prompt-chars') {
      result.semanticCharBudget = Number.parseInt(requireValue(argv, i, arg), 10);
      result.semanticRollupTargetPromptChars = result.semanticCharBudget;
      i += 1;
    } else if (arg === '--memory-consolidate-char-budget') {
      result.memoryConsolidateCharBudget = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--reflect-insight-char-budget') {
      result.reflectInsightCharBudget = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--default-stage-char-budget') {
      result.defaultStageCharBudget = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--delay-ms') {
      result.delayMs = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--session-concurrency') {
      result.sessionConcurrency = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--request-timeout-ms') {
      result.requestTimeoutMs = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--doctor-script') {
      result.doctorScript = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--doctor-ok') {
      result.doctorOk = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--stop-after-consecutive-failures') {
      result.stopAfterConsecutiveFailures = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--exclude-record') {
      result.excludeRecords.push(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--allow-summarize-concurrency') {
      result.allowSummarizeConcurrency = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--summary-model') {
      result.summaryModel = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--lesson-model') {
      result.lessonModel = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--memory-consolidate-model') {
      result.memoryConsolidateModel = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--semantic-rollup-model') {
      result.semanticRollupModel = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--skill-extract-model') {
      result.skillExtractModel = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--procedural-model') {
      result.proceduralModel = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--crystal-model') {
      result.crystalModel = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--reflect-insight-model') {
      result.reflectInsightModel = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--default-stage-model') {
      result.defaultStageModel = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--max-units-per-resume') {
      result.maxUnitsPerResume = requirePositiveSafeInteger(argv, i, arg);
      i += 1;
    } else if (arg === '--pending-policy') {
      result.pendingPolicy = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--pending-poll-ms') {
      result.pendingPollMs = requirePositiveSafeInteger(argv, i, arg);
      i += 1;
    } else if (arg === '--reset-drifted-units') {
      result.resetDriftedUnits = true;
    } else if (arg === '--run-state-format') {
      result.runStateFormat = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--resume') {
      result.resume = true;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  if (result.help) return result;
  if (!['v1', 'v2'].includes(result.runStateFormat)) {
    throw new Error('--run-state-format 必须是 v1 或 v2');
  }
  if (result.runStateFormat === 'v2' && result.resetDriftedUnits) {
    throw new Error('v2 明确拒绝 --reset-drifted-units；请创建新的 run_id');
  }
  if (!result.baseUrl) throw new Error('缺少 --base-url');
  if (!result.stateDir) throw new Error('缺少 --state-dir');
  if (!Number.isInteger(result.semanticWindowSize) || result.semanticWindowSize < 1) {
    throw new Error('--semantic-window-size 必须是正整数');
  }
  if (!Number.isInteger(result.semanticRollupTargetPromptChars) || result.semanticRollupTargetPromptChars < 1000) {
    throw new Error('--semantic-rollup-target-prompt-chars 必须是 >= 1000 的整数');
  }
  if (
    result.memoryConsolidateCharBudget !== null
    && (!Number.isInteger(result.memoryConsolidateCharBudget) || result.memoryConsolidateCharBudget < 1000)
  ) {
    throw new Error('--memory-consolidate-char-budget 必须是 >= 1000 的整数');
  }
  if (
    result.reflectInsightCharBudget !== null
    && (!Number.isInteger(result.reflectInsightCharBudget) || result.reflectInsightCharBudget < 1000)
  ) {
    throw new Error('--reflect-insight-char-budget 必须是 >= 1000 的整数');
  }
  if (
    result.defaultStageCharBudget !== null
    && (!Number.isInteger(result.defaultStageCharBudget) || result.defaultStageCharBudget < 1000)
  ) {
    throw new Error('--default-stage-char-budget 必须是 >= 1000 的整数');
  }
  if (!Number.isInteger(result.delayMs) || result.delayMs < 0) {
    throw new Error('--delay-ms 必须是非负整数');
  }
  if (!Number.isInteger(result.sessionConcurrency)
    || result.sessionConcurrency < 1
    || result.sessionConcurrency > 3) {
    throw new Error('--session-concurrency 必须是 1 到 3 的整数');
  }
  if (!Number.isInteger(result.requestTimeoutMs) || result.requestTimeoutMs < 1000) {
    throw new Error('--request-timeout-ms 必须是 >= 1000 的整数');
  }
  if (result.doctorScript && !result.doctorOk) {
    throw new Error('--doctor-ok 不能为空');
  }
  if (!Number.isInteger(result.stopAfterConsecutiveFailures) || result.stopAfterConsecutiveFailures < 1) {
    throw new Error('--stop-after-consecutive-failures 必须是正整数');
  }
  if (
    result.allowSummarizeConcurrency !== null
    && (!Number.isInteger(result.allowSummarizeConcurrency) || result.allowSummarizeConcurrency < 1)
  ) {
    throw new Error('--allow-summarize-concurrency 必须是正整数');
  }
  if (
    result.maxUnitsPerResume !== null
    && (!Number.isInteger(result.maxUnitsPerResume) || result.maxUnitsPerResume < 1)
  ) {
    throw new Error('--max-units-per-resume 必须是正整数');
  }
  if (
    result.maxUnitsPerResume !== null
    && (result.runStateFormat !== 'v2' || !result.resume || result.dryRun)
  ) {
    throw new Error('--max-units-per-resume 仅允许用于非 dry-run 的 v2 --resume');
  }
  if (!['wait', 'exit'].includes(result.pendingPolicy)) {
    throw new Error('--pending-policy 必须是 wait 或 exit');
  }
  if (!Number.isSafeInteger(result.pendingPollMs) || result.pendingPollMs < 1) {
    throw new Error('--pending-poll-ms 必须是安全正整数');
  }
  return result;
}

export function makeRunId(now = new Date()) {
  return `full-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [
    key,
    sortObject(item),
  ]));
}

export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(sortObject(value))).digest('hex');
}

function basenameWithoutJsonl(filePath) {
  return String(filePath || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.jsonl$/i, '') || '';
}

export function deriveSessionIdFromImportRecord(record) {
  const candidate = basenameWithoutJsonl(
    record?.absolute_path || record?.vault_relpath || record?.relative_source_path || '',
  );
  if (!candidate) return null;
  const codex = candidate.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/);
  if (codex?.[1]) return codex[1];
  return candidate;
}

export async function loadExcludedSessionIds(recordPaths = []) {
  const ids = new Set();
  for (const recordPath of recordPaths || []) {
    const raw = await fs.readFile(recordPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.records)) {
      throw new Error(`exclude record 缺少 records 数组: ${recordPath}`);
    }
    for (const record of parsed.records) {
      const id = deriveSessionIdFromImportRecord(record);
      if (id) ids.add(id);
    }
  }
  if ((recordPaths || []).length > 0 && ids.size === 0) {
    throw new Error('exclude record 未能解析出任何 session id');
  }
  return ids;
}

export function filterExcludedSessions(sessions, excludedSessionIds = new Set()) {
  return selectFullExtractionSessions(sessions, excludedSessionIds).sessions;
}

export function selectFullExtractionSessions(sessions, excludedSessionIds = new Set()) {
  const included = [];
  const excluded = [];
  const reasonCounts = {};
  const normalized = normalizeSessions(sessions);

  for (const session of normalized) {
    const sessionStatus = String(session.status || '').trim().toLowerCase();
    let reason = null;
    if (sessionStatus === 'active') reason = 'session_status_active';
    else if (excludedSessionIds?.has(session.id)) reason = 'exclude_record';

    if (!reason) {
      included.push(session);
      continue;
    }
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    excluded.push({
      session_id: session.id,
      session_status: sessionStatus || null,
      reason,
    });
  }

  return {
    sessions: included,
    audit: {
      discovered_count: normalized.length,
      included_count: included.length,
      excluded_count: excluded.length,
      excluded_reason_counts: Object.fromEntries(
        Object.entries(reasonCounts).sort(([left], [right]) => left.localeCompare(right)),
      ),
      excluded_sessions: excluded,
    },
  };
}

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

const CLI_STAGE_MODEL_FLAGS = {
  summary: ['summaryModel', '--summary-model'],
  lesson: ['lessonModel', '--lesson-model'],
  memory_consolidate: ['memoryConsolidateModel', '--memory-consolidate-model'],
  semantic_rollup: ['semanticRollupModel', '--semantic-rollup-model'],
  skill_extract: ['skillExtractModel', '--skill-extract-model'],
  procedural: ['proceduralModel', '--procedural-model'],
  crystal: ['crystalModel', '--crystal-model'],
  reflect_insight: ['reflectInsightModel', '--reflect-insight-model'],
};

function normalizeCliModel(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || '';
}

export function resolveCliStageModel(options, stage) {
  const entry = CLI_STAGE_MODEL_FLAGS[stage];
  if (!entry) return {};
  const [prop, flag] = entry;
  const stageModel = normalizeCliModel(options?.[prop]);
  if (stageModel) return { model: stageModel, modelSource: `cli:${flag}` };
  const defaultModel = normalizeCliModel(options?.defaultStageModel);
  if (defaultModel) {
    return { model: defaultModel, modelSource: 'cli:--default-stage-model' };
  }
  return {};
}

export function buildStageModelRequestBody(body, options, stage) {
  const resolved = resolveCliStageModel(options, stage);
  if (!resolved.model) return body;
  return { ...body, model: resolved.model };
}

const AUTOMATIC_MODEL_ENV_KEYS = [
  'AGENTMEMORY_SUMMARY_MODEL',
  'AGENTMEMORY_LESSON_MODEL',
  'AGENTMEMORY_MEMORY_CONSOLIDATE_MODEL',
  'AGENTMEMORY_SEMANTIC_ROLLUP_MODEL',
  'AGENTMEMORY_SKILL_EXTRACT_MODEL',
  'AGENTMEMORY_PROCEDURAL_MODEL',
  'AGENTMEMORY_CRYSTAL_MODEL',
  'AGENTMEMORY_REFLECT_INSIGHT_MODEL',
  'AGENTMEMORY_DEFAULT_STAGE_MODEL',
  'PI_AGENT_MODEL',
];

function isSolModel(value) {
  return normalizeCliModel(value).toLowerCase() === 'gpt-5.6-sol';
}

export function assertAutomaticModelPolicy(options, env = process.env) {
  for (const [stage, [prop, flag]] of Object.entries(CLI_STAGE_MODEL_FLAGS)) {
    if (isSolModel(options?.[prop])) {
      throw new Error(`自动 full extraction 禁止 ${flag}=gpt-5.6-sol（阶段: ${stage}）`);
    }
  }
  if (isSolModel(options?.defaultStageModel)) {
    throw new Error('自动 full extraction 禁止 --default-stage-model=gpt-5.6-sol');
  }
  for (const key of AUTOMATIC_MODEL_ENV_KEYS) {
    if (isSolModel(env?.[key])) {
      throw new Error(`自动 full extraction 禁止 ${key}=gpt-5.6-sol`);
    }
  }
}

function stageModelStateMetadata(options, stage) {
  const resolved = resolveCliStageModel(options, stage);
  if (!resolved.model) return {};
  return {
    model: resolved.model,
    model_source: resolved.modelSource,
  };
}

function configuredStageModels(options) {
  return Object.fromEntries(
    Object.keys(CLI_STAGE_MODEL_FLAGS)
      .map((stage) => [stage, stageModelStateMetadata(options, stage)])
      .filter(([, metadata]) => metadata.model),
  );
}

export function buildConfigFromOptions(options) {
  const stageModels = configuredStageModels(options);
  const semanticRollupTargetPromptChars =
    options.semanticRollupTargetPromptChars ?? options.semanticCharBudget ?? DEFAULT_STAGE_CHAR_BUDGET;
  const memoryConsolidateCharBudget =
    options.memoryConsolidateCharBudget ?? options.defaultStageCharBudget ?? DEFAULT_STAGE_CHAR_BUDGET;
  const reflectInsightCharBudget =
    options.reflectInsightCharBudget ?? options.defaultStageCharBudget ?? DEFAULT_STAGE_CHAR_BUDGET;
  return {
    agent_id: options.agentId || '*',
    session_concurrency: options.sessionConcurrency ?? 1,
    lesson_chunk_concurrency: 1,
    semantic_window_size: options.semanticWindowSize,
    semantic_char_budget: semanticRollupTargetPromptChars,
    semantic_rollup_target_prompt_chars: semanticRollupTargetPromptChars,
    memory_consolidate_char_budget: memoryConsolidateCharBudget,
    reflect_insight_char_budget: reflectInsightCharBudget,
    delay_ms: options.delayMs,
    stop_after_consecutive_failures: options.stopAfterConsecutiveFailures,
    ...(options.excludeRecords?.length ? { exclude_records: [...options.excludeRecords].sort() } : {}),
    ...(Object.keys(stageModels).length > 0 ? { stage_models: stageModels } : {}),
  };
}

export function buildInitialState({ runId, baseUrl, mark = DEFAULT_MARK, now, config = null }) {
  const stateConfig = config || {
    agent_id: '*',
    session_concurrency: 1,
    lesson_chunk_concurrency: 1,
    semantic_window_size: 20,
    semantic_char_budget: DEFAULT_STAGE_CHAR_BUDGET,
    semantic_rollup_target_prompt_chars: DEFAULT_STAGE_CHAR_BUDGET,
    memory_consolidate_char_budget: DEFAULT_STAGE_CHAR_BUDGET,
    reflect_insight_char_budget: DEFAULT_STAGE_CHAR_BUDGET,
    delay_ms: 1500,
    stop_after_consecutive_failures: 3,
  };
  return backfillOrchestrationPolicy({
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    mark,
    base_url: normalizeBaseUrl(baseUrl),
    started_at: now,
    updated_at: now,
    config: stateConfig,
    config_hash: stableHash(stateConfig),
    inventory_hash: null,
    health: { last_ok_at: null, last_error: null },
    sessions: {},
    memory_consolidate_windows: {},
    semantic_windows: {},
    skill_extract: {},
    crystal_groups: {},
    consolidation_procedural_windows: {},
    reflect_insight_windows: {},
    semantic_memory_char_sizes: {},
    coverage: computeCoverage({
      sessions: {},
      memory_consolidate_windows: {},
      semantic_windows: {},
      skill_extract: {},
      crystal_groups: {},
      consolidation_procedural_windows: {},
      reflect_insight_windows: {},
    }),
  }, now);
}

export function redactSensitiveText(value) {
  if (value === undefined || value === null) return value;
  return String(value)
    .replace(/(AGENTMEMORY_SECRET\s*=\s*)[^\s"'`]+/gi, '$1<redacted>')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"'`]+/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, '$1<redacted>')
    .replace(/([A-Z0-9_]*API[_-]?KEY\s*[:=]\s*)[^\s"',}`]+/gi, '$1<redacted>')
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s"',}`]+/gi, '$1<redacted>')
    .replace(/((?:access_)?token\s*[:=]\s*)[^\s"',}`]+/gi, '$1<redacted>')
    .replace(/(provider[_-]?key\s*[:=]\s*)[^\s"',}`]+/gi, '$1<redacted>')
    .replace(/(secret\s*[:=]\s*)[^\s"',}`]+/gi, '$1<redacted>');
}

export function redactJson(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) return [key, '<redacted>'];
      return [key, redactJson(item)];
    }));
  }
  return value;
}

export function compactResponse(value) {
  const redacted = redactJson(value);
  const text = JSON.stringify(redacted);
  if (text.length <= 12000) return redacted;
  return { truncated: true, preview: text.slice(0, 12000) };
}

export function compactStateError(value, fallback = 'operation failed') {
  const raw = value === undefined || value === null || value === ''
    ? fallback
    : (typeof value === 'string' ? value : JSON.stringify(redactJson(value)));
  const text = redactSensitiveText(raw);
  if (text.length <= MAX_STATE_ERROR_CHARS) return text;
  return `${text.slice(0, MAX_STATE_ERROR_CHARS)}... [truncated]`;
}

export function logProgress(stage, event, payload = {}) {
  console.log(`[progress] ${stage} ${event} ${JSON.stringify(redactJson(payload))}`);
}

export function requireSecret() {
  const secret = process.env.AGENTMEMORY_SECRET;
  if (!secret) {
    throw new Error('缺少 AGENTMEMORY_SECRET；请用 node --env-file=F:\\ai-runtime\\agentmemory\\home\\.env 运行本脚本');
  }
  return secret;
}

export async function requestJson(baseUrl, secret, method, apiPath, body, options = {}) {
  const startedAt = new Date().toISOString();
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let rawText;
  try {
    response = await fetch(`${normalizeBaseUrl(baseUrl)}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    rawText = await response.text();
  } catch (error) {
    if (externalSignal?.aborted) throw cancellationError(externalSignal);
    const endedAt = new Date().toISOString();
    const timedOut = error?.name === 'AbortError';
    return {
      ok: false,
      method,
      api_path: apiPath,
      status_code: 0,
      started_at: startedAt,
      ended_at: endedAt,
      error: timedOut
        ? `request timed out after ${timeoutMs}ms`
        : compactStateError(error?.message, 'request failed'),
    };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
  const endedAt = new Date().toISOString();
  let parsed = null;
  let responseContractError = '';
  if (!rawText.trim()) {
    responseContractError = 'empty_response';
  } else {
    try {
      parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        responseContractError = 'invalid_json_response';
      }
    } catch {
      parsed = { raw: redactSensitiveText(rawText) };
      responseContractError = 'invalid_json_response';
    }
  }

  const ok = response.ok && !responseContractError && parsed?.success !== false;
  const result = {
    ok,
    method,
    api_path: apiPath,
    status_code: response.status,
    started_at: startedAt,
    ended_at: endedAt,
    response: compactResponse(parsed),
    error: '',
  };
  if (!response.ok) result.error = compactStateError(parsed?.error || `HTTP ${response.status}`, `HTTP ${response.status}`);
  else if (responseContractError) result.error = responseContractError;
  else if (parsed?.success === false) result.error = compactStateError(parsed?.error, 'application reported success=false');
  Object.defineProperty(result, 'data', { value: parsed, enumerable: false });
  return result;
}

async function inspectRunnerAdoptedBaseline({ baseUrl, secret, runId, options }) {
  const result = await requestJson(
    baseUrl,
    secret,
    'POST',
    EXTRACTION_BASELINE_PATH,
    { action: 'inspect_run', runId },
    requestOptions(options),
  );
  if (result.status_code === 404) return { baselineId: null, retired: false };
  if (!result.ok) throw new Error(result.error || 'v2_adopted_baseline_inspection_failed');
  return {
    baselineId: typeof result.data?.baselineId === 'string' ? result.data.baselineId : null,
    retired: result.data?.retired === true,
  };
}

export async function partitionRunnerSessions({
  baseUrl,
  secret,
  stage,
  stageContractVersion,
  sessions,
  expectedBaselineId,
  options,
}) {
  if (sessions.length === 0) return [];
  const result = await requestJson(
    baseUrl,
    secret,
    'POST',
    EXTRACTION_BASELINE_PATH,
    {
      action: 'partition_sessions',
      stage,
      stageContractVersion,
      sessionIds: sessions.map((session) => session.id),
    },
    requestOptions(options),
  );
  if (result.status_code === 404) return sessions;
  if (!result.ok) throw new Error(result.error || 'v2_adopted_baseline_partition_failed');
  const baselineId = typeof result.data?.baselineId === 'string' ? result.data.baselineId : null;
  const openSessionIds = result.data?.openSessionIds;
  const adoptedSessionIds = result.data?.adoptedSessionIds;
  if (
    baselineId !== expectedBaselineId
    || !Array.isArray(openSessionIds)
    || !Array.isArray(adoptedSessionIds)
  ) {
    throw new Error('v2_adopted_baseline_changed');
  }
  const openIds = new Set(openSessionIds);
  const adoptedIds = new Set(adoptedSessionIds);
  const inputIds = new Set(sessions.map((session) => session.id));
  const partitionIds = new Set([...openIds, ...adoptedIds]);
  if (
    openIds.size !== openSessionIds.length
    || adoptedIds.size !== adoptedSessionIds.length
    || [...openIds].some((sessionId) => typeof sessionId !== 'string' || adoptedIds.has(sessionId))
    || [...adoptedIds].some((sessionId) => typeof sessionId !== 'string')
    || partitionIds.size !== inputIds.size
    || [...partitionIds].some((sessionId) => !inputIds.has(sessionId))
  ) throw new Error('v2_adopted_baseline_partition_invalid');
  return sessions.filter((session) => openIds.has(session.id));
}

function requestOptions(options = {}) {
  return {
    timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function runProcess(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      resolve({
        exitCode: null,
        stdout,
        stderr,
        error: String(error.message || error),
        errorCode: error?.code || null,
      });
    });
    child.once('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

export async function runPowerShellScript(scriptPath, processRunner = runProcess) {
  const escapedScriptPath = String(scriptPath).replaceAll("'", "''");
  const encodedCommand = Buffer.from(
    [
      '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '$OutputEncoding = [Text.UTF8Encoding]::new($false)',
      `& '${escapedScriptPath}'`,
    ].join('; '),
    'utf16le',
  ).toString('base64');
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ];

  let lastResult = null;
  for (const command of ['pwsh', 'powershell.exe']) {
    const result = await processRunner(command, args);
    lastResult = { ...result, command };
    if (!(result.exitCode === null && result.errorCode === 'ENOENT')) return lastResult;
  }
  return lastResult;
}

export async function runDoctorGate(doctorScript, expectedDiagnosis, options = {}) {
  const startedAt = new Date().toISOString();
  const proc = await runPowerShellScript(doctorScript, options.processRunner || runProcess);
  const endedAt = new Date().toISOString();
  const diagnosis = `${proc.stdout}\n${proc.stderr}`
    .split(/\r?\n/)
    .find((line) => line.startsWith('diagnosis='));
  const result = {
    ok: diagnosis === expectedDiagnosis,
    diagnosis: diagnosis || null,
    expected_diagnosis: expectedDiagnosis,
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: proc.exitCode,
    powershell_command: proc.command,
    stdout: redactSensitiveText(proc.stdout),
    stderr: redactSensitiveText(proc.stderr),
  };
  if (!result.ok) {
    throw new Error(`Doctor 检查未通过：期望 ${expectedDiagnosis}，实际 ${diagnosis || '无 diagnosis'}`);
  }
  return result;
}

export function buildSessionsPath(agentId = '*') {
  return `/agentmemory/sessions?agentId=${encodeURIComponent(agentId || '*')}`;
}

export function normalizeSessions(sessions) {
  return [...(sessions || [])]
    .filter((session) => typeof session?.id === 'string' && session.id)
    .sort((a, b) => {
      const byTime = String(a.startedAt || '').localeCompare(String(b.startedAt || ''));
      return byTime || a.id.localeCompare(b.id);
    });
}

export function computeInventoryHash(sessions, agentId) {
  return stableHash({
    agentId: agentId || '*',
    sessions: normalizeSessions(sessions).map((session) => ({
      id: session.id,
      startedAt: session.startedAt || null,
      project: session.project || null,
      agentId: session.agentId || null,
    })),
  });
}

export async function loadSessions(baseUrl, secret, agentId = '*', options = {}) {
  const response = await requestJson(baseUrl, secret, 'GET', buildSessionsPath(agentId), undefined, requestOptions(options));
  if (!response.ok) throw new Error(response.error || '读取 sessions 失败');
  return normalizeSessions(response.data?.sessions || response.response?.sessions || []);
}

export async function getRuntimeConfig(baseUrl, secret, options = {}) {
  const response = await requestJson(baseUrl, secret, 'GET', '/agentmemory/runtime-config', undefined, requestOptions(options));
  if (!response.ok) throw new Error(response.error || '无法脱敏确认 runtime-config');
  if (response.data?.success !== true || !response.data?.runtime) {
    throw new Error('无法脱敏确认 runtime-config：响应缺少 success:true 或 runtime');
  }
  return response.data.runtime;
}

export async function assertRuntimeConcurrency({ baseUrl, secret, allowed = null, options = {} }) {
  const runtime = await getRuntimeConfig(baseUrl, secret, options);
  const concurrency = runtime?.summarizeChunkConcurrency;
  if (concurrency === 1) return runtime;
  if (allowed !== null && concurrency === allowed) return runtime;
  throw new Error(`SUMMARIZE_CHUNK_CONCURRENCY=${concurrency}，正式全量提炼要求为 1；如已评估风险，传 --allow-summarize-concurrency ${concurrency}`);
}

export function terminalLessonStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function skippableLessonStatus(status) {
  return status === 'succeeded' || status === 'skipped';
}

export function summaryNeedsWork(item) {
  return item?.summary?.status !== 'succeeded';
}

export function findSessionSummary(sessions, sessionId) {
  return sessions.find((session) => session.id === sessionId)?.summary || null;
}

export function buildSummaryBody(sessionId, options = {}) {
  return buildStageModelRequestBody({ sessionId }, options, 'summary');
}

export function buildLessonExtractBody(sessionId, options = {}) {
  return buildStageModelRequestBody({
    sessionIds: [sessionId],
    missingOnly: true,
    retryFailed: true,
    force: false,
    timeoutMs: options.requestTimeoutMs ?? DEFAULT_LESSON_TIMEOUT_MS,
    chunkSize: 20,
    chunkConcurrency: 1,
    textLimit: 1200,
    saveLimit: 50,
  }, options, 'lesson');
}

export function summarizeChunkStatuses(chunks) {
  const counts = {};
  for (const chunk of chunks || []) {
    const status = typeof chunk?.status === 'string' ? chunk.status : 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

export function summaryPromptFields(summary) {
  return {
    title: summary?.title || '',
    narrative: summary?.narrative || '',
    keyDecisions: summary?.keyDecisions || summary?.decisions || [],
    filesModified: summary?.filesModified || summary?.files || [],
    concepts: summary?.concepts || [],
  };
}

export function estimateSingleSummaryPromptChars(summary) {
  const fields = summaryPromptFields(summary);
  return [
    `Title: ${fields.title}`,
    `Narrative: ${fields.narrative}`,
    `Decisions: ${fields.keyDecisions.join('; ')}`,
    `Files: ${fields.filesModified.join(', ')}`,
    `Concepts: ${fields.concepts.join(', ')}`,
  ].join('\n').length + 200;
}

export function estimateSummaryPromptChars(sessionItem) {
  const summary = sessionItem?.summary?.summary || sessionItem?.summary?.data || null;
  if (summary) return estimateSingleSummaryPromptChars(summary);
  return Number(sessionItem?.summary?.estimated_prompt_chars || 1200);
}

function omitSummaryContent(summaryState = {}) {
  return Object.fromEntries(
    Object.entries(summaryState || {}).filter(([key]) => !SUMMARY_CONTENT_KEYS.has(key)),
  );
}

function clearSummaryFailureMetadata(summaryState) {
  if (!summaryState || typeof summaryState !== 'object') return false;
  const changed = Object.hasOwn(summaryState, 'error')
    || Object.hasOwn(summaryState, 'failure_class')
    || Object.hasOwn(summaryState, 'failure_cause')
    || Object.hasOwn(summaryState, 'failure_diagnostics');
  delete summaryState.error;
  delete summaryState.failure_class;
  delete summaryState.failure_cause;
  delete summaryState.failure_diagnostics;
  return changed;
}

function summaryStateMetadata(summary, existing = {}) {
  const fields = summaryPromptFields(summary);
  return {
    summary_title: summary?.title || existing.summary_title || null,
    summary_hash: stableHash(fields),
    estimated_prompt_chars: estimateSingleSummaryPromptChars(summary),
  };
}

function isUsableSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
  const fields = summaryPromptFields(summary);
  return [fields.title, fields.narrative].some((value) => typeof value === 'string' && value.trim())
    || [fields.keyDecisions, fields.filesModified, fields.concepts]
      .some((values) => Array.isArray(values) && values.length > 0);
}

function summaryProgressMetadata(data = {}) {
  const metadata = {};
  for (const [sourceKey, stateKey] of [
    ['completedChunks', 'completed_chunks'],
    ['totalChunks', 'total_chunks'],
    ['skippedChunks', 'skipped_chunks'],
  ]) {
    const value = data?.[sourceKey];
    if (Number.isInteger(value) && value >= 0) metadata[stateKey] = value;
  }
  return metadata;
}

function summaryFailureCauseMetadata(data = {}) {
  const cause = typeof data?.failureCause === 'string' ? data.failureCause : '';
  return SUMMARY_FAILURE_CAUSES.has(cause) ? { failure_cause: cause } : {};
}

function summaryAdvanceCallLimit(totalChunks) {
  const total = Number.isInteger(totalChunks) && totalChunks >= 0 ? totalChunks : 0;
  return Math.min(
    SUMMARY_ADVANCE_MAX_CALL_LIMIT,
    Math.max(SUMMARY_ADVANCE_MIN_CALL_LIMIT, total + 10),
  );
}

function summaryDelayMs(state, options = {}) {
  return Math.max(0, Number(options.delayMs ?? state.config?.delay_ms ?? 1500));
}

function summarySessionPollDelayMs(state, options = {}) {
  return Math.min(summaryDelayMs(state, options), 500);
}

const EFFECTIVE_METADATA_STATE_KEYS = [
  'stage',
  'provider',
  'model',
  'model_source',
  'model_applied',
  'provider_model_override',
  'prompt_chars',
  'char_budget',
  'max_prompt_chars',
  'duration_ms',
  'parse_failures',
];

function nonEmptyString(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function firstString(value, keys) {
  for (const key of keys) {
    const found = nonEmptyString(value?.[key]);
    if (found) return found;
  }
  return null;
}

function firstNumber(value, keys) {
  for (const key of keys) {
    const found = value?.[key];
    if (Number.isFinite(found)) return found;
  }
  return null;
}

function responseStateMetadata(data, fallbackStage = '') {
  const metadata = {};
  const stage = firstString(data, ['stage']) || nonEmptyString(fallbackStage);
  const provider = firstString(data, ['provider', 'providerName', 'provider_name']);
  const providerModelOverride = firstString(data, ['providerModelOverride', 'provider_model_override']);
  const modelApplied =
    typeof data?.modelApplied === 'boolean'
      ? data.modelApplied
      : (typeof data?.model_applied === 'boolean' ? data.model_applied : null);
  if (stage) metadata.stage = stage;
  if (provider) metadata.provider = provider;
  if (modelApplied !== null) metadata.model_applied = modelApplied;
  if (providerModelOverride) metadata.provider_model_override = providerModelOverride;

  if (modelApplied !== false) {
    const model = firstString(data, ['model']);
    const modelSource = firstString(data, ['modelSource', 'model_source', 'source']);
    if (model) metadata.model = model;
    if (modelSource) metadata.model_source = modelSource;
  }

  const promptChars = firstNumber(data, ['promptChars', 'prompt_chars']);
  const charBudget = firstNumber(data, ['charBudget', 'char_budget']);
  const maxPromptChars = firstNumber(data, ['maxPromptChars', 'max_prompt_chars']);
  const durationMs = firstNumber(data, ['durationMs', 'duration_ms']);
  const parseFailures = firstNumber(data, ['parseFailures', 'parse_failures']);
  if (promptChars !== null) metadata.prompt_chars = promptChars;
  if (charBudget !== null) metadata.char_budget = charBudget;
  if (maxPromptChars !== null) metadata.max_prompt_chars = maxPromptChars;
  if (durationMs !== null) metadata.duration_ms = durationMs;
  if (parseFailures !== null) metadata.parse_failures = parseFailures;
  return metadata;
}

function applyResponseStateMetadata(target, data, fallbackStage = '') {
  for (const key of EFFECTIVE_METADATA_STATE_KEYS) delete target[key];
  if (fallbackStage === 'lesson') delete target.failure_diagnostics;
  const metadata = responseStateMetadata(data, fallbackStage);
  if (fallbackStage === 'lesson') {
    const diagnostics = sanitizeFailureDiagnostics(data?.failure_diagnostics ?? data?.failureDiagnostics);
    if (diagnostics) metadata.failure_diagnostics = diagnostics;
  }
  Object.assign(target, metadata);
  return target;
}

function lessonRunStateMetadata(detail) {
  const run = detail?.run || {};
  const metadata = responseStateMetadata({
    stage: 'lesson',
    provider: run.provider || run.providerName || run.provider_name,
    model: run.model || run.config?.model,
    modelSource: run.modelSource || run.model_source || run.config?.modelSource || run.config?.model_source,
    modelApplied: run.modelApplied ?? run.model_applied,
    providerModelOverride: run.providerModelOverride || run.provider_model_override,
    promptChars: run.promptChars ?? run.prompt_chars,
    parseFailures: run.parseFailures ?? run.parse_failures,
    durationMs: run.durationMs ?? run.duration_ms,
  }, 'lesson');
  const diagnostics = sanitizeFailureDiagnostics(run.failureDiagnostics ?? run.failure_diagnostics);
  return {
    ...metadata,
    ...(diagnostics ? { failure_diagnostics: diagnostics } : {}),
  };
}

export function planSemanticWindows(sessionIds, size) {
  const out = [];
  for (let i = 0; i < sessionIds.length; i += size) {
    const sourceSessionIds = sessionIds.slice(i, i + size);
    out.push({
      window_id: `w${String(out.length + 1).padStart(4, '0')}`,
      source_session_ids: sourceSessionIds,
      input_hash: stableHash(sourceSessionIds),
    });
  }
  return out;
}

export function planSemanticWindowsByCharBudget(sessionEntries, { maxSessionCount, charBudget }) {
  const windows = [];
  let current = [];
  let currentChars = 0;
  for (const [sessionId, estimatedChars] of sessionEntries) {
    const safeChars = Math.max(1, Number(estimatedChars || 1));
    const nextChars = currentChars + safeChars;
    if (current.length > 0 && (current.length >= maxSessionCount || nextChars > charBudget)) {
      windows.push(current);
      current = [];
      currentChars = 0;
    }
    current.push([sessionId, safeChars]);
    currentChars += safeChars;
  }
  if (current.length > 0) windows.push(current);
  return windows.map((items, index) => ({
    window_id: `w${String(index + 1).padStart(4, '0')}`,
    source_session_ids: items.map(([sessionId]) => sessionId),
    source_count: items.length,
    estimated_prompt_chars: items.reduce((sum, [, chars]) => sum + chars, 0),
    input_hash: stableHash(items.map(([sessionId]) => sessionId)),
  }));
}

export function buildSemanticRollupBody({ runId, mark, windowId, sessionIds }, options = {}) {
  return buildStageModelRequestBody(
    { runId, mark, windowId, kind: 'window', sessionIds },
    options,
    'semantic_rollup',
  );
}

function semanticWindowFromIds(state, windowId, sourceSessionIds, existing = {}) {
  return {
    ...existing,
    window_id: windowId,
    source_session_ids: sourceSessionIds,
    source_count: sourceSessionIds.length,
    estimated_prompt_chars: sourceSessionIds.reduce(
      (sum, sessionId) => sum + estimateSummaryPromptChars(state.sessions?.[sessionId]),
      0,
    ),
    input_hash: stableHash(sourceSessionIds),
  };
}

export function splitSemanticWindow(window) {
  if (!Array.isArray(window.source_session_ids) || window.source_session_ids.length <= 1) return [];
  const mid = Math.ceil(window.source_session_ids.length / 2);
  return [
    window.source_session_ids.slice(0, mid),
    window.source_session_ids.slice(mid),
  ].filter((ids) => ids.length > 0);
}

function isInputTooLargeResponse(response) {
  const data = response.data || {};
  const text = JSON.stringify(redactJson({
    error: response.error,
    code: data.code,
    reason: data.reason,
    dataError: data.error,
  }));
  return /input_too_large/i.test(text);
}

function isReachableSemanticLeaf(state, windowId, window) {
  if (!window || window.status === 'split') return false;
  if (!window.split_from) return true;
  return isValidSplitChildWindow(state, windowId, window);
}

function reachableSemanticLeafWindows(state) {
  return Object.entries(state.semantic_windows || {})
    .filter(([windowId, window]) => isReachableSemanticLeaf(state, windowId, window))
    .map(([, window]) => window);
}

export function countStatuses(items, selector) {
  const counts = { succeeded: 0, skipped: 0, failed: 0, pending: 0, running: 0, planned: 0, other: 0 };
  for (const item of items) {
    const status = selector(item) || 'pending';
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
    else counts.other += 1;
  }
  return counts;
}

export function sanitizeStateSchema(state) {
  migrateOrchestrationPolicy(state);
  state.sessions ??= {};
  state.semantic_windows ??= {};
  state.semantic_memory_char_sizes ??= {};
  for (const key of FULL_STAGE_CONTAINERS) state[key] ??= {};
  for (const { target } of orchestrationMigrationEntries(state)) {
    if (!target || typeof target !== 'object') continue;
    const diagnostics = sanitizeFailureDiagnostics(target.failure_diagnostics);
    if (diagnostics) target.failure_diagnostics = diagnostics;
    else delete target.failure_diagnostics;
  }
  for (const key of FORBIDDEN_STATE_KEYS) delete state[key];
  return state;
}

export function computeCoverage(state) {
  sanitizeStateSchema(state);
  const sessions = Object.values(state.sessions || {});
  const semanticWindows = Object.values(state.semantic_windows || {}).filter((item) => item.status !== 'split');
  const memoryConsolidateWindows = Object.values(state.memory_consolidate_windows || {}).filter((item) => item.status !== 'split');
  const summary = countStatuses(sessions, (item) => item.summary?.status);
  const lessons = countStatuses(sessions, (item) => item.lessons_extract?.status);
  const semantic = countStatuses(semanticWindows, (item) => item.status);
  const memoryConsolidate = countStatuses(memoryConsolidateWindows, (item) => item.status);
  const skillExtract = countStatuses(Object.values(state.skill_extract || {}), (item) => item.status);
  const crystalGroups = countStatuses(Object.values(state.crystal_groups || {}), (item) => item.status);
  const procedural = countStatuses(Object.values(state.consolidation_procedural_windows || {}), (item) => item.status);
  const reflectInsight = countStatuses(Object.values(state.reflect_insight_windows || {}), (item) => item.status);
  const unfinished = (counts) => counts.failed + counts.pending + counts.running + counts.planned + counts.other;
  const plannedUnitsComplete = [
    summary,
    lessons,
    memoryConsolidate,
    semantic,
    skillExtract,
    crystalGroups,
    procedural,
    reflectInsight,
  ].every((counts) => unfinished(counts) === 0 && counts.succeeded + counts.skipped > 0);
  return {
    enabled_stages: ENABLED_STAGES,
    sessions: { total: sessions.length },
    summary,
    lessons,
    memory_consolidate_windows: memoryConsolidate,
    semantic_windows: semantic,
    skill_extract: skillExtract,
    crystal_groups: crystalGroups,
    consolidation_procedural_windows: procedural,
    reflect_insight_windows: reflectInsight,
    acceptance_ready: sessions.length > 0 && plannedUnitsComplete,
  };
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

function numberStats(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

function countByValue(items, selector) {
  const counts = {};
  for (const item of items) {
    const value = selector(item);
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function stageMetricItems(state) {
  const sessions = Object.values(state.sessions || {});
  return {
    summary: sessions.map((item) => item.summary).filter(Boolean),
    lessons: sessions.map((item) => item.lessons_extract).filter(Boolean),
    memory_consolidate_windows: Object.values(state.memory_consolidate_windows || {}).filter((item) => item.status !== 'split'),
    semantic_windows: Object.values(state.semantic_windows || {}).filter((item) => item.status !== 'split'),
    skill_extract: Object.values(state.skill_extract || {}),
    crystal_groups: Object.values(state.crystal_groups || {}),
    consolidation_procedural_windows: Object.values(state.consolidation_procedural_windows || {}),
    reflect_insight_windows: Object.values(state.reflect_insight_windows || {}),
  };
}

export function computeStageMetrics(state) {
  sanitizeStateSchema(state);
  const metrics = {};
  for (const [stage, items] of Object.entries(stageMetricItems(state))) {
    const promptChars = numberStats(items.map((item) => item.prompt_chars));
    const charBudget = numberStats(items.map((item) => item.char_budget));
    const durationSeconds = numberStats(items.map((item) => (
      Number.isFinite(item.duration_ms) ? item.duration_ms / 1000 : null
    )));
    const parseFailures = items
      .map((item) => item.parse_failures)
      .filter((value) => Number.isFinite(value));
    metrics[stage] = {
      stage,
      window_count: items.length,
      status_counts: countStatuses(items, (item) => item.status),
      models: countByValue(items, (item) => item.model),
      prompt_chars: promptChars,
      char_budget: charBudget,
      duration_seconds: durationSeconds,
      parse_failures_total: parseFailures.reduce((sum, value) => sum + value, 0),
      parse_failure_units: parseFailures.filter((value) => value > 0).length,
    };
  }
  return metrics;
}

export function resetStaleRunningUnits(state, nowMs = Date.now(), staleAfterMs = 30 * 60 * 1000) {
  const resetOne = (unit) => {
    if (!unit || unit.status !== 'running') return false;
    const startedMs = Date.parse(unit.started_at || '');
    if (Number.isFinite(startedMs) && nowMs - startedMs < staleAfterMs) return false;
    unit.status = 'pending';
    unit.recovered_from_stale_running_at = new Date(nowMs).toISOString();
    return true;
  };
  let reset = 0;
  for (const item of Object.values(state.sessions || {})) {
    if (resetOne(item.summary)) reset += 1;
    if (resetOne(item.lessons_extract)) reset += 1;
  }
  for (const item of Object.values(state.semantic_windows || {})) {
    if (resetOne(item)) reset += 1;
  }
  for (const key of FULL_STAGE_CONTAINERS) {
    for (const item of Object.values(state[key] || {})) {
      if (resetOne(item)) reset += 1;
    }
  }
  return reset;
}

export function findSemanticWindowDrifts(state, plannedWindows) {
  const plannedById = new Map(plannedWindows.map((window) => [window.window_id, window]));
  const drifts = [];
  for (const [windowId, existing] of Object.entries(state.semantic_windows || {})) {
    if (!existing || existing.status === 'planned') continue;
    const expected = plannedById.get(windowId);
    if (!expected) {
      if (isValidSplitChildWindow(state, windowId, existing)) continue;
      drifts.push({ window_id: windowId, reason: 'window no longer planned' });
      continue;
    }
    const sourceHash = stableHash(existing.source_session_ids || []);
    if (existing.input_hash && existing.input_hash !== expected.input_hash) {
      drifts.push({ window_id: windowId, reason: 'input_hash drift' });
    } else if (sourceHash !== expected.input_hash) {
      drifts.push({ window_id: windowId, reason: 'source_session_ids drift' });
    }
  }
  return drifts;
}

function isValidSplitChildWindow(state, windowId, child) {
  if (!child?.split_from || child.split_from === windowId) return false;
  const parent = state.semantic_windows?.[child.split_from];
  if (!parent || parent.status !== 'split') return false;
  if (!Array.isArray(parent.split_into) || !parent.split_into.includes(windowId)) return false;
  if (!Array.isArray(child.source_session_ids) || child.source_session_ids.length === 0) return false;
  return child.input_hash === stableHash(child.source_session_ids);
}

export function resetDriftedSemanticUnits(state, plannedWindows, drifts) {
  const plannedById = new Map(plannedWindows.map((window) => [window.window_id, window]));
  for (const drift of drifts) {
    deleteSemanticSplitDescendants(state, drift.window_id);
    const planned = plannedById.get(drift.window_id);
    if (planned) {
      state.semantic_windows[drift.window_id] = {
        ...planned,
        status: 'pending',
        reset_reason: drift.reason,
        reset_at: new Date().toISOString(),
      };
    } else {
      delete state.semantic_windows[drift.window_id];
    }
  }
  state.crystal_groups = {};
  state.consolidation_procedural_windows = {};
  state.reflect_insight_windows = {};
}

export function reconcileSemanticWindowsAfterSummary(state, plannedWindows, options = {}) {
  const drifts = findSemanticWindowDrifts(state, plannedWindows);
  const unsafeDrifts = drifts.filter(({ window_id: windowId }) => {
    const status = state.semantic_windows?.[windowId]?.status;
    return !['pending', 'planned', 'failed'].includes(status);
  });
  if (unsafeDrifts.length > 0 && !options.resetDriftedUnits) {
    throw new Error(`completed semantic window input_hash drift detected: ${unsafeDrifts.map((item) => item.window_id).join(', ')}`);
  }
  if (drifts.length > 0) resetDriftedSemanticUnits(state, plannedWindows, drifts);
  for (const planned of plannedWindows) {
    state.semantic_windows[planned.window_id] ??= {
      ...planned,
      status: 'pending',
    };
  }
  return drifts;
}

function deleteSemanticSplitDescendants(state, windowId) {
  const window = state.semantic_windows?.[windowId];
  for (const childId of window?.split_into || []) {
    deleteSemanticSplitDescendants(state, childId);
    delete state.semantic_windows[childId];
  }
}

export function validateResumeState(state, options, currentSessions, plannedWindows = null) {
  sanitizeStateSchema(state);
  if (state.schema_version !== SCHEMA_VERSION) throw new Error('unsupported state schema_version');
  const expectedConfig = buildConfigFromOptions(options);
  const expectedConfigHash = stableHash(expectedConfig);
  if (state.config_hash && state.config_hash !== expectedConfigHash) {
    if (!options.resetDriftedUnits) {
      throw new Error('resume config drift detected; start a new run or pass --reset-drifted-units after reviewing state');
    }
    state.config = expectedConfig;
    state.config_hash = expectedConfigHash;
    state.semantic_windows = {};
    for (const key of FULL_STAGE_CONTAINERS) state[key] = {};
  }
  const currentInventoryHash = computeInventoryHash(currentSessions, options.agentId);
  if (state.inventory_hash && state.inventory_hash !== currentInventoryHash) {
    if (!options.resetDriftedUnits) {
      throw new Error('resume inventory drift detected; start a new run or pass --reset-drifted-units after reviewing state');
    }
    state.inventory_hash = currentInventoryHash;
    state.sessions = {};
    state.semantic_windows = {};
    for (const key of FULL_STAGE_CONTAINERS) state[key] = {};
  }
  if (plannedWindows) {
    const drifts = findSemanticWindowDrifts(state, plannedWindows);
    if (drifts.length > 0) {
      if (!options.resetDriftedUnits) {
        throw new Error(`resume semantic window input_hash drift detected: ${drifts.map((item) => item.window_id).join(', ')}`);
      }
      resetDriftedSemanticUnits(state, plannedWindows, drifts);
    }
  }
}

export function findPlannedContainerDrifts(state, containerKey, plannedUnits) {
  const plannedById = new Map(plannedUnits.map((unit) => [unit.unit_id, unit]));
  const drifts = [];
  for (const [unitId, existing] of Object.entries(state[containerKey] || {})) {
    if (!existing || existing.status === 'planned') continue;
    const expected = plannedById.get(unitId);
    if (!expected) {
      if (unitId === 'none' && existing.status === 'skipped' && plannedUnits.length > 0) continue;
      if (isValidSplitChildUnit(state, containerKey, unitId, existing)) continue;
      drifts.push({ unit_id: unitId, reason: 'unit no longer planned' });
      continue;
    }
    if (existing.input_hash && existing.input_hash !== expected.input_hash) {
      drifts.push({ unit_id: unitId, reason: 'input_hash drift' });
    }
  }
  return drifts;
}

export function validatePlannedContainerResume(state, options, containerKey, plannedUnits) {
  const drifts = findPlannedContainerDrifts(state, containerKey, plannedUnits);
  if (drifts.length === 0) return;
  if (!options.resetDriftedUnits) {
    throw new Error(`resume ${containerKey} input_hash drift detected: ${drifts.map((item) => item.unit_id).join(', ')}`);
  }
  const plannedById = new Map(plannedUnits.map((unit) => [unit.unit_id, unit]));
  for (const drift of drifts) {
    const planned = plannedById.get(drift.unit_id);
    if (planned) {
      state[containerKey][drift.unit_id] = {
        ...planned,
        status: 'pending',
        reset_reason: drift.reason,
        reset_at: new Date().toISOString(),
      };
    } else {
      delete state[containerKey][drift.unit_id];
    }
  }
}

export function enqueueStateWrite(statePath, write) {
  const previous = stateWriteTails.get(statePath) || Promise.resolve();
  const current = previous.catch(() => {}).then(write);
  stateWriteTails.set(statePath, current);
  return current.finally(() => {
    if (stateWriteTails.get(statePath) === current) stateWriteTails.delete(statePath);
  });
}

export async function writeStateAtomically(filePath, state, options = {}) {
  return enqueueStateWrite(filePath, async () => {
    const fsApi = options.fsApi || fs;
    const sleepFn = options.sleepFn || sleep;
    const tempPath = `${filePath}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    await fsApi.mkdir(path.dirname(filePath), { recursive: true });
    await fsApi.writeFile(tempPath, `${JSON.stringify(redactJson(state), null, 2)}\n`, 'utf8');

    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsApi.rename(tempPath, filePath);
        return;
      } catch (error) {
        if (!RETRYABLE_STATE_RENAME_CODES.has(error?.code)) throw error;
        if (attempt >= STATE_RENAME_RETRY_DELAYS_MS.length) {
          const detail = compactStateError(error?.message || error, 'Windows rename sharing violation');
          throw new Error(`状态文件原子替换失败：Windows rename 重试耗尽；已保留完整临时状态文件；${detail}`);
        }
        await sleepFn(STATE_RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  });
}

function isLocalPidAbsent(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function lockMetadata(owner) {
  return {
    run_id: owner.runId,
    pid: owner.pid,
    created_at: owner.createdAt,
    owner_id: owner.ownerId,
  };
}

function isLockOwner(metadata, owner) {
  return metadata?.run_id === owner.runId
    && metadata?.pid === owner.pid
    && metadata?.created_at === owner.createdAt
    && metadata?.owner_id === owner.ownerId;
}

function parseStateLock(raw) {
  try {
    const metadata = JSON.parse(raw);
    if (!metadata || typeof metadata !== 'object') return null;
    return metadata;
  } catch {
    return null;
  }
}

async function assertNoDeploymentLock(deploymentLockPath, fsApi) {
  try {
    await fsApi.access(deploymentLockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('deployment_in_progress: AgentMemory 正在部署，拒绝启动 full extraction runner');
}

export async function acquireStateLock({
  statePath,
  runId,
  fsApi = fs,
  deploymentLockPath,
}) {
  const stateDirectory = path.dirname(path.resolve(statePath));
  const runtimeRoot = path.basename(stateDirectory).toLowerCase() === 'extraction-runs'
    ? path.dirname(stateDirectory)
    : stateDirectory;
  const effectiveDeploymentLockPath = deploymentLockPath
    || process.env.AGENTMEMORY_DEPLOYMENT_LOCK
    || path.join(runtimeRoot, 'tmp', 'deploy-current.lock.json');
  const lockPath = `${statePath}.lock`;
  const owner = {
    lockPath,
    runId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerId: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  };
  await assertNoDeploymentLock(effectiveDeploymentLockPath, fsApi);
  await fsApi.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fsApi.open(lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(lockMetadata(owner))}\n`, 'utf8');
      } catch (error) {
        await fsApi.unlink(lockPath).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
      try {
        await assertNoDeploymentLock(effectiveDeploymentLockPath, fsApi);
      } catch (error) {
        await releaseStateLock(owner, fsApi);
        throw error;
      }
      return owner;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const raw = await fsApi.readFile(lockPath, 'utf8').catch((readError) => {
        if (readError?.code === 'ENOENT') return null;
        throw readError;
      });
      if (raw === null) continue;
      const existing = parseStateLock(raw);
      if (!existing || !isLocalPidAbsent(existing.pid)) {
        throw new Error('已有活跃 runner 持有该 run_id/statePath 的状态锁');
      }
      const confirmedRaw = await fsApi.readFile(lockPath, 'utf8').catch((readError) => {
        if (readError?.code === 'ENOENT') return null;
        throw readError;
      });
      if (confirmedRaw === null || confirmedRaw !== raw) continue;
      await fsApi.unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      });
    }
  }
  throw new Error('无法获取 run_id/statePath 的状态锁');
}

export async function releaseStateLock(owner, fsApi = fs) {
  if (!owner?.lockPath) return false;
  const raw = await fsApi.readFile(owner.lockPath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return false;
  const existing = parseStateLock(raw);
  if (!isLockOwner(existing, owner)) return false;
  await fsApi.unlink(owner.lockPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  return true;
}

export function sleep(ms, options = {}) {
  const signal = options.signal;
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(cancellationError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function upsertSessionsIntoState(state, sessions) {
  const seen = new Set();
  for (const session of normalizeSessions(sessions)) {
    seen.add(session.id);
    const existing = state.sessions[session.id] || {};
    const hasSummary = Boolean(session.summary);
    state.sessions[session.id] = {
      session_id: session.id,
      project: session.project || existing.project || null,
      started_at: session.startedAt || existing.started_at || null,
      completed_at: session.completedAt || session.completed_at || session.endedAt || existing.completed_at || null,
      session_status: session.status || existing.session_status || null,
      agent_id: session.agentId || existing.agent_id || null,
      ...existing,
      summary: {
        status: hasSummary ? 'succeeded' : (existing.summary?.status || 'pending'),
        attempt_count: existing.summary?.attempt_count || 0,
        ...omitSummaryContent(existing.summary || {}),
        ...(hasSummary ? {
          status: 'succeeded',
          ...summaryStateMetadata(session.summary, existing.summary || {}),
          verified_at: existing.summary?.verified_at || new Date().toISOString(),
        } : {}),
      },
      lessons_extract: existing.lessons_extract || { status: 'pending', attempt_count: 0 },
    };
    if (hasSummary) clearSummaryFailureMetadata(state.sessions[session.id].summary);
  }
  return seen;
}

async function recordExtractionRun({ state, baseUrl, secret, payload, options = {} }) {
  const response = await requestJson(baseUrl, secret, 'POST', '/agentmemory/extraction-runs/record', {
    runId: state.run_id,
    mark: state.mark,
    ...payload,
  }, requestOptions(options));
  if (!response.ok) throw new Error(response.error || 'extraction run index record failed');
  return response;
}

async function recordStageResult({ state, baseUrl, secret, stage, unitId, sourceIds = [], resultIds = [], resultType, status, options = {} }) {
  return recordExtractionRun({
    state,
    baseUrl,
    secret,
    options,
    payload: {
      stage,
      unitId,
      sourceIds,
      resultIds,
      resultType,
      status,
    },
  });
}

function stageOutcome(status, options = {}) {
  return {
    status,
    failure: options.failure || null,
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'failure')),
  };
}

function clearTerminalRetryMetadata(target) {
  for (const key of [
    'error',
    'failure_cause',
    'failure_class',
    'failure_diagnostics',
    'last_failure_cause',
    'next_retry_at',
    'retry_count',
    'record_error',
  ]) delete target[key];
}

export async function persistTerminalThenRecord({
  state,
  statePath,
  target,
  terminalState,
  record,
  writeState = writeStateAtomically,
}) {
  Object.assign(target, terminalState);
  if (target.status === 'failed') {
    for (const key of ['last_failure_cause', 'next_retry_at', 'retry_count', 'record_error']) delete target[key];
  } else {
    clearTerminalRetryMetadata(target);
  }
  target.record_pending = true;
  delete target.recorded_at;
  await writeState(statePath, state);
  try {
    await record();
  } catch (error) {
    target.record_pending = true;
    target.record_error = compactStateError(error?.message || error, 'record failed');
    await writeState(statePath, state);
    return stageOutcome('failed', {
      business_status: target.status,
      record_pending: true,
      failure: { class: 'transient_runtime', cause: 'record_failed' },
    });
  }
  target.recorded_at = new Date().toISOString();
  delete target.record_pending;
  delete target.record_error;
  await writeState(statePath, state);
  return stageOutcome(target.status);
}

async function pollSummaryFromSessions({
  state,
  baseUrl,
  secret,
  sessionId,
  options,
  expectedObservationCount,
}) {
  if (
    expectedObservationCount !== undefined
    && (!Number.isSafeInteger(expectedObservationCount) || expectedObservationCount < 0)
  ) {
    return null;
  }
  const delayMs = summarySessionPollDelayMs(state, options);
  for (let attempt = 1; attempt <= SUMMARY_SESSION_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 1 && delayMs > 0) await sleep(delayMs);
    try {
      const sessions = await loadSessions(
        baseUrl,
        secret,
        state.config?.agent_id || '*',
        options,
      );
      const session = sessions.find((entry) => entry.id === sessionId);
      const summary = session?.summary;
      if (
        expectedObservationCount !== undefined
        && (
          session?.observationCount !== expectedObservationCount
          || summary?.observationCount !== expectedObservationCount
        )
      ) {
        continue;
      }
      if (isUsableSummary(summary)) return summary;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // A short visibility poll may race the session view; retry within the fixed budget.
    }
  }
  return null;
}

export async function runSummaryForSession({ state, statePath, baseUrl, secret, sessionId, options = {} }) {
  const writeState = options.writeState || writeStateAtomically;
  const item = state.sessions[sessionId];
  if (!item) return stageOutcome('skipped');
  if (!summaryNeedsWork(item)) {
    const failureMetadataCleared = clearSummaryFailureMetadata(item.summary);
    if (item.summary.record_pending || !item.summary.recorded_at) {
      return persistTerminalThenRecord({
        state,
        statePath,
        target: item.summary,
        terminalState: { ...item.summary },
        record: () => recordExtractionRun({
          state,
          baseUrl,
          secret,
          payload: { summarySessionId: sessionId },
          options,
        }),
        writeState,
      });
    } else if (failureMetadataCleared) {
      await writeState(statePath, state);
    }
    return stageOutcome(item.summary.status === 'skipped' ? 'skipped' : 'succeeded');
  }
  const now = new Date().toISOString();
  item.summary = {
    ...omitSummaryContent(item.summary || {}),
    status: 'running',
    started_at: item.summary?.started_at || now,
    attempt_count: (item.summary?.attempt_count || 0) + 1,
  };
  await writeState(statePath, state);

  const failSummary = async (error, data, response) => {
    const failure = classifyStageResponse({ ...response, data });
    item.summary = applyResponseStateMetadata({
      ...omitSummaryContent(item.summary),
      status: 'failed',
      completed_at: new Date().toISOString(),
      ...summaryProgressMetadata(data),
      error: compactStateError(error, 'resumable summarize failed'),
    }, data, 'summary');
    applyFailureState(item.summary, failure);
    await writeState(statePath, state);
    return stageOutcome('failed', { failure });
  };
  const response = await requestJson(
    baseUrl,
    secret,
    'POST',
    SUMMARY_RESUMABLE_PATH,
    buildSummaryBody(sessionId, options),
    requestOptions(options),
  );
  const data = response.data || {};
  const progress = summaryProgressMetadata(data);

  if (!response.ok || data.status === 'failed' || data.status === 'infeasible' || data.status === 'preflight_unavailable') {
    return failSummary(response.error || data.error, data, response);
  }
  if (data.status === 'succeeded') {
    const summary = isUsableSummary(data.summary)
      ? data.summary
      : await pollSummaryFromSessions({ state, baseUrl, secret, sessionId, options });
    if (!summary) {
      return failSummary(
        `resumable summarize succeeded but no usable summary was visible after ${SUMMARY_SESSION_POLL_ATTEMPTS} /agentmemory/sessions polls`,
        data,
        { ...response, status_code: 200 },
      );
    }
    item.summary = applyResponseStateMetadata({
      ...omitSummaryContent(item.summary),
      status: 'succeeded',
      completed_at: new Date().toISOString(),
      verified_at: new Date().toISOString(),
      ...progress,
      ...summaryStateMetadata(summary, item.summary || {}),
    }, data, 'summary');
    clearSummaryFailureMetadata(item.summary);
    return persistTerminalThenRecord({
      state,
      statePath,
      target: item.summary,
      terminalState: { ...item.summary },
      record: () => recordExtractionRun({
        state,
        baseUrl,
        secret,
        payload: { summarySessionId: sessionId },
        options,
      }),
      writeState,
    });
  }
  if (data.status !== 'in_progress' || !['completed', 'skipped', 'none'].includes(data.advanced)) {
    return failSummary(`invalid resumable summarize status: ${String(data.status || '<missing>')}`, data, {
      ...response,
      status_code: 200,
    });
  }

  const stepFailure = data.advanced === 'none'
    ? { class: 'transient_runtime', cause: 'summary_no_progress' }
    : (data.advanced === 'skipped'
      ? classifyStageResponse({ ...response, data })
      : null);

  item.summary = applyResponseStateMetadata({
    ...omitSummaryContent(item.summary),
    status: 'pending',
    service_status: 'in_progress',
    advanced: data.advanced,
    ...progress,
    last_progress_at: new Date().toISOString(),
    ...(stepFailure ? failureStateMetadata(stepFailure) : {}),
  }, data, 'summary');
  if (stepFailure) applyFailureState(item.summary, stepFailure);
  else clearSummaryFailureMetadata(item.summary);
  await writeState(statePath, state);
  return stageOutcome('in_progress', {
    failure: stepFailure,
    advanced: data.advanced,
    progress,
  });
}

export async function getLatestLessonRun(baseUrl, secret, sessionId, options = {}) {
  const response = await requestJson(
    baseUrl,
    secret,
    'GET',
    `/agentmemory/lessons/extract/runs?sessionId=${encodeURIComponent(sessionId)}&limit=1`,
    undefined,
    requestOptions(options),
  );
  if (!response.ok) throw new Error(response.error || '读取 lesson runs 失败');
  return response.data?.runs?.[0] || null;
}

export async function getLessonRunDetail(baseUrl, secret, runId, options = {}) {
  const response = await requestJson(
    baseUrl,
    secret,
    'GET',
    `/agentmemory/lessons/extract/run?runId=${encodeURIComponent(runId)}`,
    undefined,
    requestOptions(options),
  );
  if (!response.ok) throw new Error(response.error || '读取 lesson run 详情失败');
  return response.data;
}

export async function processLessonRuns(baseUrl, secret, limit = 1, options = {}) {
  return requestJson(baseUrl, secret, 'POST', '/agentmemory/lessons/extract/process', { limit }, requestOptions(options));
}

export function isRunFreshForAttempt(run, attemptStartedAt, previousRunId) {
  if (!run?.id) return false;
  if (previousRunId && run.id === previousRunId) return false;
  const attemptMs = Date.parse(attemptStartedAt || '');
  if (!Number.isFinite(attemptMs)) return false;
  const runMs = [
    run.createdAt,
    run.created_at,
    run.startedAt,
    run.started_at,
  ]
    .map((value) => Date.parse(value || ''))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  if (!Number.isFinite(runMs)) return false;
  return runMs + RUN_FRESHNESS_CLOCK_SKEW_MS >= attemptMs;
}

export async function applyLessonRunDetail({ state, statePath, baseUrl, secret, item, runId, detail, options = {} }) {
  const status = detail?.run?.status || 'unknown';
  const terminal = terminalLessonStatus(status);
  item.lessons_extract = applyResponseStateMetadata({
    ...item.lessons_extract,
    status: terminal ? status : 'running',
    terminal_status: status,
    run_id: runId,
    chunk_status_counts: summarizeChunkStatuses(detail?.chunks || []),
    ...(terminal ? {
      completed_at: new Date().toISOString(),
      verified_at: new Date().toISOString(),
    } : {}),
  }, lessonRunStateMetadata(detail), 'lesson');
  if (terminal) {
    const outcome = await persistTerminalThenRecord({
      state,
      statePath,
      target: item.lessons_extract,
      terminalState: { ...item.lessons_extract },
      record: () => recordExtractionRun({
        state,
        baseUrl,
        secret,
        payload: { lessonRunId: runId },
        options,
      }),
    });
    return {
      terminal,
      status,
      outcome: outcome.failure || status !== 'failed'
        ? outcome
        : stageOutcome('failed', { failure: { class: 'unit', cause: 'lesson_run_failed' } }),
    };
  }
  await writeStateAtomically(statePath, state);
  return { terminal, status };
}

function lessonRunLastError(detail) {
  return String(detail?.run?.lastError || detail?.run?.last_error || '').trim();
}

export function classifyRetryableLessonRun(detail) {
  if (detail?.run?.status !== 'retryable') return null;
  const run = detail.run;
  const hasDiagnostics = Object.hasOwn(run, 'failureDiagnostics')
    || Object.hasOwn(run, 'failure_diagnostics');
  if (hasDiagnostics) {
    const diagnostics = sanitizeFailureDiagnostics(
      run.failureDiagnostics ?? run.failure_diagnostics,
    );
    if (!diagnostics) return null;
    if (diagnostics.parseErrorCode) {
      return {
        class: 'unit',
        cause: diagnostics.parseErrorCode,
        diagnostics,
      };
    }
    return {
      class: providerFailureClass(diagnostics.providerErrorCode) || 'unit',
      cause: diagnostics.providerErrorCode,
      diagnostics,
    };
  }
  const lastError = lessonRunLastError(detail);
  for (const cause of LESSON_UNIT_FAILURE_CAUSES) {
    if (lastError.includes(cause)) return { class: 'unit', cause };
  }
  for (const cause of HARD_FAILURE_CAUSES) {
    if (lastError.includes(cause)) return { class: 'hard', cause };
  }
  for (const cause of PROVIDER_FAILURE_CAUSES) {
    if (lastError.includes(cause)) return { class: 'transient_provider', cause };
  }
  for (const cause of UNIT_PROVIDER_CODES) {
    if (lastError.includes(cause)) return { class: 'unit', cause };
  }
  return null;
}

function skippableRetryableLessonRun(detail) {
  const status = detail?.run?.status || 'unknown';
  if (status !== 'retryable') return false;
  return /No <lesson> blocks/i.test(lessonRunLastError(detail));
}

export async function waitForLessonRunTerminal({ state, statePath, baseUrl, secret, item, runId, maxPolls = 6, options = {} }) {
  let lastDetail = null;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const detail = await getLessonRunDetail(baseUrl, secret, runId, options);
    lastDetail = detail;
    const applied = await applyLessonRunDetail({ state, statePath, baseUrl, secret, item, runId, detail, options });
    if (applied.terminal) return applied;
    const retryableFailure = classifyRetryableLessonRun(detail);
    if (retryableFailure) {
      item.lessons_extract = applyResponseStateMetadata({
        ...item.lessons_extract,
        status: 'failed',
        terminal_status: detail.run.status,
        run_id: runId,
        chunk_status_counts: summarizeChunkStatuses(detail?.chunks || []),
        completed_at: new Date().toISOString(),
        verified_at: new Date().toISOString(),
        error: retryableFailure.cause,
        failure_class: retryableFailure.class,
        failure_cause: retryableFailure.cause,
      }, lessonRunStateMetadata(detail), 'lesson');
      await writeStateAtomically(statePath, state);
      return { terminal: false, status: 'failed', failure: retryableFailure };
    }
    await processLessonRuns(baseUrl, secret, 1, options);
  }
  if (skippableRetryableLessonRun(lastDetail)) {
    item.lessons_extract = applyResponseStateMetadata({
      ...item.lessons_extract,
      status: 'skipped',
      terminal_status: lastDetail.run.status,
      run_id: runId,
      chunk_status_counts: summarizeChunkStatuses(lastDetail?.chunks || []),
      completed_at: new Date().toISOString(),
      verified_at: new Date().toISOString(),
      skipped_reason: lessonRunLastError(lastDetail),
    }, lessonRunStateMetadata(lastDetail), 'lesson');
    const outcome = await persistTerminalThenRecord({
      state,
      statePath,
      target: item.lessons_extract,
      terminalState: { ...item.lessons_extract },
      record: () => recordExtractionRun({
        state,
        baseUrl,
        secret,
        payload: { lessonRunId: runId },
        options,
      }),
    });
    return { terminal: true, status: 'skipped', outcome };
  }
  item.lessons_extract = {
    ...item.lessons_extract,
    status: 'failed',
    completed_at: new Date().toISOString(),
    error: 'lesson run did not reach terminal status after polling',
    failure_class: 'unit',
    failure_cause: 'lesson_terminal_poll_exhausted',
  };
  await writeStateAtomically(statePath, state);
  return {
    terminal: false,
    status: 'failed',
    failure: { class: 'unit', cause: 'lesson_terminal_poll_exhausted' },
  };
}

export async function reconcileLatestLessonRun({
  state,
  statePath,
  baseUrl,
  secret,
  item,
  sessionId,
  attemptStartedAt,
  previousRunId,
  options = {},
}) {
  try {
    const latest = await getLatestLessonRun(baseUrl, secret, sessionId, options);
    const latestSessionId = latest?.sessionId || latest?.session_id || null;
    if (!latest?.id || (latestSessionId && latestSessionId !== sessionId)) return null;
    if (!isRunFreshForAttempt(latest, attemptStartedAt, previousRunId)) return null;
    return waitForLessonRunTerminal({ state, statePath, baseUrl, secret, item, runId: latest.id, options });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return {
      terminal: false,
      status: 'failed',
      error: compactStateError(error?.message, 'lesson run reconciliation failed'),
    };
  }
}

export async function runLessonsForSession({ state, statePath, baseUrl, secret, sessionId, options = {} }) {
  const item = state.sessions[sessionId];
  if (!item) return stageOutcome('skipped');
  if (skippableLessonStatus(item.lessons_extract?.status)) {
    if (item.lessons_extract.run_id && (item.lessons_extract.record_pending || !item.lessons_extract.recorded_at)) {
      return persistTerminalThenRecord({
        state,
        statePath,
        target: item.lessons_extract,
        terminalState: { ...item.lessons_extract },
        record: () => recordExtractionRun({
          state,
          baseUrl,
          secret,
          payload: { lessonRunId: item.lessons_extract.run_id },
          options,
        }),
      });
    }
    return stageOutcome(item.lessons_extract.status);
  }
  if (item.lessons_extract?.run_id && item.lessons_extract?.status === 'running') {
    const applied = await waitForLessonRunTerminal({
      state,
      statePath,
      baseUrl,
      secret,
      item,
      runId: item.lessons_extract.run_id,
      options,
    });
    if (applied.terminal) return applied.outcome || stageOutcome(applied.status);
    if (applied.failure) return stageOutcome('failed', { failure: applied.failure });
  }
  const attemptStartedAt = new Date().toISOString();
  const previousRunId = item.lessons_extract?.run_id || null;
  item.lessons_extract = {
    ...(item.lessons_extract || {}),
    status: 'running',
    attempt_count: (item.lessons_extract?.attempt_count || 0) + 1,
    started_at: item.lessons_extract?.started_at || attemptStartedAt,
  };
  await writeStateAtomically(statePath, state);

  const response = await requestJson(
    baseUrl,
    secret,
    'POST',
    '/agentmemory/lessons/extract',
    buildLessonExtractBody(sessionId, options),
    requestOptions(options),
  );
  if (!response.ok) {
    const reconciled = await reconcileLatestLessonRun({
      state,
      statePath,
      baseUrl,
      secret,
      item,
      sessionId,
      attemptStartedAt,
      previousRunId,
      options,
    });
    if (reconciled?.terminal) {
      return reconciled.outcome || stageOutcome(reconciled.status);
    }
    if (reconciled) {
      item.lessons_extract = {
        ...item.lessons_extract,
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: compactStateError(reconciled.error, 'lesson run reconciliation failed'),
      };
      await writeStateAtomically(statePath, state);
      return stageOutcome('failed', { failure: { class: 'transient_runtime', cause: 'lesson_reconciliation_failed' } });
    }
    item.lessons_extract = {
      ...item.lessons_extract,
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: compactStateError(
        `${response.error || 'lessons extract failed'}; lesson extract HTTP failed and no fresh server run was reconciled`,
        'lessons extract failed',
      ),
    };
    await writeStateAtomically(statePath, state);
    return stageOutcome('failed', { failure: classifyStageResponse(response) });
  }

  const run = response.data?.runs?.[0] || null;
  if (!run?.id) {
    item.lessons_extract = {
      ...item.lessons_extract,
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: 'lessons extract returned no run id',
    };
    await writeStateAtomically(statePath, state);
    return stageOutcome('failed', { failure: { class: 'unit', cause: 'lesson_run_id_missing' } });
  }

  const applied = await waitForLessonRunTerminal({
    state,
    statePath,
    baseUrl,
    secret,
    item,
    runId: run.id,
    options,
  });
  return applied.terminal
    ? (applied.outcome || stageOutcome(applied.status))
    : stageOutcome('failed', {
        failure: applied.failure || { class: 'unit', cause: 'lesson_terminal_poll_exhausted' },
      });
}

export async function runSemanticWindow({ state, statePath, baseUrl, secret, window, options = {} }) {
  const existing = state.semantic_windows[window.window_id];
  const writeState = options.writeState || writeStateAtomically;
  const recordSemantic = (status, resultIds = []) => status === 'succeeded'
    ? recordExtractionRun({
      state,
      baseUrl,
      secret,
      payload: { semanticWindowId: window.window_id },
      options,
    })
    : recordStageResult({
      state,
      baseUrl,
      secret,
      stage: 'semantic_rollup',
      unitId: window.window_id,
      sourceIds: window.source_session_ids || [],
      resultIds,
      resultType: 'semantic',
      status,
      options,
    });
  if (existing?.status === 'succeeded' || existing?.status === 'skipped') {
    if (existing.record_pending) {
      return persistTerminalThenRecord({
        state,
        statePath,
        target: existing,
        terminalState: { ...existing },
        record: () => recordSemantic(existing.status, existing.semantic_memory_ids || []),
        writeState,
      });
    }
    return stageOutcome(existing.status);
  }
  state.semantic_windows[window.window_id] = {
    ...window,
    status: 'running',
    started_at: existing?.started_at || new Date().toISOString(),
    attempt_count: (existing?.attempt_count || 0) + 1,
  };
  await writeState(statePath, state);

  const response = await requestJson(
    baseUrl,
    secret,
    'POST',
    '/agentmemory/semantic-rollup',
    buildFormalOperationBody(
      buildSemanticRollupBody({
        runId: state.run_id,
        mark: state.mark,
        windowId: window.window_id,
        sessionIds: window.source_session_ids,
      }, options),
      {
        state,
        stage: 'semantic_rollup',
        unitId: window.window_id,
        inputHash: window.input_hash,
      },
    ),
    requestOptions(options),
  );
  if (!response.ok) {
    const splitSources = isInputTooLargeResponse(response) ? splitSemanticWindow(window) : [];
    if (splitSources.length > 0) {
      const splitIds = splitSources.map((ids, index) => `${window.window_id}${String.fromCharCode(97 + index)}`);
      for (let i = 0; i < splitSources.length; i += 1) {
        const childId = splitIds[i];
        const existingChild = state.semantic_windows[childId] || {};
        const nextChild = semanticWindowFromIds(
          state,
          childId,
          splitSources[i],
          existingChild.input_hash === stableHash(splitSources[i]) ? existingChild : {},
        );
        state.semantic_windows[childId] = {
          ...nextChild,
          status: nextChild.status || 'pending',
          split_from: window.window_id,
        };
      }
      state.semantic_windows[window.window_id] = applyResponseStateMetadata({
        ...state.semantic_windows[window.window_id],
        status: 'split',
        completed_at: new Date().toISOString(),
        error: 'input_too_large',
        prompt_chars: response.data?.promptChars || response.data?.prompt_chars || null,
        max_prompt_chars: response.data?.maxPromptChars || response.data?.max_prompt_chars || null,
        split_into: splitIds,
      }, response.data, 'semantic_rollup');
      await writeState(statePath, state);
      return stageOutcome('retry_planned');
    }
    state.semantic_windows[window.window_id] = applyResponseStateMetadata({
      ...state.semantic_windows[window.window_id],
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: compactStateError(response.error || response.data?.error, 'semantic rollup failed'),
      prompt_chars: response.data?.promptChars || response.data?.prompt_chars || null,
      max_prompt_chars: response.data?.maxPromptChars || response.data?.max_prompt_chars || null,
    }, response.data, 'semantic_rollup');
    const failure = classifyStageResponse(response);
    applyFailureState(state.semantic_windows[window.window_id], failure);
    await writeState(statePath, state);
    return stageOutcome('failed', { failure });
  }

  const semanticMemoryIds = response.data?.semanticMemoryIds || [];
  state.semantic_windows[window.window_id] = applyResponseStateMetadata({
    ...state.semantic_windows[window.window_id],
    status: response.data?.skipped ? 'skipped' : 'succeeded',
    semantic_memory_ids: semanticMemoryIds,
    semantic_memory_char_sizes: response.data?.semanticMemoryCharSizes || {},
    input_hash: window.input_hash,
    semantic_rollup_input_hash: response.data?.inputHash || null,
    completed_at: new Date().toISOString(),
    verified_at: new Date().toISOString(),
    ...(response.data?.reason ? { skipped_reason: response.data.reason } : {}),
  }, response.data, 'semantic_rollup');
  Object.assign(state.semantic_memory_char_sizes, response.data?.semanticMemoryCharSizes || {});
  const status = state.semantic_windows[window.window_id].status;
  return persistTerminalThenRecord({
    state,
    statePath,
    target: state.semantic_windows[window.window_id],
    terminalState: { ...state.semantic_windows[window.window_id] },
    record: () => recordSemantic(status, semanticMemoryIds),
    writeState,
  });
}

const FULL_WINDOW_STAGE_DEFINITIONS = {
  memory_consolidate_windows: {
    stage: 'memory_consolidate',
    label: 'memory_consolidate',
    planEndpoint: '/agentmemory/full/memory-consolidate-windows/plan',
    runEndpoint: '/agentmemory/full/memory-consolidate-window',
    prepareEndpoint: '/agentmemory/full/memory-consolidate-window/prepare',
    commitEndpoint: '/agentmemory/full/memory-consolidate-window/commit',
    resultFields: ['memoryIds', 'memory_ids'],
    resultStateKey: 'memory_ids',
    resultType: 'memory',
    noneReason: 'no eligible memory consolidate windows',
    unitPrefix: 'mcw',
  },
  consolidation_procedural_windows: {
    stage: 'consolidation_procedural',
    label: 'consolidation_procedural',
    planEndpoint: '/agentmemory/full/consolidation-procedural-windows/plan',
    runEndpoint: '/agentmemory/full/consolidation-procedural-window',
    resultFields: ['proceduralMemoryIds', 'procedural_memory_ids', 'memoryIds', 'memory_ids'],
    resultStateKey: 'procedural_memory_ids',
    resultType: 'procedural',
    noneReason: 'no eligible pattern memories',
    unitPrefix: 'cpw',
  },
  reflect_insight_windows: {
    stage: 'reflect_insight',
    label: 'reflect_insight',
    planEndpoint: '/agentmemory/full/reflect-insight-windows/plan',
    runEndpoint: '/agentmemory/full/reflect-insight-window',
    resultFields: ['insightIds', 'insight_ids', 'memoryIds', 'memory_ids'],
    resultStateKey: 'insight_ids',
    resultType: 'insight',
    noneReason: 'no eligible reflect insight windows',
    unitPrefix: 'riw',
    extraRunBody: { useGraph: false },
  },
};

function arrayFromFirst(value, keys) {
  for (const key of keys) {
    const found = value?.[key];
    if (Array.isArray(found)) return found;
  }
  return [];
}

function normalizePlanItems(data) {
  return arrayFromFirst(data, ['windows', 'units', 'items', 'groups'])
    .concat(arrayFromFirst(data?.plan, ['windows', 'units', 'items', 'groups']));
}

function normalizePlanUnit(item, index, prefix) {
  const sourceIds = arrayFromFirst(item, [
    'sourceIds',
    'source_ids',
    'sourceObservationIds',
    'source_observation_ids',
    'observationIds',
    'observation_ids',
    'sessionIds',
    'session_ids',
    'semanticMemoryIds',
    'semantic_memory_ids',
    'lessonIds',
    'lesson_ids',
    'crystalIds',
    'crystal_ids',
    'actionIds',
    'action_ids',
    'memoryIds',
    'memory_ids',
    'patternMemoryIds',
    'pattern_memory_ids',
  ]);
  const unitId = item?.unitId || item?.unit_id || item?.windowId || item?.window_id || item?.groupId || item?.group_id || item?.id || `${prefix}${String(index + 1).padStart(4, '0')}`;
  return {
    ...item,
    unit_id: unitId,
    window_id: item?.windowId || item?.window_id || unitId,
    source_ids: sourceIds,
    action_ids: arrayFromFirst(item, ['actionIds', 'action_ids']),
    action_updated_ats: arrayFromFirst(item, ['actionUpdatedAts', 'action_updated_ats']),
    source_count: Number(item?.sourceCount || item?.source_count || sourceIds.length || 0),
    input_hash: item?.inputHash || item?.input_hash || stableHash({ unitId, sourceIds }),
  };
}

function idsFromUnit(unit, keys) {
  return arrayFromFirst(unit, keys);
}

function fullStageRunBody({ state, containerKey, unit, options = {} }) {
  const body = {
    windowId: unit.window_id || unit.unit_id,
  };
  if (containerKey === 'memory_consolidate_windows') {
    return buildFormalOperationBody(buildStageModelRequestBody({
      ...body,
      concept: unit.concept,
      sourceObservationIds: idsFromUnit(unit, [
        'sourceObservationIds',
        'source_observation_ids',
        'observationIds',
        'observation_ids',
        'sourceIds',
        'source_ids',
      ]),
      observationSessionIds: unit.observationSessionIds || unit.observation_session_ids,
      charBudget: state.config.memory_consolidate_char_budget,
    }, options, 'memory_consolidate'), {
      state,
      stage: 'memory_consolidate',
      unitId: unit.unit_id,
      inputHash: unit.input_hash,
    });
  }
  if (containerKey === 'consolidation_procedural_windows') {
    return buildFormalOperationBody(buildStageModelRequestBody({
      ...body,
      memoryIds: idsFromUnit(unit, [
        'memoryIds',
        'memory_ids',
        'patternMemoryIds',
        'pattern_memory_ids',
        'sourceIds',
        'source_ids',
      ]),
    }, options, 'procedural'), {
      state,
      stage: 'consolidation_procedural',
      unitId: unit.unit_id,
      inputHash: unit.input_hash,
    });
  }
  if (containerKey === 'reflect_insight_windows') {
    return buildFormalOperationBody(buildStageModelRequestBody({
      ...body,
      useGraph: false,
      semanticMemoryIds: idsFromUnit(unit, ['semanticMemoryIds', 'semantic_memory_ids']),
      lessonIds: idsFromUnit(unit, ['lessonIds', 'lesson_ids']),
      crystalIds: idsFromUnit(unit, ['crystalIds', 'crystal_ids']),
      charBudget: state.config.reflect_insight_char_budget,
    }, options, 'reflect_insight'), {
      state,
      stage: 'reflect_insight',
      unitId: unit.unit_id,
      inputHash: unit.input_hash,
    });
  }
  return body;
}

function fullStagePlanBody({ state, containerKey }) {
  if (containerKey === 'memory_consolidate_windows') {
    return { charBudget: state.config.memory_consolidate_char_budget };
  }
  if (containerKey === 'reflect_insight_windows') {
    return { charBudget: state.config.reflect_insight_char_budget };
  }
  return {};
}

function normalizePlanUnits(data, prefix) {
  return normalizePlanItems(data).map((item, index) => normalizePlanUnit(item, index, prefix));
}

function terminalStageStatus(status) {
  return status === 'succeeded' || status === 'skipped';
}

function fullResponseStatus(response, data) {
  const text = [
    data?.status,
    data?.result,
    data?.reason,
    data?.error,
    response.error,
  ].filter(Boolean).join(' ').toLowerCase();
  if (data?.skipped || /skipped|no eligible|none/.test(text)) return 'skipped';
  if (/too few observations/.test(text)) return 'skipped';
  if (!response.ok) return 'failed';
  if (/failed|error/.test(text)) return 'failed';
  return 'succeeded';
}

function resultIdsFromData(data, fields) {
  const ids = arrayFromFirst(data || {}, fields);
  if (ids.length > 0) return ids;
  const nestedIds = [];
  for (const key of ['skill', 'crystal', 'memory', 'proceduralMemory', 'insight']) {
    const id = data?.[key]?.id;
    if (typeof id === 'string' && id.trim()) nestedIds.push(id.trim());
  }
  return nestedIds;
}

async function writeNoneSkipped({ state, statePath, baseUrl, secret, containerKey, stage, resultType, reason, dryRun, options = {} }) {
  const existing = state[containerKey]?.none;
  if (terminalStageStatus(existing?.status) && existing.input_hash === stableHash(reason)) {
    if (!dryRun && (existing.record_pending || !existing.recorded_at)) {
      return persistTerminalThenRecord({
        state,
        statePath,
        target: existing,
        terminalState: { ...existing },
        record: () => recordStageResult({
          state,
          baseUrl,
          secret,
          stage,
          unitId: 'none',
          resultType,
          status: 'skipped',
          options,
        }),
      });
    }
    return stageOutcome(existing.status);
  }
  state[containerKey] = {
    none: {
      unit_id: 'none',
      status: 'skipped',
      skipped_reason: reason,
      input_hash: stableHash(reason),
      completed_at: new Date().toISOString(),
    },
  };
  if (!dryRun) {
    return persistTerminalThenRecord({
      state,
      statePath,
      target: state[containerKey].none,
      terminalState: { ...state[containerKey].none },
      record: () => recordStageResult({
        state,
        baseUrl,
        secret,
        stage,
        unitId: 'none',
        resultType,
        status: 'skipped',
        options,
      }),
    });
  }
  await writeStateAtomically(statePath, state);
  return stageOutcome('skipped');
}

function upsertPlannedUnits(state, containerKey, units, dryRun) {
  for (const unit of units) {
    const existing = state[containerKey][unit.unit_id];
    if (terminalStageStatus(existing?.status) && existing.input_hash === unit.input_hash) continue;
    state[containerKey][unit.unit_id] = {
      ...existing,
      ...unit,
      status: dryRun ? 'planned' : (existing?.status || 'pending'),
    };
  }
}

function numericUnitField(unit, keys) {
  for (const key of keys) {
    const value = Number(unit?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function memoryConsolidateSourceIds(unit) {
  return idsFromUnit(unit, [
    'sourceObservationIds',
    'source_observation_ids',
    'observationIds',
    'observation_ids',
    'sourceIds',
    'source_ids',
  ]);
}

function estimatedCharsForObservationIds(unit, ids, fallbackParentChars, parentSourceCount) {
  const map = unit.observationEstimatedChars || unit.observation_estimated_chars;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    const total = ids.reduce((sum, id) => sum + Number(map[id] || 0), 0);
    if (Number.isFinite(total) && total > 0) return total;
  }
  const entries = unit.observationCharSizes || unit.observation_char_sizes || unit.observationEstimates || unit.observation_estimates;
  if (Array.isArray(entries)) {
    const byId = new Map(entries.map((entry) => [
      entry?.id || entry?.observationId || entry?.observation_id,
      Number(entry?.estimatedChars ?? entry?.estimated_chars ?? entry?.charSize ?? entry?.char_size),
    ]));
    const total = ids.reduce((sum, id) => {
      const value = byId.get(id);
      return sum + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0);
    if (total > 0) return total;
  }
  if (Number.isFinite(fallbackParentChars) && fallbackParentChars > 0 && parentSourceCount > 0) {
    return Math.ceil((fallbackParentChars * ids.length) / parentSourceCount);
  }
  return null;
}

export function validatePlannedWindowBudget(unit, charBudget) {
  const budget = Number(charBudget);
  const sourceIds = memoryConsolidateSourceIds(unit);
  const estimatedChars = numericUnitField(unit, [
    'estimatedChars',
    'estimated_chars',
    'estimatedPromptChars',
    'estimated_prompt_chars',
    'promptChars',
    'prompt_chars',
  ]);
  if (!Number.isFinite(budget) || budget <= 0 || estimatedChars === null) {
    return { status: 'within_budget', sourceIds, estimatedChars };
  }
  if (estimatedChars <= budget) {
    return { status: 'within_budget', sourceIds, estimatedChars };
  }
  if (sourceIds.length <= 1) {
    return { status: 'single_observation_over_budget', sourceIds, estimatedChars };
  }
  return { status: 'needs_split', sourceIds, estimatedChars };
}

function splitMemoryConsolidateUnit(unit) {
  const sourceObservationIds = memoryConsolidateSourceIds(unit);
  if (sourceObservationIds.length <= 1) return [];
  const parentEstimatedChars = numericUnitField(unit, ['estimatedChars', 'estimated_chars', 'promptChars', 'prompt_chars']);
  const mid = Math.ceil(sourceObservationIds.length / 2);
  return [sourceObservationIds.slice(0, mid), sourceObservationIds.slice(mid)]
    .filter((ids) => ids.length > 0)
    .map((ids, index) => {
      const unitId = `${unit.unit_id}${String.fromCharCode(97 + index)}`;
      const inputHash = stableHash({ unitId, sourceIds: ids });
      const estimatedChars = estimatedCharsForObservationIds(
        unit,
        ids,
        parentEstimatedChars,
        sourceObservationIds.length,
      );
      const parentSessionIds = unit.observationSessionIds || unit.observation_session_ids;
      const observationSessionIds = parentSessionIds && typeof parentSessionIds === 'object'
        ? Object.fromEntries(ids
          .filter((id) => typeof parentSessionIds[id] === 'string' && parentSessionIds[id])
          .map((id) => [id, parentSessionIds[id]]))
        : undefined;
      return {
        concept: unit.concept,
        unit_id: unitId,
        window_id: unitId,
        source_ids: ids,
        sourceObservationIds: ids,
        observationIds: ids,
        source_count: ids.length,
        observationCount: ids.length,
        ...(observationSessionIds && Object.keys(observationSessionIds).length === ids.length
          ? { observationSessionIds }
          : {}),
        ...(estimatedChars !== null ? { estimatedChars, estimated_chars: estimatedChars } : {}),
        ...(unit.charBudget || unit.char_budget ? { charBudget: unit.charBudget || unit.char_budget } : {}),
        inputHash,
        input_hash: inputHash,
        split_from: unit.unit_id,
      };
    });
}

function isValidSplitChildUnit(state, containerKey, unitId, child) {
  if (!child?.split_from || child.split_from === unitId) return false;
  const parent = state[containerKey]?.[child.split_from];
  if (!parent || parent.status !== 'split') return false;
  if (!Array.isArray(parent.split_into) || !parent.split_into.includes(unitId)) return false;
  const sourceIds = idsFromUnit(child, ['sourceIds', 'source_ids', 'sourceObservationIds', 'source_observation_ids', 'observationIds', 'observation_ids']);
  if (sourceIds.length === 0) return false;
  return child.input_hash === stableHash({ unitId, sourceIds });
}

export function splitChildUnitsForContainer(state, containerKey, unitId) {
  const work = [];
  const collect = (currentId) => {
    const unit = state[containerKey]?.[currentId];
    if (!unit) return;
    if (unit.status === 'split') {
      for (const childId of unit.split_into || []) collect(childId);
      return;
    }
    if (!terminalStageStatus(unit.status)) work.push(unit);
  };
  for (const childId of state[containerKey]?.[unitId]?.split_into || []) collect(childId);
  return work;
}

async function prepareMemoryConsolidateBudgetUnits({ state, statePath, baseUrl, secret, units, dryRun, options = {} }) {
  const containerKey = 'memory_consolidate_windows';
  const executable = [];
  const failuresToRecord = [];
  let recordFailure = null;
  const charBudget = state.config.memory_consolidate_char_budget;

  const visit = (unit) => {
    const existing = state[containerKey][unit.unit_id] || unit;
    if (terminalStageStatus(existing.status)) return;
    if (
      existing.status === 'failed'
      && existing.input_hash === unit.input_hash
      && existing.budget_failure_reason === 'input_too_large_single_observation'
    ) {
      if (!dryRun && existing.record_pending) failuresToRecord.push(existing);
      return;
    }
    const check = validatePlannedWindowBudget({ ...unit, ...existing }, charBudget);
    if (check.status === 'within_budget') {
      executable.push({ ...unit, ...existing });
      return;
    }
    if (check.status === 'single_observation_over_budget') {
      const alreadyRecorded = existing.recorded_at && existing.input_hash === unit.input_hash;
      state[containerKey][unit.unit_id] = {
        ...existing,
        ...unit,
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: 'input_too_large_single_observation',
        budget_failure_reason: 'input_too_large_single_observation',
        char_budget: charBudget,
        estimated_chars: check.estimatedChars,
        source_ids: check.sourceIds,
        input_hash: unit.input_hash,
        failure_class: 'hard',
        failure_cause: 'input_too_large_single_observation',
      };
      if (!dryRun && !alreadyRecorded) failuresToRecord.push(state[containerKey][unit.unit_id]);
      return;
    }

    const childUnits = splitMemoryConsolidateUnit({ ...unit, ...existing });
    if (childUnits.length === 0) {
      state[containerKey][unit.unit_id] = {
        ...existing,
        ...unit,
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: 'input_too_large_single_observation',
        budget_failure_reason: 'input_too_large_single_observation',
        char_budget: charBudget,
        estimated_chars: check.estimatedChars,
        source_ids: check.sourceIds,
        input_hash: unit.input_hash,
        failure_class: 'hard',
        failure_cause: 'input_too_large_single_observation',
      };
      if (!dryRun) failuresToRecord.push(state[containerKey][unit.unit_id]);
      return;
    }
    const splitIds = childUnits.map((child) => child.unit_id);
    for (const child of childUnits) {
      const existingChild = state[containerKey][child.unit_id] || {};
      state[containerKey][child.unit_id] = {
        ...child,
        ...(existingChild.input_hash === child.input_hash ? existingChild : {}),
        ...child,
        status: terminalStageStatus(existingChild.status) && existingChild.input_hash === child.input_hash
          ? existingChild.status
          : (existingChild.status === 'split' ? 'split' : (existingChild.status === 'failed' ? 'failed' : 'pending')),
      };
    }
    state[containerKey][unit.unit_id] = {
      ...existing,
      ...unit,
      status: 'split',
      completed_at: new Date().toISOString(),
      error: 'planned_window_over_budget',
      split_into: splitIds,
      char_budget: charBudget,
      estimated_chars: check.estimatedChars,
      input_hash: unit.input_hash,
    };
    for (const child of childUnits) visit(state[containerKey][child.unit_id]);
  };

  for (const unit of units) visit(unit);
  for (const failure of failuresToRecord) {
    const outcome = await persistTerminalThenRecord({
      state,
      statePath,
      target: failure,
      terminalState: { ...failure },
      record: () => recordStageResult({
        state,
        baseUrl,
        secret,
        stage: 'memory_consolidate',
        unitId: failure.unit_id,
        sourceIds: failure.source_ids || [],
        resultType: 'memory',
        status: 'failed',
        options,
      }),
    });
    if (!recordFailure && outcome.failure) recordFailure = outcome;
  }
  return { units: executable, recordFailure };
}

function invalidMemoryPlanPage(error) {
  return {
    ok: false,
    status_code: 400,
    error,
    data: { error },
  };
}

function memoryPlanPage(data) {
  if (!data || !Array.isArray(data.descriptors)) return null;
  const totalSessions = Number(data.totalSessions);
  const sessionOffset = Number(data.sessionOffset);
  const sessionInventoryHash = nonEmptyString(data.sessionInventoryHash);
  const nextSessionOffset = data.nextSessionOffset === null
    ? null
    : Number(data.nextSessionOffset);
  if (
    !Number.isInteger(totalSessions)
    || totalSessions < 0
    || !Number.isInteger(sessionOffset)
    || sessionOffset < 0
    || !sessionInventoryHash
    || (nextSessionOffset !== null
      && (!Number.isInteger(nextSessionOffset) || nextSessionOffset <= sessionOffset))
  ) return null;
  return {
    descriptors: data.descriptors,
    totalSessions,
    sessionOffset,
    sessionInventoryHash,
    nextSessionOffset,
    plannerId: nonEmptyString(data.plannerId),
    accumulatedDescriptorCount: Number.isInteger(Number(data.accumulatedDescriptorCount))
      ? Number(data.accumulatedDescriptorCount)
      : null,
  };
}

function logMemoryPlanPage(page) {
  const sessionsScanned = page.nextSessionOffset ?? page.totalSessions;
  if (sessionsScanned === page.totalSessions || sessionsScanned % 256 === 0) {
    logProgress('memory_consolidate', 'plan_page', {
      sessions_scanned: sessionsScanned,
      total_sessions: page.totalSessions,
      descriptors_accumulated: page.accumulatedDescriptorCount,
    });
  }
}

function memoryPlanWindowPage(data) {
  if (!data || !Array.isArray(data.windows)) return null;
  const totalWindows = Number(data.totalWindows);
  const windowOffset = Number(data.windowOffset);
  const nextWindowOffset = data.nextWindowOffset === null
    ? null
    : Number(data.nextWindowOffset);
  if (
    !Number.isInteger(totalWindows)
    || totalWindows < 0
    || !Number.isInteger(windowOffset)
    || windowOffset < 0
    || (nextWindowOffset !== null
      && (!Number.isInteger(nextWindowOffset) || nextWindowOffset <= windowOffset))
  ) return null;
  return {
    windows: data.windows,
    totalWindows,
    windowOffset,
    nextWindowOffset,
    plannerId: nonEmptyString(data.plannerId),
  };
}

function logMemoryPlanWindowPage(page) {
  const windowsReceived = page.nextWindowOffset ?? page.totalWindows;
  if (windowsReceived === page.totalWindows || windowsReceived % 256 === 0) {
    logProgress('memory_consolidate', 'plan_windows', {
      windows_received: windowsReceived,
      total_windows: page.totalWindows,
    });
  }
}

export async function requestMemoryConsolidatePlan({
  state,
  baseUrl,
  secret,
  options,
  definition,
}) {
  const baseBody = fullStagePlanBody({
    state,
    containerKey: 'memory_consolidate_windows',
  });
  const plannerId = stableHash([
    'memory-consolidate-plan',
    state.run_id,
    state.scheduler_epoch,
    state.config_hash,
    state.inventory_hash,
  ]);
  let response = await requestJson(
    baseUrl,
    secret,
    'POST',
    definition.planEndpoint,
    { ...baseBody, plannerId, sessionOffset: 0, sessionLimit: 8 },
    requestOptions(options),
  );
  if (!response.ok) return response;
  let page = memoryPlanPage(response.data);
  if (!page) {
    return response.data?.success === false
      ? invalidMemoryPlanPage(response.data.error || 'memory consolidate descriptor page failed')
      : response;
  }

  const totalSessions = page.totalSessions;
  const sessionInventoryHash = page.sessionInventoryHash;
  if (page.plannerId !== plannerId) {
    return invalidMemoryPlanPage('invalid paged memory consolidate planner id');
  }
  logMemoryPlanPage(page);
  let nextSessionOffset = page.nextSessionOffset;
  while (nextSessionOffset !== null) {
    response = await requestJson(
      baseUrl,
      secret,
      'POST',
      definition.planEndpoint,
      { ...baseBody, plannerId, sessionOffset: nextSessionOffset, sessionLimit: 8 },
      requestOptions(options),
    );
    if (!response.ok) return response;
    page = memoryPlanPage(response.data);
    if (
      !page
      || page.totalSessions !== totalSessions
      || page.sessionInventoryHash !== sessionInventoryHash
      || page.plannerId !== plannerId
      || page.sessionOffset !== nextSessionOffset
      || (page.nextSessionOffset !== null && page.nextSessionOffset > totalSessions)
    ) {
      return invalidMemoryPlanPage('invalid paged memory consolidate plan response');
    }
    logMemoryPlanPage(page);
    nextSessionOffset = page.nextSessionOffset;
  }

  response = await requestJson(
    baseUrl,
    secret,
    'POST',
    definition.planEndpoint,
    { ...baseBody, plannerId, windowOffset: 0, windowLimit: 8 },
    requestOptions(options),
  );
  if (!response.ok) return response;
  let windowPage = memoryPlanWindowPage(response.data);
  if (!windowPage || response.data?.success === false) {
    return invalidMemoryPlanPage(
      response.data?.error || 'invalid paged memory consolidate window response',
    );
  }
  if (windowPage.plannerId !== plannerId || windowPage.windowOffset !== 0) {
    return invalidMemoryPlanPage('invalid paged memory consolidate window cursor');
  }
  const totalWindows = windowPage.totalWindows;
  const windows = [...windowPage.windows];
  const {
    windows: _firstWindows,
    windowOffset: _firstWindowOffset,
    nextWindowOffset: _firstNextWindowOffset,
    ...planSummary
  } = response.data;
  void _firstWindows;
  void _firstWindowOffset;
  void _firstNextWindowOffset;
  logMemoryPlanWindowPage(windowPage);
  let nextWindowOffset = windowPage.nextWindowOffset;
  while (nextWindowOffset !== null) {
    response = await requestJson(
      baseUrl,
      secret,
      'POST',
      definition.planEndpoint,
      { ...baseBody, plannerId, windowOffset: nextWindowOffset, windowLimit: 8 },
      requestOptions(options),
    );
    if (!response.ok) return response;
    windowPage = memoryPlanWindowPage(response.data);
    if (
      !windowPage
      || response.data?.success === false
      || windowPage.plannerId !== plannerId
      || windowPage.totalWindows !== totalWindows
      || windowPage.windowOffset !== nextWindowOffset
      || (windowPage.nextWindowOffset !== null && windowPage.nextWindowOffset > totalWindows)
    ) {
      return invalidMemoryPlanPage(
        response.data?.error || 'invalid paged memory consolidate window response',
      );
    }
    windows.push(...windowPage.windows);
    logMemoryPlanWindowPage(windowPage);
    nextWindowOffset = windowPage.nextWindowOffset;
  }
  if (windows.length !== totalWindows) {
    return invalidMemoryPlanPage('incomplete paged memory consolidate window response');
  }
  return {
    ...response,
    data: {
      ...planSummary,
      windows,
    },
  };
}

async function planRestFullStage({ state, statePath, baseUrl, secret, options, containerKey, dryRun }) {
  const definition = FULL_WINDOW_STAGE_DEFINITIONS[containerKey];
  const pendingBudgetRecords = containerKey === 'memory_consolidate_windows' && !dryRun
    ? Object.values(state[containerKey] || {}).filter((unit) =>
      unit?.budget_failure_reason === 'input_too_large_single_observation' && unit.record_pending)
    : [];
  if (pendingBudgetRecords.length > 0) {
    for (const target of pendingBudgetRecords) {
      const outcome = await persistTerminalThenRecord({
        state,
        statePath,
        target,
        terminalState: { ...target },
        record: () => recordStageResult({
          state,
          baseUrl,
          secret,
          stage: definition.stage,
          unitId: target.unit_id,
          sourceIds: target.source_ids || [],
          resultType: definition.resultType,
          status: 'failed',
          options,
        }),
      });
      if (outcome.failure) return { outcome, units: [] };
    }
  }
  if (!dryRun && state[containerKey]?.none?.record_pending) {
    const outcome = await writeNoneSkipped({
      state,
      statePath,
      baseUrl,
      secret,
      containerKey,
      stage: definition.stage,
      resultType: definition.resultType,
      reason: definition.noneReason,
      dryRun,
      options,
    });
    return { outcome, units: [] };
  }
  const response = containerKey === 'memory_consolidate_windows'
    ? await requestMemoryConsolidatePlan({
      state,
      baseUrl,
      secret,
      options,
      definition,
    })
    : await requestJson(
      baseUrl,
      secret,
      'POST',
      definition.planEndpoint,
      fullStagePlanBody({ state, containerKey }),
      requestOptions(options),
    );
  if (!response.ok) {
    const failure = await classifyPlanFailure(response, options.runtimeDiagnostics);
    state[containerKey].none = {
      unit_id: 'none',
      status: 'failed',
      error: compactStateError(response.error || response.data?.error, `${definition.stage} plan failed`),
      completed_at: new Date().toISOString(),
      input_hash: stableHash(`${definition.stage}:plan-failed`),
      ...failureStateMetadata(failure),
    };
    await writeStateAtomically(statePath, state);
    return { outcome: stageOutcome('failed', { failure }), units: [] };
  }
  const units = normalizePlanUnits(response.data || response.response || {}, definition.unitPrefix);
  const recoveredPlanFailure = state[containerKey].none?.status === 'failed';
  if (recoveredPlanFailure) delete state[containerKey].none;
  if (units.length === 0) {
    if (options.resume && !recoveredPlanFailure) {
      validatePlannedContainerResume(state, options, containerKey, [{
        unit_id: 'none',
        input_hash: stableHash(definition.noneReason),
      }]);
    }
    const outcome = await writeNoneSkipped({
      state,
      statePath,
      baseUrl,
      secret,
      containerKey,
      stage: definition.stage,
      resultType: definition.resultType,
      reason: definition.noneReason,
      dryRun,
      options,
    });
    return { outcome, units: [] };
  }
  if (options.resume && !recoveredPlanFailure) validatePlannedContainerResume(state, options, containerKey, units);
  delete state[containerKey].none;
  upsertPlannedUnits(state, containerKey, units, dryRun);
  const budgetResult = containerKey === 'memory_consolidate_windows'
    ? await prepareMemoryConsolidateBudgetUnits({ state, statePath, baseUrl, secret, units, dryRun, options })
    : { units, recordFailure: null };
  await writeStateAtomically(statePath, state);
  return {
    outcome: budgetResult.recordFailure || stageOutcome('succeeded'),
    units: budgetResult.recordFailure ? [] : budgetResult.units,
  };
}

export async function runRestMemoryPrepareUnit({ state, statePath, baseUrl, secret, unit, options = {} }) {
  const definition = FULL_WINDOW_STAGE_DEFINITIONS.memory_consolidate_windows;
  const writeState = options.writeState || writeStateAtomically;
  const existing = state.memory_consolidate_windows[unit.unit_id] || unit;
  if (terminalStageStatus(existing.status) || existing.status === 'prepared') {
    return stageOutcome('succeeded');
  }
  Object.assign(existing, unit, {
    status: 'preparing',
    started_at: existing.started_at || new Date().toISOString(),
    attempt_count: (existing.attempt_count || 0) + 1,
  });
  state.memory_consolidate_windows[unit.unit_id] = existing;
  await writeState(statePath, state);
  let response = await requestJson(
    baseUrl,
    secret,
    'POST',
    definition.prepareEndpoint,
    fullStageRunBody({ state, containerKey: 'memory_consolidate_windows', unit, options }),
    requestOptions(options),
  );
  if (response.status === 404 || response.status_code === 404) {
    response = await requestJson(
      baseUrl,
      secret,
      'POST',
      definition.runEndpoint,
      fullStageRunBody({ state, containerKey: 'memory_consolidate_windows', unit, options }),
      requestOptions(options),
    );
    const legacyData = response.data || {};
    if (response.ok) {
      const resultIds = resultIdsFromData(legacyData, definition.resultFields);
      Object.assign(existing, {
        status: 'succeeded',
        memory_ids: resultIds,
        completed_at: new Date().toISOString(),
        verified_at: new Date().toISOString(),
      });
      return persistTerminalThenRecord({
        state,
        statePath,
        target: existing,
        terminalState: { ...existing },
        record: () => recordStageResult({
          state,
          baseUrl,
          secret,
          stage: definition.stage,
          unitId: unit.unit_id,
          sourceIds: unit.source_ids || [],
          resultIds,
          resultType: definition.resultType,
          status: 'succeeded',
          options,
        }),
        writeState,
      });
    }
  }
  const data = response.data || {};
  const directResultIds = resultIdsFromData(data, definition.resultFields);
  if (response.ok && directResultIds.length > 0 && !data.preparedHandle) {
    Object.assign(existing, applyResponseStateMetadata({
      ...existing,
      status: 'succeeded',
      memory_ids: directResultIds,
      completed_at: new Date().toISOString(),
      verified_at: new Date().toISOString(),
    }, data, definition.stage));
    return persistTerminalThenRecord({
      state,
      statePath,
      target: existing,
      terminalState: { ...existing },
      record: () => recordStageResult({
        state,
        baseUrl,
        secret,
        stage: definition.stage,
        unitId: unit.unit_id,
        sourceIds: unit.source_ids || [],
        resultIds: directResultIds,
        resultType: definition.resultType,
        status: 'succeeded',
        options,
      }),
      writeState,
    });
  }
  if (!response.ok && isInputTooLargeResponse(response)) {
    const childUnits = splitMemoryConsolidateUnit(unit);
    if (childUnits.length > 0) {
      const splitIds = childUnits.map((child) => child.unit_id);
      for (const child of childUnits) {
        const existingChild = state.memory_consolidate_windows[child.unit_id] || {};
        state.memory_consolidate_windows[child.unit_id] = {
          ...child,
          ...(existingChild.input_hash === child.input_hash ? existingChild : {}),
          ...child,
          status: terminalStageStatus(existingChild.status) && existingChild.input_hash === child.input_hash
            ? existingChild.status
            : (existingChild.status === 'split' ? 'split' : 'pending'),
        };
      }
      Object.assign(existing, {
        status: 'split',
        completed_at: new Date().toISOString(),
        error: 'input_too_large',
        split_into: splitIds,
      });
      await writeState(statePath, state);
      return stageOutcome('retry_planned');
    }
  }
  if (response.ok && typeof data.preparedHandle === 'string' && data.preparedHandle) {
    Object.assign(existing, {
      status: data.status === 'committed' ? 'succeeded' : 'prepared',
      prepared_handle: data.preparedHandle,
      proposal_hash: data.proposalHash || null,
      prepared_at: new Date().toISOString(),
    });
    clearTerminalRetryMetadata(existing);
    await writeState(statePath, state);
    return stageOutcome('succeeded');
  }
  if (
    response.ok
    && (
      data.status === 'skipped'
      || data.skipped === true
      || Number(data.consolidated) === 0
    )
  ) {
    Object.assign(existing, applyResponseStateMetadata({
      ...existing,
      status: 'skipped',
      memory_ids: [],
      completed_at: new Date().toISOString(),
      verified_at: new Date().toISOString(),
    }, data, definition.stage));
    return persistTerminalThenRecord({
      state,
      statePath,
      target: existing,
      terminalState: { ...existing },
      record: () => recordStageResult({
        state,
        baseUrl,
        secret,
        stage: definition.stage,
        unitId: unit.unit_id,
        sourceIds: unit.source_ids || [],
        resultIds: [],
        resultType: definition.resultType,
        status: 'skipped',
        options,
      }),
      writeState,
    });
  }
  const failure = classifyStageResponse({ ...response, data });
  Object.assign(existing, {
    status: 'failed',
    error: compactStateError(response.error || data.error, 'memory_consolidate prepare failed'),
  });
  applyFailureState(existing, failure);
  await writeState(statePath, state);
  return stageOutcome('failed', { failure });
}

async function runRestMemoryCommitUnit({ state, statePath, baseUrl, secret, unit, options = {} }) {
  const definition = FULL_WINDOW_STAGE_DEFINITIONS.memory_consolidate_windows;
  const writeState = options.writeState || writeStateAtomically;
  const existing = state.memory_consolidate_windows[unit.unit_id] || unit;
  const recordUnit = (status, resultIds = []) => recordStageResult({
    state,
    baseUrl,
    secret,
    stage: definition.stage,
    unitId: unit.unit_id,
    sourceIds: unit.source_ids || [],
    resultIds,
    resultType: definition.resultType,
    status,
    options,
  });
  if (
    existing.record_pending
    && ['succeeded', 'skipped', 'failed'].includes(existing.status)
  ) {
    return persistTerminalThenRecord({
      state,
      statePath,
      target: existing,
      terminalState: { ...existing },
      record: () => recordUnit(
        existing.status,
        existing.status === 'succeeded' ? existing.memory_ids || [] : [],
      ),
      writeState,
    });
  }
  if (terminalStageStatus(existing.status)) {
    return stageOutcome(existing.status);
  }
  if (!existing.prepared_handle) {
    return stageOutcome('failed', {
      failure: { class: 'hard', cause: 'memory_consolidate_proposal_missing' },
    });
  }
  existing.status = 'committing';
  await writeState(statePath, state);
  const body = buildFormalOperationBody({
    preparedHandle: existing.prepared_handle,
  }, {
    state,
    stage: 'memory_consolidate',
    unitId: unit.unit_id,
    inputHash: unit.input_hash,
  });
  const response = await requestJson(
    baseUrl,
    secret,
    'POST',
    definition.commitEndpoint,
    body,
    requestOptions(options),
  );
  const data = response.data || {};
  const status = fullResponseStatus(response, data);
  const resultIds = status === 'succeeded' ? resultIdsFromData(data, definition.resultFields) : [];
  Object.assign(existing, applyResponseStateMetadata({
    ...existing,
    status,
    memory_ids: resultIds,
    completed_at: new Date().toISOString(),
    ...(status === 'succeeded' ? { verified_at: new Date().toISOString() } : {}),
    ...(status === 'failed'
      ? { error: compactStateError(response.error || data.error, 'memory_consolidate commit failed') }
      : {}),
  }, data, definition.stage));
  if (status === 'succeeded' || status === 'skipped') {
    return persistTerminalThenRecord({
      state,
      statePath,
      target: existing,
      terminalState: { ...existing },
      record: () => recordUnit(status, resultIds),
      writeState,
    });
  }
  const failure = classifyStageResponse({ ...response, data });
  applyFailureState(existing, failure);
  await writeState(statePath, state);
  return stageOutcome('failed', { failure });
}

async function runRestFullStageUnit({ state, statePath, baseUrl, secret, containerKey, unit, options = {} }) {
  const definition = FULL_WINDOW_STAGE_DEFINITIONS[containerKey];
  const totalStartedAt = performance.now();
  let persistenceMs = 0;
  let recordMs = 0;
  const baseWriteState = options.writeState || writeStateAtomically;
  const writeState = async (...args) => {
    const startedAt = performance.now();
    try {
      return await baseWriteState(...args);
    } finally {
      persistenceMs += performance.now() - startedAt;
    }
  };
  const finishOutcome = (outcome, responseData = {}) => ({
    ...outcome,
    timing: {
      model_ms: Number.isFinite(Number(responseData.durationMs ?? responseData.duration_ms))
        ? Number(responseData.durationMs ?? responseData.duration_ms)
        : null,
      persistence_ms: Math.round(persistenceMs * 100) / 100,
      record_ms: Math.round(recordMs * 100) / 100,
      total_ms: Math.round((performance.now() - totalStartedAt) * 100) / 100,
    },
  });
  const existing = state[containerKey][unit.unit_id];
  const recordUnit = async (status, resultIds = []) => {
    const startedAt = performance.now();
    try {
      return await recordStageResult({
        state,
        baseUrl,
        secret,
        stage: definition.stage,
        unitId: unit.unit_id,
        sourceIds: unit.source_ids || [],
        resultIds,
        resultType: definition.resultType,
        status,
        options,
      });
    } finally {
      recordMs += performance.now() - startedAt;
    }
  };
  if (terminalStageStatus(existing?.status)) {
    if (existing.record_pending) {
      const outcome = await persistTerminalThenRecord({
        state,
        statePath,
        target: existing,
        terminalState: { ...existing },
        record: () => recordUnit(existing.status, existing[definition.resultStateKey] || []),
        writeState,
      });
      return finishOutcome(outcome, existing);
    }
    return finishOutcome(stageOutcome(existing.status), existing);
  }
  if (existing?.status === 'split') return finishOutcome(stageOutcome('retry_planned'), existing);
  state[containerKey][unit.unit_id] = {
    ...existing,
    ...unit,
    status: 'running',
    started_at: existing?.started_at || new Date().toISOString(),
    attempt_count: (existing?.attempt_count || 0) + 1,
  };
  await writeState(statePath, state);

  const response = await requestJson(
    baseUrl,
    secret,
    'POST',
    definition.runEndpoint,
    fullStageRunBody({ state, containerKey, unit, options }),
    requestOptions(options),
  );
  const data = response.data || {};
  if (!response.ok && containerKey === 'memory_consolidate_windows' && isInputTooLargeResponse(response)) {
    const childUnits = splitMemoryConsolidateUnit(unit);
    if (childUnits.length > 0) {
      const splitIds = childUnits.map((child) => child.unit_id);
      for (const child of childUnits) {
        const existingChild = state[containerKey][child.unit_id] || {};
        state[containerKey][child.unit_id] = {
          ...child,
          ...(existingChild.input_hash === child.input_hash ? existingChild : {}),
          ...child,
          status: terminalStageStatus(existingChild.status) && existingChild.input_hash === child.input_hash
            ? existingChild.status
            : (existingChild.status === 'split' ? 'split' : 'pending'),
        };
      }
      state[containerKey][unit.unit_id] = applyResponseStateMetadata({
        ...state[containerKey][unit.unit_id],
        status: 'split',
        completed_at: new Date().toISOString(),
        error: 'input_too_large',
        prompt_chars: data.promptChars || data.prompt_chars || null,
        max_prompt_chars: data.maxPromptChars || data.max_prompt_chars || null,
        split_into: splitIds,
      }, data, definition.stage);
      await writeState(statePath, state);
      return finishOutcome(stageOutcome('retry_planned'), data);
    }
  }
  const status = fullResponseStatus(response, data);
  const resultIds = status === 'succeeded' ? resultIdsFromData(data, definition.resultFields) : [];
  state[containerKey][unit.unit_id] = applyResponseStateMetadata({
    ...state[containerKey][unit.unit_id],
    status,
    [definition.resultStateKey]: resultIds,
    input_hash: unit.input_hash,
    completed_at: new Date().toISOString(),
    ...(status === 'succeeded' ? { verified_at: new Date().toISOString() } : {}),
    ...(status === 'skipped' ? { skipped_reason: data.reason || data.status || 'skipped by full endpoint' } : {}),
    ...(status === 'failed' ? { error: compactStateError(response.error || data.error, `${definition.stage} failed`) } : {}),
  }, data, definition.stage);
  if (status === 'succeeded' || status === 'skipped') {
    const outcome = await persistTerminalThenRecord({
      state,
      statePath,
      target: state[containerKey][unit.unit_id],
      terminalState: { ...state[containerKey][unit.unit_id] },
      record: () => recordUnit(status, resultIds),
      writeState,
    });
    return finishOutcome(outcome, data);
  }
  const failure = classifyStageResponse({ ...response, data });
  applyFailureState(state[containerKey][unit.unit_id], failure);
  await writeState(statePath, state);
  return finishOutcome(stageOutcome('failed', { failure }), data);
}

function completedSummarySessionIds(state) {
  return Object.values(state.sessions || {})
    .filter((item) => item.summary?.status === 'succeeded')
    .filter((item) => item.completed_at || item.session_status === 'completed' || item.session_status === 'done')
    .sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')) || a.session_id.localeCompare(b.session_id))
    .map((item) => item.session_id);
}

export function planSkillExtractUnits(state) {
  return completedSummarySessionIds(state).map((sessionId, index) => {
    const summary = state.sessions[sessionId]?.summary || {};
    return {
      unit_id: `skill-${String(index + 1).padStart(4, '0')}`,
      session_id: sessionId,
      source_ids: [sessionId],
      source_count: 1,
      input_hash: stableHash({ sessionId, summary_hash: summary.summary_hash || null }),
    };
  });
}

async function planSkillExtractStage({ state, statePath, baseUrl, secret, options, dryRun }) {
  const units = planSkillExtractUnits(state);
  if (units.length === 0) {
    if (options.resume) {
      validatePlannedContainerResume(state, options, 'skill_extract', [{
        unit_id: 'none',
        input_hash: stableHash('no completed summarized sessions'),
      }]);
    }
    const outcome = await writeNoneSkipped({
      state,
      statePath,
      baseUrl,
      secret,
      containerKey: 'skill_extract',
      stage: 'skill_extract',
      resultType: 'procedural',
      reason: 'no completed summarized sessions',
      dryRun,
      options,
    });
    return { outcome, units: [] };
  }
  if (options.resume) validatePlannedContainerResume(state, options, 'skill_extract', units);
  delete state.skill_extract.none;
  upsertPlannedUnits(state, 'skill_extract', units, dryRun);
  await writeStateAtomically(statePath, state);
  return { outcome: stageOutcome('succeeded'), units };
}

export async function runSkillExtractUnit({ state, statePath, baseUrl, secret, unit, options = {} }) {
  const existing = state.skill_extract[unit.unit_id];
  const recordSkill = (status, resultIds) => recordStageResult({
    state,
    baseUrl,
    secret,
    stage: 'skill_extract',
    unitId: unit.unit_id,
    sourceIds: unit.source_ids,
    resultIds,
    resultType: 'procedural',
    status,
    options,
  });
  if (terminalStageStatus(existing?.status)) {
    if (existing.record_pending) {
      return persistTerminalThenRecord({
        state,
        statePath,
        target: existing,
        terminalState: { ...existing },
        record: () => recordSkill(existing.status, existing.skill_ids || []),
      });
    }
    return stageOutcome(existing.status);
  }
  state.skill_extract[unit.unit_id] = {
    ...existing,
    ...unit,
    status: 'running',
    started_at: existing?.started_at || new Date().toISOString(),
    attempt_count: (existing?.attempt_count || 0) + 1,
  };
  await writeStateAtomically(statePath, state);

  const response = await requestJson(
    baseUrl,
    secret,
    'POST',
    '/agentmemory/full/skill-extract',
    buildFormalOperationBody(
      buildStageModelRequestBody({ sessionId: unit.session_id }, options, 'skill_extract'),
      {
        state,
        stage: 'skill_extract',
        unitId: unit.unit_id,
        inputHash: unit.input_hash,
      },
    ),
    requestOptions(options),
  );
  const data = response.data || {};
  const status = fullResponseStatus(response, data);
  const resultIds = status === 'succeeded'
    ? resultIdsFromData(data, ['skillIds', 'skill_ids', 'proceduralMemoryIds', 'procedural_memory_ids', 'memoryIds', 'memory_ids'])
    : [];
  state.skill_extract[unit.unit_id] = applyResponseStateMetadata({
    ...state.skill_extract[unit.unit_id],
    status,
    skill_ids: resultIds,
    input_hash: unit.input_hash,
    completed_at: new Date().toISOString(),
    ...(status === 'succeeded' ? { verified_at: new Date().toISOString() } : {}),
    ...(status === 'skipped' ? { skipped_reason: data.reason || data.status || 'too few observations' } : {}),
    ...(status === 'failed' ? { error: compactStateError(response.error || data.error, 'skill_extract_full failed') } : {}),
  }, data, 'skill_extract');
  if (status === 'succeeded' || status === 'skipped') {
    return persistTerminalThenRecord({
      state,
      statePath,
      target: state.skill_extract[unit.unit_id],
      terminalState: { ...state.skill_extract[unit.unit_id] },
      record: () => recordSkill(status, resultIds),
    });
  }
  const failure = classifyStageResponse({ ...response, data });
  applyFailureState(state.skill_extract[unit.unit_id], failure);
  await writeStateAtomically(statePath, state);
  return stageOutcome('failed', { failure });
}

export async function runSkillExtractPrepareUnit({
  state,
  statePath,
  baseUrl,
  secret,
  unit,
  options = {},
}) {
  const writeState = options.writeState || writeStateAtomically;
  const existing = state.skill_extract[unit.unit_id];
  const recordSkill = (status, resultIds = []) => recordStageResult({
    state,
    baseUrl,
    secret,
    stage: 'skill_extract',
    unitId: unit.unit_id,
    sourceIds: unit.source_ids,
    resultIds,
    resultType: 'procedural',
    status,
    options,
  });
  if (
    existing?.record_pending
    && ['succeeded', 'skipped', 'failed'].includes(existing.status)
  ) {
    return persistTerminalThenRecord({
      state,
      statePath,
      target: existing,
      terminalState: { ...existing },
      record: () => recordSkill(
        existing.status,
        existing.status === 'succeeded' ? existing.skill_ids || [] : [],
      ),
      writeState,
    });
  }
  if (terminalStageStatus(existing?.status)) {
    return stageOutcome(existing.status);
  }
  if (existing?.status === 'prepared') return stageOutcome('succeeded');

  state.skill_extract[unit.unit_id] = {
    ...existing,
    ...unit,
    status: 'preparing',
    started_at: existing?.started_at || new Date().toISOString(),
    attempt_count: (existing?.attempt_count || 0) + 1,
  };
  await writeState(statePath, state);
  const response = await requestJson(
    baseUrl,
    secret,
    'POST',
    '/agentmemory/full/skill-extract/prepare',
    buildFormalOperationBody(
      buildStageModelRequestBody({ sessionId: unit.session_id }, options, 'skill_extract'),
      {
        state,
        stage: 'skill_extract',
        unitId: unit.unit_id,
        inputHash: unit.input_hash,
      },
    ),
    requestOptions(options),
  );
  const data = response.data || {};
  const resultIds = resultIdsFromData(data, [
    'skillIds',
    'skill_ids',
    'proceduralMemoryIds',
    'procedural_memory_ids',
    'memoryIds',
    'memory_ids',
  ]);
  if (
    response.ok
    && typeof data.preparedHandle === 'string'
    && data.preparedHandle
    && data.status !== 'committed'
    && data.status !== 'succeeded'
  ) {
    Object.assign(state.skill_extract[unit.unit_id], applyResponseStateMetadata({
      ...state.skill_extract[unit.unit_id],
      status: 'prepared',
      prepared_handle: data.preparedHandle,
      proposal_hash: data.proposalHash || null,
      prepared_at: new Date().toISOString(),
    }, data, 'skill_extract'));
    clearTerminalRetryMetadata(state.skill_extract[unit.unit_id]);
    await writeState(statePath, state);
    return stageOutcome('succeeded');
  }
  if (
    fullResponseStatus(response, data) === 'skipped'
    || data.extracted === false
  ) {
    const terminal = applyResponseStateMetadata({
      ...state.skill_extract[unit.unit_id],
      status: 'skipped',
      skill_ids: [],
      input_hash: unit.input_hash,
      completed_at: new Date().toISOString(),
      verified_at: new Date().toISOString(),
      skipped_reason: data.reason || data.error || response.error || 'no clear procedure found',
    }, data, 'skill_extract');
    return persistTerminalThenRecord({
      state,
      statePath,
      target: state.skill_extract[unit.unit_id],
      terminalState: terminal,
      record: () => recordSkill('skipped', []),
      writeState,
    });
  }
  if (
    response.ok
    && (
      data.status === 'succeeded'
      || data.status === 'committed'
      || data.extracted === true
    )
  ) {
    const terminal = applyResponseStateMetadata({
      ...state.skill_extract[unit.unit_id],
      status: 'succeeded',
      skill_ids: resultIds,
      input_hash: unit.input_hash,
      completed_at: new Date().toISOString(),
      verified_at: new Date().toISOString(),
    }, data, 'skill_extract');
    return persistTerminalThenRecord({
      state,
      statePath,
      target: state.skill_extract[unit.unit_id],
      terminalState: terminal,
      record: () => recordSkill('succeeded', resultIds),
      writeState,
    });
  }
  const failure = classifyStageResponse({ ...response, data });
  Object.assign(state.skill_extract[unit.unit_id], {
    status: 'failed',
    error: compactStateError(response.error || data.error, 'skill_extract prepare failed'),
  });
  applyFailureState(state.skill_extract[unit.unit_id], failure);
  await writeState(statePath, state);
  return stageOutcome('failed', { failure });
}

export async function runSkillExtractCommitUnit({
  state,
  statePath,
  baseUrl,
  secret,
  unit,
  options = {},
}) {
  const writeState = options.writeState || writeStateAtomically;
  const existing = state.skill_extract[unit.unit_id];
  const recordSkill = (status, resultIds = []) => recordStageResult({
    state,
    baseUrl,
    secret,
    stage: 'skill_extract',
    unitId: unit.unit_id,
    sourceIds: unit.source_ids,
    resultIds,
    resultType: 'procedural',
    status,
    options,
  });
  if (terminalStageStatus(existing?.status)) {
    if (existing.record_pending) {
      return persistTerminalThenRecord({
        state,
        statePath,
        target: existing,
        terminalState: { ...existing },
        record: () => recordSkill(existing.status, existing.skill_ids || []),
        writeState,
      });
    }
    return stageOutcome(existing.status);
  }
  if (!existing?.prepared_handle) {
    return stageOutcome('failed', {
      failure: { class: 'hard', cause: 'skill_extract_proposal_missing' },
    });
  }
  existing.status = 'committing';
  await writeState(statePath, state);
  const response = await requestJson(
    baseUrl,
    secret,
    'POST',
    '/agentmemory/full/skill-extract/commit',
    buildFormalOperationBody({ preparedHandle: existing.prepared_handle }, {
      state,
      stage: 'skill_extract',
      unitId: unit.unit_id,
      inputHash: unit.input_hash,
    }),
    requestOptions(options),
  );
  const data = response.data || {};
  const status = fullResponseStatus(response, data);
  const resultIds = status === 'succeeded'
    ? resultIdsFromData(data, [
      'skillIds',
      'skill_ids',
      'proceduralMemoryIds',
      'procedural_memory_ids',
      'memoryIds',
      'memory_ids',
    ])
    : [];
  Object.assign(existing, applyResponseStateMetadata({
    ...existing,
    status,
    skill_ids: resultIds,
    input_hash: unit.input_hash,
    completed_at: new Date().toISOString(),
    ...(status === 'succeeded' ? { verified_at: new Date().toISOString() } : {}),
    ...(status === 'failed'
      ? { error: compactStateError(response.error || data.error, 'skill_extract commit failed') }
      : {}),
  }, data, 'skill_extract'));
  if (status === 'succeeded' || status === 'skipped') {
    return persistTerminalThenRecord({
      state,
      statePath,
      target: existing,
      terminalState: { ...existing },
      record: () => recordSkill(status, resultIds),
      writeState,
    });
  }
  const failure = classifyStageResponse({ ...response, data });
  applyFailureState(existing, failure);
  await writeState(statePath, state);
  return stageOutcome('failed', { failure });
}

async function planCrystalStage({ state, statePath, baseUrl, secret, options, dryRun }) {
  if (!dryRun && state.crystal_groups?.none?.record_pending) {
    const outcome = await writeNoneSkipped({
      state,
      statePath,
      baseUrl,
      secret,
      containerKey: 'crystal_groups',
      stage: 'crystal',
      resultType: 'crystal',
      reason: 'no eligible actions',
      dryRun,
      options,
    });
    return { outcome, units: [] };
  }
  const response = await requestJson(
    baseUrl,
    secret,
    'POST',
    '/agentmemory/full/crystals/auto',
    buildStageModelRequestBody({ dryRun: true }, options, 'crystal'),
    requestOptions(options),
  );
  if (!response.ok) {
    const failure = classifyStageResponse(response);
    state.crystal_groups.none = {
      unit_id: 'none',
      status: 'failed',
      error: compactStateError(response.error || response.data?.error, 'crystal_full plan failed'),
      completed_at: new Date().toISOString(),
      input_hash: stableHash('crystal:plan-failed'),
      ...failureStateMetadata(failure),
    };
    await writeStateAtomically(statePath, state);
    return { outcome: stageOutcome('failed', { failure }), units: [] };
  }
  const units = normalizePlanItems(response.data || response.response || {})
    .map((item, index) => normalizePlanUnit(item, index, 'cg'))
    .map((unit) => {
      const actionIds = unit.action_ids.length > 0 ? unit.action_ids : unit.source_ids;
      const actionUpdatedAts = unit.action_updated_ats || [];
      return {
        ...unit,
        source_ids: actionIds,
        action_ids: actionIds,
        action_updated_ats: actionUpdatedAts,
        input_hash: stableHash({ actionIds, actionUpdatedAts }),
      };
    });
  const recoveredPlanFailure = state.crystal_groups.none?.status === 'failed';
  if (recoveredPlanFailure) delete state.crystal_groups.none;
  if (units.length === 0) {
    if (options.resume && !recoveredPlanFailure) {
      validatePlannedContainerResume(state, options, 'crystal_groups', [{
        unit_id: 'none',
        input_hash: stableHash('no eligible actions'),
      }]);
    }
    const outcome = await writeNoneSkipped({
      state,
      statePath,
      baseUrl,
      secret,
      containerKey: 'crystal_groups',
      stage: 'crystal',
      resultType: 'crystal',
      reason: 'no eligible actions',
      dryRun,
      options,
    });
    return { outcome, units: [] };
  }
  if (options.resume && !recoveredPlanFailure) validatePlannedContainerResume(state, options, 'crystal_groups', units);
  delete state.crystal_groups.none;
  upsertPlannedUnits(state, 'crystal_groups', units, dryRun);
  await writeStateAtomically(statePath, state);
  return {
    outcome: stageOutcome('succeeded'),
    units: [{
      unit_id: 'auto',
      source_ids: units.flatMap((unit) => unit.action_ids || unit.source_ids || []),
      planned_group_ids: units.map((unit) => unit.unit_id),
      input_hash: stableHash(units.map((unit) => [unit.unit_id, unit.input_hash])),
    }],
  };
}

async function runCrystalAuto({ state, statePath, baseUrl, secret, unit, options }) {
  const plannedIds = unit.planned_group_ids || Object.keys(state.crystal_groups || {}).filter((id) => id !== 'none');
  const recordCrystal = (id, status, resultIds = []) => recordStageResult({
    state,
    baseUrl,
    secret,
    stage: 'crystal',
    unitId: id,
    sourceIds: state.crystal_groups[id]?.source_ids || [],
    resultIds,
    resultType: 'crystal',
    status,
    options,
  });
  for (const id of plannedIds) {
    const existing = state.crystal_groups[id];
    if (!terminalStageStatus(existing?.status) || !existing.record_pending) continue;
    const outcome = await persistTerminalThenRecord({
      state,
      statePath,
      target: existing,
      terminalState: { ...existing },
      record: () => recordCrystal(id, existing.status, existing.crystal_ids || []),
    });
    if (outcome.failure) return outcome;
  }
  const pendingIds = plannedIds.filter((id) => !terminalStageStatus(state.crystal_groups[id]?.status));
  if (pendingIds.length === 0) return stageOutcome('skipped');
  const startedAt = new Date().toISOString();
  for (const id of pendingIds) {
    const existing = state.crystal_groups[id] || {};
    state.crystal_groups[id] = {
      ...existing,
      status: 'running',
      started_at: existing.started_at || startedAt,
      attempt_count: (existing.attempt_count || 0) + 1,
    };
  }
  await writeStateAtomically(statePath, state);

  const response = await requestJson(
    baseUrl,
    secret,
    'POST',
    '/agentmemory/full/crystals/auto',
    buildFormalOperationBody(buildStageModelRequestBody({}, options, 'crystal'), {
      state,
      stage: 'crystal',
      unitId: unit.unit_id,
      inputHash: unit.input_hash,
    }),
    requestOptions(options),
  );
  if (!response.ok) {
    const failure = classifyStageResponse(response);
    for (const id of pendingIds) {
      state.crystal_groups[id] = {
        ...state.crystal_groups[id],
        status: 'failed',
        completed_at: new Date().toISOString(),
        ...failureStateMetadata(failure),
        error: compactStateError(response.error || response.data?.error, 'crystal_full failed'),
      };
      applyFailureState(state.crystal_groups[id], failure);
    }
    await writeStateAtomically(statePath, state);
    return stageOutcome('failed', { failure });
  }

  const groups = normalizePlanItems(response.data || response.response || {});
  if (groups.length === 0) {
    for (const id of pendingIds) {
      state.crystal_groups[id] = {
        ...state.crystal_groups[id],
        status: 'skipped',
        skipped_reason: response.data?.reason || 'no eligible crystal groups',
        completed_at: new Date().toISOString(),
      };
      const outcome = await persistTerminalThenRecord({
        state,
        statePath,
        target: state.crystal_groups[id],
        terminalState: { ...state.crystal_groups[id] },
        record: () => recordCrystal(id, 'skipped'),
      });
      if (outcome.failure) return outcome;
    }
    return stageOutcome('skipped');
  }

  let firstFailure = null;
  for (let index = 0; index < groups.length; index += 1) {
    const group = normalizePlanUnit(groups[index], index, 'cg');
    const status = fullResponseStatus({ ok: true }, group);
    const resultIds = resultIdsFromData(group, ['crystalIds', 'crystal_ids', 'memoryIds', 'memory_ids']);
    const groupFailure = status === 'failed'
      ? classifyStageResponse({ status_code: 200, data: group })
      : null;
    if (!firstFailure && groupFailure) firstFailure = groupFailure;
    const actionIds = group.action_ids.length > 0 ? group.action_ids : group.source_ids;
    const existing = state.crystal_groups[group.unit_id] || {};
    const actionUpdatedAts = group.action_updated_ats.length > 0
      ? group.action_updated_ats
      : (existing.action_updated_ats || []);
    state.crystal_groups[group.unit_id] = {
      ...existing,
      ...group,
      source_ids: actionIds,
      action_ids: actionIds,
      action_updated_ats: actionUpdatedAts,
      input_hash: stableHash({ actionIds, actionUpdatedAts }),
      status,
      crystal_ids: resultIds,
      completed_at: new Date().toISOString(),
      ...(status === 'succeeded' ? { verified_at: new Date().toISOString() } : {}),
      ...(status === 'skipped' ? { skipped_reason: group.reason || 'skipped by full endpoint' } : {}),
      ...(status === 'failed' ? {
        error: compactStateError(group.error, 'crystal group failed'),
        ...failureStateMetadata(groupFailure),
      } : {}),
    };
    if (groupFailure) applyFailureState(state.crystal_groups[group.unit_id], groupFailure);
    if (status === 'succeeded' || status === 'skipped') {
      const outcome = await persistTerminalThenRecord({
        state,
        statePath,
        target: state.crystal_groups[group.unit_id],
        terminalState: { ...state.crystal_groups[group.unit_id] },
        record: () => recordCrystal(group.unit_id, status, resultIds),
      });
      if (outcome.failure) return outcome;
    }
  }
  if (firstFailure) {
    await writeStateAtomically(statePath, state);
    return stageOutcome('failed', { failure: firstFailure });
  }
  return stageOutcome('succeeded');
}

export async function runWithConsecutiveFailureStop(label, state, statePath, work, options = {}) {
  let consecutiveFailures = 0;
  const concurrency = options.concurrency || 1;
  for (let start = 0; start < work.length; start += concurrency) {
    const batch = work.slice(start, start + concurrency);
    const settled = await Promise.allSettled(batch.map((item) => options.run(item)));
    const unexpectedFailure = settled.find((result) => result.status === 'rejected');
    if (unexpectedFailure) throw unexpectedFailure.reason;
    const results = settled.map((result) => result.value);
    let stopFailureCount = null;
    for (let offset = 0; offset < results.length; offset += 1) {
      const item = batch[offset];
      const result = results[offset];
      if (result === 'failed') consecutiveFailures += 1;
      else if (result === 'succeeded' || result === 'skipped' || result === 'retry_planned') consecutiveFailures = 0;
      if (stopFailureCount === null
        && consecutiveFailures >= state.config.stop_after_consecutive_failures) {
        stopFailureCount = consecutiveFailures;
      }
      if (typeof options.expand === 'function') {
        const nextItems = options.expand(item, result) || [];
        work.push(...nextItems);
      }
      state.coverage = computeCoverage(state);
      state.updated_at = new Date().toISOString();
      await writeStateAtomically(statePath, state);
      logProgress(label, 'item', {
        index: start + offset + 1,
        total: work.length,
        id: typeof options.itemId === 'function' ? options.itemId(item) : String(item),
        status: result,
        coverage: state.coverage,
      });
    }
    if (stopFailureCount !== null) {
      state.health.last_error = `连续 ${stopFailureCount} 个 ${label} 失败，停止推进`;
      await writeStateAtomically(statePath, state);
      throw new Error(state.health.last_error);
    }
    await sleep(state.config.delay_ms);
  }
}

function summarizedSessionIdsFromState(state) {
  return Object.values(state.sessions || {})
    .filter((item) => item.summary?.status === 'succeeded')
    .sort((a, b) => {
      const byTime = String(a.started_at || '').localeCompare(String(b.started_at || ''));
      return byTime || a.session_id.localeCompare(b.session_id);
    })
    .map((item) => item.session_id);
}

function semanticEntriesFromState(state) {
  return summarizedSessionIdsFromState(state).map((sessionId) => [
    sessionId,
    estimateSummaryPromptChars(state.sessions[sessionId]),
  ]);
}

function planSemanticWindowsForState(state) {
  return planSemanticWindowsByCharBudget(semanticEntriesFromState(state), {
    maxSessionCount: state.config.semantic_window_size,
    charBudget: state.config.semantic_rollup_target_prompt_chars ?? state.config.semantic_char_budget,
  });
}

function semanticWindowNeedsWork(window) {
  const status = window?.status || 'pending';
  return status === 'pending' || status === 'failed' || status === 'planned';
}

function collectSemanticLeafWindowsForExecution(state, windowId, work) {
  const window = state.semantic_windows?.[windowId];
  if (!window || !isValidSplitChildWindow(state, windowId, window)) return;
  if (window.status === 'split') {
    for (const childId of window.split_into || []) {
      collectSemanticLeafWindowsForExecution(state, childId, work);
    }
    return;
  }
  if (semanticWindowNeedsWork(window)) work.push(window);
}

export function semanticSplitLeafWindowsForExecution(state, windowId) {
  const work = [];
  for (const childId of state.semantic_windows?.[windowId]?.split_into || []) {
    collectSemanticLeafWindowsForExecution(state, childId, work);
  }
  return work;
}

function semanticWindowsForExecution(state, plannedWindows) {
  const work = [];
  for (const planned of plannedWindows) {
    const existing = state.semantic_windows?.[planned.window_id];
    if (existing?.status === 'split') {
      work.push(...semanticSplitLeafWindowsForExecution(state, planned.window_id));
      continue;
    }
    const window = existing || planned;
    if (semanticWindowNeedsWork(window)) work.push({ ...planned, ...window });
  }
  return work;
}

async function loadOrCreateState({ options, runId, statePath, now }) {
  if (options.resume) {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    migrateOrchestrationPolicy(state, now);
    return sanitizeStateSchema(state);
  }
  return sanitizeStateSchema(buildInitialState({
    runId,
    baseUrl: options.baseUrl,
    mark: options.mark,
    now,
    config: buildConfigFromOptions(options),
  }));
}

export async function runLocalRuntimeDiagnostics({ baseUrl, secret, options = {}, doctorHealthy = null }) {
  try {
    await getRuntimeConfig(baseUrl, secret, options);
    return { runtime_healthy: true, doctor_healthy: doctorHealthy };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { runtime_healthy: false, doctor_healthy: doctorHealthy };
  }
}

function stageItemState(state, stage, item) {
  if (stage === 'summary' || stage === 'lessons') {
    const session = state.sessions?.[String(item)];
    return stage === 'summary' ? session?.summary : session?.lessons_extract;
  }
  if (stage === 'semantic_rollup') return state.semantic_windows?.[item.window_id];
  const containerKey = {
    memory_consolidate: 'memory_consolidate_windows',
    skill_extract: 'skill_extract',
    crystal: 'crystal_groups',
    consolidation_procedural: 'consolidation_procedural_windows',
    reflect_insight: 'reflect_insight_windows',
  }[stage];
  return state[containerKey]?.[item.unit_id];
}

function initialStageOutcome(state, stage, item) {
  const target = stageItemState(state, stage, item);
  if (!target) return null;
  if (target.record_pending) {
    return stageOutcome('failed', { failure: { class: 'transient_runtime', cause: 'record_failed' } });
  }
  if (
    (target.status === 'succeeded' || target.status === 'skipped' || target.status === 'split')
    && target.recorded_at
  ) {
    return stageOutcome(target.status === 'skipped' ? 'skipped' : 'succeeded');
  }
  const storedFailure = stageFailureFromState(target);
  if (storedFailure) return stageOutcome('failed', { failure: storedFailure });
  if (target.status === 'failed') {
    return stageOutcome('failed', { failure: { class: 'unit', cause: 'historical_stage_failure' } });
  }
  return null;
}

export function initialPlanOutcome(state, containerKey) {
  const none = state[containerKey]?.none;
  if (!none) return null;
  if (none.record_pending) {
    return stageOutcome('failed', { failure: { class: 'transient_runtime', cause: 'record_failed' } });
  }
  if (none.status === 'failed') {
    const storedFailure = stageFailureFromState(none);
    if (storedFailure?.class === 'hard' && storedFailure.cause === 'http_404') {
      return stageOutcome('failed', {
        failure: { class: 'transient_runtime', cause: 'http_404' },
      });
    }
    return stageOutcome('failed', {
      failure: storedFailure || { class: 'unit', cause: 'historical_plan_failure' },
    });
  }
  return null;
}

function markStageItemIsolated(state, stage, item, outcome) {
  const now = new Date().toISOString();
  const failure = outcome?.failure || { class: 'unit', cause: 'unit_attempts_exhausted' };
  const target = stageItemState(state, stage, item);
  if (!target) return;
  target.isolated_at = now;
  target.isolation_epoch = state.scheduler_epoch;
  applyFailureState(target, failure);
}

class V2ExecutionPauseReached extends Error {
  constructor() {
    super('v2_execution_pause_reached');
    this.name = 'V2ExecutionPauseReached';
  }
}

function createV2DrainRequestProbe({ journal, fsApi, now = () => Date.now() }) {
  const requestPath = path.join(journal.rootDir, 'drain-request.json');
  return async () => {
    const raw = await fsApi.readFile(requestPath, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return null;
    let request;
    try {
      request = JSON.parse(raw);
    } catch {
      throw new Error('v2_drain_request_invalid');
    }
    if (
      request?.format !== 'agentmemory-full-extraction-drain-request/v2'
      || request?.schema_version !== 2
      || request?.run_id !== journal.runId
      || typeof request?.owner_id !== 'string'
      || !request.owner_id
      || typeof request?.requested_at !== 'string'
    ) {
      throw new Error('v2_drain_request_invalid');
    }
    if (request.owner_id !== journal.lock?.owner_id) {
      throw new Error('v2_drain_request_owner_mismatch');
    }
    const requestedAt = Date.parse(request.requested_at);
    const lockCreatedAt = Date.parse(journal.lock?.created_at || '');
    if (
      !Number.isFinite(requestedAt)
      || !Number.isFinite(lockCreatedAt)
      || requestedAt < lockCreatedAt
      || requestedAt > now() + 60_000
    ) {
      throw new Error('v2_drain_request_time_invalid');
    }
    return { requestedAt: request.requested_at };
  };
}

function createV2ExecutionBoundary({ limit, drainRequestProbe }) {
  if (limit === null && typeof drainRequestProbe !== 'function') return null;
  let remaining = limit;
  let processed = 0;
  let last = null;
  let pause = null;
  const pollDrain = async ({ stage, unitId }) => {
    const drainRequest = await drainRequestProbe?.();
    if (!drainRequest) return false;
    pause = {
      reasonCode: 'operator_drain_requested',
      stage,
      lastUnitId: last?.unitId || null,
      nextUnitId: unitId,
      processedCount: processed,
      requestedAt: drainRequest.requestedAt,
    };
    return true;
  };
  return {
    limit,
    async claim({ stage, unitId }) {
      if (await pollDrain({ stage, unitId })) return false;
      if (remaining !== null && remaining <= 0) return false;
      if (remaining !== null) remaining -= 1;
      processed += 1;
      last = { stage, unitId };
      return true;
    },
    pollDrain,
    reached() {
      if (pause) return true;
      if (limit !== null && processed > 0 && remaining === 0) {
        pause = {
          reasonCode: 'resume_unit_limit_reached',
          stage: last.stage,
          lastUnitId: last.unitId,
          processedCount: processed,
        };
        return true;
      }
      return false;
    },
    pause: () => pause,
    processedCount: () => processed,
    lastUnitId: () => last?.unitId || null,
    lastStage: () => last?.stage || null,
  };
}

async function runV2JournalSingleStage({
  stage,
  control,
  journal,
  durable,
  plan,
  adapter,
  planOnly,
  dependencyStates = new Map(),
  executionBoundary = null,
  inProcessAcceptedUnitIds = null,
}) {
  const opened = control.some((event) => event.type === 'stage_opened' && event.payload?.stage === stage);
  if (!opened) await durable('control', 'stage_opened', { stage });
  const events = await journal.readStage(stage);
  const effectivePlan = events.some((event) => event.type === 'stage_plan_completed')
    ? events.filter((event) => event.type === 'unit_planned').map((event) => event.payload)
    : await (typeof plan === 'function' ? plan() : plan);
  const planMetadata = {
    plan_hash: stableHash(effectivePlan),
    order_hash: stableHash(effectivePlan.map((unit) => unit.unit_id)),
  };
  const result = await runSinglePhaseStage({
    events,
    plan: effectivePlan,
    planMetadata,
    append: (type, payload) => durable(stage, type, payload),
    planOnly,
    stage,
    dependencyStates,
    ...adapter,
    executionBoundary,
    inProcessAcceptedUnitIds,
  });
  const recoveryProjection = reduceRecoveryJournal(await journal.readStage(stage)).run;
  let statusEntry;
  if (result.status === 'completed') {
    statusEntry = {
      status: 'completed',
      accepted: result.acceptedCount,
      ...(recoveryProjection
        ? {
            recovery_policy_version: RECOVERY_POLICY_VERSION,
            recovery: recoveryProjection.projection,
            acceptance_ready: recoveryProjection.acceptance_ready,
          }
        : {}),
    };
    await journal.writeStatus({
      current_stage: null,
      [stage]: statusEntry,
    });
  } else {
    statusEntry = {
      status: result.status,
      ...(result.unitId ? { unit_id: result.unitId } : {}),
      ...(result.failure ? { failure: normalizeFailureClassification(result.failure) } : {}),
      ...(recoveryProjection
        ? {
            recovery_policy_version: RECOVERY_POLICY_VERSION,
            recovery: recoveryProjection.projection,
            acceptance_ready: recoveryProjection.acceptance_ready,
          }
        : {}),
    };
    if (result.status !== 'paused') {
      await journal.writeStatus({
        current_stage: stage,
        [stage]: statusEntry,
      });
    }
  }
  return {
    ...result,
    statusEntry,
    control: await journal.readControl(),
  };
}

async function runV2JournalTwoPhaseStage({
  stage,
  control,
  journal,
  durable,
  plan,
  adapter,
  planOnly,
  executionBoundary = null,
  inProcessAcceptedUnitIds = null,
}) {
  const opened = control.some((event) => event.type === 'stage_opened' && event.payload?.stage === stage);
  if (!opened) await durable('control', 'stage_opened', { stage });
  const events = await journal.readStage(stage);
  const effectivePlan = events.some((event) => event.type === 'stage_plan_completed')
    ? events.filter((event) => event.type === 'unit_planned').map((event) => event.payload)
    : await (typeof plan === 'function' ? plan() : plan);
  const planMetadata = {
    plan_hash: stableHash(effectivePlan),
    order_hash: stableHash(effectivePlan.map((unit) => unit.unit_id)),
  };
  const result = await runTwoPhaseStage({
    events,
    plan: effectivePlan,
    planMetadata,
    append: (type, payload) => durable(stage, type, payload),
    planOnly,
    stage,
    ...adapter,
    executionBoundary,
    inProcessAcceptedUnitIds,
  });
  const latestEvents = await journal.readStage(stage);
  const hasRecoveryProjection = latestEvents.some((event) => (
    event.type === 'unit_outcome_observed'
    || event.type === 'unit_effect_committed'
    || event.type === 'unit_reconciliation_requested'
    || event.type === 'unit_commit_resumed'
    || event.type === 'unit_isolated'
    || event.type === 'run_blocked'
  ));
  const recoveryProjection = hasRecoveryProjection
    ? reduceRecoveryJournal(latestEvents).run
    : null;
  if (result.status === 'completed') {
    await journal.writeStatus({
      current_stage: null,
      [stage]: {
        status: 'completed',
        accepted: result.acceptedCount,
        ...(recoveryProjection
          ? {
              recovery_policy_version: RECOVERY_POLICY_VERSION,
              recovery: recoveryProjection.projection,
              acceptance_ready: recoveryProjection.acceptance_ready,
            }
          : {}),
      },
    });
  } else if (result.status !== 'paused') {
    await journal.writeStatus({
      current_stage: stage,
      [stage]: {
        status: result.status,
        ...(result.unitId ? { unit_id: result.unitId } : {}),
        ...(recoveryProjection
          ? {
              recovery_policy_version: RECOVERY_POLICY_VERSION,
              recovery: recoveryProjection.projection,
              acceptance_ready: recoveryProjection.acceptance_ready,
            }
          : {}),
      },
    });
  }
  return { ...result, control: await journal.readControl() };
}

function buildV2SummaryPlan(sessions, baseUrl, options) {
  return sessions.map((session) => ({
    unit_id: session.id,
    input_hash: stableHash({
      session_id: session.id,
      started_at: session.startedAt || null,
    }),
    request_hash: stableHash({
      base_url: baseUrl,
      stage: 'summary',
      request: buildSummaryBody(session.id, options),
    }),
  }));
}

export function resolveV2FrozenSummaryInventory({
  options,
  started,
  sessions,
  eligibleSummarySessions = sessions,
  events,
  baseUrl,
}) {
  if (!options.resume || !started || events.length === 0) return null;
  const lifecycle = validateSinglePhaseStage(events);
  if (!lifecycle.planCompleted) return null;

  const plan = events
    .filter((event) => event.type === 'unit_planned')
    .map((event) => event.payload);
  const completed = events.find((event) => event.type === 'stage_plan_completed');
  const expectedKeys = ['input_hash', 'request_hash', 'unit_id'];
  if (
    !completed
    || Number(completed.payload?.unit_count) !== plan.length
    || completed.payload?.plan_hash !== stableHash(plan)
    || completed.payload?.order_hash !== stableHash(plan.map((unit) => unit.unit_id))
    || plan.some((unit) => (
      Object.keys(unit || {}).sort().join(',') !== expectedKeys.join(',')
      || typeof unit.unit_id !== 'string'
      || !unit.unit_id
      || typeof unit.input_hash !== 'string'
      || !unit.input_hash
      || typeof unit.request_hash !== 'string'
      || !unit.request_hash
    ))
  ) {
    throw new Error('v2_frozen_plan_invalid');
  }

  const livePlan = buildV2SummaryPlan(eligibleSummarySessions, baseUrl, options);
  const livePlanById = new Map(livePlan.map((unit) => [unit.unit_id, unit]));
  const liveSessionById = new Map(sessions.map((session) => [session.id, session]));
  for (const unit of plan) {
    const liveUnit = livePlanById.get(unit.unit_id);
    if (!liveUnit || !liveSessionById.has(unit.unit_id)) {
      throw new Error('v2_frozen_plan_source_missing');
    }
    if (
      liveUnit.input_hash !== unit.input_hash
      || liveUnit.request_hash !== unit.request_hash
    ) {
      throw new Error('v2_frozen_plan_source_drifted');
    }
  }

  const eligibleSummaryIds = new Set(eligibleSummarySessions.map((session) => session.id));
  const frozenOpenIds = new Set(plan.map((unit) => unit.unit_id));
  const frozenSessions = sessions.filter((session) => (
    !eligibleSummaryIds.has(session.id) || frozenOpenIds.has(session.id)
  ));
  const inventoryHash = computeInventoryHash(frozenSessions, options.agentId);
  if (started.payload?.inventory_hash !== inventoryHash) {
    throw new Error('v2_frozen_plan_inventory_drifted');
  }
  return {
    sessions: frozenSessions,
    inventoryHash,
    plan,
    addedCount: sessions.length - frozenSessions.length,
  };
}

function buildV2LessonsPlan(sessions, baseUrl, options) {
  return sessions.map((session) => ({
    unit_id: session.id,
    input_hash: stableHash({
      session_id: session.id,
      started_at: session.startedAt || null,
    }),
    request_hash: stableHash({
      base_url: baseUrl,
      stage: 'lessons',
      request: buildLessonExtractBody(session.id, options),
    }),
    depends_on: [{
      stage: 'summary',
      unit_id: session.id,
    }],
  }));
}

function recoveryDependencyStates(stage, events) {
  const reduced = reduceRecoveryJournal(events);
  return new Map([...reduced.units.values()].map((unit) => [
    `${stage}:${unit.unit_id}`,
    {
      state: unit.recovery.state,
      terminal: unit.terminal,
      recorded: unit.recorded,
      ...(Number.isSafeInteger(unit.terminal_seq)
        ? { source_seq: unit.terminal_seq }
        : {}),
    },
  ]));
}

function verifiedV2SummaryResult(data, unit, attemptId) {
  if (
    !isUsableSummary(data?.summary)
    || data.attemptId !== attemptId
    || data.runnerInputHash !== unit.input_hash
    || typeof data.serviceInputHash !== 'string'
    || !data.serviceInputHash
    || typeof data.resumableRunId !== 'string'
    || !data.resumableRunId
  ) {
    return null;
  }
  return {
    summary_hash: stableHash(summaryPromptFields(data.summary)),
    service_input_hash: data.serviceInputHash,
    resumable_run_id: data.resumableRunId,
    runner_input_hash: data.runnerInputHash,
  };
}

function nextV2SummaryOperationId(unitId, operationId, data) {
  const mapPrefix = `${unitId}:map:`;
  if (!operationId.startsWith(mapPrefix)) {
    throw new Error(`v2_summary_operation_sequence_invalid:${operationId}`);
  }
  const chunkIndex = Number.parseInt(operationId.slice(mapPrefix.length), 10);
  const totalChunks = Number(data.totalChunks);
  if (
    !Number.isSafeInteger(chunkIndex)
    || chunkIndex < 0
    || !Number.isSafeInteger(totalChunks)
    || totalChunks <= chunkIndex
  ) {
    throw new Error(`v2_summary_operation_progress_invalid:${operationId}`);
  }
  return chunkIndex + 1 < totalChunks
    ? `${unitId}:map:${chunkIndex + 1}`
    : `${unitId}:reduce`;
}

function buildV2SummaryAdapter({ baseUrl, secret, options, runId, summaryRemote }) {
  const reconciliationBinding = (
    result,
    {
      unit,
      attemptId,
      operationId,
      expectedReceiptInputHash,
    },
  ) => (
    extractionOperationReconciliationBinding(result, {
      attemptId,
      stage: 'summary',
      unitId: operationId,
      runnerInputHash: unit.input_hash,
      expectedReceiptInputHash,
      stableHash,
    })
  );
  return {
    attemptIdForUnit: (unit, attemptNumber = 0) => stableHash({
      run_id: runId,
      stage: 'summary',
      unit_id: unit.unit_id,
      ...(attemptNumber > 0 ? { attempt_number: attemptNumber } : {}),
    }),
    verifyRecoveredTerminal: async ({
      unit,
      attemptId,
      terminal,
      completedOperations,
      recoveryBudget,
    }) => {
      const operationId = completedOperations.at(-1)?.operation_id;
      const result = await summaryRemote.advance({
        baseUrl,
        secret,
        sessionId: unit.unit_id,
        attemptId,
        inputHash: unit.input_hash,
        operationUnitId: operationId,
        requireExistingReceipt: true,
        request: buildSummaryBody(unit.unit_id, options),
        signal: options.signal,
      });
      const data = result?.data || result || {};
      const payload = verifiedV2SummaryResult(data, unit, attemptId);
      const terminalMatches = terminal?.status === 'succeeded'
        && payload
        && terminal.summary_hash === payload.summary_hash
        && terminal.service_input_hash === payload.service_input_hash
        && terminal.resumable_run_id === payload.resumable_run_id
        && terminal.runner_input_hash === payload.runner_input_hash;
      return {
        recoveryCandidate: adaptSummaryOperationEvidence({
          result: terminalMatches
            ? result
            : {
                ok: false,
                error: 'summary_recovered_terminal_unverified',
                data: {
                  status: 'failed',
                  error: 'summary_recovered_terminal_unverified',
                },
              },
          unit,
          attemptId,
          operationId,
        }),
      };
    },
    execute: async ({
      unit,
      attemptId,
      activeOperation,
      completedOperations,
      observedOutcomes = [],
      retryAuthorization,
      recoveryBudget,
      startOperation,
      completeOperation,
      resolveOutcome,
    }) => {
      const completedTerminal = completedOperations.at(-1)?.terminal_result;
      let operationId = activeOperation?.operation_id
        || (completedTerminal ? completedOperations.at(-1)?.operation_id : null)
        || completedOperations.at(-1)?.next_operation_id
        || `${unit.unit_id}:map:0`;
      let operationStarted = Boolean(activeOperation);
      let requireExistingReceipt = Boolean(activeOperation)
        || retryAuthorization?.operation_id === operationId;
      let expectedReceiptInputHash;
      for (let advance = 0; advance < SUMMARY_ADVANCE_MAX_CALL_LIMIT; advance += 1) {
        if (completedTerminal) {
          const result = await summaryRemote.advance({
            baseUrl,
            secret,
            sessionId: unit.unit_id,
            attemptId,
            inputHash: unit.input_hash,
            operationUnitId: operationId,
            requireExistingReceipt: true,
            request: buildSummaryBody(unit.unit_id, options),
            signal: options.signal,
          });
          const data = result?.data || result || {};
          const payload = verifiedV2SummaryResult(data, unit, attemptId);
          const terminalMatches = completedTerminal.status === 'succeeded'
            && payload
            && completedTerminal.payload?.summary_hash === payload.summary_hash
            && completedTerminal.payload?.service_input_hash === payload.service_input_hash
            && completedTerminal.payload?.resumable_run_id === payload.resumable_run_id
            && completedTerminal.payload?.runner_input_hash === payload.runner_input_hash;
          const recovery = await resolveOutcome({
            operationId,
            verification: true,
            ...adaptSummaryOperationEvidence({
              result: terminalMatches
                ? result
                : {
                    ok: false,
                    error: 'summary_recovered_terminal_unverified',
                    data: {
                      status: 'failed',
                      error: 'summary_recovered_terminal_unverified',
                    },
                  },
              unit,
              attemptId,
              operationId,
            }),
          });
          if (terminalMatches && recovery.decision.action === 'replay') {
            return { ...completedTerminal, recovery };
          }
          return {
            status: 'blocked',
            reason: 'summary_recovered_terminal_unverified',
            payload: { error: 'summary_recovered_terminal_unverified' },
            recovery,
          };
        }
        if (!operationStarted) {
          await startOperation({ operationId });
          operationStarted = true;
        }
        const result = await summaryRemote.advance({
          baseUrl,
          secret,
          sessionId: unit.unit_id,
          attemptId,
          inputHash: unit.input_hash,
          operationUnitId: operationId,
          requireExistingReceipt,
          expectedReceiptInputHash,
          ...(retryAuthorization?.operation_id === operationId
            ? {
                failedReceiptRetryAuthorization: {
                  receiptInputHash: retryAuthorization.receipt_input_hash,
                  retryEpoch: retryAuthorization.retry_epoch,
                  failureClass: retryAuthorization.failure_class,
                  failureCause: retryAuthorization.failure_cause,
                  failurePhase: retryAuthorization.failure_phase,
                  lastSafeFailure: {
                    errorClass: retryAuthorization.last_safe_failure.error_class,
                    cause: retryAuthorization.last_safe_failure.cause,
                    phase: retryAuthorization.last_safe_failure.phase,
                    timestamp: retryAuthorization.last_safe_failure.timestamp,
                  },
                },
              }
            : {}),
          request: buildSummaryBody(unit.unit_id, options),
          signal: options.signal,
        });
        const data = result?.data || result || {};
        const receiptBinding = reconciliationBinding(result, {
          unit,
          attemptId,
          operationId,
          expectedReceiptInputHash,
        });
        const failureCause = data?.failure?.cause || data?.failure?.error || data?.error || result?.error;
        const authorizedOperation = retryAuthorization?.operation_id === operationId;
        const statusCode = Number(result?.status_code ?? result?.statusCode ?? 0);
        const receiptAbsence = (
          requireExistingReceipt
          && !retryAuthorization
        )
          ? exactExtractionOperationReceiptAbsence(result, {
              attemptId,
              stage: 'summary',
              unitId: operationId,
              runnerInputHash: unit.input_hash,
              stableHash,
            })
          : null;
        if (receiptAbsence) {
          expectedReceiptInputHash = receiptAbsence.inputHash;
          requireExistingReceipt = false;
          continue;
        }
        const hasRecoveryContract = Boolean(data?.recoveryEvidence)
          || (
            typeof data?.failure?.class === 'string'
            && typeof data?.failure?.cause === 'string'
          )
          || [
            'extraction_operation_reconciliation_required',
            'extraction_operation_input_hash_conflict',
          ].includes(failureCause);
        const observeRecovery = async () => {
          return resolveOutcome({
            operationId,
            ...adaptSummaryOperationEvidence({
              result,
              unit,
              attemptId,
              operationId,
            }),
          });
        };
        const legacyAuthorizedFailure = data?.failure;
        if (result?.ok === false && statusCode >= 500 && !hasRecoveryContract) {
          return { status: 'pending' };
        }
        if (
          authorizedOperation
          && failureCause === 'extraction_operation_reconciliation_required'
        ) {
          return {
            status: 'blocked',
            reason: failureCause,
            payload: { error: failureCause },
          };
        }
        if (
          authorizedOperation
          && result?.ok === false
          && statusCode === 0
        ) {
          return { status: 'pending' };
        }
        if (
          authorizedOperation
          && operationId.endsWith(':reduce')
          && ['transient_provider', 'transient_runtime'].includes(legacyAuthorizedFailure?.class)
          && ['provider_call', 'before_final_persistence'].includes(legacyAuthorizedFailure?.phase)
        ) {
          const terminalResult = {
            status: 'failed',
            payload: { error: legacyAuthorizedFailure.cause },
          };
          await completeOperation({
            operationId,
            status: 'failed',
            error: legacyAuthorizedFailure.cause,
            terminal_result: terminalResult,
          });
          return terminalResult;
        }
        if ([
          'extraction_operation_reconciliation_required',
          'extraction_operation_input_hash_conflict',
        ].includes(failureCause)) {
          const recovery = await observeRecovery();
          return {
            status: 'blocked',
            reason: failureCause,
            payload: { error: failureCause },
            recovery,
            ...(receiptBinding ? { reconciliationBinding: receiptBinding } : {}),
          };
        }
        if (result?.ok === false && statusCode === 0) {
          if (!receiptBinding) return { status: 'pending' };
          const recovery = await observeRecovery();
          if (recovery.decision.action !== 'reconcile') {
            throw new Error('v2_summary_recovery_decision_invalid');
          }
          return {
            status: 'pending',
            recovery,
            reconciliationBinding: receiptBinding,
          };
        }
        if (
          result?.ok === false
          || ['failed', 'infeasible', 'preflight_unavailable', 'skipped'].includes(data.status)
        ) {
          const recovery = await observeRecovery();
          if (recovery.decision.action === 'skipped') {
            const terminalResult = {
              status: 'skipped',
              payload: { reason: recovery.evidence.reasonCode },
            };
            await completeOperation({
              operationId,
              status: 'skipped',
              terminal_result: terminalResult,
            });
            return { ...terminalResult, recovery };
          }
          if (recovery.decision.action === 'retry') {
            return { status: 'pending', recovery };
          }
          if (recovery.decision.action === 'reconcile') {
            return {
              status: 'blocked',
              reason: 'summary_reconciliation_required',
              payload: { error: 'summary_reconciliation_required' },
              recovery,
              ...(receiptBinding ? { reconciliationBinding: receiptBinding } : {}),
            };
          }
          if (recovery.decision.action === 'isolate') {
            const terminalResult = {
              status: 'failed',
              payload: { error: recovery.evidence.reasonCode },
            };
            await completeOperation({
              operationId,
              status: 'failed',
              error: recovery.evidence.reasonCode,
              terminal_result: terminalResult,
            });
            return { ...terminalResult, recovery };
          }
          if (recovery.decision.action === 'block_run') {
            return {
              status: 'blocked',
              reason: recovery.decision.code,
              payload: { error: recovery.decision.code },
              recovery,
            };
          }
          const failure = data?.failure;
          if (
            operationId.endsWith(':reduce')
            && ['transient_provider', 'transient_runtime'].includes(failure?.class)
            && ['provider_call', 'before_final_persistence'].includes(failure?.phase)
          ) {
            return {
              status: 'pending',
              failure,
            };
          }
          const terminalResult = {
            status: 'failed',
            payload: { error: failureCause || 'resumable summarize failed' },
          };
          await completeOperation({
            operationId,
            status: 'failed',
            error: failureCause || 'resumable summarize failed',
            terminal_result: terminalResult,
          });
          return terminalResult;
        }
        if (data.operationUnitId && data.operationUnitId !== operationId) {
          const recovery = await observeRecovery();
          return {
            status: 'blocked',
            reason: 'summary_operation_identity_conflict',
            payload: { error: 'summary_operation_identity_conflict', operation_id: operationId },
            recovery,
          };
        }
        if (data.status === 'succeeded') {
          const payload = verifiedV2SummaryResult(data, unit, attemptId);
          if (!payload) {
            const recovery = await observeRecovery();
            return {
              status: 'blocked',
              reason: 'summary_source_unproven',
              payload: { error: 'summary_source_unproven' },
              recovery,
            };
          }
          const recoveryCandidate = adaptSummaryOperationEvidence({
            result,
            unit,
            attemptId,
            operationId,
          });
          const terminalResult = {
            status: 'succeeded',
            payload,
          };
          await completeOperation({
            operationId,
            status: 'succeeded',
            terminal_result: terminalResult,
          });
          const recovery = await resolveOutcome({
            operationId,
            verification: true,
            ...recoveryCandidate,
          });
          if (recovery.decision.action !== 'replay') {
            return {
              status: 'blocked',
              reason: 'summary_recovery_contract_invalid',
              payload: { error: 'summary_recovery_contract_invalid' },
              recovery,
            };
          }
          return { ...terminalResult, recovery };
        }
        if (data.status !== 'in_progress' || !['completed', 'skipped', 'none'].includes(data.advanced)) {
          const recovery = await observeRecovery();
          if (recovery.decision.action === 'reconcile') {
            return {
              status: 'blocked',
              reason: 'summary_reconciliation_required',
              payload: { error: 'summary_reconciliation_required' },
              recovery,
              ...(receiptBinding ? { reconciliationBinding: receiptBinding } : {}),
            };
          }
          return {
            status: 'blocked',
            reason: recovery.decision.code || 'summary_recovery_contract_invalid',
            payload: {
              error: recovery.decision.code || 'summary_recovery_contract_invalid',
            },
            recovery,
          };
        }
        if (data.advanced === 'none') return { status: 'pending' };
        const nextOperationId = nextV2SummaryOperationId(unit.unit_id, operationId, data);
        await completeOperation({
          operationId,
          status: data.advanced,
          completed_chunks: data.completedChunks,
          total_chunks: data.totalChunks,
          skipped_chunks: data.skippedChunks,
          next_operation_id: nextOperationId,
        });
        operationId = nextOperationId;
        operationStarted = false;
        requireExistingReceipt = false;
        expectedReceiptInputHash = undefined;
        if (options.delayMs > 0) await sleep(Math.min(options.delayMs, 500), { signal: options.signal });
      }
      return { status: 'pending' };
    },
    record: ({ unit, attemptId }) => summaryRemote.record({
      baseUrl,
      secret,
      runId,
      mark: options.mark,
      sessionId: unit.unit_id,
      attemptId,
      inputHash: unit.input_hash,
      signal: options.signal,
    }),
  };
}

function buildV2LessonsAdapter({ baseUrl, secret, options, runId, lessonsRemote }) {
  return {
    attemptIdForUnit: (unit, attemptNumber = 0) => stableHash({
      run_id: runId,
      stage: 'lessons',
      unit_id: unit.unit_id,
      ...(attemptNumber > 0 ? { attempt_number: attemptNumber } : {}),
    }),
    verifyRecoveredTerminal: async ({
      unit,
      attemptId,
      terminal,
      completedOperations,
      recoveryBudget,
    }) => {
      const operationId = completedOperations.at(-1)?.operation_id;
      const result = await lessonsRemote.start({
        baseUrl,
        secret,
        sessionId: unit.unit_id,
        attemptId,
        inputHash: unit.input_hash,
        requireExistingReceipt: true,
        request: buildLessonExtractBody(unit.unit_id, options),
        signal: options.signal,
      });
      const data = result?.data || result || {};
      const lessonRun = data?.runs?.[0] || data?.run || null;
      return {
        recoveryCandidate: adaptLessonOperationEvidence({
          result: terminal?.status === 'succeeded' && terminal.run_id === lessonRun?.id
            ? result
            : {
                ok: false,
                data: {
                  failure: { cause: 'lessons_recovered_terminal_unverified' },
                },
              },
          unit,
          attemptId,
          operationId,
        }),
      };
    },
    execute: async ({ unit, attemptId, recovered, retryAuthorization, activeOperation, completedOperations, startOperation, completeOperation, resolveOutcome }) => {
      const operationId = activeOperation?.operation_id
        || completedOperations?.at(-1)?.operation_id
        || `${unit.unit_id}:lessons`;
      let operationStarted = Boolean(activeOperation);
      const authorizedRetry = retryAuthorization?.stage === 'lessons'
        ? {
            failedReceiptRetryAuthorization: {
              receiptInputHash: retryAuthorization.receipt_input_hash,
              retryEpoch: retryAuthorization.retry_epoch,
              failureClass: retryAuthorization.failure_class,
              failureCause: retryAuthorization.failure_cause,
              failurePhase: retryAuthorization.failure_phase,
              lastSafeFailure: {
                errorClass: retryAuthorization.last_safe_failure.error_class,
                cause: retryAuthorization.last_safe_failure.cause,
                phase: retryAuthorization.last_safe_failure.phase,
                timestamp: retryAuthorization.last_safe_failure.timestamp,
              },
            },
            failedLessonRunEvidence: {
              status: retryAuthorization.lesson_run_evidence.status,
              inputHash: retryAuthorization.lesson_run_evidence.input_hash,
              configHash: retryAuthorization.lesson_run_evidence.config_hash,
              failureCause: retryAuthorization.lesson_run_evidence.failure_cause,
              failurePhase: retryAuthorization.lesson_run_evidence.failure_phase,
              failedAt: retryAuthorization.lesson_run_evidence.failed_at,
              createdLessonCount: retryAuthorization.lesson_run_evidence.created_lesson_count,
              replacedLessonCount: retryAuthorization.lesson_run_evidence.replaced_lesson_count,
              chunkLessonCount: retryAuthorization.lesson_run_evidence.chunk_lesson_count,
            },
          }
        : {};
      if (
        !operationStarted
        && !completedOperations?.at(-1)?.terminal_result
      ) {
        await startOperation({ operationId });
        operationStarted = true;
      }
      const requestResult = await executeReceiptAwareRequest({
        recovered: recovered || Boolean(activeOperation),
        invoke: (requireExistingReceipt, expectedReceiptInputHash) => lessonsRemote.start({
          baseUrl,
          secret,
          sessionId: unit.unit_id,
          attemptId,
          inputHash: unit.input_hash,
          requireExistingReceipt,
          expectedReceiptInputHash,
          ...authorizedRetry,
          request: buildLessonExtractBody(unit.unit_id, options),
          signal: options.signal,
        }),
        acceptReceiptAbsence: !retryAuthorization
          ? (response) => exactExtractionOperationReceiptAbsence(response, {
              attemptId,
              stage: 'lessons',
              unitId: unit.unit_id,
              runnerInputHash: unit.input_hash,
              stableHash,
            })
          : () => false,
      });
      if (requestResult.pending) return { status: 'pending' };
      const result = requestResult.response;
      const data = result?.data || result || {};
      const reconciliationBinding = extractionOperationReconciliationBinding(
        result,
        {
          attemptId,
          stage: 'lessons',
          unitId: unit.unit_id,
          runnerInputHash: unit.input_hash,
          expectedReceiptInputHash: requestResult.expectedReceiptInputHash,
          stableHash,
        },
      );
      const failure = data?.failure;
      const failureCause = data?.failure?.cause || data?.failure?.error || data?.error || result?.error;
      const hasRecoveryContract = Boolean(data?.lessonEvidence)
        || data?.failure?.cause === 'lesson_no_blocks'
        || failureCause === 'extraction_operation_reconciliation_required';
      const statusCode = Number(result?.status_code ?? result?.statusCode ?? 0);
      if (result?.ok === false && statusCode >= 500 && !hasRecoveryContract) {
        return { status: 'pending' };
      }
      const recoveryCandidate = hasRecoveryContract
        ? adaptLessonOperationEvidence({ result, unit, attemptId, operationId })
        : null;
      if (
        recoveryCandidate
        && !operationStarted
        && !completedOperations?.at(-1)?.terminal_result
      ) {
        await startOperation({ operationId });
        operationStarted = true;
      }
      const recovery = recoveryCandidate
        ? await resolveOutcome({
            operationId,
            verification: !operationStarted
              && Boolean(completedOperations?.at(-1)?.terminal_result),
            ...recoveryCandidate,
          })
        : null;
      if (recovery && [
        'resume_commit',
        'reconcile_commit',
        'retry',
        'reconcile',
      ].includes(recovery.decision.action)) {
        return {
          status: recovery.decision.action === 'reconcile' ? 'blocked' : 'pending',
          ...(recovery.decision.action === 'reconcile'
            ? {
                reason: 'lessons_reconciliation_required',
                payload: { error: 'lessons_reconciliation_required' },
              }
            : {}),
          recovery,
          ...(reconciliationBinding ? { reconciliationBinding } : {}),
        };
      }
      if (recovery?.decision.action === 'skipped') {
        const terminalResult = {
          status: 'skipped',
          payload: { reason: recovery.evidence.reasonCode },
        };
        await completeOperation({
          operationId,
          status: 'skipped',
          terminal_result: terminalResult,
        });
        return { ...terminalResult, recovery };
      }
      if (recovery?.decision.action === 'isolate') {
        const terminalResult = {
          status: 'failed',
          payload: { error: recovery.evidence.reasonCode },
        };
        await completeOperation({
          operationId,
          status: 'failed',
          terminal_result: terminalResult,
        });
        return { ...terminalResult, recovery };
      }
      if (recovery?.decision.action === 'block_run') {
        return {
          status: 'blocked',
          reason: recovery.decision.code,
          payload: { error: recovery.decision.code },
          recovery,
        };
      }
      if (failureCause === 'extraction_operation_reconciliation_required') {
        return {
          status: 'blocked',
          reason: failureCause,
          payload: { error: failureCause },
          recovery,
          ...(reconciliationBinding ? { reconciliationBinding } : {}),
        };
      }
      if (result?.ok === false) {
        if (
          ['transient_provider', 'transient_runtime'].includes(failure?.class)
            && ['provider_call', 'before_final_persistence'].includes(failure?.phase)
        ) {
          return { status: 'pending', failure, recovery };
        }
        if (recovery?.decision.action === 'replay') {
          return {
            status: 'blocked',
            reason: 'lessons_recovery_contract_invalid',
            payload: { error: 'lessons_recovery_contract_invalid' },
          };
        }
        const terminalResult = {
          status: 'failed',
          payload: { error: failureCause || 'lessons extract failed' },
        };
        if (operationStarted) {
          await completeOperation({
            operationId,
            status: 'failed',
            terminal_result: terminalResult,
          });
        }
        return { ...terminalResult, recovery };
      }
      const lessonRun = data?.runs?.[0] || data?.run || null;
      const lessonRunId = lessonRun?.id || lessonRun?.runId || lessonRun?.run_id || null;
      if (!lessonRunId) {
        return { status: 'blocked', payload: { error: 'lessons extract returned no run id' }, recovery };
      }
      const lessonStatus = lessonRun.status || data.status || 'running';
      if (['succeeded', 'skipped'].includes(lessonStatus)) {
        const terminalResult = { status: lessonStatus, payload: { run_id: lessonRunId } };
        if (recovery) {
          if (operationStarted) {
            await completeOperation({
              operationId,
              status: lessonStatus,
              terminal_result: terminalResult,
            });
          }
        } else if (operationStarted) {
          await completeOperation({
            operationId,
            status: lessonStatus,
            terminal_result: terminalResult,
          });
        }
        return { ...terminalResult, ...(recovery ? { recovery } : {}) };
      }
      if (['failed', 'retryable', 'infeasible'].includes(lessonStatus)) {
        const terminalResult = {
          status: 'failed',
          payload: {
            run_id: lessonRunId,
            error: lessonRun.error || lessonRun.lastError || failureCause || 'lesson run failed',
          },
        };
        if (operationStarted) {
          await completeOperation({
            operationId,
            status: 'failed',
            terminal_result: terminalResult,
          });
        }
        return {
          ...terminalResult,
          ...(recovery ? { recovery } : {}),
        };
      }
      return { status: 'pending' };
    },
    record: ({ unit, attemptId, terminal }) => lessonsRemote.record({
      baseUrl,
      secret,
      runId: terminal.run_id,
      attemptId,
      inputHash: unit.input_hash,
      signal: options.signal,
    }),
  };
}

async function ensureV2CompletedStatus({ journal, fsApi, runId, control }) {
  const completed = control.find((event) => event.type === 'run_completed');
  if (!completed) return false;
  if (completed.payload?.run_id !== runId || Number(completed.payload?.stage_count) !== 8) {
    throw new Error('v2_run_completed_invalid');
  }

  let current = null;
  try {
    current = JSON.parse(await fsApi.readFile(journal.statusPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const controlSeq = control.at(-1)?.seq ?? -1;
  if (
    current?.status !== 'completed'
    || current?.current_stage !== null
    || Number(current?.stage_count) !== 8
    || current?.run_id !== runId
    || Number(current?.control_seq) !== controlSeq
  ) {
    await journal.writeStatus({
      status: 'completed',
      current_stage: null,
      stage_count: 8,
    });
  }
  return true;
}

async function repairV2ResumedStatusCache({ journal, fsApi, control, controlLifecycle }) {
  if (controlLifecycle.state !== 'running' || !controlLifecycle.pause) return false;
  let resumed = null;
  for (let index = control.length - 1; index >= 0; index -= 1) {
    const event = control[index];
    if (
      event.type === 'run_resumed'
      && event.payload?.previous_pause_seq === controlLifecycle.pause.seq
    ) {
      resumed = event;
      break;
    }
  }
  if (!resumed) return false;

  let current = null;
  try {
    current = JSON.parse(await fsApi.readFile(journal.statusPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  if (
    current?.status !== 'paused'
    && Number(current?.control_seq) >= resumed.seq
  ) return false;

  await journal.writeStatus({
    status: 'running',
    current_stage: controlLifecycle.pause.payload.stage,
    resumed_from_pause_seq: controlLifecycle.pause.seq,
  });
  return true;
}

async function runV2SummaryLifecycle({ options, runId, dependencies = {} }) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const secret = requireSecret();
  const fsApi = dependencies.fsApi || fs;
  let executionBoundary = null;
  const journal = new RunStateJournalV2({
    rootDir: path.join(options.stateDir, `${runId}.v2`),
    runId,
    fsApi,
  });
  const durable = async (scope, type, payload) => {
    const event = scope === 'control'
      ? await journal.appendControl(type, payload)
      : await journal.appendStage(scope, type, payload);
    await dependencies.onV2DurableEvent?.({ scope, type, payload, event });
    return event;
  };
  try {
    for (const v1Path of [
      path.join(options.stateDir, `${runId}.json`),
      path.join(options.stateDir, `${runId}.journal.jsonl`),
      path.join(options.stateDir, `${runId}.status.json`),
      path.join(options.stateDir, `${runId}.json.lock`),
    ]) {
      const exists = await fsApi.access(v1Path).then(() => true).catch((error) => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      });
      if (exists) throw new Error('v2_v1_state_collision: 该 run_id 已有 v1 状态或锁');
    }
    await assertV1ReleaseGate(options.stateDir, { fsApi });
    const baselineInspection = dependencies.v2BaselineRunInspection
      ? await dependencies.v2BaselineRunInspection({ baseUrl, secret, runId, options })
      : dependencies.v2RuntimeCheck
        ? { baselineId: null, retired: false }
        : await inspectRunnerAdoptedBaseline({ baseUrl, secret, runId, options });
    if (baselineInspection?.retired === true) {
      throw new Error(`v2_run_retired_by_adopted_baseline:${baselineInspection.baselineId || 'unknown'}`);
    }
    const activeBaselineId = typeof baselineInspection?.baselineId === 'string'
      ? baselineInspection.baselineId
      : null;
    const verifiedTakeover = dependencies.v2VerifiedTakeover
      || (options.resume ? async ({ owner }) => owner.run_id === runId : null);
    await journal.acquireLock({ takeover: verifiedTakeover });
    executionBoundary = createV2ExecutionBoundary({
      limit: options.maxUnitsPerResume,
      drainRequestProbe: createV2DrainRequestProbe({ journal, fsApi }),
    });
    let control = await journal.open();
    let controlLifecycle = reduceRunControlLifecycle(control);
    const migrationGates = [];
    for (const stage of EFFECT_STATE_RECOVERY_STAGES) {
      const stagePath = journal.stagePath(stage);
      const exists = await fsApi.access(stagePath).then(
        () => true,
        (error) => error?.code === 'ENOENT' ? false : Promise.reject(error),
      );
      if (!exists) continue;
      const gate = inspectRecoveryMigrationGate(await journal.readStage(stage));
      if (gate.state !== 'open') migrationGates.push({ stage, ...gate });
    }
    const incompleteMigration = migrationGates.find((gate) => gate.state === 'fenced');
    if (incompleteMigration) {
      await journal.writeStatus({
        status: 'blocked',
        current_stage: incompleteMigration.stage,
        recovery_contract_version:
          incompleteMigration.manifest.recovery_contract_version,
        system_block_reason_code: 'recovery_migration_incomplete',
        acceptance_ready: false,
      });
      return 1;
    }
    await repairV2ResumedStatusCache({
      journal,
      fsApi,
      control,
      controlLifecycle,
    });
  if (options.doctorScript) {
    await runDoctorGate(path.resolve(options.doctorScript), options.doctorOk);
  }
  const runtimeCheck = dependencies.v2RuntimeCheck || assertRuntimeConcurrency;
  try {
    await runtimeCheck({
      baseUrl,
      secret,
      allowed: options.allowSummarizeConcurrency,
      options,
    });
  } catch (error) {
    if (!options.dryRun) throw error;
  }
  const summaryRemote = dependencies.v2SummaryRemote || {
    advance: async ({
      sessionId,
      attemptId,
      inputHash,
      operationUnitId,
      requireExistingReceipt,
      expectedReceiptInputHash,
      failedReceiptRetryAuthorization,
      request,
      signal,
    }) => requestJson(
      baseUrl,
      secret,
      'POST',
      SUMMARY_RESUMABLE_PATH,
      {
        ...request,
        sessionId,
        attemptId,
        inputHash,
        operationUnitId,
        ...(requireExistingReceipt ? { requireExistingReceipt: true } : {}),
        ...(expectedReceiptInputHash ? { expectedReceiptInputHash } : {}),
        ...(failedReceiptRetryAuthorization
          ? { failedReceiptRetryAuthorization }
          : {}),
      },
      requestOptions({ ...options, signal }),
    ),
    record: async ({ sessionId, attemptId, inputHash, signal }) => {
      const response = await requestJson(baseUrl, secret, 'POST', '/agentmemory/extraction-runs/record', {
        runId,
        mark: options.mark,
        summarySessionId: sessionId,
      }, requestOptions({ ...options, signal }));
      if (!response.ok) throw new Error(response.error || 'v2_summary_record_failed');
    },
  };
  const lessonsRemote = dependencies.v2LessonsRemote || {
    start: async ({
      sessionId,
      attemptId,
      inputHash,
      requireExistingReceipt,
      expectedReceiptInputHash,
      failedReceiptRetryAuthorization,
      failedLessonRunEvidence,
      request,
      signal,
    }) => requestJson(
      baseUrl,
      secret,
      'POST',
      '/agentmemory/lessons/extract',
      {
        ...request,
        sessionIds: [sessionId],
        attemptId,
        inputHash,
        ...(requireExistingReceipt ? { requireExistingReceipt: true } : {}),
        ...(expectedReceiptInputHash ? { expectedReceiptInputHash } : {}),
        ...(failedReceiptRetryAuthorization
          ? { failedReceiptRetryAuthorization }
          : {}),
        ...(failedLessonRunEvidence ? { failedLessonRunEvidence } : {}),
      },
      requestOptions({ ...options, signal }),
    ),
    record: async ({ runId: lessonRunId, attemptId, inputHash, signal }) => {
      const response = await requestJson(baseUrl, secret, 'POST', '/agentmemory/extraction-runs/record', {
        runId,
        mark: options.mark,
        lessonRunId,
      }, requestOptions({ ...options, signal }));
      if (!response.ok) throw new Error(response.error || 'v2_lessons_record_failed');
    },
  };
    const allSessions = await loadSessions(baseUrl, secret, options.agentId, options);
    const excludedSessionIds = await loadExcludedSessionIds(options.excludeRecords);
    const selection = selectFullExtractionSessions(allSessions, excludedSessionIds);
    let sessions = selection.sessions;
    const config = {
      ...buildConfigFromOptions(options),
      base_url: baseUrl,
      mark: options.mark,
    };
    if (activeBaselineId) config.adopted_baseline_id = activeBaselineId;
    const configHash = stableHash(config);
    const partitionSessions = dependencies.v2BaselinePartition
      || (dependencies.v2RuntimeCheck
        ? async ({ sessions: inputSessions }) => inputSessions
        : (input) => partitionRunnerSessions({
          ...input,
          baseUrl,
          secret,
          expectedBaselineId: activeBaselineId,
          options,
        }));
    const started = control.find((event) => event.type === 'run_started');
    if (started) {
      if (
        started.payload?.format !== 'run-state-journal-v2'
        || started.payload?.schema_version !== 2
        || started.payload?.base_url !== baseUrl
        || started.payload?.config_hash !== configHash
        || (
          started.payload?.recovery_policy_version !== undefined
          && (
            started.payload.recovery_policy_version !== RECOVERY_POLICY_VERSION
            || started.payload.recovery_policy_hash !== RECOVERY_POLICY_HASH
          )
        )
      ) {
        throw new Error('v2_run_input_drifted: 请创建新的 run_id');
      }
    }
    const summaryEvents = started && options.resume
      ? await journal.readStage('summary')
      : [];
    const eligibleSummarySessions = started && options.resume && activeBaselineId
      ? await partitionSessions({
        stage: 'summary',
        stageContractVersion: 'summary/v1',
        sessions,
      })
      : sessions;
    const frozenSummary = resolveV2FrozenSummaryInventory({
      options,
      started,
      sessions,
      eligibleSummarySessions,
      events: summaryEvents,
      baseUrl,
    });
    if (frozenSummary) sessions = frozenSummary.sessions;
    const inventoryHash = frozenSummary?.inventoryHash
      || computeInventoryHash(sessions, options.agentId);
    if (started && started.payload?.inventory_hash !== inventoryHash) {
      throw new Error('v2_run_input_drifted: 请创建新的 run_id');
    }
    const [summarySessions, lessonSessions] = await Promise.all([
      partitionSessions({
        stage: 'summary',
        stageContractVersion: 'summary/v1',
        sessions,
      }),
      partitionSessions({
        stage: 'lessons',
        stageContractVersion: 'lessons/v1',
        sessions,
      }),
    ]);
    if (!started) {
      await durable('control', 'run_started', {
        run_id: runId,
        format: 'run-state-journal-v2',
        schema_version: 2,
        base_url: baseUrl,
        config_hash: configHash,
        inventory_hash: inventoryHash,
        recovery_policy_version: RECOVERY_POLICY_VERSION,
        recovery_policy_hash: RECOVERY_POLICY_HASH,
      });
      control = await journal.readControl();
      controlLifecycle = reduceRunControlLifecycle(control);
    }
    if (controlLifecycle.state === 'paused' && !options.resume) {
      throw new Error('v2_paused_run_requires_resume');
    }
    if (options.resume && controlLifecycle.state === 'paused') {
      const previousPause = controlLifecycle.pause;
      await durable('control', 'run_resumed', {
        run_id: runId,
        previous_pause_seq: previousPause.seq,
      });
      control = await journal.readControl();
      controlLifecycle = reduceRunControlLifecycle(control);
      await repairV2ResumedStatusCache({
        journal,
        fsApi,
        control,
        controlLifecycle,
      });
    }
    if (await ensureV2CompletedStatus({ journal, fsApi, runId, control })) return 0;

    const pendingWait = dependencies.v2PendingWait || sleep;
    const inProcessAcceptedUnitIdsByStage = new Map();
    const acceptedUnitIdsForStage = (stage) => {
      if (!inProcessAcceptedUnitIdsByStage.has(stage)) {
        inProcessAcceptedUnitIdsByStage.set(stage, new Set());
      }
      return inProcessAcceptedUnitIdsByStage.get(stage);
    };
    const pendingCanWait = async (stages) => {
      let hasContinuableWork = false;
      let nextUnit = null;
      for (const stage of stages) {
        const stagePath = journal.stagePath(stage);
        const exists = await fsApi.access(stagePath).then(
          () => true,
          (error) => error?.code === 'ENOENT' ? false : Promise.reject(error),
        );
        if (!exists) continue;
        const reduced = reduceRecoveryJournal(await journal.readStage(stage));
        const projection = reduced.run.projection;
        if (
          projection.reconciling > 0
          || projection.isolated > 0
          || projection.dependency_blocked > 0
          || projection.system_blocked > 0
        ) return { canWait: false, nextUnit: null };
        if (projection.runnable > 0 || projection.running > 0 || projection.retry_wait > 0) {
          hasContinuableWork = true;
          const candidate = [...reduced.units.values()].find((unit) => (
            !unit.split
            && !unit.terminal
            && !unit.blocked
            && ['planned', 'running', 'retry_wait'].includes(unit.recovery.state)
          ));
          if (!nextUnit && candidate) nextUnit = { stage, unitId: candidate.unit_id };
        }
      }
      return { canWait: hasContinuableWork, nextUnit };
    };
    while (true) {
      const summaryResult = await runV2JournalSingleStage({
        stage: 'summary',
        control,
        journal,
        durable,
        plan: buildV2SummaryPlan(summarySessions, baseUrl, options),
        adapter: buildV2SummaryAdapter({ baseUrl, secret, options, runId, summaryRemote }),
        planOnly: options.dryRun,
        executionBoundary,
        inProcessAcceptedUnitIds: acceptedUnitIdsForStage('summary'),
      });
      control = summaryResult.control;
      if (summaryResult.status === 'paused') {
        throw new V2ExecutionPauseReached();
      }
      if (summaryResult.status === 'blocked') {
        return 1;
      }
      const summaryDependencyStates = recoveryDependencyStates(
        'summary',
        await journal.readStage('summary'),
      );
      const lessonsResult = await runV2JournalSingleStage({
        stage: 'lessons',
        control,
        journal,
        durable,
        plan: buildV2LessonsPlan(lessonSessions, baseUrl, options),
        adapter: buildV2LessonsAdapter({ baseUrl, secret, options, runId, lessonsRemote }),
        planOnly: options.dryRun,
        dependencyStates: summaryDependencyStates,
        executionBoundary,
        inProcessAcceptedUnitIds: acceptedUnitIdsForStage('lessons'),
      });
      control = lessonsResult.control;
      if (lessonsResult.status === 'paused') {
        throw new V2ExecutionPauseReached();
      }
      const earlyStageStatuses = [summaryResult.status, lessonsResult.status];
      await journal.writeStatus({
        status: earlyStageStatuses.includes('blocked')
          ? 'blocked'
          : earlyStageStatuses.includes('attention_required')
            ? 'attention_required'
            : 'running',
        current_stage: !['completed', 'planned'].includes(lessonsResult.status)
          ? 'lessons'
          : !['completed', 'planned'].includes(summaryResult.status)
            ? 'summary'
            : null,
        summary: summaryResult.statusEntry,
        lessons: lessonsResult.statusEntry,
      });
      if (lessonsResult.status === 'blocked') {
        return 1;
      }
      if (dependencies.v2RemainingStages === false) {
        if (earlyStageStatuses.includes('attention_required')) return 1;
        if (earlyStageStatuses.includes('pending')) {
          const pendingState = await pendingCanWait(['summary', 'lessons']);
          if (
            pendingState.nextUnit
            && await executionBoundary?.pollDrain(pendingState.nextUnit)
          ) throw new V2ExecutionPauseReached();
          if (
            options.pendingPolicy === 'exit'
            || !pendingState.canWait
          ) return 75;
          logProgress('v2', 'pending_wait', {
            stages: ['summary', 'lessons'],
            poll_ms: options.pendingPollMs,
          });
          await pendingWait(options.pendingPollMs, { signal: options.signal });
          continue;
        }
        if (earlyStageStatuses.some((status) => !['completed', 'planned'].includes(status))) {
          return 1;
        }
        return 0;
      }
      const request = (endpoint, body) => requestJson(
        baseUrl,
        secret,
        'POST',
        endpoint,
        body,
        requestOptions(options),
      );
      const runRemaining = typeof dependencies.v2RemainingStages === 'function'
        ? dependencies.v2RemainingStages
        : runV2RemainingStages;
      const remainingResult = await runRemaining({
        options,
        runId,
        config,
        configHash,
        inventoryHash,
        request,
        stableHash,
        loadSelectedSessions: async () => {
          const latest = await loadSessions(baseUrl, secret, options.agentId, options);
          const latestSelection = selectFullExtractionSessions(latest, excludedSessionIds).sessions;
          if (!frozenSummary) return latestSelection;
          return resolveV2FrozenSummaryInventory({
            options,
            started,
            sessions: latestSelection,
            events: summaryEvents,
            baseUrl,
          }).sessions;
        },
        loadSelectedSessionsForStage: async (stage, inputSessions) => {
          const stageContractVersion = {
            memory_consolidate: 'memory_consolidate/v1',
            semantic_rollup: 'semantic-rollup/v1',
            skill_extract: 'skill_extract/v1',
          }[stage];
          if (!stageContractVersion) throw new Error(`v2_adopted_baseline_stage_invalid:${stage}`);
          return partitionSessions({
            stage,
            stageContractVersion,
            sessions: inputSessions,
          });
        },
        eligibleStages: {
          semantic_rollup: ['completed', 'planned'].includes(summaryResult.status),
          skill_extract: ['completed', 'planned'].includes(summaryResult.status),
          reflect_insight: (
            ['completed', 'planned'].includes(summaryResult.status)
            && ['completed', 'planned'].includes(lessonsResult.status)
          ),
        },
        runSingleStage: async ({ stage, plan, adapter }) => {
          const result = await runV2JournalSingleStage({
            stage,
            control,
            journal,
            durable,
            plan,
            adapter,
            planOnly: options.dryRun,
            executionBoundary,
            inProcessAcceptedUnitIds: acceptedUnitIdsForStage(stage),
          });
          control = result.control;
          if (result.status === 'paused') {
            throw new V2ExecutionPauseReached();
          }
          return result;
        },
        runTwoPhaseStage: async ({ stage, plan, adapter }) => {
          const result = await runV2JournalTwoPhaseStage({
            stage,
            control,
            journal,
            durable,
            plan,
            adapter,
            planOnly: options.dryRun,
            executionBoundary,
            inProcessAcceptedUnitIds: acceptedUnitIdsForStage(stage),
          });
          control = result.control;
          if (result.status === 'paused') {
            throw new V2ExecutionPauseReached();
          }
          return result;
        },
      });
      const finalStageStatuses = [...earlyStageStatuses, remainingResult.status];
      if (finalStageStatuses.includes('blocked')) {
        return 1;
      }
      if (finalStageStatuses.includes('attention_required')) {
        return 1;
      }
      if (finalStageStatuses.includes('pending')) {
        const pendingState = await pendingCanWait(EFFECT_STATE_RECOVERY_STAGES);
        if (
          pendingState.nextUnit
          && await executionBoundary?.pollDrain(pendingState.nextUnit)
        ) throw new V2ExecutionPauseReached();
        if (
          options.pendingPolicy === 'exit'
          || !pendingState.canWait
        ) return 75;
        logProgress('v2', 'pending_wait', {
          stages: EFFECT_STATE_RECOVERY_STAGES,
          poll_ms: options.pendingPollMs,
        });
        await pendingWait(options.pendingPollMs, { signal: options.signal });
        continue;
      }
      if (finalStageStatuses.some((status) => !['completed', 'planned'].includes(status))) {
        return 1;
      }
      if (!options.dryRun && !control.some((event) => event.type === 'run_completed')) {
        await durable('control', 'run_completed', {
          run_id: runId,
          stage_count: 8,
        });
        await journal.writeStatus({
          status: 'completed',
          current_stage: null,
          stage_count: 8,
        });
      }
      return 0;
    }
  } catch (error) {
    if (!(error instanceof V2ExecutionPauseReached)) throw error;
    const pause = executionBoundary?.pause();
    if (!pause?.stage || !pause?.reasonCode) throw new Error('v2_execution_pause_state_invalid');
    const processedCount = pause.processedCount;
    const operatorDrain = pause.reasonCode === 'operator_drain_requested';
    const pausePayload = operatorDrain
      ? {
          run_id: runId,
          reason_code: pause.reasonCode,
          stage: pause.stage,
          ...(pause.lastUnitId ? { last_unit_id: pause.lastUnitId } : {}),
          next_unit_id: pause.nextUnitId,
          processed_unit_count: processedCount,
          requested_at: pause.requestedAt,
        }
      : {
          run_id: runId,
          reason_code: pause.reasonCode,
          stage: pause.stage,
          unit_id: pause.lastUnitId,
          processed_unit_count: processedCount,
          max_units_per_resume: executionBoundary.limit,
        };
    if (
      !Number.isSafeInteger(processedCount)
      || processedCount < (operatorDrain ? 0 : 1)
      || (!operatorDrain && !pause.lastUnitId)
      || (operatorDrain && (!pause.nextUnitId || !pause.requestedAt))
    ) throw new Error('v2_execution_pause_state_invalid');
    const recoveryProjection = reduceRecoveryJournal(await journal.readStage(pause.stage)).run;
    await durable('control', 'run_paused', pausePayload);
    reduceRunControlLifecycle(await journal.readControl());
    await journal.writeStatus({
      status: 'paused',
      current_stage: pause.stage,
      pause_reason_code: pause.reasonCode,
      processed_units_this_invocation: processedCount,
      ...(operatorDrain
        ? { next_unit_id: pause.nextUnitId }
        : { max_units_per_resume: executionBoundary.limit }),
      [pause.stage]: {
        status: 'paused',
        ...(operatorDrain
          ? {
              ...(pause.lastUnitId ? { last_unit_id: pause.lastUnitId } : {}),
              next_unit_id: pause.nextUnitId,
            }
          : { unit_id: pause.lastUnitId }),
        recovery_policy_version: RECOVERY_POLICY_VERSION,
        recovery: recoveryProjection.projection,
        acceptance_ready: recoveryProjection.acceptance_ready,
      },
    });
    return 75;
  } finally {
    await journal.releaseLock();
  }
}

export async function mainForTest(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP_TEXT);
    return 0;
  }
  assertAutomaticModelPolicy(options);

  const cancellation = dependencies.cancellation || createCancellationController(dependencies.signalSource || process);
  options.signal = dependencies.signal || cancellation.signal;

  const runId = options.runId || makeRunId();
  if (options.runStateFormat === 'v2') {
    try {
      return await runV2SummaryLifecycle({ options, runId, dependencies });
    } finally {
      cancellation.dispose?.();
    }
  }
  const statePath = path.join(options.stateDir, `${runId}.json`);
  const drainRequestPath = `${statePath}.drain-request.json`;
  let stateLock = null;
  let state = null;
  let runStateStore = null;
  try {
    stateLock = await acquireStateLock({ statePath, runId });
    const now = new Date().toISOString();
    const secret = requireSecret();
    state = await loadOrCreateState({ options, runId, statePath, now });
    runStateStore = new RunStateStore({ statePath, writeSnapshot: writeStateAtomically });
    const includedSeq = Number(state.orchestration_journal?.included_seq || 0);
    const journalEvents = await runStateStore.loadJournal({
      retainFromSeq: Math.max(1, includedSeq),
    });
    runStateStore.replay(state, journalEvents);
    const drainRequestPresent = await fs.access(drainRequestPath).then(() => true).catch((error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (!drainRequestPresent) delete state.drain_requested_at;
    sanitizeStateSchema(state);
    if (options.resume && !options.dryRun) beginResumeSchedulerEpoch(state, now);
    state.base_url = normalizeBaseUrl(options.baseUrl);
    state.mark = options.mark;

    if (options.doctorScript) {
      state.health.doctor = await runDoctorGate(path.resolve(options.doctorScript), options.doctorOk);
    }

    let runtime;
    try {
      runtime = await assertRuntimeConcurrency({
        baseUrl: state.base_url,
        secret,
        allowed: options.allowSummarizeConcurrency,
        options,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (!options.dryRun) throw error;
      runtime = null;
      state.health.last_error = redactSensitiveText(error.message);
      state.health.runtime_warning = state.health.last_error;
    }
    if (runtime) {
      state.health.last_ok_at = new Date().toISOString();
      state.runtime = redactJson(runtime);
    }
    logProgress('runtime', runtime ? 'ok' : 'warning', { runtime: state.runtime || null, warning: state.health.runtime_warning || null });

    const allSessions = await loadSessions(state.base_url, secret, options.agentId, options);
    const excludedSessionIds = await loadExcludedSessionIds(options.excludeRecords);
    const inventorySelection = selectFullExtractionSessions(allSessions, excludedSessionIds);
    const sessions = inventorySelection.sessions;
    logProgress('inventory', 'sessions', {
      agent_id: options.agentId,
      count: sessions.length,
      excluded_count: inventorySelection.audit.excluded_count,
      excluded_reason_counts: inventorySelection.audit.excluded_reason_counts,
    });
    if (options.resume) {
      validateResumeState(state, options, sessions);
    }

    state.config = buildConfigFromOptions(options);
    state.config_hash = stableHash(state.config);
    state.inventory_hash = computeInventoryHash(sessions, state.config.agent_id);
    state.inventory_audit = inventorySelection.audit;
    upsertSessionsIntoState(state, sessions);

    const plannedWindows = planSemanticWindowsForState(state);
    if (options.resume) {
      validateResumeState(state, options, sessions, plannedWindows);
      const resetCount = resetStaleRunningUnits(state);
      if (resetCount > 0) state.recovered_stale_running_units = (state.recovered_stale_running_units || 0) + resetCount;
    }

    for (const window of plannedWindows) {
      state.semantic_windows[window.window_id] ??= {
        ...window,
        status: options.dryRun ? 'planned' : 'pending',
      };
    }
    if (options.dryRun) {
      await planRestFullStage({
        state,
        statePath,
        baseUrl: state.base_url,
        secret,
        options,
        containerKey: 'memory_consolidate_windows',
        dryRun: true,
      });
      await planSkillExtractStage({ state, statePath, baseUrl: state.base_url, secret, options, dryRun: true });
      await planCrystalStage({ state, statePath, baseUrl: state.base_url, secret, options, dryRun: true });
      await planRestFullStage({
        state,
        statePath,
        baseUrl: state.base_url,
        secret,
        options,
        containerKey: 'consolidation_procedural_windows',
        dryRun: true,
      });
      await planRestFullStage({
        state,
        statePath,
        baseUrl: state.base_url,
        secret,
        options,
        containerKey: 'reflect_insight_windows',
        dryRun: true,
      });
    }

    state.coverage = computeCoverage(state);
    state.updated_at = new Date().toISOString();
    await writeStateAtomically(statePath, state);
    logProgress('semantic_rollup', 'planned', {
      count: plannedWindows.length,
      target_prompt_chars: state.config.semantic_rollup_target_prompt_chars ?? state.config.semantic_char_budget,
    });
    logProgress('coverage', options.dryRun ? 'planned' : 'initial', { coverage: state.coverage });

    if (!options.dryRun) {
      const sessionIds = Object.keys(state.sessions).sort((a, b) => {
        const left = state.sessions[a];
        const right = state.sessions[b];
        const byTime = String(left.started_at || '').localeCompare(String(right.started_at || ''));
        return byTime || a.localeCompare(b);
      });
      const runtimeDiagnostics = dependencies.runtimeDiagnostics || (() => runLocalRuntimeDiagnostics({
        baseUrl: state.base_url,
        secret,
        options,
        doctorHealthy: state.health?.doctor?.ok ?? null,
      }));
      const runQueue = async (stage, work, queueOptions) => {
        const queueWriteState = queueOptions.writeState || writeStateAtomically;
        const result = await runStageWorkQueue(stage, state, statePath, work, {
          ...queueOptions,
          signal: options.signal,
          runtimeDiagnostics,
          ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
          ...(dependencies.jitter ? { jitter: dependencies.jitter } : {}),
          initialOutcome: queueOptions.initialOutcome || ((item) => initialStageOutcome(state, stage, item)),
          markIsolated: (item, outcome) => markStageItemIsolated(state, stage, item, outcome),
          shouldDrain: async () => {
            if (queueOptions.ignoreDrain === true) return false;
            const raw = await fs.readFile(drainRequestPath, 'utf8').catch((error) => {
              if (error?.code === 'ENOENT') return null;
              throw error;
            });
            if (raw === null) return false;
            const request = JSON.parse(raw);
            return validateDrainRequest(request, stateLock);
          },
        });
        state.coverage = computeCoverage(state);
        state.updated_at = new Date().toISOString();
        const unresolvedInState = typeof queueOptions.hasUnresolved === 'function'
          && queueOptions.hasUnresolved();
        let status = 'completed';
        if (result.status === 'drained') {
          status = 'drained';
        } else if (result.status === 'blocked') {
          status = result.failure?.class === 'transient_runtime'
            ? 'blocked_runtime'
            : 'blocked_hard';
        } else if (result.status === 'completed_with_failures' || unresolvedInState) {
          status = 'completed_with_unit_failures';
        }
        if (status !== 'completed') {
          if (status === 'drained') {
            if (typeof queueOptions.onDrained === 'function') {
              await queueWriteState(statePath, state);
              return queueOptions.onDrained();
            }
            state.drain_requested_at = new Date().toISOString();
            state.health.last_error = null;
            await runStateStore.checkpoint(state);
            await runStateStore.writeStatus(state);
            return false;
          }
          const cause = result.failure?.cause || result.unresolved?.[0]?.failure?.cause || `${stage}_unresolved`;
          const independentContinuation = status === 'completed_with_unit_failures'
            && queueOptions.allowUnitFailures === true;
          state.health.last_error = independentContinuation
            ? `${stage} 阶段存在已隔离单元失败；无依赖阶段可继续：${cause}`
            : `${stage} 阶段存在未解决失败，依赖阶段不再推进：${cause}`;
          await queueWriteState(statePath, state);
          return independentContinuation;
        }
        await queueWriteState(statePath, state);
        return true;
      };
      const runPipelineQueue = async (mode, stage, work, queueOptions) => {
        const results = await runStagePipeline([work], {
          mode,
          concurrency: 1,
          execute: (items) => runQueue(stage, items, queueOptions),
        });
        return results[0] === true;
      };
      const runPlanQueue = async (stage, containerKey, planner) => {
        let plannedUnits = [];
        const ok = await runQueue(`${stage}_plan`, [{ unit_id: 'plan' }], {
          itemId: () => 'plan',
          initialOutcome: () => initialPlanOutcome(state, containerKey),
          run: async (_item, context) => {
            const result = await planner({
              ...options,
              signal: context.signal,
              runtimeDiagnostics: () => runtimeDiagnostics({
                stage: `${stage}_plan`,
                item: { unit_id: 'plan' },
                signal: context.signal,
              }),
            });
            if (!result.outcome.failure) plannedUnits = result.units;
            return result.outcome;
          },
        });
        return { ok, units: plannedUnits };
      };
      let canContinue = await runQueue('summary', sessionIds, {
        concurrency: state.config.session_concurrency,
        run: (sessionId, context) => runSummaryForSession({
          state,
          statePath,
          baseUrl: state.base_url,
          secret,
          sessionId,
          options: { ...options, signal: context.signal },
        }),
        itemId: (sessionId) => sessionId,
        hasUnresolved: () => Object.values(state.sessions).some((session) =>
          session.summary?.status === 'failed' || session.summary?.record_pending === true),
      });
      let finalSemanticWindows = [];
      if (canContinue) {
        finalSemanticWindows = planSemanticWindowsForState(state);
        reconcileSemanticWindowsAfterSummary(state, finalSemanticWindows, options);
        state.coverage = computeCoverage(state);
        state.updated_at = new Date().toISOString();
        await writeStateAtomically(statePath, state);
        canContinue = await runQueue('lessons', sessionIds, {
          concurrency: state.config.session_concurrency,
          allowUnitFailures: true,
          run: (sessionId, context) => runLessonsForSession({
            state,
            statePath,
            baseUrl: state.base_url,
            secret,
            sessionId,
            options: { ...options, signal: context.signal },
          }),
          itemId: (sessionId) => sessionId,
          hasUnresolved: () => Object.values(state.sessions).some((session) =>
            session.lessons_extract?.status === 'failed' || session.lessons_extract?.record_pending === true),
        });
      }

      if (canContinue) {
        const pendingMemoryCommitRepairs = selectDrainCommitUnits(
          state,
          'memory_consolidate_windows',
          Object.values(state.memory_consolidate_windows || {}),
        );
        if (pendingMemoryCommitRepairs.length > 0) {
          canContinue = await runQueue('memory_consolidate_commit_repair', pendingMemoryCommitRepairs, {
            concurrency: 1,
            ignoreDrain: true,
            allowUnitFailures: true,
            run: (unit, context) => runRestMemoryCommitUnit({
              state,
              statePath,
              baseUrl: state.base_url,
              secret,
              unit,
              options: { ...options, signal: context.signal },
            }),
            itemId: (unit) => unit.unit_id,
            initialOutcome: () => null,
            hasUnresolved: () => hasUnresolvedStageFailures(state, 'memory_consolidate_windows'),
          });
        }
      }

      if (canContinue) {
        const pendingSkillCommitRepairs = selectDrainCommitUnits(
          state,
          'skill_extract',
          Object.values(state.skill_extract || {}),
        );
        if (pendingSkillCommitRepairs.length > 0) {
          canContinue = await runQueue('skill_extract_commit_repair', pendingSkillCommitRepairs, {
            concurrency: 1,
            ignoreDrain: true,
            allowUnitFailures: true,
            run: (unit, context) => runSkillExtractCommitUnit({
              state,
              statePath,
              baseUrl: state.base_url,
              secret,
              unit,
              options: { ...options, signal: context.signal },
            }),
            itemId: (unit) => unit.unit_id,
            initialOutcome: () => null,
            hasUnresolved: () => hasUnresolvedStageFailures(state, 'skill_extract'),
          });
        }
      }

      if (canContinue) {
        if (!state.memory_consolidate_order) {
          const existingMemoryUnits = Object.values(state.memory_consolidate_windows || {})
            .filter((unit) => unit?.unit_id && !unit.split_from);
          const hasUnstableExistingUnit = existingMemoryUnits.some((unit) =>
            unit.record_pending === true
            || ['failed', 'running', 'preparing', 'prepared', 'committing'].includes(unit.status));
          if (existingMemoryUnits.length > 0 && !hasUnstableExistingUnit) {
            freezeMemoryConsolidateOrder(state, existingMemoryUnits);
          }
        }
        const memoryPlan = await runPlanQueue('memory_consolidate', 'memory_consolidate_windows', (planOptions) =>
          planRestFullStage({
            state,
            statePath,
            baseUrl: state.base_url,
            secret,
            options: planOptions,
            containerKey: 'memory_consolidate_windows',
            dryRun: false,
          }));
        canContinue = memoryPlan.ok;
        if (canContinue) {
          const orderedMemoryUnits = freezeMemoryConsolidateOrder(state, memoryPlan.units);
          const memoryProviderLimiter = new AdaptiveProviderLimiter({
            buckets: state.provider_limiter || {},
          });
          const memoryProviderRoute = {
            provider: state.runtime?.providerName || state.runtime?.provider_name || 'unknown',
            model: state.config.stage_models?.memory_consolidate || 'service-default',
            endpointClass: 'memory-consolidate-prepare',
          };
          const persistMemoryLimiter = () => {
            state.provider_limiter = memoryProviderLimiter.toJSON();
          };
          persistMemoryLimiter();
          await runStateStore.checkpoint(state);
          const writeMemoryScheduler = async () => {
            await runStateStore.append('scheduler_state', {
              stage_work_queues: redactJson(state.stage_work_queues),
              last_failure_cause: state.last_failure_cause || null,
              provider_limiter: redactJson(state.provider_limiter),
            }, { durable: true });
            await runStateStore.writeStatus(state);
          };
          const writeMemoryUnit = (unit) => async () => {
            const current = state.memory_consolidate_windows[unit.unit_id];
            await runStateStore.append('unit_state', {
              container_key: 'memory_consolidate_windows',
              unit_id: unit.unit_id,
              unit: redactJson(current),
            }, {
              durable: terminalStageStatus(current?.status)
                || current?.status === 'prepared'
                || current?.record_pending === true,
            });
            await runStateStore.writeStatus(state);
          };
          const memoryChunks = [];
          for (let index = 0; index < orderedMemoryUnits.length; index += 4) {
            memoryChunks.push(orderedMemoryUnits.slice(index, index + 4));
          }
          for (const chunk of memoryChunks) {
            let prepareDrained = false;
            canContinue = await runQueue('memory_consolidate_prepare', chunk, {
              concurrency: 2,
              getConcurrency: () => memoryProviderLimiter.state(memoryProviderRoute).concurrency,
              requiresProviderProbe: () => memoryProviderLimiter.requiresProbe(memoryProviderRoute),
              getProviderRetryAt: () => memoryProviderLimiter.state(memoryProviderRoute).retryAt,
              onOutcome: (unit, outcome, context) => {
                const current = state.memory_consolidate_windows[unit.unit_id];
                if (outcome.failure) {
                  memoryProviderLimiter.recordFailure(memoryProviderRoute, outcome.failure, {
                    retryAfterMs: Number(outcome.failure.diagnostics?.retryAfterMs || 0),
                    now: context.settledAt,
                  });
                } else if (['prepared', 'succeeded', 'skipped'].includes(current?.status)) {
                  memoryProviderLimiter.recordProviderSuccess(memoryProviderRoute, {
                    probe: context.probe,
                  });
                }
                persistMemoryLimiter();
              },
              writeState: writeMemoryScheduler,
              run: (unit, context) => runRestMemoryPrepareUnit({
                state,
                statePath,
                baseUrl: state.base_url,
                secret,
                unit,
                options: {
                  ...options,
                  signal: context.signal,
                  writeState: writeMemoryUnit(unit),
                },
              }),
              itemId: (unit) => unit.unit_id,
              expand: (unit, outcome) => outcome.status === 'retry_planned'
                ? splitChildUnitsForContainer(state, 'memory_consolidate_windows', unit.unit_id)
                : [],
              initialOutcome: (unit) => {
                const status = state.memory_consolidate_windows[unit.unit_id]?.status;
                if (terminalStageStatus(status) || status === 'prepared') return stageOutcome('succeeded');
                return initialStageOutcome(state, 'memory_consolidate', unit);
              },
              hasUnresolved: () => hasUnresolvedStageFailures(state, 'memory_consolidate_windows'),
              onDrained: () => {
                prepareDrained = true;
                return true;
              },
            });
            if (!canContinue) break;
            const expandedCommitUnits = (prepareDrained ? orderedMemoryUnits : chunk)
              .flatMap((unit) =>
              state.memory_consolidate_windows[unit.unit_id]?.status === 'split'
                ? splitChildUnitsForContainer(state, 'memory_consolidate_windows', unit.unit_id)
                : [unit]);
            const commitChunk = prepareDrained
              ? selectDrainCommitUnits(
                  state,
                  'memory_consolidate_windows',
                  expandedCommitUnits,
                )
              : expandedCommitUnits;
            canContinue = await runQueue('memory_consolidate', commitChunk, {
              concurrency: 1,
              ignoreDrain: prepareDrained,
              writeState: writeMemoryScheduler,
              run: (unit, context) => runRestMemoryCommitUnit({
                state,
                statePath,
                baseUrl: state.base_url,
                secret,
                unit,
                options: {
                  ...options,
                  signal: context.signal,
                  writeState: writeMemoryUnit(unit),
                },
              }),
              itemId: (unit) => unit.unit_id,
              hasUnresolved: () => hasUnresolvedStageFailures(state, 'memory_consolidate_windows'),
            });
            if (!canContinue) break;
            await runStateStore.checkpoint(state);
            if (prepareDrained) {
              state.drain_requested_at = new Date().toISOString();
              state.health.last_error = null;
              await runStateStore.checkpoint(state);
              await runStateStore.writeStatus(state);
              canContinue = false;
              break;
            }
          }
        }
      }

      if (canContinue) {
        const refreshedWindows = semanticWindowsForExecution(state, finalSemanticWindows);
        const writeSemanticScheduler = async () => {
          await runStateStore.append('scheduler_state', {
            stage_work_queues: redactJson(state.stage_work_queues),
            last_failure_cause: state.last_failure_cause || null,
            provider_limiter: redactJson(state.provider_limiter),
          }, { durable: true });
          await runStateStore.writeStatus(state);
        };
        const writeSemanticUnit = (window) => async () => {
          const current = state.semantic_windows[window.window_id];
          await runStateStore.append('unit_state', {
            container_key: 'semantic_windows',
            unit_id: window.window_id,
            unit: redactJson(current),
            semantic_memory_char_sizes: redactJson(state.semantic_memory_char_sizes),
          }, {
            durable: terminalStageStatus(current?.status) || current?.record_pending === true,
          });
          await runStateStore.writeStatus(state);
        };
        canContinue = await runPipelineQueue('independent', 'semantic_rollup', refreshedWindows, {
          concurrency: 2,
          writeState: writeSemanticScheduler,
          run: (window, context) => runSemanticWindow({
            state,
            statePath,
            baseUrl: state.base_url,
            secret,
            window,
            options: {
              ...options,
              signal: context.signal,
              writeState: writeSemanticUnit(window),
            },
          }),
          itemId: (window) => window.window_id,
          expand: (window, outcome) => outcome.status === 'retry_planned'
            ? semanticSplitLeafWindowsForExecution(state, window.window_id)
            : [],
          hasUnresolved: () => hasUnresolvedStageFailures(state, 'semantic_windows'),
        });
        if (canContinue) await runStateStore.checkpoint(state);
      }

      if (canContinue) {
        const skillPlan = await runPlanQueue('skill_extract', 'skill_extract', (planOptions) => planSkillExtractStage({
          state,
          statePath,
          baseUrl: state.base_url,
          secret,
          options: planOptions,
          dryRun: false,
        }));
        canContinue = skillPlan.ok;
        if (canContinue) {
          const skillProviderLimiter = new AdaptiveProviderLimiter({
            buckets: state.provider_limiter || {},
          });
          const skillProviderRoute = {
            provider: state.runtime?.providerName || state.runtime?.provider_name || 'unknown',
            model: state.config.stage_models?.skill_extract || 'service-default',
            endpointClass: 'skill-extract-prepare',
          };
          const persistSkillLimiter = () => {
            state.provider_limiter = skillProviderLimiter.toJSON();
          };
          persistSkillLimiter();
          const writeSkillScheduler = async () => {
            await runStateStore.append('scheduler_state', {
              stage_work_queues: redactJson(state.stage_work_queues),
              last_failure_cause: state.last_failure_cause || null,
              provider_limiter: redactJson(state.provider_limiter),
            }, { durable: true });
            await runStateStore.writeStatus(state);
          };
          const writeSkillUnit = (unit) => async () => {
            const current = state.skill_extract[unit.unit_id];
            await runStateStore.append('unit_state', {
              container_key: 'skill_extract',
              unit_id: unit.unit_id,
              unit: redactJson(current),
            }, {
              durable: terminalStageStatus(current?.status)
                || current?.status === 'prepared'
                || current?.record_pending === true,
            });
            await runStateStore.writeStatus(state);
          };
          const skillChunks = [];
          for (let index = 0; index < skillPlan.units.length; index += 4) {
            skillChunks.push(skillPlan.units.slice(index, index + 4));
          }
          for (const chunk of skillChunks) {
            let prepareDrained = false;
            const results = await runStagePipeline([chunk], {
              mode: 'ordered-commit',
              concurrency: 1,
              prepare: async (items) => runQueue('skill_extract_prepare', items, {
                concurrency: 2,
                getConcurrency: () => skillProviderLimiter.state(skillProviderRoute).concurrency,
                requiresProviderProbe: () => skillProviderLimiter.requiresProbe(skillProviderRoute),
                getProviderRetryAt: () => skillProviderLimiter.state(skillProviderRoute).retryAt,
                onOutcome: (unit, outcome, context) => {
                  const current = state.skill_extract[unit.unit_id];
                  if (outcome.failure) {
                    skillProviderLimiter.recordFailure(skillProviderRoute, outcome.failure, {
                      retryAfterMs: Number(outcome.failure.diagnostics?.retryAfterMs || 0),
                      now: context.settledAt,
                    });
                  } else if (['prepared', 'succeeded', 'skipped'].includes(current?.status)) {
                    skillProviderLimiter.recordProviderSuccess(skillProviderRoute, {
                      probe: context.probe,
                    });
                  }
                  persistSkillLimiter();
                },
                writeState: writeSkillScheduler,
                run: (unit, context) => runSkillExtractPrepareUnit({
                  state,
                  statePath,
                  baseUrl: state.base_url,
                  secret,
                  unit,
                  options: {
                    ...options,
                    signal: context.signal,
                    writeState: writeSkillUnit(unit),
                  },
                }),
                itemId: (unit) => unit.unit_id,
                initialOutcome: (unit) => {
                  const status = state.skill_extract[unit.unit_id]?.status;
                  if (terminalStageStatus(status) || status === 'prepared') return stageOutcome('succeeded');
                  return initialStageOutcome(state, 'skill_extract', unit);
                },
                hasUnresolved: () => hasUnresolvedStageFailures(state, 'skill_extract'),
                onDrained: () => {
                  prepareDrained = true;
                  return true;
                },
              }),
              commit: async (items, prepared) => prepared === true && runQueue(
                'skill_extract',
                prepareDrained
                  ? selectDrainCommitUnits(state, 'skill_extract', skillPlan.units)
                  : items,
                {
                concurrency: 1,
                ignoreDrain: prepareDrained,
                writeState: writeSkillScheduler,
                run: (unit, context) => runSkillExtractCommitUnit({
                  state,
                  statePath,
                  baseUrl: state.base_url,
                  secret,
                  unit,
                  options: {
                    ...options,
                    signal: context.signal,
                    writeState: writeSkillUnit(unit),
                  },
                }),
                itemId: (unit) => unit.unit_id,
                hasUnresolved: () => hasUnresolvedStageFailures(state, 'skill_extract'),
                },
              ),
            });
            canContinue = results[0] === true;
            if (!canContinue) break;
            await runStateStore.checkpoint(state);
            if (prepareDrained) {
              state.drain_requested_at = new Date().toISOString();
              state.health.last_error = null;
              await runStateStore.checkpoint(state);
              await runStateStore.writeStatus(state);
              canContinue = false;
              break;
            }
          }
        }
      }

      if (canContinue) {
        const crystalPlan = await runPlanQueue('crystal', 'crystal_groups', (planOptions) => planCrystalStage({
          state,
          statePath,
          baseUrl: state.base_url,
          secret,
          options: planOptions,
          dryRun: false,
        }));
        canContinue = crystalPlan.ok;
        if (canContinue) canContinue = await runPipelineQueue('single-step', 'crystal', crystalPlan.units, {
          concurrency: 1,
          run: (unit, context) => runCrystalAuto({
            state,
            statePath,
            baseUrl: state.base_url,
            secret,
            unit,
            options: { ...options, signal: context.signal },
          }),
          itemId: (unit) => unit.unit_id,
          hasUnresolved: () => hasUnresolvedStageFailures(state, 'crystal_groups'),
        });
      }

      if (canContinue) {
        const proceduralPlan = await runPlanQueue(
          'consolidation_procedural',
          'consolidation_procedural_windows',
          (planOptions) => planRestFullStage({
            state,
            statePath,
            baseUrl: state.base_url,
            secret,
            options: planOptions,
            containerKey: 'consolidation_procedural_windows',
            dryRun: false,
          }),
        );
        canContinue = proceduralPlan.ok;
        if (canContinue) canContinue = await runPipelineQueue(
          'single-step',
          'consolidation_procedural',
          proceduralPlan.units,
          {
            concurrency: 1,
          run: (unit, context) => runRestFullStageUnit({
            state,
            statePath,
            baseUrl: state.base_url,
            secret,
            containerKey: 'consolidation_procedural_windows',
            unit,
            options: { ...options, signal: context.signal },
          }),
          itemId: (unit) => unit.unit_id,
          hasUnresolved: () => hasUnresolvedStageFailures(state, 'consolidation_procedural_windows'),
          },
        );
      }

      if (canContinue) {
        const reflectProviderRoute = {
          provider: state.runtime?.providerName || state.runtime?.provider_name || 'unknown',
          model: state.config.stage_models?.reflect_insight || 'service-default',
          endpointClass: 'reflect-insight',
        };
        const reflectBucketKey = new AdaptiveProviderLimiter({ max: 2 }).key(reflectProviderRoute);
        const reflectProviderLimiter = new AdaptiveProviderLimiter({
          initial: 2,
          max: 2,
          buckets: state.provider_limiter?.[reflectBucketKey]
            ? { [reflectBucketKey]: state.provider_limiter[reflectBucketKey] }
            : {},
        });
        const persistReflectLimiter = () => {
          state.provider_limiter = {
            ...(state.provider_limiter || {}),
            ...reflectProviderLimiter.toJSON(),
          };
        };
        persistReflectLimiter();
        const writeReflectScheduler = async () => {
          await runStateStore.append('scheduler_state', {
            stage_work_queues: redactJson(state.stage_work_queues),
            last_failure_cause: state.last_failure_cause || null,
            provider_limiter: redactJson(state.provider_limiter),
          }, { durable: true });
          await runStateStore.writeStatus(state);
        };
        const writeReflectUnit = (unit) => async () => {
          const current = state.reflect_insight_windows[unit.unit_id];
          state.coverage = computeCoverage(state);
          state.updated_at = new Date().toISOString();
          await runStateStore.append('unit_state', {
            container_key: 'reflect_insight_windows',
            unit_id: unit.unit_id,
            unit: redactJson(current),
          }, {
            durable: terminalStageStatus(current?.status) || current?.record_pending === true,
          });
          await runStateStore.writeStatus(state);
        };
        const reflectPlan = await runPlanQueue('reflect_insight', 'reflect_insight_windows', (planOptions) =>
          planRestFullStage({
            state,
            statePath,
            baseUrl: state.base_url,
            secret,
            options: planOptions,
            containerKey: 'reflect_insight_windows',
            dryRun: false,
          }));
        if (reflectPlan.ok) await runPipelineQueue('single-step', 'reflect_insight', reflectPlan.units, {
          concurrency: 2,
          getConcurrency: () => reflectProviderLimiter.state(reflectProviderRoute).concurrency,
          requiresProviderProbe: () => reflectProviderLimiter.requiresProbe(reflectProviderRoute),
          getProviderRetryAt: () => reflectProviderLimiter.state(reflectProviderRoute).retryAt,
          onOutcome: (_unit, outcome, context) => {
            if (outcome.failure) {
              reflectProviderLimiter.recordFailure(reflectProviderRoute, outcome.failure, {
                retryAfterMs: Number(outcome.failure.diagnostics?.retryAfterMs || 0),
                now: context.settledAt,
              });
            } else if (['succeeded', 'skipped'].includes(outcome.status)) {
              reflectProviderLimiter.recordProviderSuccess(reflectProviderRoute, {
                probe: context.probe,
              });
            }
            persistReflectLimiter();
          },
          writeState: writeReflectScheduler,
          run: (unit, context) => runRestFullStageUnit({
            state,
            statePath,
            baseUrl: state.base_url,
            secret,
            containerKey: 'reflect_insight_windows',
            unit,
            options: {
              ...options,
              signal: context.signal,
              writeState: writeReflectUnit(unit),
            },
          }),
          itemId: (unit) => unit.unit_id,
          hasUnresolved: () => hasUnresolvedStageFailures(state, 'reflect_insight_windows'),
        });
      }
    }

    state.coverage = computeCoverage(state);
    state.stage_metrics = computeStageMetrics(state);
    state.updated_at = new Date().toISOString();
    await runStateStore.checkpoint(state);
    await runStateStore.writeStatus(state);
    logProgress('coverage', 'final', { coverage: state.coverage });
    logProgress('metrics', 'final', { stage_metrics: state.stage_metrics });
    const finalSummary = redactJson({
      run_id: state.run_id,
      state_path: statePath,
      coverage: state.coverage,
      stage_metrics: state.stage_metrics,
    });
    console.log(JSON.stringify(finalSummary, null, 2));
    if (state.drain_requested_at) return 75;
    if (!options.dryRun && state.coverage?.acceptance_ready !== true) {
      console.error(redactSensitiveText(`full extraction not acceptance ready: ${JSON.stringify(finalSummary.coverage)}`));
      return 1;
    }
    return 0;
  } catch (error) {
    if (error?.name !== 'AbortError') throw error;
    if (state) {
      state.cancelled_at ??= new Date().toISOString();
      state.health ??= {};
      state.health.last_error = 'cancelled';
      state.updated_at = new Date().toISOString();
      await writeStateAtomically(statePath, state);
    }
    return 130;
  } finally {
    cancellation.dispose?.();
    try {
      if (stateLock) await releaseStateLock(stateLock);
    } catch {
      // 锁释放尽力而为，不能掩盖运行本身的结果或错误。
    }
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  mainForTest().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(redactSensitiveText(error?.message || error));
    process.exitCode = 1;
  });
}

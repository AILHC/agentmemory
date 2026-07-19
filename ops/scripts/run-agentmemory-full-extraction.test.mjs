import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  assertRuntimeConcurrency,
  assertAutomaticModelPolicy,
  acquireStateLock,
  buildConfigFromOptions,
  buildInitialState,
  backfillOrchestrationPolicy,
  buildLessonExtractBody,
  buildSemanticRollupBody,
  buildStageModelRequestBody,
  buildFormalOperationBody,
  buildSummaryBody,
  buildSessionsPath,
  beginResumeSchedulerEpoch,
  computeCoverage,
  computeStageMetrics,
  computeInventoryHash,
  classifyRetryableLessonRun,
  classifyPlanFailure,
  classifyStageResponse,
  createCancellationController,
  deriveSessionIdFromImportRecord,
  ENABLED_STAGES,
  enqueueStateWrite,
  filterExcludedSessions,
  findPlannedContainerDrifts,
  findSessionSummary,
  freezeMemoryConsolidateOrder,
  isRunFreshForAttempt,
  mainForTest,
  makeRunId,
  migrateOrchestrationPolicy,
  normalizeSessions,
  parseArgs,
  persistTerminalThenRecord,
  planSkillExtractUnits,
  planSemanticWindows,
  planSemanticWindowsByCharBudget,
  redactJson,
  redactSensitiveText,
  reconcileSemanticWindowsAfterSummary,
  releaseStateLock,
  requestJson,
  requestMemoryConsolidatePlan,
  resolveCliStageModel,
  runDoctorGate,
  runLessonsForSession,
  runPowerShellScript,
  runRestMemoryPrepareUnit,
  runWithConsecutiveFailureStop,
  runStageWorkQueue,
  runSemanticWindow,
  runSkillExtractCommitUnit,
  runSkillExtractPrepareUnit,
  runSkillExtractUnit,
  runSummaryForSession,
  sanitizeFailureDiagnostics,
  sanitizeStateSchema,
  selectFullExtractionSessions,
  semanticSplitLeafWindowsForExecution,
  resetDriftedSemanticUnits,
  resetStaleRunningUnits,
  splitChildUnitsForContainer,
  stableHash,
  stageFailureFromState,
  summarizeChunkStatuses,
  summaryPromptFields,
  summaryNeedsWork,
  hasUnresolvedStageFailures,
  initialPlanOutcome,
  terminalLessonStatus,
  validateDrainRequest,
  validatePlannedWindowBudget,
  validateResumeState,
  writeStateAtomically,
} from './run-agentmemory-full-extraction.mjs';
import { AdaptiveProviderLimiter } from './lib/adaptive-provider-limiter.mjs';

test('plan 404 is runtime-transient only when runtime diagnostics are unhealthy', async () => {
  const response = { status_code: 404, data: { error: 'not found' } };
  assert.deepEqual(
    await classifyPlanFailure(response, async () => ({ runtime_healthy: false })),
    { class: 'transient_runtime', cause: 'http_404' },
  );
  assert.deepEqual(
    await classifyPlanFailure(response, async () => ({ runtime_healthy: true })),
    { class: 'hard', cause: 'http_404' },
  );
});

test('stage queue drains before starting new work', async () => {
  const state = buildInitialState({
    runId: 'drain-test',
    baseUrl: 'http://127.0.0.1:3111',
    now: '2026-07-18T00:00:00.000Z',
  });
  const run = async () => ({ status: 'succeeded', failure: null });
  let calls = 0;
  const result = await runStageWorkQueue('summary', state, 'unused.json', ['a'], {
    run: async (...args) => {
      calls += 1;
      return run(...args);
    },
    shouldDrain: async () => true,
    writeState: async () => {},
  });
  assert.equal(result.status, 'drained');
  assert.equal(calls, 0);
});

test('memory consolidate commit order is frozen across planner reorder and rejects membership drift', () => {
  const state = {};
  const original = [{ unit_id: 'a' }, { unit_id: 'b' }, { unit_id: 'c' }];
  assert.deepEqual(freezeMemoryConsolidateOrder(state, original).map((unit) => unit.unit_id), ['a', 'b', 'c']);
  assert.deepEqual(
    freezeMemoryConsolidateOrder(state, [original[2], original[0], original[1]]).map((unit) => unit.unit_id),
    ['a', 'b', 'c'],
  );
  assert.throws(
    () => freezeMemoryConsolidateOrder(state, [{ unit_id: 'a' }, { unit_id: 'b' }, { unit_id: 'd' }]),
    /memory_consolidate_order_drift/,
  );
});

test('memory consolidate resume accepts only an executable subset of the frozen order', () => {
  const state = {
    memory_consolidate_windows: {
      done: {
        unit_id: 'done',
        input_hash: 'done-hash',
        status: 'succeeded',
      },
      a: {
        unit_id: 'a',
        input_hash: 'a-hash',
        status: 'pending',
      },
      b: {
        unit_id: 'b',
        input_hash: 'b-hash',
        status: 'pending',
      },
    },
    memory_consolidate_order: {
      unit_ids: ['done', 'a', 'b'],
      order_hash: stableHash(['done', 'a', 'b']),
    },
  };
  const remainingWork = [
    { unit_id: 'a', input_hash: 'a-hash' },
    { unit_id: 'b', input_hash: 'b-hash' },
  ];
  assert.deepEqual(
    freezeMemoryConsolidateOrder(state, [
      remainingWork[1],
      remainingWork[0],
    ]).map((unit) => unit.unit_id),
    ['a', 'b'],
  );
  assert.throws(
    () => freezeMemoryConsolidateOrder({
      ...state,
      memory_consolidate_windows: {
        ...state.memory_consolidate_windows,
        done: { ...state.memory_consolidate_windows.done, status: 'failed' },
      },
    }, remainingWork),
    /memory_consolidate_order_drift/,
  );
  assert.throws(
    () => freezeMemoryConsolidateOrder(state, [
      remainingWork[0],
      { unit_id: 'other', input_hash: 'other-hash' },
    ]),
    /memory_consolidate_order_drift/,
  );
});

test('drain request must bind to the current lock owner and lock lifetime', () => {
  const lock = {
    runId: 'formal-run',
    ownerId: 'owner-1',
    createdAt: '2026-07-18T00:00:00.000Z',
  };
  assert.equal(validateDrainRequest({
    run_id: 'formal-run',
    owner_id: 'owner-1',
    requested_at: '2026-07-18T00:01:00.000Z',
  }, lock, Date.parse('2026-07-18T00:02:00.000Z')), true);
  assert.throws(() => validateDrainRequest({
    run_id: 'formal-run',
    owner_id: 'owner-old',
    requested_at: '2026-07-18T00:01:00.000Z',
  }, lock), /drain_request_lock_owner_mismatch/);
  assert.throws(() => validateDrainRequest({
    run_id: 'formal-run',
    owner_id: 'owner-1',
    requested_at: '2026-07-17T23:59:59.000Z',
  }, lock), /drain_request_timestamp_invalid/);
});

test('historical plan 404 re-enters runtime recovery after an operator restart', () => {
  const state = {
    memory_consolidate_windows: {
      none: {
        status: 'failed',
        failure_class: 'hard',
        failure_cause: 'http_404',
      },
    },
  };
  assert.deepEqual(
    initialPlanOutcome(state, 'memory_consolidate_windows'),
    {
      status: 'failed',
      failure: { class: 'transient_runtime', cause: 'http_404' },
    },
  );
});

test('doctor gate prefers pwsh and uses an encoded command with UTF-8 IO', async () => {
  const calls = [];
  const expectedDiagnosis = 'diagnosis=OK_FORMAL_CONSOLE_OWNS_AGENTMEMORY_PORTS';
  const result = await runDoctorGate(
    "F:\\ai runtime\\含中文\\doctor's-agentmemory.ps1",
    expectedDiagnosis,
    {
      processRunner: async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 0, stdout: `${expectedDiagnosis}\n`, stderr: '' };
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pwsh');
  const encodedCommand = calls[0].args.at(-1);
  const decodedCommand = Buffer.from(encodedCommand, 'base64').toString('utf16le');
  assert.match(decodedCommand, /\[Console\]::OutputEncoding/);
  assert.match(decodedCommand, /含中文/);
  assert.match(decodedCommand, /doctor''s-agentmemory\.ps1/);
  assert.equal(result.powershell_command, 'pwsh');
});

test('PowerShell runner falls back only when pwsh is unavailable', async () => {
  const calls = [];
  const result = await runPowerShellScript('F:\\runtime\\doctor.ps1', async (command) => {
    calls.push(command);
    if (command === 'pwsh') {
      return { exitCode: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
    }
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  });

  assert.deepEqual(calls, ['pwsh', 'powershell.exe']);
  assert.equal(result.command, 'powershell.exe');
});

test('formal write bodies include operation identity while plan and dry-run bodies stay unchanged', () => {
  const state = { run_id: 'formal-run' };
  const base = { project: 'repo' };
  for (const [stage, unitId] of [
    ['memory_consolidate', 'mcw-1'],
    ['semantic_rollup', 'w0001'],
    ['skill_extract', 'skill-1'],
    ['crystal', 'auto'],
    ['consolidation_procedural', 'cpw-1'],
    ['reflect_insight', 'riw-1'],
  ]) {
    assert.deepEqual(buildFormalOperationBody(base, {
      state,
      stage,
      unitId,
      inputHash: `hash-${unitId}`,
    }), {
      project: 'repo',
      runId: 'formal-run',
      stage,
      unitId,
      inputHash: `hash-${unitId}`,
    });
  }
  assert.deepEqual(buildFormalOperationBody(base, { state, dryRun: true }), base);
  assert.deepEqual(buildFormalOperationBody(base, { state, plan: true }), base);
});

test('stage response classification uses only the current structured failure', () => {
  assert.deepEqual(classifyStageResponse({
    ok: false,
    status_code: 503,
    data: {
      failure: {
        class: 'transient_provider',
        cause: 'pi_stream_failed',
        diagnostics: {
          requestPhase: 'chunk',
          providerErrorCode: 'rate_limited',
          statusCode: 429,
          retryAfterMs: 2500,
          elapsedMs: 12,
          inputChars: 345,
          maxOutputTokens: 4096,
          responseStarted: false,
          responseModel: 'safe-model',
          stopReason: 'error',
          prompt: 'prompt-marker',
          rawError: 'raw-error-marker',
          headers: { authorization: 'credential-marker' },
          token: 'token-marker',
        },
      },
    },
    error: 'old failure_cause=unit',
  }), {
    class: 'transient_provider',
    cause: 'pi_stream_failed',
    diagnostics: {
      requestPhase: 'chunk',
      providerErrorCode: 'rate_limited',
      statusCode: 429,
      retryAfterMs: 2500,
      elapsedMs: 12,
      inputChars: 345,
      maxOutputTokens: 4096,
      responseStarted: false,
      responseModel: 'safe-model',
      stopReason: 'error',
    },
  });
  assert.deepEqual(classifyStageResponse({
    ok: false,
    status_code: 500,
    data: {},
    error: 'HTTP 500 provider maybe unavailable',
  }), { class: 'transient_runtime', cause: 'http_500' });
  assert.deepEqual(classifyStageResponse({
    ok: false,
    status_code: 0,
    data: {},
    error: 'request timed out',
  }), { class: 'transient_runtime', cause: 'request_transport_failed' });
  assert.deepEqual(classifyStageResponse({
    ok: false,
    status_code: 400,
    data: {},
    error: 'invalid operation identity',
  }), { class: 'hard', cause: 'http_400' });
});

test('stage response classification preserves a legacy circuit breaker error as provider recovery', () => {
  assert.deepEqual(classifyStageResponse({
    ok: false,
    status_code: 200,
    data: {
      success: false,
      error: 'circuit_breaker_open',
    },
  }), {
    class: 'transient_provider',
    cause: 'circuit_breaker_open',
  });
});

test('provider diagnostics determine runner recovery class without replacing the displayed failure cause', () => {
  const diagnostics = (providerErrorCode) => ({
    requestPhase: 'chunk',
    providerErrorCode,
    elapsedMs: 10,
    inputChars: 100,
    maxOutputTokens: 4096,
    responseStarted: false,
  });
  for (const providerErrorCode of ['auth_failed', 'model_not_found']) {
    const failure = classifyStageResponse({
      data: {
        failure: {
          class: 'transient_provider',
          cause: 'pi_stream_failed',
          diagnostics: diagnostics(providerErrorCode),
        },
      },
    });
    assert.equal(failure.class, 'hard');
    assert.equal(failure.cause, 'pi_stream_failed');
  }
  for (const providerErrorCode of ['rate_limited', 'timeout', 'network_error', 'server_error']) {
    const failure = classifyStageResponse({
      data: {
        failure: {
          class: 'unit',
          cause: 'pi_stream_failed',
          diagnostics: diagnostics(providerErrorCode),
        },
      },
    });
    assert.equal(failure.class, 'transient_provider');
    assert.equal(failure.cause, 'pi_stream_failed');
  }
  for (const providerErrorCode of ['provider_rejected', 'unknown']) {
    const failure = classifyStageResponse({
      data: {
        failure: {
          class: 'transient_provider',
          cause: 'pi_stream_failed',
          diagnostics: diagnostics(providerErrorCode),
        },
      },
    });
    assert.equal(failure.class, 'unit');
    assert.equal(failure.cause, 'pi_stream_failed');
  }
  assert.deepEqual(stageFailureFromState({
    failure_class: 'transient_provider',
    failure_cause: 'pi_stream_failed',
  }), { class: 'transient_provider', cause: 'pi_stream_failed' });
});

test('retryable lesson diagnostics use the same hard transient and unit classification', () => {
  const detail = (providerErrorCode) => ({
    run: {
      status: 'retryable',
      failureDiagnostics: {
        requestPhase: 'chunk',
        providerErrorCode,
        elapsedMs: 1,
        inputChars: 1,
        maxOutputTokens: 1,
        responseStarted: false,
      },
    },
  });
  for (const providerErrorCode of ['auth_failed', 'model_not_found']) {
    assert.equal(classifyRetryableLessonRun(detail(providerErrorCode)).class, 'hard');
  }
  for (const providerErrorCode of ['rate_limited', 'timeout', 'network_error', 'server_error']) {
    assert.equal(classifyRetryableLessonRun(detail(providerErrorCode)).class, 'transient_provider');
  }
  for (const providerErrorCode of ['provider_rejected', 'unknown']) {
    assert.equal(classifyRetryableLessonRun(detail(providerErrorCode)).class, 'unit');
  }
});

test('failure diagnostics allowlist and legacy state recovery reject unknown fields', () => {
  const diagnostics = sanitizeFailureDiagnostics({
    requestPhase: 'reduce',
    providerErrorCode: 'server_error',
    statusCode: 503,
    retryAfterMs: 2000,
    elapsedMs: 22,
    inputChars: 456,
    maxOutputTokens: 8192,
    responseStarted: true,
    responseModel: 'safe-model',
    stopReason: 'error',
    prompt: 'prompt-marker',
    rawError: 'raw-error-marker',
    headers: { authorization: 'credential-marker' },
    token: 'token-marker',
  });
  assert.deepEqual(diagnostics, {
    requestPhase: 'reduce',
    providerErrorCode: 'server_error',
    statusCode: 503,
    retryAfterMs: 2000,
    elapsedMs: 22,
    inputChars: 456,
    maxOutputTokens: 8192,
    responseStarted: true,
    responseModel: 'safe-model',
    stopReason: 'error',
  });
  assert.equal(JSON.stringify(diagnostics).includes('marker'), false);
  assert.equal(sanitizeFailureDiagnostics({
    requestPhase: 'chunk',
    providerErrorCode: 'rate_limited',
    retryAfterMs: 999_999,
    elapsedMs: 1,
    inputChars: 1,
    maxOutputTokens: 1,
    responseStarted: false,
  }).retryAfterMs, 300_000);
  assert.equal(sanitizeFailureDiagnostics({ providerErrorCode: 'unknown' }), undefined);
  assert.deepEqual(stageFailureFromState({
    failure_class: 'transient_provider',
    failure_cause: 'pi_stream_failed',
  }), { class: 'transient_provider', cause: 'pi_stream_failed' });
});

test('orchestration policy backfill preserves legacy config hash and stop threshold', () => {
  const state = {
    config_hash: 'legacy-config-hash',
    config: { stop_after_consecutive_failures: 3 },
  };
  backfillOrchestrationPolicy(state, '2026-07-14T00:00:00.000Z');
  assert.equal(state.config_hash, 'legacy-config-hash');
  assert.equal(state.config.stop_after_consecutive_failures, 3);
  assert.equal(state.orchestration_policy_version, 1);
  assert.match(state.orchestration_policy_hash, /^[a-f0-9]{64}$/);
  assert.equal(state.scheduler_epoch, 1);
  assert.equal(state.next_retry_at, null);
  assert.equal(state.last_failure_cause, null);
});

test('explicit resume starts a fresh scheduler epoch without changing unit results', async () => {
  const state = backfillOrchestrationPolicy({
    scheduler_epoch: 1,
    next_retry_at: null,
    sessions: {
      failed: {
        summary: {
          status: 'failed',
          attempt_count: 3,
          failure_class: 'unit',
          failure_cause: 'stage_response_failed',
          isolation_epoch: 1,
        },
      },
    },
    stage_work_queues: {
      summary: {
        epoch: 1,
        provider_attempt: 0,
        runtime_attempt: 0,
        runtime_unhealthy_confirmations: 0,
        unit_attempts: { failed: 3 },
        provider_recovery_ids: [],
        runtime_recovery_ids: [],
        next_retry_at: null,
        retry_kind: null,
      },
    },
  });
  const before = structuredClone(state.sessions);

  beginResumeSchedulerEpoch(state, '2026-07-15T00:00:00.000Z');

  assert.equal(state.scheduler_epoch, 2);
  assert.equal(state.scheduler_resumed_at, '2026-07-15T00:00:00.000Z');
  assert.deepEqual(state.sessions, before);
  assert.deepEqual(state.stage_work_queues.summary.unit_attempts, { failed: 3 });

  let calls = 0;
  const result = await runStageWorkQueue('summary', state, 'unused.json', ['failed'], {
    itemId: (item) => item,
    writeState: async () => {},
    run: async () => {
      calls += 1;
      state.sessions.failed.summary.status = 'succeeded';
      return { status: 'succeeded', failure: null };
    },
    initialOutcome: () => ({
      status: 'failed',
      failure: { class: 'unit', cause: 'stage_response_failed' },
    }),
  });

  assert.equal(calls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(state.stage_work_queues.summary.epoch, 2);
  assert.deepEqual(state.stage_work_queues.summary.unit_attempts, {});
});

test('v0 to v1 orchestration migration preserves formal coverage and rebuilds only explicit recovery classes', async () => {
  const sessions = {};
  for (let index = 0; index < 3334; index += 1) {
    const id = `success-${String(index).padStart(4, '0')}`;
    sessions[id] = {
      session_id: id,
      summary: {
        status: 'succeeded',
        attempt_count: index % 4,
        input_hash: `input-${id}`,
        summary_hash: `summary-${id}`,
        result_ids: [`result-${id}`],
      },
      lessons_extract: { status: 'succeeded' },
    };
  }
  for (let index = 0; index < 11; index += 1) {
    const provider = index < 5;
    const id = `${provider ? 'provider' : 'unknown'}-${String(index).padStart(2, '0')}`;
    sessions[id] = {
      session_id: id,
      summary: {
        status: 'failed',
        attempt_count: 99,
        input_hash: `input-${id}`,
        ...(provider ? { failure_cause: 'pi_stream_failed' } : {}),
      },
      lessons_extract: { status: 'pending' },
    };
  }
  for (let index = 0; index < 607; index += 1) {
    const id = `pending-${String(index).padStart(4, '0')}`;
    sessions[id] = {
      session_id: id,
      summary: { status: 'pending', attempt_count: 0, input_hash: `input-${id}` },
      lessons_extract: { status: 'pending' },
    };
  }
  const state = {
    schema_version: 2,
    run_id: 'formal-v0-fixture',
    config_hash: 'legacy-config-hash',
    config: { delay_ms: 1500, stop_after_consecutive_failures: 3 },
    health: {},
    sessions,
    memory_consolidate_windows: {},
    semantic_windows: {},
    skill_extract: {},
    crystal_groups: {},
    consolidation_procedural_windows: {},
    reflect_insight_windows: {},
  };
  const beforeStatuses = Object.values(state.sessions).reduce((counts, session) => {
    counts[session.summary.status] = (counts[session.summary.status] || 0) + 1;
    return counts;
  }, {});
  const beforeSuccessIdentity = stableHash(Object.values(state.sessions)
    .filter((session) => session.summary.status === 'succeeded')
    .map((session) => [session.session_id, session.summary.input_hash, session.summary.summary_hash, session.summary.result_ids]));
  const beforeAllInputHashes = stableHash(Object.values(state.sessions)
    .map((session) => [session.session_id, session.summary.input_hash]));

  const report = migrateOrchestrationPolicy(state, '2026-07-14T12:00:00.000Z');

  const afterStatuses = Object.values(state.sessions).reduce((counts, session) => {
    counts[session.summary.status] = (counts[session.summary.status] || 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(beforeStatuses, { succeeded: 3334, failed: 11, pending: 607 });
  assert.deepEqual(afterStatuses, beforeStatuses);
  assert.equal(state.config_hash, 'legacy-config-hash');
  assert.equal(stableHash(Object.values(state.sessions)
    .filter((session) => session.summary.status === 'succeeded')
    .map((session) => [session.session_id, session.summary.input_hash, session.summary.summary_hash, session.summary.result_ids])), beforeSuccessIdentity);
  assert.equal(stableHash(Object.values(state.sessions)
    .map((session) => [session.session_id, session.summary.input_hash])), beforeAllInputHashes);
  assert.equal(state.orchestration_policy_version, 1);
  assert.equal(state.scheduler_epoch, 1);
  assert.equal(report.migrated, true);
  assert.equal(report.provider_recovery_units, 5);
  assert.equal(report.unit_failure_units, 6);
  assert.deepEqual(state.stage_work_queues.summary.provider_recovery_ids, [
    'provider-00',
    'provider-01',
    'provider-02',
    'provider-03',
    'provider-04',
  ]);
  assert.deepEqual(state.stage_work_queues.summary.unit_attempts, {});
  for (let index = 5; index < 11; index += 1) {
    const summary = state.sessions[`unknown-${String(index).padStart(2, '0')}`].summary;
    assert.equal(summary.failure_class, 'unit');
    assert.equal(summary.failure_cause, 'historical_stage_failure');
    assert.equal(summary.attempt_count, 99);
  }

  const starts = [];
  const failedIds = Object.keys(state.sessions).filter((id) => state.sessions[id].summary.status === 'failed');
  const outcome = await runStageWorkQueue('summary', state, 'unused.json', failedIds, {
    concurrency: 3,
    itemId: (item) => item,
    writeState: async () => {},
    sleep: async () => {},
    jitter: () => 0,
    run: async (item, context) => {
      starts.push({ item, probe: context.probe });
      return { status: 'succeeded', failure: null };
    },
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(starts.slice(0, 6).every((entry) => entry.probe === false), true);
  assert.deepEqual(starts.filter((entry) => entry.probe).map((entry) => entry.item), [
    'provider-00',
    'provider-01',
    'provider-02',
    'provider-03',
    'provider-04',
  ]);
});

test('state schema sanitization cannot silently bypass v0 orchestration migration', () => {
  const state = {
    schema_version: 2,
    config_hash: 'legacy-config-hash',
    sessions: {
      provider: {
        summary: { status: 'failed', attempt_count: 17, failure_cause: 'pi_stream_failed' },
        lessons_extract: { status: 'pending' },
      },
      unknown: {
        summary: { status: 'failed', attempt_count: 23 },
        lessons_extract: { status: 'pending' },
      },
    },
  };

  sanitizeStateSchema(state);

  assert.equal(state.orchestration_migration.migrated, true);
  assert.equal(state.orchestration_migration.from_version, 0);
  assert.deepEqual(state.stage_work_queues.summary.provider_recovery_ids, ['provider']);
  assert.equal(state.sessions.unknown.summary.failure_class, 'unit');
  assert.equal(state.sessions.unknown.summary.failure_cause, 'historical_stage_failure');
  assert.equal(state.sessions.provider.summary.attempt_count, 17);
  assert.equal(state.sessions.unknown.summary.attempt_count, 23);
});

test('orchestration migration rejects every policy version except integer v0 or v1', () => {
  for (const version of [Number.NaN, -1, 0.5, 2, '1']) {
    assert.throws(
      () => migrateOrchestrationPolicy({ orchestration_policy_version: version, sessions: {} }),
      /unsupported orchestration policy version/,
    );
  }
  assert.doesNotThrow(() => migrateOrchestrationPolicy({ orchestration_policy_version: 0, sessions: {} }));
  assert.doesNotThrow(() => migrateOrchestrationPolicy({ orchestration_policy_version: 1, sessions: {} }));
});

test('v0 migration keeps business failure semantics separate from pending record recovery', () => {
  const state = {
    schema_version: 2,
    sessions: {
      hard: {
        summary: {
          status: 'failed',
          record_pending: true,
          failure_class: 'hard',
          failure_cause: 'http_400',
        },
      },
      missing: {
        summary: { status: 'failed', record_pending: true },
      },
      succeeded: {
        summary: { status: 'succeeded', record_pending: true },
      },
      skipped: {
        summary: { status: 'skipped', record_pending: true },
      },
    },
  };

  const report = migrateOrchestrationPolicy(state, '2026-07-14T12:30:00.000Z');

  assert.deepEqual(
    {
      class: state.sessions.hard.summary.failure_class,
      cause: state.sessions.hard.summary.failure_cause,
    },
    { class: 'hard', cause: 'http_400' },
  );
  assert.deepEqual(
    {
      class: state.sessions.missing.summary.failure_class,
      cause: state.sessions.missing.summary.failure_cause,
    },
    { class: 'unit', cause: 'historical_stage_failure' },
  );
  assert.equal(Object.hasOwn(state.sessions.succeeded.summary, 'failure_class'), false);
  assert.equal(Object.hasOwn(state.sessions.succeeded.summary, 'failure_cause'), false);
  assert.equal(Object.hasOwn(state.sessions.skipped.summary, 'failure_class'), false);
  assert.equal(Object.hasOwn(state.sessions.skipped.summary, 'failure_cause'), false);
  assert.deepEqual(state.stage_work_queues.summary.runtime_recovery_ids, [
    'hard',
    'missing',
    'skipped',
    'succeeded',
  ]);
  assert.deepEqual(state.stage_work_queues.summary.provider_recovery_ids, []);
  assert.equal(report.runtime_recovery_units, 4);
  assert.equal(report.hard_failure_units, 1);
  assert.equal(report.unit_failure_units, 1);
});

test('stage work queue persists refreshed coverage after a settled batch changes business state', async () => {
  const state = backfillOrchestrationPolicy({
    config: { delay_ms: 0 },
    health: {},
    sessions: {
      a: {
        summary: { status: 'pending' },
        lessons_extract: { status: 'pending' },
      },
    },
  });
  state.coverage = computeCoverage(state);
  const writes = [];

  await runStageWorkQueue('summary', state, 'unused.json', ['a'], {
    writeState: async (_statePath, written) => {
      writes.push(structuredClone(written.coverage));
    },
    run: async () => {
      state.sessions.a.summary.status = 'succeeded';
      return { status: 'succeeded', failure: null };
    },
  });

  assert.equal(writes.at(-1).summary.succeeded, 1);
  assert.equal(writes.at(-1).summary.pending, 0);
  assert.deepEqual(state.coverage, writes.at(-1));
});

test('provider probe persists refreshed coverage on both failure and success', async () => {
  const state = backfillOrchestrationPolicy({
    config: { delay_ms: 0 },
    health: {},
    sessions: {
      a: {
        summary: { status: 'pending' },
        lessons_extract: { status: 'pending' },
      },
    },
  });
  state.coverage = computeCoverage(state);
  state.stage_work_queues.summary = {
    epoch: state.scheduler_epoch,
    provider_attempt: 0,
    runtime_attempt: 0,
    runtime_unhealthy_confirmations: 0,
    unit_attempts: {},
    provider_recovery_ids: ['a'],
    runtime_recovery_ids: [],
    next_retry_at: null,
    retry_kind: null,
  };
  const writes = [];
  let calls = 0;

  await runStageWorkQueue('summary', state, 'unused.json', ['a'], {
    writeState: async (_statePath, written) => {
      writes.push(structuredClone(written.coverage));
    },
    sleep: async () => {},
    jitter: () => 0,
    run: async () => {
      calls += 1;
      if (calls === 1) {
        state.sessions.a.summary.status = 'failed';
        return { status: 'failed', failure: { class: 'transient_provider', cause: 'pi_stream_failed' } };
      }
      state.sessions.a.summary.status = 'succeeded';
      return { status: 'succeeded', failure: null };
    },
  });

  assert.ok(writes.some((coverage) => coverage.summary.failed === 1));
  assert.equal(writes.at(-1).summary.succeeded, 1);
  assert.equal(writes.at(-1).summary.failed, 0);
});

test('mixed provider failure persists recovery state but lets the healthy queue continue before sleeping', async () => {
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const events = [];
  const calls = new Map();
  let recoveryStateSeenByHealthyTail = null;
  let active = 0;
  let peak = 0;
  const result = await runStageWorkQueue('summary', state, 'unused.json', ['a', 'b', 'c', 'd'], {
    concurrency: 3,
    itemId: (item) => item,
    now: () => now,
    writeState: async () => {},
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
      now += ms;
    },
    jitter: () => 0,
    run: async (item, context) => {
      events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
      if (item === 'd') {
        recoveryStateSeenByHealthyTail = structuredClone(state.stage_work_queues.summary);
      }
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      const count = (calls.get(item) || 0) + 1;
      calls.set(item, count);
      if (item === 'c' && count === 1) {
        return {
          status: 'failed',
          failure: {
            class: 'transient_provider',
            cause: 'pi_stream_failed',
            diagnostics: {
              requestPhase: 'chunk',
              providerErrorCode: 'timeout',
              elapsedMs: 10,
              inputChars: 100,
              maxOutputTokens: 4096,
              responseStarted: false,
            },
          },
        };
      }
      return { status: 'succeeded', failure: null };
    },
  });

  assert.equal(peak, 3);
  assert.deepEqual(events, [
    'run:a:normal',
    'run:b:normal',
    'run:c:normal',
    'run:d:normal',
    'sleep:60000',
    'run:c:probe',
  ]);
  assert.deepEqual(recoveryStateSeenByHealthyTail.provider_recovery_ids, ['c']);
  assert.equal(recoveryStateSeenByHealthyTail.retry_kind, 'provider');
  assert.equal(typeof recoveryStateSeenByHealthyTail.next_retry_at, 'string');
  assert.equal(result.status, 'completed');
});

test('adaptive provider cooldown blocks healthy tail work until one recovery probe succeeds', async () => {
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const limiter = new AdaptiveProviderLimiter({ initial: 3, cooldownMs: 60_000 });
  const route = {
    provider: 'pi-agent-sdk',
    model: 'gpt-5.6-luna',
    endpointClass: 'memory-consolidate-prepare',
  };
  const events = [];
  let failedCalls = 0;

  const result = await runStageWorkQueue('memory_consolidate_prepare', state, 'unused.json', [
    'failed',
    'healthy-1',
    'healthy-2',
    'tail',
  ], {
    concurrency: 3,
    getConcurrency: () => limiter.state(route).concurrency,
    requiresProviderProbe: () => limiter.requiresProbe(route),
    getProviderRetryAt: () => limiter.state(route).retryAt,
    now: () => now,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
      now += ms;
    },
    onOutcome: (_item, outcome, context) => {
      if (outcome.failure) {
        limiter.recordFailure(route, outcome.failure, { now: context.settledAt });
      } else {
        limiter.recordProviderSuccess(route, { probe: context.probe });
      }
    },
    run: async (item, context) => {
      events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
      if (item === 'failed' && failedCalls++ === 0) {
        return {
          status: 'failed',
          failure: { class: 'transient_provider', cause: 'timeout' },
        };
      }
      return { status: 'succeeded', failure: null };
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(events, [
    'run:failed:normal',
    'run:healthy-1:normal',
    'run:healthy-2:normal',
    'sleep:60000',
    'run:failed:probe',
    'run:tail:normal',
  ]);
  assert.equal(limiter.requiresProbe(route), false);
  assert.equal(limiter.state(route).successStreak, 2);
});

test('adaptive recovery remains a probe when provider recovery crosses the runtime gate', async () => {
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const limiter = new AdaptiveProviderLimiter({ initial: 1, cooldownMs: 60_000 });
  const route = {
    provider: 'pi-agent-sdk',
    model: 'gpt-5.6-luna',
    endpointClass: 'memory-consolidate-prepare',
  };
  const events = [];
  let failedCalls = 0;

  await runStageWorkQueue('memory_consolidate_prepare', state, 'unused.json', ['failed', 'tail'], {
    concurrency: 1,
    getConcurrency: () => limiter.state(route).concurrency,
    requiresProviderProbe: () => limiter.requiresProbe(route),
    getProviderRetryAt: () => limiter.state(route).retryAt,
    now: () => now,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
      now += ms;
    },
    runtimeDiagnostics: async () => ({ runtime_healthy: true }),
    onOutcome: (_item, outcome, context) => {
      if (outcome.failure) {
        limiter.recordFailure(route, outcome.failure, { now: context.settledAt });
      } else {
        limiter.recordProviderSuccess(route, { probe: context.probe });
      }
    },
    run: async (item, context) => {
      events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
      if (item === 'failed' && failedCalls++ === 0) {
        return { status: 'failed', failure: { class: 'transient_provider', cause: 'timeout' } };
      }
      if (item === 'failed' && failedCalls === 2) {
        return { status: 'failed', failure: { class: 'transient_runtime', cause: 'request_transport_failed' } };
      }
      return { status: 'succeeded', failure: null };
    },
  });

  assert.deepEqual(events, [
    'run:failed:normal',
    'sleep:60000',
    'run:failed:probe',
    'sleep:60000',
    'run:failed:probe',
    'run:tail:normal',
  ]);
  assert.equal(limiter.requiresProbe(route), false);
});

test('due provider recovery inserts at most one fair probe per healthy batch', async () => {
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  state.stage_work_queues.summary = {
    epoch: state.scheduler_epoch,
    provider_attempt: 0,
    runtime_attempt: 0,
    runtime_unhealthy_confirmations: 0,
    unit_attempts: {},
    provider_recovery_ids: ['r1', 'r2'],
    runtime_recovery_ids: [],
    next_retry_at: new Date(now).toISOString(),
    retry_kind: 'provider',
  };
  const events = [];
  let r2Calls = 0;
  const result = await runStageWorkQueue('summary', state, 'unused.json', ['r1', 'r2', 'n1', 'n2', 'n3'], {
    concurrency: 2,
    itemId: (item) => item,
    initialOutcome: (item) => item.startsWith('r')
      ? { status: 'failed', failure: { class: 'transient_provider', cause: 'pi_stream_failed' } }
      : null,
    now: () => now,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
      now += ms;
    },
    run: async (item, context) => {
      events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
      if (item === 'r2') {
        r2Calls += 1;
        if (r2Calls === 1) {
          return {
            status: 'failed',
            failure: {
              class: 'transient_provider',
              cause: 'pi_stream_failed',
              diagnostics: {
                requestPhase: 'chunk',
                providerErrorCode: 'timeout',
                elapsedMs: 1,
                inputChars: 1,
                maxOutputTokens: 1,
                responseStarted: false,
              },
            },
          };
        }
      }
      return { status: 'succeeded', failure: null };
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(events, [
    'run:r1:probe',
    'run:n1:normal',
    'run:r2:probe',
    'run:n2:normal',
    'run:n3:normal',
    'sleep:120000',
    'run:r2:probe',
  ]);
  assert.deepEqual(state.stage_work_queues.summary.provider_recovery_ids, []);
});

test('concurrency one alternates due recovery and healthy work without starving either queue', async () => {
  const now = Date.parse('2026-07-15T00:00:00.000Z');
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  state.stage_work_queues.summary = {
    epoch: state.scheduler_epoch,
    provider_attempt: 0,
    runtime_attempt: 0,
    runtime_unhealthy_confirmations: 0,
    unit_attempts: {},
    provider_recovery_ids: ['r1', 'r2'],
    runtime_recovery_ids: [],
    next_retry_at: new Date(now).toISOString(),
    retry_kind: 'provider',
  };
  const starts = [];
  await runStageWorkQueue('summary', state, 'unused.json', ['r1', 'r2', 'n1', 'n2'], {
    concurrency: 1,
    itemId: (item) => item,
    initialOutcome: (item) => item.startsWith('r')
      ? { status: 'failed', failure: { class: 'transient_provider', cause: 'pi_stream_failed' } }
      : null,
    now: () => now,
    writeState: async () => {},
    sleep: async () => { throw new Error('due recovery must not sleep'); },
    run: async (item, context) => {
      starts.push({ item, probe: context.probe });
      return { status: 'succeeded', failure: null };
    },
  });

  assert.deepEqual(starts, [
    { item: 'r1', probe: true },
    { item: 'n1', probe: false },
    { item: 'r2', probe: true },
    { item: 'n2', probe: false },
  ]);
});

test('two of three provider failures and a successful call do not open the global gate', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const events = [];
  const calls = new Map();
  await runStageWorkQueue('summary', state, 'unused.json', ['a', 'b', 'c', 'tail'], {
    concurrency: 3,
    itemId: (item) => item,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => { events.push(`sleep:${ms}`); },
    run: async (item, context) => {
      events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
      const callsForItem = (calls.get(item) || 0) + 1;
      calls.set(item, callsForItem);
      if (['a', 'b'].includes(item) && callsForItem === 1) {
        return {
          status: 'failed',
          failure: {
            class: 'transient_provider',
            cause: 'pi_stream_failed',
            diagnostics: {
              requestPhase: 'chunk',
              providerErrorCode: 'server_error',
              elapsedMs: 1,
              inputChars: 1,
              maxOutputTokens: 1,
              responseStarted: false,
            },
          },
        };
      }
      return { status: 'succeeded', failure: null };
    },
  });

  assert.deepEqual(events.slice(0, 4), [
    'run:a:normal',
    'run:b:normal',
    'run:c:normal',
    'run:tail:normal',
  ]);
});

test('a single provider failure in a one-item tail batch remains an ordinary recovery item', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const events = [];
  let tailCalls = 0;
  await runStageWorkQueue('summary', state, 'unused.json', ['a', 'b', 'c', 'tail'], {
    concurrency: 3,
    itemId: (item) => item,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => { events.push(`sleep:${ms}`); },
    run: async (item, context) => {
      events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
      if (item === 'tail' && tailCalls++ === 0) {
        return {
          status: 'failed',
          failure: {
            class: 'transient_provider',
            cause: 'pi_stream_failed',
            diagnostics: {
              requestPhase: 'chunk',
              providerErrorCode: 'timeout',
              elapsedMs: 1,
              inputChars: 1,
              maxOutputTokens: 1,
              responseStarted: false,
            },
          },
        };
      }
      return { status: 'succeeded', failure: null };
    },
  });
  assert.deepEqual(events.slice(0, 4), [
    'run:a:normal',
    'run:b:normal',
    'run:c:normal',
    'run:tail:normal',
  ]);
  assert.match(events[4], /^sleep:\d+$/);
  const sleptMs = Number(events[4].slice('sleep:'.length));
  assert.ok(sleptMs >= 59_000 && sleptMs <= 60_000);
  assert.equal(events[5], 'run:tail:probe');
});

test('three distinct breaker-eligible provider failures within sixty seconds open the global gate', async () => {
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const events = [];
  const calls = new Map();
  await runStageWorkQueue('summary', state, 'unused.json', ['a', 'b', 'c', 'tail'], {
    concurrency: 1,
    itemId: (item) => item,
    now: () => now,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
      now += ms;
    },
    run: async (item, context) => {
      events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
      const callsForItem = (calls.get(item) || 0) + 1;
      calls.set(item, callsForItem);
      if (['a', 'b', 'c'].includes(item) && callsForItem === 1) {
        now += 10_000;
        return {
          status: 'failed',
          failure: {
            class: 'transient_provider',
            cause: 'pi_stream_failed',
            diagnostics: {
              requestPhase: 'chunk',
              providerErrorCode: 'network_error',
              elapsedMs: 1,
              inputChars: 1,
              maxOutputTokens: 1,
              responseStarted: false,
            },
          },
        };
      }
      return { status: 'succeeded', failure: null };
    },
  });

  assert.deepEqual(events.slice(0, 4), [
    'run:a:normal',
    'run:b:normal',
    'run:c:normal',
    'sleep:40000',
  ]);
  assert.ok(events.indexOf('run:a:probe') < events.indexOf('run:tail:normal'));
});

test('pi_stream_failed without diagnostics stays in provider recovery but does not open the global gate', async () => {
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const events = [];
  const calls = new Map();
  await runStageWorkQueue('summary', state, 'unused.json', ['a', 'b', 'c', 'tail'], {
    concurrency: 1,
    itemId: (item) => item,
    now: () => now,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
      now += ms;
    },
    run: async (item, context) => {
      events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
      const count = (calls.get(item) || 0) + 1;
      calls.set(item, count);
      if (['a', 'b', 'c'].includes(item) && count === 1) {
        return {
          status: 'failed',
          failure: { class: 'transient_provider', cause: 'pi_stream_failed' },
        };
      }
      return { status: 'succeeded', failure: null };
    },
  });

  assert.deepEqual(events.slice(0, 4), [
    'run:a:normal',
    'run:b:normal',
    'run:c:normal',
    'run:tail:normal',
  ]);
  assert.ok(events.some((event) => event === 'run:a:probe'));
});

test('concurrent provider streak follows actual settlement order and time', async (t) => {
  const providerFailure = {
    status: 'failed',
    failure: {
      class: 'transient_provider',
      cause: 'pi_stream_failed',
      diagnostics: {
        requestPhase: 'chunk',
        providerErrorCode: 'timeout',
        elapsedMs: 1,
        inputChars: 1,
        maxOutputTokens: 1,
        responseStarted: false,
      },
    },
  };
  const createDeferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };

  const runScenario = async ({ work, settlementOrder }) => {
    let now = 0;
    const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
    const deferredByItem = new Map(work.slice(0, 3).map((item) => [item, createDeferred()]));
    const events = [];
    const calls = new Map();
    const execution = runStageWorkQueue('summary', state, 'unused.json', work, {
      concurrency: 3,
      itemId: (item) => item,
      now: () => now,
      writeState: async () => {},
      jitter: () => 0,
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
        now += ms;
      },
      run: async (item, context) => {
        const count = (calls.get(item) || 0) + 1;
        calls.set(item, count);
        events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}:${count}`);
        if (count === 1 && deferredByItem.has(item)) return deferredByItem.get(item).promise;
        if (item === 'c' && count === 1) {
          now = 30_000;
          return providerFailure;
        }
        if (item === 'unit' && count === 1) {
          return { status: 'failed', failure: { class: 'unit', cause: 'parse_failed' } };
        }
        return { status: 'succeeded', failure: null };
      },
    });

    while (events.filter((event) => event.endsWith(':normal:1')).length < 3) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (let index = 0; index < settlementOrder.length; index += 1) {
      const item = settlementOrder[index];
      now = index * 10_000;
      deferredByItem.get(item).resolve(
        item === 'success' ? { status: 'succeeded', failure: null } : providerFailure,
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    await execution;
    return events;
  };

  await t.test('does not falsely open when the success settles after two failures', async () => {
    const events = await runScenario({
      work: ['success', 'a', 'b', 'c', 'unit'],
      settlementOrder: ['a', 'b', 'success'],
    });
    const sleepIndex = events.findIndex((event) => event.startsWith('sleep:'));
    assert.ok(events.indexOf('run:unit:normal:2') < sleepIndex, events.join('\n'));
  });

  await t.test('opens when the success settles before three later failures', async () => {
    const events = await runScenario({
      work: ['a', 'b', 'success', 'c', 'unit'],
      settlementOrder: ['success', 'a', 'b'],
    });
    const sleepIndex = events.findIndex((event) => event.startsWith('sleep:'));
    assert.ok(sleepIndex < events.indexOf('run:unit:normal:2'), events.join('\n'));
  });
});

test('repeated failures from one item and failures outside the sixty-second window do not open the global gate', async (t) => {
  const failure = {
    status: 'failed',
    failure: {
      class: 'transient_provider',
      cause: 'pi_stream_failed',
      diagnostics: {
        requestPhase: 'chunk',
        providerErrorCode: 'timeout',
        retryAfterMs: 300_000,
        elapsedMs: 1,
        inputChars: 1,
        maxOutputTokens: 1,
        responseStarted: false,
      },
    },
  };

  await t.test('one item id is counted once', async () => {
    let now = 0;
    const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
    const events = [];
    await runStageWorkQueue('summary', state, 'unused.json', ['same-1', 'same-2', 'same-3', 'tail'], {
      concurrency: 1,
      itemId: (item) => item.startsWith('same') ? 'same' : item,
      now: () => now,
      writeState: async () => {},
      jitter: () => 0,
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
        now += ms;
      },
      run: async (item, context) => {
        events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
        return item.startsWith('same') && !context.probe
          ? failure
          : { status: 'succeeded', failure: null };
      },
    });
    assert.equal(events.indexOf('run:tail:normal') < events.findIndex((event) => event.startsWith('sleep:')), true);
  });

  await t.test('expired distinct failures are pruned', async () => {
    let now = 0;
    const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
    const events = [];
    await runStageWorkQueue('summary', state, 'unused.json', ['a', 'b', 'c', 'tail'], {
      concurrency: 1,
      itemId: (item) => item,
      now: () => now,
      writeState: async () => {},
      jitter: () => 0,
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
        now += ms;
      },
      run: async (item, context) => {
        events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
        if (['a', 'b', 'c'].includes(item) && !context.probe) {
          now += 31_000;
          return failure;
        }
        return { status: 'succeeded', failure: null };
      },
    });
    assert.equal(events.indexOf('run:tail:normal') < events.findIndex((event) => event.startsWith('sleep:')), true);
  });
});

test('a provider success breaks the systemic failure streak', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const events = [];
  const calls = new Map();
  await runStageWorkQueue('summary', state, 'unused.json', ['a', 'success', 'b', 'c', 'tail'], {
    concurrency: 1,
    itemId: (item) => item,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => { events.push(`sleep:${ms}`); },
    run: async (item, context) => {
      events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
      const callsForItem = (calls.get(item) || 0) + 1;
      calls.set(item, callsForItem);
      if (['a', 'b', 'c'].includes(item) && callsForItem === 1) {
        return {
          status: 'failed',
          failure: {
            class: 'transient_provider',
            cause: 'pi_stream_failed',
            diagnostics: {
              requestPhase: 'chunk',
              providerErrorCode: 'timeout',
              elapsedMs: 1,
              inputChars: 1,
              maxOutputTokens: 1,
              responseStarted: false,
            },
          },
        };
      }
      return { status: 'succeeded', failure: null };
    },
  });

  assert.deepEqual(events.slice(0, 5), [
    'run:a:normal',
    'run:success:normal',
    'run:b:normal',
    'run:c:normal',
    'run:tail:normal',
  ]);
});

test('circuit_breaker_open enters the global gate immediately', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const events = [];
  let firstCalls = 0;
  await runStageWorkQueue('summary', state, 'unused.json', ['first', 'tail'], {
    concurrency: 1,
    itemId: (item) => item,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => { events.push(`sleep:${ms}`); },
    run: async (item, context) => {
      events.push(`run:${item}:${context.probe ? 'probe' : 'normal'}`);
      if (item === 'first' && firstCalls++ === 0) {
        return { status: 'failed', failure: { class: 'transient_provider', cause: 'circuit_breaker_open' } };
      }
      return { status: 'succeeded', failure: null };
    },
  });
  assert.deepEqual(events.slice(0, 3), [
    'run:first:normal',
    'sleep:60000',
    'run:first:probe',
  ]);
});

test('unknown and provider_rejected stay within finite unit retries and never sleep at the provider gate', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const calls = new Map();
  const diagnostics = (providerErrorCode) => ({
    requestPhase: 'chunk',
    providerErrorCode,
    elapsedMs: 1,
    inputChars: 1,
    maxOutputTokens: 1,
    responseStarted: false,
  });
  const result = await runStageWorkQueue('summary', state, 'unused.json', ['unknown', 'rejected', 'healthy'], {
    concurrency: 1,
    itemId: (item) => item,
    writeState: async () => {},
    sleep: async () => { throw new Error('unit failures must not enter provider recovery'); },
    run: async (item) => {
      calls.set(item, (calls.get(item) || 0) + 1);
      if (item === 'healthy') return { status: 'succeeded', failure: null };
      return {
        status: 'failed',
        failure: {
          class: 'transient_provider',
          cause: 'pi_stream_failed',
          diagnostics: diagnostics(item === 'unknown' ? 'unknown' : 'provider_rejected'),
        },
      };
    },
  });

  assert.equal(result.status, 'completed_with_failures');
  assert.equal(calls.get('unknown'), 3);
  assert.equal(calls.get('rejected'), 3);
  assert.equal(calls.get('healthy'), 1);
});

test('provider retryAfterMs is capped at five minutes and dominates policy backoff', async () => {
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const sleeps = [];
  let calls = 0;
  await runStageWorkQueue('summary', state, 'unused.json', ['a'], {
    itemId: (item) => item,
    now: () => now,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    run: async () => {
      calls += 1;
      if (calls > 1) return { status: 'succeeded', failure: null };
      return {
        status: 'failed',
        failure: {
          class: 'transient_provider',
          cause: 'pi_stream_failed',
          diagnostics: {
            requestPhase: 'chunk',
            providerErrorCode: 'rate_limited',
            retryAfterMs: 999_999,
            elapsedMs: 1,
            inputChars: 1,
            maxOutputTokens: 1,
            responseStarted: false,
          },
        },
      };
    },
  });
  assert.deepEqual(sleeps, [300_000]);
});

test('healthy work overlaps provider backoff and reduces virtual completion time', async () => {
  let now = 0;
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  let failedOnce = false;
  await runStageWorkQueue('summary', state, 'unused.json', ['failure', 'healthy-1', 'healthy-2', 'healthy-3'], {
    concurrency: 1,
    itemId: (item) => item,
    now: () => now,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => { now += ms; },
    run: async (item) => {
      if (item === 'failure' && !failedOnce) {
        failedOnce = true;
        return {
          status: 'failed',
          failure: {
            class: 'transient_provider',
            cause: 'pi_stream_failed',
            diagnostics: {
              requestPhase: 'chunk',
              providerErrorCode: 'timeout',
              elapsedMs: 1,
              inputChars: 1,
              maxOutputTokens: 1,
              responseStarted: false,
            },
          },
        };
      }
      if (item.startsWith('healthy')) now += 30_000;
      return { status: 'succeeded', failure: null };
    },
  });

  assert.equal(now, 90_000);
  assert.ok(now < 150_000);
});

test('provider recovery backoff is persisted, capped, jitterable, and never hot-loops', async () => {
  const now = Date.parse('2026-07-15T00:00:00.000Z');
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const controller = new AbortController();
  const sleeps = [];
  await assert.rejects(
    runStageWorkQueue('summary', state, 'unused.json', ['a'], {
      concurrency: 3,
      signal: controller.signal,
      now: () => now,
      writeState: async () => {},
      jitter: () => 7,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 5) controller.abort(new Error('test cancel'));
      },
      run: async () => ({
        status: 'failed',
        failure: { class: 'transient_provider', cause: 'circuit_breaker_open' },
      }),
    }),
    /cancel/i,
  );
  assert.deepEqual(sleeps, [60_007, 120_007, 240_007, 300_007, 300_007]);
  assert.equal(state.last_failure_cause, 'circuit_breaker_open');
  assert.ok(state.next_retry_at);
});

test('runtime failures require two unhealthy diagnostic confirmations and doctor is only secondary', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  let calls = 0;
  let diagnostics = 0;
  const result = await runStageWorkQueue('semantic_rollup', state, 'unused.json', ['a'], {
    writeState: async () => {},
    sleep: async () => {},
    run: async () => {
      calls += 1;
      return {
        status: 'failed',
        failure: { class: 'transient_runtime', cause: 'request_transport_failed' },
      };
    },
    runtimeDiagnostics: async () => {
      diagnostics += 1;
      return { runtime_healthy: false, doctor_healthy: false };
    },
  });
  assert.equal(calls, 2);
  assert.equal(diagnostics, 2);
  assert.equal(result.status, 'blocked');
  assert.equal(result.failure.class, 'hard');
  assert.equal(result.failure.cause, 'runtime_unhealthy_confirmed');
});

test('unit failures get two extra attempts in one epoch then isolate without blocking sibling work', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const calls = new Map();
  const result = await runStageWorkQueue('skill_extract', state, 'unused.json', ['bad', 'good'], {
    concurrency: 1,
    itemId: (item) => item,
    writeState: async () => {},
    sleep: async () => {},
    run: async (item) => {
      calls.set(item, (calls.get(item) || 0) + 1);
      return item === 'bad'
        ? { status: 'failed', failure: { class: 'unit', cause: 'parse_failed' } }
        : { status: 'succeeded', failure: null };
    },
  });
  assert.equal(calls.get('bad'), 3);
  assert.equal(calls.get('good'), 1);
  assert.equal(result.status, 'completed_with_failures');
  assert.deepEqual(result.unresolved.map((item) => item.id), ['bad']);
});

test('resume queue skips terminal units before applying batch delay', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 1500 }, health: {} });
  const calls = [];
  const sleeps = [];

  const result = await runStageWorkQueue('summary', state, 'unused.json', ['done', 'failed'], {
    concurrency: 1,
    itemId: (item) => item,
    writeState: async () => {},
    sleep: async (ms) => { sleeps.push(ms); },
    initialOutcome: (item) => item === 'done'
      ? { status: 'succeeded', failure: null }
      : { status: 'failed', failure: { class: 'unit', cause: 'parse_failed' } },
    run: async (item) => {
      calls.push(item);
      return { status: 'succeeded', failure: null };
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['failed']);
  assert.deepEqual(sleeps, []);
});

test('stage barrier blocks dependent planning while unresolved failures remain', () => {
  assert.equal(hasUnresolvedStageFailures({
    semantic_windows: {
      a: { status: 'succeeded' },
      b: { status: 'failed', isolated_at: '2026-07-14T00:00:00.000Z' },
    },
  }, 'semantic_windows'), true);
  assert.equal(hasUnresolvedStageFailures({
    semantic_windows: { a: { status: 'succeeded' }, b: { status: 'skipped' } },
  }, 'semantic_windows'), false);
});

test('injected signal cancellation aborts cancellable queue work without real process signals', async () => {
  const source = new EventEmitter();
  const cancellation = createCancellationController(source);
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const promise = runStageWorkQueue('summary', state, 'unused.json', ['a'], {
    signal: cancellation.signal,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async () => {
      source.emit('SIGTERM');
    },
    run: async () => ({
      status: 'failed',
      failure: { class: 'transient_provider', cause: 'pi_stream_failed' },
    }),
  });
  await assert.rejects(promise, /cancel/i);
  assert.ok(state.cancelled_at);
  assert.deepEqual(state.stage_work_queues.summary.provider_recovery_ids, ['a']);
  assert.equal(state.stage_work_queues.summary.retry_kind, 'provider');
  assert.equal(typeof state.stage_work_queues.summary.next_retry_at, 'string');
  cancellation.dispose();
  assert.equal(source.listenerCount('SIGINT'), 0);
  assert.equal(source.listenerCount('SIGTERM'), 0);
});

test('summary skipped step preserves the current provider failure for the recovery gate', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      return {
        success: true,
        status: 'in_progress',
        advanced: 'skipped',
        completedChunks: 0,
        totalChunks: 22,
        skippedChunks: 1,
        failure: { class: 'transient_provider', cause: 'pi_stream_failed' },
      };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-skipped-provider-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'summary-skipped-provider',
      mark: 'full',
      config: { agent_id: '*' },
      sessions: { s1: { session_id: 's1', summary: { status: 'pending', attempt_count: 0 } } },
    };
    const outcome = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(outcome.status, 'in_progress');
    assert.deepEqual(outcome.failure, { class: 'transient_provider', cause: 'pi_stream_failed' });
    assert.equal(state.sessions.s1.summary.status, 'pending');
    assert.equal(state.sessions.s1.summary.advanced, 'skipped');
    assert.equal(state.sessions.s1.summary.failure_class, 'transient_provider');
    assert.equal(state.sessions.s1.summary.failure_cause, 'pi_stream_failed');
    assert.equal(requests.filter((request) => request.url === '/agentmemory/summarize/resumable').length, 1);
  });
});

test('summary in_progress with no advance is a recoverable no-progress failure', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      return {
        success: true,
        status: 'in_progress',
        advanced: 'none',
        completedChunks: 3,
        totalChunks: 22,
        skippedChunks: 0,
      };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-no-progress-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'summary-no-progress',
      mark: 'full',
      config: { agent_id: '*' },
      sessions: { s1: { session_id: 's1', summary: { status: 'pending', attempt_count: 0 } } },
    };
    const outcome = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(outcome.status, 'in_progress');
    assert.deepEqual(outcome.failure, { class: 'transient_runtime', cause: 'summary_no_progress' });
    assert.equal(state.sessions.s1.summary.failure_class, 'transient_runtime');
    assert.equal(state.sessions.s1.summary.failure_cause, 'summary_no_progress');
  });
});

test('successful provider recovery removes only that item and every recovery item gets a fair probe', async () => {
  const now = Date.parse('2026-07-15T00:00:00.000Z');
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const calls = new Map();
  const sleeps = [];
  const probes = [];
  let activeNormal = 0;
  let peakNormal = 0;
  const outcome = await runStageWorkQueue('summary', state, 'unused.json', ['a', 'b', 'c', 'd', 'e', 'f'], {
    concurrency: 3,
    itemId: (item) => item,
    now: () => now,
    writeState: async () => {},
    sleep: async (ms) => { sleeps.push(ms); },
    jitter: () => 0,
    run: async (item, context) => {
      const count = (calls.get(item) || 0) + 1;
      calls.set(item, count);
      if (context.probe) probes.push(item);
      if (!context.probe) {
        activeNormal += 1;
        peakNormal = Math.max(peakNormal, activeNormal);
        await Promise.resolve();
        activeNormal -= 1;
      }
      if (['a', 'b', 'c'].includes(item) && count === 1) {
        return { status: 'failed', failure: { class: 'transient_provider', cause: 'pi_stream_failed' } };
      }
      return { status: 'succeeded', failure: null };
    },
  });

  assert.equal(outcome.status, 'completed');
  assert.deepEqual(sleeps, [60_000]);
  assert.equal(peakNormal, 3);
  assert.deepEqual(probes, ['a', 'b', 'c']);
  assert.equal(calls.get('a'), 2);
  assert.equal(calls.get('b'), 2);
  assert.equal(calls.get('c'), 2);
});

test('provider probe preserves hard, runtime, and unit classification without an extra ordinary call', async (t) => {
  await t.test('hard blocks immediately', async () => {
    const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
    let calls = 0;
    const outcome = await runStageWorkQueue('summary', state, 'unused.json', ['a'], {
      writeState: async () => {},
      sleep: async () => {},
      jitter: () => 0,
      run: async () => {
        calls += 1;
        return calls === 1
          ? { status: 'failed', failure: { class: 'transient_provider', cause: 'pi_stream_failed' } }
          : { status: 'failed', failure: { class: 'hard', cause: 'pi_auth_failed' } };
      },
    });
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.failure.cause, 'pi_auth_failed');
    assert.equal(calls, 2);
  });

  await t.test('runtime enters the serial runtime gate', async () => {
    const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
    let calls = 0;
    let diagnostics = 0;
    const outcome = await runStageWorkQueue('summary', state, 'unused.json', ['a'], {
      writeState: async () => {},
      sleep: async () => {},
      jitter: () => 0,
      runtimeDiagnostics: async () => {
        diagnostics += 1;
        return { runtime_healthy: false, doctor_healthy: true };
      },
      run: async () => {
        calls += 1;
        if (calls === 1) return { status: 'failed', failure: { class: 'transient_provider', cause: 'pi_stream_failed' } };
        return { status: 'failed', failure: { class: 'transient_runtime', cause: 'http_503' } };
      },
    });
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.failure.cause, 'runtime_unhealthy_confirmed');
    assert.equal(diagnostics, 2);
    assert.equal(calls, 3);
  });

  await t.test('unit probe consumes the first unit attempt', async () => {
    const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
    let calls = 0;
    const outcome = await runStageWorkQueue('summary', state, 'unused.json', ['a'], {
      itemId: (item) => item,
      writeState: async () => {},
      sleep: async () => {},
      jitter: () => 0,
      run: async () => {
        calls += 1;
        return calls === 1
          ? { status: 'failed', failure: { class: 'transient_provider', cause: 'pi_stream_failed' } }
          : { status: 'failed', failure: { class: 'unit', cause: 'parse_failed' } };
      },
    });
    assert.equal(outcome.status, 'completed_with_failures');
    assert.equal(calls, 4);
  });
});

test('historical provider failure preserves recovery while healthy work runs before its deadline', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const started = [];
  const outcome = await runStageWorkQueue('summary', state, 'unused.json', ['a', 'b', 'c'], {
    concurrency: 3,
    itemId: (item) => item,
    initialOutcome: (item) => item === 'a'
      ? { status: 'failed', failure: { class: 'transient_provider', cause: 'pi_stream_failed' } }
      : null,
    writeState: async () => {},
    sleep: async () => {},
    jitter: () => 0,
    run: async (item, context) => {
      started.push({ item, probe: context.probe });
      return { status: 'succeeded', failure: null };
    },
  });

  assert.equal(outcome.status, 'completed');
  assert.deepEqual(started.slice(0, 2), [
    { item: 'b', probe: false },
    { item: 'c', probe: false },
  ]);
  assert.deepEqual(started.at(-1), { item: 'a', probe: true });
});

test('runtime recovery confirms health once per separated gate round and never per batch item', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  let calls = 0;
  let diagnostics = 0;
  const sleeps = [];
  const outcome = await runStageWorkQueue('semantic_rollup', state, 'unused.json', ['a', 'b', 'c'], {
    concurrency: 3,
    itemId: (item) => item,
    writeState: async () => {},
    sleep: async (ms) => { sleeps.push(ms); },
    jitter: () => 0,
    runtimeDiagnostics: async () => {
      diagnostics += 1;
      return { runtime_healthy: false, doctor_healthy: true };
    },
    run: async () => {
      calls += 1;
      return { status: 'failed', failure: { class: 'transient_runtime', cause: 'http_503' } };
    },
  });

  assert.equal(outcome.status, 'blocked');
  assert.equal(diagnostics, 2);
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [60_000]);
});

test('healthy runtime with repeated transport failures uses persisted low-frequency probes', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  const sleeps = [];
  let calls = 0;
  await assert.rejects(runStageWorkQueue('semantic_rollup', state, 'unused.json', ['a'], {
    writeState: async () => {},
    sleep: async (ms) => { sleeps.push(ms); },
    jitter: () => 0,
    runtimeDiagnostics: async () => ({ runtime_healthy: true, doctor_healthy: false }),
    run: async () => {
      calls += 1;
      if (calls === 5) throw new Error('stop persistent runtime test');
      return { status: 'failed', failure: { class: 'transient_runtime', cause: 'request_transport_failed' } };
    },
  }), /stop persistent runtime test/);

  assert.deepEqual(sleeps, [60_000, 120_000, 240_000, 300_000]);
  assert.equal(state.stage_work_queues.semantic_rollup.runtime_attempt, 3);
  assert.deepEqual(state.stage_work_queues.semantic_rollup.runtime_recovery_ids, ['a']);
});

test('unit retry budget survives a crash in the same scheduler epoch', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  let calls = 0;
  let writes = 0;
  await assert.rejects(runStageWorkQueue('skill_extract', state, 'unused.json', ['a'], {
    itemId: (item) => item,
    writeState: async () => {
      writes += 1;
      if (writes === 1) throw new Error('simulated crash');
    },
    sleep: async () => {},
    run: async () => {
      calls += 1;
      return { status: 'failed', failure: { class: 'unit', cause: 'parse_failed' } };
    },
  }), /simulated crash/);

  assert.equal(state.stage_work_queues.skill_extract.unit_attempts.a, 1);
  const resumed = await runStageWorkQueue('skill_extract', state, 'unused.json', ['a'], {
    itemId: (item) => item,
    initialOutcome: () => ({ status: 'failed', failure: { class: 'unit', cause: 'parse_failed' } }),
    writeState: async () => {},
    sleep: async () => {},
    run: async () => {
      calls += 1;
      return { status: 'failed', failure: { class: 'unit', cause: 'parse_failed' } };
    },
  });

  assert.equal(resumed.status, 'completed_with_failures');
  assert.equal(calls, 3);
  assert.equal(state.stage_work_queues.skill_extract.epoch, state.scheduler_epoch);
});

test('provider recovery ids and next retry deadline survive a crash and resume with one probe', async () => {
  const state = backfillOrchestrationPolicy({ config: { delay_ms: 0 }, health: {} });
  await assert.rejects(runStageWorkQueue('summary', state, 'unused.json', ['a'], {
    itemId: (item) => item,
    writeState: async () => {},
    jitter: () => 0,
    sleep: async () => { throw new Error('crash during provider backoff'); },
    run: async () => ({
      status: 'failed',
      failure: { class: 'transient_provider', cause: 'pi_stream_failed' },
    }),
  }), /crash during provider backoff/);

  const persisted = state.stage_work_queues.summary;
  assert.deepEqual(persisted.provider_recovery_ids, ['a']);
  assert.equal(persisted.provider_attempt, 0);
  assert.equal(persisted.retry_kind, 'provider');
  assert.equal(typeof persisted.next_retry_at, 'string');
  const retryAt = persisted.next_retry_at;

  beginResumeSchedulerEpoch(state, '2026-07-15T00:00:00.000Z');
  assert.equal(state.stage_work_queues.summary.next_retry_at, retryAt);
  assert.deepEqual(state.stage_work_queues.summary.provider_recovery_ids, ['a']);

  const resumedSleeps = [];
  const starts = [];
  const outcome = await runStageWorkQueue('summary', state, 'unused.json', ['a'], {
    itemId: (item) => item,
    initialOutcome: () => ({
      status: 'failed',
      failure: { class: 'transient_provider', cause: 'pi_stream_failed' },
    }),
    writeState: async () => {},
    jitter: () => 0,
    sleep: async (ms) => { resumedSleeps.push(ms); },
    run: async (item, context) => {
      starts.push({ item, probe: context.probe });
      return { status: 'succeeded', failure: null };
    },
  });

  assert.equal(outcome.status, 'completed');
  assert.deepEqual(starts, [{ item: 'a', probe: true }]);
  assert.equal(resumedSleeps.length, 1);
  assert.ok(resumedSleeps[0] > 0 && resumedSleeps[0] <= 60_000);
});

test('parseArgs requires base-url and state-dir', () => {
  assert.throws(
    () => parseArgs(['--base-url', 'http://127.0.0.1:3111']),
    /缺少 --state-dir/,
  );
});

test('parseArgs accepts session concurrency up to 3', () => {
  const required = ['--base-url', 'http://127.0.0.1:3111', '--state-dir', path.join(os.tmpdir(), 'runs')];
  const options = parseArgs([...required, '--session-concurrency', '3']);
  assert.equal(options.sessionConcurrency, 3);
  assert.equal(buildConfigFromOptions(options).session_concurrency, 3);
  assert.equal(parseArgs(required).sessionConcurrency, 1);
  assert.throws(() => parseArgs([...required, '--session-concurrency', '0']), /必须是 1 到 3/);
  assert.throws(() => parseArgs([...required, '--session-concurrency', '4']), /必须是 1 到 3/);
});

test('parseArgs accepts dry-run and resume and defaults agent_id to *', () => {
  const args = parseArgs([
    '--base-url',
    'http://127.0.0.1:3111',
    '--state-dir',
    'F:\\ai-runtime\\agentmemory\\extraction-runs',
    '--run-id',
    'full-test',
    '--dry-run',
    '--resume',
  ]);
  assert.equal(args.baseUrl, 'http://127.0.0.1:3111');
  assert.equal(args.runId, 'full-test');
  assert.equal(args.agentId, '*');
  assert.equal(args.dryRun, true);
  assert.equal(args.resume, true);
  assert.equal(args.requestTimeoutMs, 360000);
  assert.equal(args.semanticRollupTargetPromptChars, 64000);
  assert.equal(args.memoryConsolidateCharBudget, null);
  assert.equal(args.reflectInsightCharBudget, null);
  const config = buildConfigFromOptions(args);
  assert.equal(config.semantic_rollup_target_prompt_chars, 64000);
  assert.equal(config.memory_consolidate_char_budget, 64000);
  assert.equal(config.reflect_insight_char_budget, 64000);
});

test('parseArgs accepts request timeout and exclude record', () => {
  const args = parseArgs([
    '--base-url',
    'http://127.0.0.1:3111',
    '--state-dir',
    'F:\\ai-runtime\\agentmemory\\extraction-runs',
    '--request-timeout-ms',
    '720000',
    '--exclude-record',
    'F:\\ai-runtime\\session-source\\agentmemory-first-batch-20x2.json',
  ]);
  assert.equal(args.requestTimeoutMs, 720000);
  assert.deepEqual(args.excludeRecords, [
    'F:\\ai-runtime\\session-source\\agentmemory-first-batch-20x2.json',
  ]);
  assert.equal(args.doctorScript, '');
  assert.equal(args.doctorOk, 'diagnosis=OK_FORMAL_CONSOLE_OWNS_AGENTMEMORY_PORTS');
  assert.deepEqual(buildConfigFromOptions(args).exclude_records, [
    'F:\\ai-runtime\\session-source\\agentmemory-first-batch-20x2.json',
  ]);
});

test('parseArgs accepts formal console doctor gate', () => {
  const args = parseArgs([
    '--base-url',
    'http://127.0.0.1:3111',
    '--state-dir',
    'F:\\ai-runtime\\agentmemory\\extraction-runs',
    '--doctor-script',
    'F:\\ai-runtime\\agentmemory\\scripts\\doctor-agentmemory-console.ps1',
  ]);
  assert.equal(args.doctorScript, 'F:\\ai-runtime\\agentmemory\\scripts\\doctor-agentmemory-console.ps1');
  assert.equal(args.doctorOk, 'diagnosis=OK_FORMAL_CONSOLE_OWNS_AGENTMEMORY_PORTS');
  assert.equal(buildConfigFromOptions(args).doctor_script, undefined);
});

test('exclude record derives Codex and Claude session ids', () => {
  assert.equal(
    deriveSessionIdFromImportRecord({
      absolute_path: 'F:\\vault\\rollout-2026-03-22T00-05-48-019d1125-44a2-73d0-b30b-7fb2eb6bc0ed.jsonl',
    }),
    '019d1125-44a2-73d0-b30b-7fb2eb6bc0ed',
  );
  assert.equal(
    deriveSessionIdFromImportRecord({
      vault_relpath: 'remote-vault/home/claude-code/default/projects/repo/eea858e4-6b01-4849-94c4-6dab0fefff19.jsonl',
    }),
    'eea858e4-6b01-4849-94c4-6dab0fefff19',
  );
});

test('filterExcludedSessions removes excluded ids before inventory planning', () => {
  const filtered = filterExcludedSessions([
    { id: 'keep', startedAt: '2026-01-02T00:00:00.000Z' },
    { id: 'drop', startedAt: '2026-01-01T00:00:00.000Z' },
  ], new Set(['drop']));
  assert.deepEqual(filtered.map((session) => session.id), ['keep']);
});

test('full extraction inventory excludes active sessions with an auditable reason and keeps terminal sessions', () => {
  const selection = selectFullExtractionSessions([
    { id: 'active-1', status: 'active', startedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'completed-1', status: 'completed', startedAt: '2026-01-02T00:00:00.000Z' },
    { id: 'abandoned-1', status: 'abandoned', startedAt: '2026-01-03T00:00:00.000Z' },
  ]);

  assert.deepEqual(selection.sessions.map((session) => session.id), ['completed-1', 'abandoned-1']);
  assert.deepEqual(selection.audit, {
    discovered_count: 3,
    included_count: 2,
    excluded_count: 1,
    excluded_reason_counts: { session_status_active: 1 },
    excluded_sessions: [{
      session_id: 'active-1',
      session_status: 'active',
      reason: 'session_status_active',
    }],
  });
});

test('active session churn does not drift resume inventory hash but becoming terminal does', () => {
  const terminalSessions = [
    { id: 'completed-1', status: 'completed', startedAt: '2026-01-02T00:00:00.000Z' },
    { id: 'abandoned-1', status: 'abandoned', startedAt: '2026-01-03T00:00:00.000Z' },
  ];
  const first = selectFullExtractionSessions([
    { id: 'active-before', status: 'active', startedAt: '2026-01-01T00:00:00.000Z' },
    ...terminalSessions,
  ]);
  const afterActiveInputChanged = selectFullExtractionSessions([
    { id: 'active-after', status: 'active', startedAt: '2026-01-04T00:00:00.000Z' },
    ...terminalSessions,
  ]);
  const state = buildInitialState({
    runId: 'full-test',
    baseUrl: 'http://127.0.0.1:3111',
    now: '2026-07-10T00:00:00.000Z',
  });
  state.inventory_hash = computeInventoryHash(first.sessions, '*');

  assert.doesNotThrow(() => validateResumeState(state, resumeOptions(), afterActiveInputChanged.sessions));
  assert.equal(
    computeInventoryHash(first.sessions, '*'),
    computeInventoryHash(afterActiveInputChanged.sessions, '*'),
  );

  const afterCompletion = selectFullExtractionSessions([
    { id: 'active-after', status: 'completed', startedAt: '2026-01-04T00:00:00.000Z' },
    ...terminalSessions,
  ]);
  assert.throws(
    () => validateResumeState(state, resumeOptions(), afterCompletion.sessions),
    /inventory drift/,
  );
});

test('parseArgs accepts optional stage model overrides', () => {
  const args = parseArgs([
    '--base-url',
    'http://127.0.0.1:3111',
    '--state-dir',
    'F:\\ai-runtime\\agentmemory\\extraction-runs',
    '--summary-model',
    'summary-model',
    '--lesson-model',
    'lesson-model',
    '--memory-consolidate-model',
    'memory-model',
    '--semantic-rollup-model',
    'semantic-model',
    '--skill-extract-model',
    'skill-model',
    '--procedural-model',
    'procedural-model',
    '--crystal-model',
    'crystal-model',
    '--reflect-insight-model',
    'reflect-model',
    '--default-stage-model',
    'default-model',
    '--semantic-rollup-target-prompt-chars',
    '17000',
    '--memory-consolidate-char-budget',
    '18000',
    '--reflect-insight-char-budget',
    '19000',
    '--default-stage-char-budget',
    '20000',
  ]);

  assert.equal(args.summaryModel, 'summary-model');
  assert.equal(args.lessonModel, 'lesson-model');
  assert.equal(args.memoryConsolidateModel, 'memory-model');
  assert.equal(args.semanticRollupModel, 'semantic-model');
  assert.equal(args.skillExtractModel, 'skill-model');
  assert.equal(args.proceduralModel, 'procedural-model');
  assert.equal(args.crystalModel, 'crystal-model');
  assert.equal(args.reflectInsightModel, 'reflect-model');
  assert.equal(args.defaultStageModel, 'default-model');
  assert.equal(args.semanticRollupTargetPromptChars, 17000);
  assert.equal(args.memoryConsolidateCharBudget, 18000);
  assert.equal(args.reflectInsightCharBudget, 19000);
  assert.equal(args.defaultStageCharBudget, 20000);
});

test('semantic-char-budget only aliases semantic planning target, not service char budgets', () => {
  const options = parseArgs([
    '--base-url',
    'http://127.0.0.1:3111',
    '--state-dir',
    'F:\\ai-runtime\\agentmemory\\extraction-runs',
    '--semantic-char-budget',
    '2700',
    '--default-stage-char-budget',
    '22000',
    '--reflect-insight-char-budget',
    '23000',
  ]);

  const config = buildConfigFromOptions(options);
  assert.equal(config.semantic_rollup_target_prompt_chars, 2700);
  assert.equal(config.semantic_char_budget, 2700);
  assert.equal(config.memory_consolidate_char_budget, 22000);
  assert.equal(config.reflect_insight_char_budget, 23000);
});

test('stage-specific CLI model wins over default-stage-model for one run', () => {
  const options = parseArgs([
    '--base-url',
    'http://127.0.0.1:3111',
    '--state-dir',
    'F:\\ai-runtime\\agentmemory\\extraction-runs',
    '--summary-model',
    'summary-model',
    '--default-stage-model',
    'default-model',
  ]);

  assert.deepEqual(resolveCliStageModel(options, 'summary'), {
    model: 'summary-model',
    modelSource: 'cli:--summary-model',
  });
  assert.deepEqual(resolveCliStageModel(options, 'lesson'), {
    model: 'default-model',
    modelSource: 'cli:--default-stage-model',
  });
  assert.deepEqual(resolveCliStageModel(options, 'procedural'), {
    model: 'default-model',
    modelSource: 'cli:--default-stage-model',
  });
});

test('automatic full extraction rejects Sol from CLI or service model configuration', () => {
  assert.throws(
    () => assertAutomaticModelPolicy({ proceduralModel: 'gpt-5.6-sol' }, {}),
    /禁止 --procedural-model=gpt-5\.6-sol/,
  );
  assert.throws(
    () => assertAutomaticModelPolicy({}, { AGENTMEMORY_CRYSTAL_MODEL: 'gpt-5.6-sol' }),
    /禁止 AGENTMEMORY_CRYSTAL_MODEL=gpt-5\.6-sol/,
  );
  assert.doesNotThrow(() => assertAutomaticModelPolicy({ proceduralModel: 'gpt-5.6-terra' }, {}));
});

test('request body builders omit model when CLI model options are absent', () => {
  const options = parseArgs([
    '--base-url',
    'http://127.0.0.1:3111',
    '--state-dir',
    'F:\\ai-runtime\\agentmemory\\extraction-runs',
  ]);

  assert.equal(Object.hasOwn(buildSummaryBody('s1', options), 'model'), false);
  assert.equal(Object.hasOwn(buildLessonExtractBody('s1', options), 'model'), false);
  assert.equal(Object.hasOwn(buildSemanticRollupBody({
    runId: 'run',
    mark: 'mark',
    windowId: 'w1',
    sessionIds: ['s1'],
  }, options), 'model'), false);
  assert.equal(Object.hasOwn(buildStageModelRequestBody({ sessionId: 's1' }, options, 'skill_extract'), 'model'), false);
});

test('request body builders include only model when CLI model options are present', () => {
  const options = parseArgs([
    '--base-url',
    'http://127.0.0.1:3111',
    '--state-dir',
    'F:\\ai-runtime\\agentmemory\\extraction-runs',
    '--default-stage-model',
    'default-model',
    '--skill-extract-model',
    'skill-model',
  ]);

  assert.deepEqual(buildSummaryBody('s1', options), {
    sessionId: 's1',
    model: 'default-model',
  });
  assert.deepEqual(buildStageModelRequestBody({ sessionId: 's1' }, options, 'skill_extract'), {
    sessionId: 's1',
    model: 'skill-model',
  });
});

test('buildInitialState creates stable top-level schema', () => {
  const state = buildInitialState({
    runId: 'full-test',
    baseUrl: 'http://127.0.0.1:3111',
    mark: 'agentmemory-full-extraction',
    now: '2026-07-05T00:00:00.000Z',
  });
  assert.equal(state.schema_version, 1);
  assert.equal(state.run_id, 'full-test');
  assert.equal(state.config.agent_id, '*');
  assert.equal(typeof state.config_hash, 'string');
  assert.deepEqual(state.sessions, {});
  assert.deepEqual(state.memory_consolidate_windows, {});
  assert.deepEqual(state.semantic_windows, {});
  assert.deepEqual(state.skill_extract, {});
  assert.deepEqual(state.crystal_groups, {});
  assert.deepEqual(state.consolidation_procedural_windows, {});
  assert.deepEqual(state.reflect_insight_windows, {});
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'corpus_windows'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'corpus_rollup'), false);
});

test('makeRunId is deterministic for a supplied date', () => {
  assert.equal(makeRunId(new Date('2026-07-05T04:00:00.000Z')), 'full-20260705T040000Z');
});

test('planSemanticWindows creates deterministic windows', () => {
  const ids = Array.from({ length: 45 }, (_, i) => `sess_${String(i).padStart(2, '0')}`);
  const windows = planSemanticWindows(ids, 20);
  assert.equal(windows.length, 3);
  assert.equal(windows[0].window_id, 'w0001');
  assert.equal(windows[2].source_session_ids.length, 5);
});

test('planSemanticWindowsByCharBudget uses source_session_ids and char budget', () => {
  const windows = planSemanticWindowsByCharBudget([
    ['s1', 900],
    ['s2', 900],
    ['s3', 900],
  ], { maxSessionCount: 20, charBudget: 1800 });

  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0].source_session_ids, ['s1', 's2']);
  assert.equal(windows[0].source_count, 2);
  assert.equal(windows[0].estimated_prompt_chars, 1800);
  assert.equal(Object.prototype.hasOwnProperty.call(windows[0], 'session_ids'), false);
  const body = buildSemanticRollupBody({
    runId: 'run',
    mark: 'mark',
    windowId: windows[0].window_id,
    sessionIds: windows[0].source_session_ids,
  });
  assert.deepEqual(body.sessionIds, ['s1', 's2']);
});

test('terminalLessonStatus distinguishes terminal and retryable states', () => {
  assert.equal(terminalLessonStatus('succeeded'), true);
  assert.equal(terminalLessonStatus('skipped'), true);
  assert.equal(terminalLessonStatus('failed'), true);
  assert.equal(terminalLessonStatus('retryable'), false);
  assert.equal(terminalLessonStatus('running'), false);
});

test('redactSensitiveText removes bearer tokens and secrets', () => {
  const text = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz token=secret-value provider_key=secret-provider-key OPENAI_API_KEY=sk-secret api_key=raw-secret';
  const redacted = redactSensitiveText(text);
  assert.match(redacted, /Bearer <redacted>/);
  assert.match(redacted, /token=<redacted>/);
  assert.match(redacted, /provider_key=<redacted>/);
  assert.match(redacted, /OPENAI_API_KEY=<redacted>/);
  assert.match(redacted, /api_key=<redacted>/);
});

test('redactJson removes nested sensitive values before state write', () => {
  const redacted = redactJson({
    headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' },
    nested: { token: 'secret-token', provider_key: 'secret-provider-key', child: { secret: 'x' } },
  });
  assert.equal(redacted.headers.Authorization, '<redacted>');
  assert.equal(redacted.nested.token, '<redacted>');
  assert.equal(redacted.nested.provider_key, '<redacted>');
  assert.equal(redacted.nested.child.secret, '<redacted>');
});

test('state writer retries a transient Windows rename lock with the same complete temp file', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-retry-'));
  const statePath = path.join(stateDir, 'state.json');
  const state = { run_id: 'retry', progress: { step: 2 } };
  const renameSources = [];
  const delays = [];
  let renameAttempts = 0;
  await fs.writeFile(statePath, '{"previous":true}\n', 'utf8');

  await writeStateAtomically(statePath, state, {
    fsApi: {
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      rename: async (source, target) => {
        renameSources.push(source);
        renameAttempts += 1;
        if (renameAttempts < 3) {
          assert.equal(await fs.readFile(target, 'utf8'), '{"previous":true}\n');
          assert.deepEqual(JSON.parse(await fs.readFile(source, 'utf8')), state);
          const error = new Error('sharing violation');
          error.code = 'EPERM';
          throw error;
        }
        return fs.rename(source, target);
      },
    },
    sleepFn: async (delayMs) => { delays.push(delayMs); },
  });

  assert.deepEqual(delays, [25, 50]);
  assert.equal(renameSources.length, 3);
  assert.equal(new Set(renameSources).size, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')), state);
  await assert.rejects(() => fs.access(renameSources[0]));
});

test('state writer preserves both complete files after exhausting Windows rename retries', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-exhausted-'));
  const statePath = path.join(stateDir, 'state.json');
  const state = { run_id: 'exhausted', progress: { step: 3 } };
  const delays = [];
  const renameSources = [];
  let failure;
  await fs.writeFile(statePath, '{"previous":true}\n', 'utf8');

  await assert.rejects(
    () => writeStateAtomically(statePath, state, {
      fsApi: {
        mkdir: fs.mkdir,
        writeFile: fs.writeFile,
        rename: async (source) => {
          renameSources.push(source);
          const error = new Error('sharing violation token=not-for-output');
          error.code = 'EACCES';
          throw error;
        },
      },
      sleepFn: async (delayMs) => { delays.push(delayMs); },
    }),
    (error) => {
      failure = error;
      return /状态文件原子替换失败/.test(error.message);
    },
  );

  assert.equal(failure.message.includes('not-for-output'), false);
  assert.deepEqual(delays, [25, 50, 100, 200, 400, 800]);
  assert.equal(renameSources.length, 7);
  assert.equal(new Set(renameSources).size, 1);
  assert.equal(await fs.readFile(statePath, 'utf8'), '{"previous":true}\n');
  assert.deepEqual(JSON.parse(await fs.readFile(renameSources[0], 'utf8')), state);
});

test('state writer fails fast for non-retryable rename errors', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-fail-fast-'));
  const statePath = path.join(stateDir, 'state.json');
  const state = { run_id: 'fail-fast' };
  const delays = [];
  let attempts = 0;
  await fs.writeFile(statePath, '{"previous":true}\n', 'utf8');

  await assert.rejects(
    () => writeStateAtomically(statePath, state, {
      fsApi: {
        mkdir: fs.mkdir,
        writeFile: fs.writeFile,
        rename: async () => {
          attempts += 1;
          const error = new Error('disk failure');
          error.code = 'EIO';
          throw error;
        },
      },
      sleepFn: async (delayMs) => { delays.push(delayMs); },
    }),
    /disk failure/,
  );

  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
  assert.equal(await fs.readFile(statePath, 'utf8'), '{"previous":true}\n');
});

test('bounded work runner never exceeds concurrency 3', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-work-pool-'));
  const statePath = path.join(stateDir, 'state.json');
  const state = buildInitialState({ runId: 'pool' });
  state.config.delay_ms = 0;
  let active = 0;
  let peak = 0;

  await runWithConsecutiveFailureStop('summary', state, statePath, ['a', 'b', 'c', 'd'], {
    concurrency: 3,
    run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return 'succeeded';
    },
  });

  assert.equal(peak, 3);
});

test('state writes for one path are serialized', async () => {
  const events = [];
  await Promise.all([
    enqueueStateWrite('state.json', async () => {
      events.push('a:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('a:end');
    }),
    enqueueStateWrite('state.json', async () => {
      events.push('b:start');
      events.push('b:end');
    }),
  ]);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('consecutive failures are evaluated in input order and stop new batches', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-work-stop-'));
  const statePath = path.join(stateDir, 'state.json');
  const state = buildInitialState({ runId: 'pool-stop' });
  state.config.delay_ms = 0;
  state.config.stop_after_consecutive_failures = 3;
  const started = [];

  await assert.rejects(
    () => runWithConsecutiveFailureStop('summary', state, statePath, [1, 2, 3, 4], {
      concurrency: 3,
      run: async (id) => {
        started.push(id);
        return 'failed';
      },
    }),
    /连续 3 个 summary 失败/,
  );
  assert.deepEqual(started.sort(), [1, 2, 3]);
});

test('failure threshold reached inside a batch remains latched after later in-flight success', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-work-stop-latched-'));
  const statePath = path.join(stateDir, 'state.json');
  const state = buildInitialState({ runId: 'pool-stop-latched' });
  state.config.delay_ms = 0;
  state.config.stop_after_consecutive_failures = 2;
  const started = [];

  await assert.rejects(
    () => runWithConsecutiveFailureStop('summary', state, statePath, [1, 2, 3, 4], {
      concurrency: 3,
      run: async (id) => {
        started.push(id);
        return id === 3 ? 'succeeded' : 'failed';
      },
    }),
    /连续 2 个 summary 失败/,
  );
  assert.deepEqual(started.sort(), [1, 2, 3]);
});

test('unexpected batch error waits for in-flight work before rejecting and stops the next batch', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-work-throw-settle-'));
  const statePath = path.join(stateDir, 'state.json');
  const state = buildInitialState({ runId: 'pool-throw-settle' });
  state.config.delay_ms = 0;
  const events = [];

  const error = await runWithConsecutiveFailureStop('summary', state, statePath, [1, 2, 3], {
    concurrency: 2,
    run: async (id) => {
      events.push(`${id}:start`);
      if (id === 1) throw new Error('unexpected task failure');
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`${id}:done`);
      return 'succeeded';
    },
  }).catch((caught) => {
    events.push('rejected');
    return caught;
  });

  assert.match(error.message, /unexpected task failure/);
  assert.deepEqual(events, ['1:start', '2:start', '2:done', 'rejected']);
});

test('state lock rejects a second runner before it can call the AgentMemory API', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-lock-active-'));
  const statePath = path.join(stateDir, 'same-run.json');
  const owner = await acquireStateLock({ statePath, runId: 'same-run' });
  try {
    await withMockAgentMemory(() => {
      throw new Error('second runner must fail before any API call');
    }, async (baseUrl, requests) => {
      await withSecret('test-secret', async () => {
        await assert.rejects(
          () => mainForTest([
            '--base-url', baseUrl,
            '--state-dir', stateDir,
            '--run-id', 'same-run',
            '--dry-run',
          ]),
          /已有活跃 runner/,
        );
      });
      assert.equal(requests.length, 0);
    });
  } finally {
    await releaseStateLock(owner);
  }
});

test('deployment lock rejects a runner before and after state lock acquisition', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-deployment-lock-'));
  const statePath = path.join(stateDir, 'deployment-blocked.json');
  const deploymentLockPath = path.join(stateDir, 'deploy-current.lock.json');
  await fs.writeFile(deploymentLockPath, '{}\n');

  await assert.rejects(
    () => acquireStateLock({
      statePath,
      runId: 'deployment-blocked',
      deploymentLockPath,
    }),
    /deployment_in_progress/,
  );
  await assert.rejects(() => fs.access(`${statePath}.lock`));

  await fs.rm(deploymentLockPath);
  let deploymentChecks = 0;
  const fsApi = {
    ...fs,
    async access(targetPath) {
      if (targetPath === deploymentLockPath) {
        deploymentChecks += 1;
        if (deploymentChecks === 1) {
          const error = new Error('missing before state lock');
          error.code = 'ENOENT';
          throw error;
        }
        return undefined;
      }
      return fs.access(targetPath);
    },
  };
  await assert.rejects(
    () => acquireStateLock({
      statePath,
      runId: 'deployment-race',
      deploymentLockPath,
      fsApi,
    }),
    /deployment_in_progress/,
  );
  await assert.rejects(() => fs.access(`${statePath}.lock`));
});

test('state lock reclaims only a stale local PID lock', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-lock-stale-'));
  const statePath = path.join(stateDir, 'stale-run.json');
  const lockPath = `${statePath}.lock`;
  let stalePid = 2147483647;
  while (true) {
    try {
      process.kill(stalePid, 0);
      stalePid -= 1;
    } catch (error) {
      if (error.code === 'ESRCH') break;
      throw error;
    }
  }
  await fs.writeFile(lockPath, `${JSON.stringify({
    run_id: 'stale-run',
    pid: stalePid,
    created_at: '2026-07-12T00:00:00.000Z',
    owner_id: 'stale-owner',
  })}\n`, 'utf8');

  const owner = await acquireStateLock({ statePath, runId: 'stale-run' });
  try {
    const persisted = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    assert.deepEqual(Object.keys(persisted).sort(), ['created_at', 'owner_id', 'pid', 'run_id']);
    assert.equal(persisted.run_id, 'stale-run');
    assert.equal(persisted.pid, process.pid);
    assert.notEqual(persisted.owner_id, 'stale-owner');
  } finally {
    await releaseStateLock(owner);
  }
});

test('state lock release does not delete a different owner lock', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-lock-owner-'));
  const statePath = path.join(stateDir, 'owner-run.json');
  const owner = await acquireStateLock({ statePath, runId: 'owner-run' });
  try {
    await releaseStateLock({ ...owner, ownerId: 'different-owner' });
    const persisted = JSON.parse(await fs.readFile(owner.lockPath, 'utf8'));
    assert.equal(persisted.owner_id, owner.ownerId);
  } finally {
    await releaseStateLock(owner);
  }
  await assert.rejects(() => fs.access(owner.lockPath));
});

test('runner releases its state lock after an exception', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-lock-exception-'));
  const statePath = path.join(stateDir, 'exception-run.json');
  await withMockAgentMemory((method, url) => {
    assert.equal(`${method} ${url}`, 'GET /agentmemory/runtime-config');
    return { statusCode: 503, body: { success: false, error: 'runtime unavailable' } };
  }, async (baseUrl) => {
    await withSecret('test-secret', async () => {
      await assert.rejects(
        () => mainForTest([
          '--base-url', baseUrl,
          '--state-dir', stateDir,
          '--run-id', 'exception-run',
        ]),
        /runtime unavailable/,
      );
    });
  });
  await assert.rejects(() => fs.access(`${statePath}.lock`));
});

test('SIGTERM cancels an in-flight main request, persists cancellation, and releases the state lock', async () => {
  const signalSource = new EventEmitter();
  await withMockAgentMemory(async (method, url) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1 } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return { sessions: [{ id: 's1', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z' }] };
    }
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      setImmediate(() => signalSource.emit('SIGTERM'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { success: true, status: 'in_progress', advanced: 'none' };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-main-cancel-'));
    const statePath = path.join(stateDir, 'cancel.json');
    const result = await withSecret('test-secret', () => mainForTest([
      '--base-url', baseUrl,
      '--state-dir', stateDir,
      '--run-id', 'cancel',
      '--delay-ms', '0',
    ], { signalSource }));

    assert.equal(result, 130);
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(typeof state.cancelled_at, 'string');
    assert.equal(state.health.last_error, 'cancelled');
    await assert.rejects(() => fs.access(`${statePath}.lock`));
  });
});

test('requestJson returns a structured timeout instead of hanging forever', async () => {
  const server = http.createServer((_req, _res) => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await requestJson(
      `http://127.0.0.1:${port}`,
      'secret',
      'POST',
      '/slow',
      {},
      { timeoutMs: 10 },
    );

    assert.equal(response.ok, false);
    assert.equal(response.status_code, 0);
    assert.match(response.error, /timed out/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('requestJson timeout also covers a response body that never ends', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"success":');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await requestJson(
      `http://127.0.0.1:${port}`,
      'secret',
      'POST',
      '/slow-body',
      {},
      { timeoutMs: 10 },
    );

    assert.equal(response.ok, false);
    assert.equal(response.status_code, 0);
    assert.match(response.error, /timed out/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('normalizeSessions sorts by startedAt then id', () => {
  const sessions = normalizeSessions([
    { id: 'b', startedAt: '2026-01-02T00:00:00.000Z' },
    { id: 'a', startedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c', startedAt: '2026-01-02T00:00:00.000Z' },
  ]);
  assert.deepEqual(sessions.map((session) => session.id), ['a', 'b', 'c']);
});

test('session list path defaults to all agent ids and encodes specified agent ids', () => {
  assert.equal(buildSessionsPath('*'), '/agentmemory/sessions?agentId=*');
  assert.equal(buildSessionsPath('agent-x'), '/agentmemory/sessions?agentId=agent-x');
  assert.equal(buildSessionsPath('agent x/1'), '/agentmemory/sessions?agentId=agent%20x%2F1');
});

test('summaryNeedsWork only runs pending or failed summaries', () => {
  assert.equal(summaryNeedsWork({ summary: { status: 'succeeded' } }), false);
  assert.equal(summaryNeedsWork({ summary: { status: 'pending' } }), true);
  assert.equal(summaryNeedsWork({ summary: { status: 'failed' } }), true);
});

test('findSessionSummary returns embedded summary', () => {
  const found = findSessionSummary([{ id: 's1', summary: { title: 'Done' } }], 's1');
  assert.equal(found.title, 'Done');
});

test('buildLessonExtractBody pins chunkConcurrency to 1', () => {
  const body = buildLessonExtractBody('s1');
  assert.deepEqual(body.sessionIds, ['s1']);
  assert.equal(body.chunkConcurrency, 1);
  assert.equal(body.missingOnly, true);
});

test('summarizeChunkStatuses counts chunk statuses', () => {
  const counts = summarizeChunkStatuses([{ status: 'succeeded' }, { status: 'failed' }, { status: 'succeeded' }]);
  assert.deepEqual(counts, { succeeded: 2, failed: 1 });
});

test('buildSemanticRollupBody includes run mark and source sessions', () => {
  const body = buildSemanticRollupBody({
    runId: 'full-test',
    mark: 'agentmemory-full-extraction',
    windowId: 'w0001',
    sessionIds: ['s1', 's2'],
  });
  assert.equal(body.kind, 'window');
  assert.deepEqual(body.sessionIds, ['s1', 's2']);
});

test('computeCoverage separates succeeded skipped failed pending running units', () => {
  const coverage = computeCoverage({
    sessions: {
      s1: { summary: { status: 'succeeded' }, lessons_extract: { status: 'succeeded' } },
      s2: { summary: { status: 'failed' }, lessons_extract: { status: 'failed' } },
      s3: { summary: { status: 'pending' }, lessons_extract: { status: 'running' } },
      s4: { summary: { status: 'skipped' }, lessons_extract: { status: 'skipped' } },
    },
    semantic_windows: {
      w0001: { status: 'succeeded' },
      w0002: { status: 'failed' },
      w0003: { status: 'pending' },
      w0004: { status: 'running' },
    },
    memory_consolidate_windows: { m1: { status: 'succeeded' } },
    skill_extract: { sk1: { status: 'skipped' } },
    crystal_groups: { cg1: { status: 'failed' } },
    consolidation_procedural_windows: { cp1: { status: 'pending' } },
    reflect_insight_windows: { ri1: { status: 'running' } },
  });
  assert.deepEqual(coverage.enabled_stages, ENABLED_STAGES);
  assert.equal(coverage.sessions.total, 4);
  assert.equal(coverage.summary.succeeded, 1);
  assert.equal(coverage.summary.skipped, 1);
  assert.equal(coverage.summary.failed, 1);
  assert.equal(coverage.summary.pending, 1);
  assert.equal(coverage.lessons.succeeded, 1);
  assert.equal(coverage.lessons.failed, 1);
  assert.equal(coverage.lessons.running, 1);
  assert.equal(coverage.semantic_windows.succeeded, 1);
  assert.equal(coverage.semantic_windows.failed, 1);
  assert.equal(coverage.semantic_windows.pending, 1);
  assert.equal(coverage.semantic_windows.running, 1);
  assert.equal(coverage.memory_consolidate_windows.succeeded, 1);
  assert.equal(coverage.skill_extract.skipped, 1);
  assert.equal(coverage.crystal_groups.failed, 1);
  assert.equal(coverage.consolidation_procedural_windows.pending, 1);
  assert.equal(coverage.reflect_insight_windows.running, 1);
  assert.equal(coverage.acceptance_ready, false);
});

test('computeCoverage counts planned units separately from other', () => {
  const coverage = computeCoverage({
    sessions: {
      s1: { summary: { status: 'planned' }, lessons_extract: { status: 'planned' } },
    },
    semantic_windows: {
      w0001: { status: 'planned' },
      w0002: { status: 'unexpected' },
    },
    memory_consolidate_windows: { m1: { status: 'planned' } },
    skill_extract: { sk1: { status: 'planned' } },
    crystal_groups: { cg1: { status: 'planned' } },
    consolidation_procedural_windows: { cp1: { status: 'planned' } },
    reflect_insight_windows: { ri1: { status: 'planned' } },
  });

  assert.equal(coverage.summary.planned, 1);
  assert.equal(coverage.summary.other, 0);
  assert.equal(coverage.lessons.planned, 1);
  assert.equal(coverage.lessons.other, 0);
  assert.equal(coverage.semantic_windows.planned, 1);
  assert.equal(coverage.semantic_windows.other, 1);
  assert.equal(coverage.memory_consolidate_windows.planned, 1);
  assert.equal(coverage.skill_extract.planned, 1);
  assert.equal(coverage.crystal_groups.planned, 1);
  assert.equal(coverage.consolidation_procedural_windows.planned, 1);
  assert.equal(coverage.reflect_insight_windows.planned, 1);
  assert.equal(coverage.acceptance_ready, false);
});

test('splitChildUnitsForContainer returns pending nested split leaves', () => {
  const state = buildInitialState({ runId: 'r1' });
  state.memory_consolidate_windows = {
    root: { unit_id: 'root', status: 'split', split_into: ['roota', 'rootb'] },
    roota: { unit_id: 'roota', status: 'split', split_into: ['rootaa', 'rootab'], split_from: 'root' },
    rootaa: { unit_id: 'rootaa', status: 'pending', split_from: 'roota', source_ids: ['o1'] },
    rootab: { unit_id: 'rootab', status: 'succeeded', split_from: 'roota', source_ids: ['o2'] },
    rootb: { unit_id: 'rootb', status: 'split', split_into: ['rootba'], split_from: 'root' },
    rootba: { unit_id: 'rootba', status: 'failed', split_from: 'rootb', source_ids: ['o3'] },
  };

  assert.deepEqual(
    splitChildUnitsForContainer(state, 'memory_consolidate_windows', 'root').map((unit) => unit.unit_id),
    ['rootaa', 'rootba'],
  );
});

test('validatePlannedWindowBudget distinguishes split windows from single oversized observations', () => {
  assert.deepEqual(
    validatePlannedWindowBudget({
      unit_id: 'mcw-big',
      estimatedChars: 1193362,
      sourceObservationIds: ['o1', 'o2', 'o3', 'o4'],
    }, 300000),
    {
      status: 'needs_split',
      sourceIds: ['o1', 'o2', 'o3', 'o4'],
      estimatedChars: 1193362,
    },
  );
  assert.deepEqual(
    validatePlannedWindowBudget({
      unit_id: 'mcw-single',
      estimatedChars: 400000,
      sourceObservationIds: ['o1'],
      overBudget: true,
    }, 300000),
    {
      status: 'single_observation_over_budget',
      sourceIds: ['o1'],
      estimatedChars: 400000,
    },
  );
});

test('semanticSplitLeafWindowsForExecution returns nested pending leaves only', () => {
  const state = buildInitialState({ runId: 'r1' });
  state.semantic_windows = {
    w0001: {
      window_id: 'w0001',
      status: 'split',
      source_session_ids: ['s1', 's2', 's3'],
      input_hash: stableHash(['s1', 's2', 's3']),
      split_into: ['w0001a', 'w0001b'],
    },
    w0001a: {
      window_id: 'w0001a',
      status: 'split',
      split_from: 'w0001',
      source_session_ids: ['s1', 's2'],
      input_hash: stableHash(['s1', 's2']),
      split_into: ['w0001aa', 'w0001ab'],
    },
    w0001aa: {
      window_id: 'w0001aa',
      status: 'succeeded',
      split_from: 'w0001a',
      source_session_ids: ['s1'],
      input_hash: stableHash(['s1']),
    },
    w0001ab: {
      window_id: 'w0001ab',
      status: 'pending',
      split_from: 'w0001a',
      source_session_ids: ['s2'],
      input_hash: stableHash(['s2']),
    },
    w0001b: {
      window_id: 'w0001b',
      status: 'pending',
      split_from: 'w0001',
      source_session_ids: ['s3'],
      input_hash: stableHash(['s3']),
    },
  };

  assert.deepEqual(
    semanticSplitLeafWindowsForExecution(state, 'w0001').map((window) => window.window_id),
    ['w0001ab', 'w0001b'],
  );
});

test('findPlannedContainerDrifts ignores stale skipped none when units are now planned', () => {
  const state = buildInitialState({ runId: 'r1' });
  state.skill_extract = {
    none: {
      unit_id: 'none',
      status: 'skipped',
      input_hash: stableHash('no completed summarized sessions'),
    },
  };

  const drifts = findPlannedContainerDrifts(state, 'skill_extract', [{
    unit_id: 'skill-0001',
    input_hash: stableHash({ sessionId: 's1' }),
  }]);

  assert.deepEqual(drifts, []);
});

test('summary completion replaces partial pending semantic windows with the final plan', () => {
  const state = buildInitialState({ runId: 'semantic-final-plan' });
  state.semantic_windows = {
    w0001: {
      window_id: 'w0001',
      status: 'pending',
      source_session_ids: ['s1'],
      input_hash: stableHash(['s1']),
    },
  };
  const planned = [
    {
      window_id: 'w0001',
      source_session_ids: ['s1', 's2'],
      input_hash: stableHash(['s1', 's2']),
    },
    {
      window_id: 'w0002',
      source_session_ids: ['s3'],
      input_hash: stableHash(['s3']),
    },
  ];

  const drifts = reconcileSemanticWindowsAfterSummary(state, planned);

  assert.deepEqual(drifts, [{ window_id: 'w0001', reason: 'input_hash drift' }]);
  assert.deepEqual(state.semantic_windows.w0001.source_session_ids, ['s1', 's2']);
  assert.equal(state.semantic_windows.w0001.status, 'pending');
  assert.deepEqual(state.semantic_windows.w0002, { ...planned[1], status: 'pending' });
});

test('summary completion refuses to replace a completed semantic window without reset approval', () => {
  const state = buildInitialState({ runId: 'semantic-completed-drift' });
  state.semantic_windows = {
    w0001: {
      window_id: 'w0001',
      status: 'succeeded',
      source_session_ids: ['s1'],
      input_hash: stableHash(['s1']),
    },
  };
  const planned = [{
    window_id: 'w0001',
    source_session_ids: ['s1', 's2'],
    input_hash: stableHash(['s1', 's2']),
  }];

  assert.throws(
    () => reconcileSemanticWindowsAfterSummary(state, planned),
    /completed semantic window input_hash drift detected/,
  );
});

test('computeStageMetrics summarizes numeric metadata without content fields', () => {
  const state = {
    sessions: {
      s1: {
        summary: {
          status: 'succeeded',
          model: 'gpt-5.4-mini',
          prompt_chars: 100,
          duration_ms: 1000,
          parse_failures: 0,
          summary_title: '摘要标题',
        },
        lessons_extract: {
          status: 'succeeded',
          model: 'gpt-5.4-mini',
          prompt_chars: 200,
          duration_ms: 2000,
          parse_failures: 1,
        },
      },
      s2: {
        summary: {
          status: 'failed',
          model: 'gpt-5.4-mini',
          prompt_chars: 300,
          duration_ms: 3000,
          parse_failures: 2,
        },
      },
    },
    semantic_windows: {
      parent: { status: 'split', prompt_chars: 9999 },
      w1: {
        status: 'succeeded',
        model: 'gpt-5.5',
        prompt_chars: 1000,
        char_budget: 64000,
        duration_ms: 4000,
        parse_failures: 0,
      },
      w2: {
        status: 'succeeded',
        model: 'gpt-5.5',
        prompt_chars: 2000,
        char_budget: 64000,
        duration_ms: 8000,
        parse_failures: 1,
      },
    },
    memory_consolidate_windows: {},
    skill_extract: {},
    crystal_groups: {},
    consolidation_procedural_windows: {},
    reflect_insight_windows: {},
  };

  const metrics = computeStageMetrics(state);

  assert.equal(metrics.summary.window_count, 2);
  assert.equal(metrics.summary.status_counts.succeeded, 1);
  assert.equal(metrics.summary.status_counts.failed, 1);
  assert.equal(metrics.summary.prompt_chars.p50, 100);
  assert.equal(metrics.summary.prompt_chars.p90, 300);
  assert.equal(metrics.summary.duration_seconds.max, 3);
  assert.deepEqual(metrics.summary.models, { 'gpt-5.4-mini': 2 });
  assert.equal(metrics.summary.parse_failures_total, 2);
  assert.equal(metrics.summary.parse_failure_units, 1);
  assert.equal(metrics.semantic_windows.window_count, 2);
  assert.equal(metrics.semantic_windows.prompt_chars.max, 2000);
  assert.equal(metrics.semantic_windows.char_budget.p50, 64000);
  assert.equal(metrics.semantic_windows.parse_failures_total, 1);
  assert.equal(JSON.stringify(metrics).includes('摘要标题'), false);
});

test('computeCoverage is acceptance ready only when there are no failed or unfinished units', () => {
  const coverage = computeCoverage({
    sessions: {
      s1: { summary: { status: 'succeeded' }, lessons_extract: { status: 'succeeded' } },
    },
    semantic_windows: {
      w0001: { status: 'succeeded' },
    },
    memory_consolidate_windows: { none: { status: 'skipped' } },
    skill_extract: { none: { status: 'skipped' } },
    crystal_groups: { none: { status: 'skipped' } },
    consolidation_procedural_windows: { none: { status: 'skipped' } },
    reflect_insight_windows: { none: { status: 'skipped' } },
  });
  assert.equal(coverage.acceptance_ready, true);
  const failed = computeCoverage({
    sessions: {
      s1: { summary: { status: 'succeeded' }, lessons_extract: { status: 'failed' } },
    },
    semantic_windows: {
      w0001: { status: 'succeeded' },
    },
    memory_consolidate_windows: { none: { status: 'skipped' } },
    skill_extract: { none: { status: 'skipped' } },
    crystal_groups: { none: { status: 'skipped' } },
    consolidation_procedural_windows: { none: { status: 'skipped' } },
    reflect_insight_windows: { none: { status: 'skipped' } },
  });
  assert.equal(failed.acceptance_ready, false);
  const pendingFullWindow = computeCoverage({
    sessions: {
      s1: { summary: { status: 'succeeded' }, lessons_extract: { status: 'succeeded' } },
    },
    semantic_windows: {
      w0001: { status: 'succeeded' },
    },
    memory_consolidate_windows: { m1: { status: 'pending' } },
    skill_extract: { none: { status: 'skipped' } },
    crystal_groups: { none: { status: 'skipped' } },
    consolidation_procedural_windows: { none: { status: 'skipped' } },
    reflect_insight_windows: { none: { status: 'skipped' } },
  });
  assert.equal(pendingFullWindow.acceptance_ready, false);
});

test('resetStaleRunningUnits resets old running units to pending', () => {
  const state = {
    sessions: {
      s1: {
        summary: { status: 'running', started_at: '2026-07-05T00:00:00.000Z' },
        lessons_extract: { status: 'running', started_at: '2026-07-05T00:00:00.000Z' },
      },
    },
    semantic_windows: {
      w0001: { status: 'running', started_at: '2026-07-05T00:00:00.000Z' },
    },
    memory_consolidate_windows: { m1: { status: 'running', started_at: '2026-07-05T00:00:00.000Z' } },
    skill_extract: { sk1: { status: 'running', started_at: '2026-07-05T00:00:00.000Z' } },
    crystal_groups: { cg1: { status: 'running', started_at: '2026-07-05T00:00:00.000Z' } },
    consolidation_procedural_windows: { cp1: { status: 'running', started_at: '2026-07-05T00:00:00.000Z' } },
    reflect_insight_windows: { ri1: { status: 'running', started_at: '2026-07-05T00:00:00.000Z' } },
  };
  const reset = resetStaleRunningUnits(state, Date.parse('2026-07-05T01:00:00.000Z'), 30 * 60 * 1000);
  assert.equal(reset, 8);
  assert.equal(state.sessions.s1.summary.status, 'pending');
  assert.equal(state.sessions.s1.lessons_extract.status, 'pending');
  assert.equal(state.semantic_windows.w0001.status, 'pending');
  assert.equal(state.memory_consolidate_windows.m1.status, 'pending');
  assert.equal(state.skill_extract.sk1.status, 'pending');
  assert.equal(state.crystal_groups.cg1.status, 'pending');
  assert.equal(state.consolidation_procedural_windows.cp1.status, 'pending');
  assert.equal(state.reflect_insight_windows.ri1.status, 'pending');
});

function resumeOptions(overrides = {}) {
  return {
    agentId: '*',
    semanticWindowSize: 20,
    semanticCharBudget: 64000,
    delayMs: 1500,
    stopAfterConsecutiveFailures: 3,
    resetDriftedUnits: false,
    ...overrides,
  };
}

test('resume fails on config drift', () => {
  const state = buildInitialState({
    runId: 'full-test',
    baseUrl: 'http://127.0.0.1:3111',
    now: '2026-07-05T00:00:00.000Z',
  });
  assert.throws(
    () => validateResumeState(state, resumeOptions({ semanticWindowSize: 10 }), []),
    /config drift/,
  );
});

test('resume fails on inventory drift', () => {
  const sessions = [{ id: 's1', startedAt: '2026-01-01T00:00:00.000Z' }];
  const state = buildInitialState({
    runId: 'full-test',
    baseUrl: 'http://127.0.0.1:3111',
    now: '2026-07-05T00:00:00.000Z',
  });
  state.inventory_hash = computeInventoryHash(sessions, '*');
  assert.throws(
    () => validateResumeState(state, resumeOptions(), [{ id: 's2', startedAt: '2026-01-02T00:00:00.000Z' }]),
    /inventory drift/,
  );
});

test('resetting inventory drift clears stale sessions', () => {
  const oldSessions = [{ id: 'old', startedAt: '2026-01-01T00:00:00.000Z' }];
  const newSessions = [{ id: 'new', startedAt: '2026-01-02T00:00:00.000Z' }];
  const state = buildInitialState({
    runId: 'full-test',
    baseUrl: 'http://127.0.0.1:3111',
    now: '2026-07-05T00:00:00.000Z',
  });
  state.inventory_hash = computeInventoryHash(oldSessions, '*');
  state.sessions.old = {
    session_id: 'old',
    summary: { status: 'succeeded' },
    lessons_extract: { status: 'succeeded' },
  };

  validateResumeState(state, resumeOptions({ resetDriftedUnits: true }), newSessions);

  assert.deepEqual(state.sessions, {});
  assert.equal(state.inventory_hash, computeInventoryHash(newSessions, '*'));
});

test('resume accepts split semantic child windows with matching parent lineage', () => {
  const sessions = [
    { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一' } },
    { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二' } },
  ];
  const state = buildInitialState({
    runId: 'full-test',
    baseUrl: 'http://127.0.0.1:3111',
    now: '2026-07-05T00:00:00.000Z',
  });
  state.inventory_hash = computeInventoryHash(sessions, '*');
  state.sessions = {
    s1: { session_id: 's1', summary: { status: 'succeeded', estimated_prompt_chars: 700 } },
    s2: { session_id: 's2', summary: { status: 'succeeded', estimated_prompt_chars: 700 } },
  };
  state.semantic_windows = {
    w0001: {
      window_id: 'w0001',
      status: 'split',
      source_session_ids: ['s1', 's2'],
      input_hash: stableHash(['s1', 's2']),
      split_into: ['w0001a', 'w0001b'],
      failure_diagnostics: {
        requestPhase: 'chunk',
        providerErrorCode: 'timeout',
        elapsedMs: 1,
        inputChars: 1,
        maxOutputTokens: 1,
        responseStarted: false,
      },
    },
    w0001a: {
      window_id: 'w0001a',
      status: 'succeeded',
      split_from: 'w0001',
      source_session_ids: ['s1'],
      input_hash: stableHash(['s1']),
    },
    w0001b: {
      window_id: 'w0001b',
      status: 'pending',
      split_from: 'w0001',
      source_session_ids: ['s2'],
      input_hash: stableHash(['s2']),
    },
  };

  validateResumeState(state, resumeOptions(), sessions, [
    {
      window_id: 'w0001',
      source_session_ids: ['s1', 's2'],
      source_count: 2,
      estimated_prompt_chars: 1400,
      input_hash: stableHash(['s1', 's2']),
    },
  ]);
});

test('resetting drifted split semantic parent deletes descendant windows', () => {
  const state = buildInitialState({
    runId: 'full-test',
    baseUrl: 'http://127.0.0.1:3111',
    now: '2026-07-05T00:00:00.000Z',
  });
  state.semantic_windows = {
    w0001: {
      window_id: 'w0001',
      status: 'split',
      source_session_ids: ['s1', 's2'],
      input_hash: stableHash(['s1', 's2']),
      split_into: ['w0001a', 'w0001b'],
    },
    w0001a: {
      window_id: 'w0001a',
      status: 'succeeded',
      split_from: 'w0001',
      source_session_ids: ['s1'],
      input_hash: stableHash(['s1']),
      semantic_memory_ids: ['sem-old-a'],
    },
    w0001b: {
      window_id: 'w0001b',
      status: 'split',
      split_from: 'w0001',
      source_session_ids: ['s2'],
      input_hash: stableHash(['s2']),
      split_into: ['w0001ba'],
    },
    w0001ba: {
      window_id: 'w0001ba',
      status: 'succeeded',
      split_from: 'w0001b',
      source_session_ids: ['s2'],
      input_hash: stableHash(['s2']),
      semantic_memory_ids: ['sem-old-ba'],
    },
  };
  state.crystal_groups = { cg1: { status: 'succeeded' } };
  state.consolidation_procedural_windows = { cp1: { status: 'succeeded' } };
  state.reflect_insight_windows = { ri1: { status: 'succeeded' } };

  resetDriftedSemanticUnits(state, [{
    window_id: 'w0001',
    source_session_ids: ['s1', 's2'],
    input_hash: stableHash(['s2', 's1']),
  }], [{ window_id: 'w0001', reason: 'input_hash drift' }]);

  assert.deepEqual(Object.keys(state.semantic_windows), ['w0001']);
  assert.equal(state.semantic_windows.w0001.status, 'pending');
  assert.equal(state.semantic_windows.w0001.reset_reason, 'input_hash drift');
  assert.equal(Object.hasOwn(state.semantic_windows.w0001, 'failure_diagnostics'), false);
  assert.deepEqual(state.crystal_groups, {});
  assert.deepEqual(state.consolidation_procedural_windows, {});
  assert.deepEqual(state.reflect_insight_windows, {});
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'corpus_windows'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'corpus_rollup'), false);
});

async function withMockAgentMemory(handler, testBody) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText ? JSON.parse(bodyText) : null;
      requests.push({ method: req.method, url: req.url, body, headers: req.headers });
      Promise.resolve(handler(req.method, req.url, body)).then((payload) => {
        const statusCode = payload?.statusCode || payload?.status_code || 200;
        const responseBody = payload && (Object.prototype.hasOwnProperty.call(payload, 'statusCode') || Object.prototype.hasOwnProperty.call(payload, 'status_code'))
          ? payload.body
          : payload;
        res.statusCode = statusCode;
        res.setHeader('content-type', 'application/json');
        res.end(typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody));
      }).catch((error) => {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ success: false, error: error.message }));
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await testBody(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withSecret(value, fn) {
  const previous = process.env.AGENTMEMORY_SECRET;
  process.env.AGENTMEMORY_SECRET = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.AGENTMEMORY_SECRET;
    else process.env.AGENTMEMORY_SECRET = previous;
  }
}

async function captureConsole(fn) {
  const previousLog = console.log;
  const previousError = console.error;
  const logs = [];
  const errors = [];
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = previousLog;
    console.error = previousError;
  }
}

function defaultFullEndpointResponse(method, url, body) {
  if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
    return { success: true };
  }
  if (method === 'POST' && [
    '/agentmemory/full/memory-consolidate-windows/plan',
    '/agentmemory/full/consolidation-procedural-windows/plan',
    '/agentmemory/full/reflect-insight-windows/plan',
  ].includes(url)) {
    return { success: true, windows: [] };
  }
  if (method === 'POST' && url === '/agentmemory/full/crystals/auto') {
    if (body?.dryRun === true) return { success: true, dryRun: true, groups: [] };
    return { success: true, groups: [] };
  }
  if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window') {
    return { success: true, memoryIds: [`mem-${body.unitId}`] };
  }
  if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window/prepare') {
    return {
      success: true,
      status: 'prepared',
      preparedHandle: `prepared-${body.unitId}`,
      proposalHash: `proposal-${body.unitId}`,
    };
  }
  if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window/commit') {
    return { success: true, status: 'succeeded', memoryIds: [`mem-${body.unitId}`] };
  }
  if (method === 'POST' && url === '/agentmemory/full/skill-extract') {
    return { success: true, status: 'extracted', skillIds: [`skill-${body.sessionId}`] };
  }
  if (method === 'POST' && url === '/agentmemory/full/skill-extract/prepare') {
    return {
      success: true,
      status: 'prepared',
      preparedHandle: `prepared-${body.unitId}`,
      proposalHash: `proposal-${body.unitId}`,
    };
  }
  if (method === 'POST' && url === '/agentmemory/full/skill-extract/commit') {
    return { success: true, status: 'succeeded', proceduralMemoryIds: [`skill-${body.unitId}`] };
  }
  if (method === 'POST' && url === '/agentmemory/full/consolidation-procedural-window') {
    return { success: true, proceduralMemoryIds: [`proc-${body.unitId}`] };
  }
  if (method === 'POST' && url === '/agentmemory/full/reflect-insight-window') {
    assert.equal(body.useGraph, false);
    return { success: true, insightIds: [`insight-${body.unitId}`] };
  }
  return null;
}

test('skill prepare/commit adapter preserves formal identity and replays terminal state locally', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/prepare') {
      return {
        success: true,
        status: 'prepared',
        preparedHandle: 'skill-handle-1',
        proposalHash: 'skill-proposal-1',
        stage: 'skill_extract',
        model: 'skill-release-b',
        modelSource: 'explicitModel',
        modelApplied: true,
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/commit') {
      return {
        success: true,
        status: 'succeeded',
        proceduralMemoryIds: ['skill-1'],
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    return { statusCode: 404, body: { success: false, error: 'unexpected' } };
  }, async (baseUrl, requests) => {
    const unit = {
      unit_id: 'skill-unit-1',
      session_id: 'session-1',
      source_ids: ['session-1'],
      input_hash: 'skill-input-1',
    };
    const state = {
      run_id: 'release-b-run',
      mark: 'release-b',
      config: {},
      skill_extract: { [unit.unit_id]: { ...unit, status: 'pending' } },
    };
    const options = {
      skillExtractModel: 'skill-release-b',
      writeState: async () => {},
    };

    assert.equal((await runSkillExtractPrepareUnit({
      state,
      statePath: 'unused.json',
      baseUrl,
      secret: 'test-secret',
      unit,
      options,
    })).status, 'succeeded');
    assert.equal((await runSkillExtractPrepareUnit({
      state,
      statePath: 'unused.json',
      baseUrl,
      secret: 'test-secret',
      unit,
      options,
    })).status, 'succeeded');
    assert.equal((await runSkillExtractCommitUnit({
      state,
      statePath: 'unused.json',
      baseUrl,
      secret: 'test-secret',
      unit,
      options,
    })).status, 'succeeded');
    assert.equal((await runSkillExtractCommitUnit({
      state,
      statePath: 'unused.json',
      baseUrl,
      secret: 'test-secret',
      unit,
      options,
    })).status, 'succeeded');

    const prepareRequests = requests.filter((request) =>
      request.url === '/agentmemory/full/skill-extract/prepare');
    const commitRequests = requests.filter((request) =>
      request.url === '/agentmemory/full/skill-extract/commit');
    assert.equal(prepareRequests.length, 1);
    assert.equal(commitRequests.length, 1);
    assert.deepEqual({
      runId: prepareRequests[0].body.runId,
      stage: prepareRequests[0].body.stage,
      unitId: prepareRequests[0].body.unitId,
      inputHash: prepareRequests[0].body.inputHash,
      sessionId: prepareRequests[0].body.sessionId,
      model: prepareRequests[0].body.model,
    }, {
      runId: 'release-b-run',
      stage: 'skill_extract',
      unitId: 'skill-unit-1',
      inputHash: 'skill-input-1',
      sessionId: 'session-1',
      model: 'skill-release-b',
    });
    assert.equal(commitRequests[0].body.preparedHandle, 'skill-handle-1');
    assert.equal(state.skill_extract[unit.unit_id].status, 'succeeded');
    assert.deepEqual(state.skill_extract[unit.unit_id].skill_ids, ['skill-1']);
  });
});

test('memory prepare maps a replayed empty legacy result to a persisted skipped terminal', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window/prepare') {
      return { success: true, status: 'skipped', consolidated: 0, memoryIds: [], replayed: true };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    return { statusCode: 404, body: { success: false, error: 'unexpected' } };
  }, async (baseUrl, requests) => {
    const unit = {
      unit_id: 'mcw-empty',
      window_id: 'mcw-empty',
      source_ids: ['obs-1'],
      input_hash: 'input-empty',
    };
    const state = {
      run_id: 'formal-run',
      mark: 'formal',
      config: { memory_consolidate_char_budget: 64000 },
      memory_consolidate_windows: { [unit.unit_id]: unit },
    };
    const outcome = await runRestMemoryPrepareUnit({
      state,
      statePath: 'unused.json',
      baseUrl,
      secret: 'test-secret',
      unit,
      options: { writeState: async () => {} },
    });
    assert.equal(outcome.status, 'skipped');
    assert.equal(state.memory_consolidate_windows[unit.unit_id].status, 'skipped');
    assert.deepEqual(state.memory_consolidate_windows[unit.unit_id].memory_ids, []);
    const record = requests.find((request) => request.url === '/agentmemory/extraction-runs/record');
    assert.equal(record.body.status, 'skipped');
    assert.deepEqual(record.body.resultIds, []);
  });
});

test('memory consolidate planner reads bounded descriptor pages before finalizing', async () => {
  const bodies = [];
  await withMockAgentMemory((method, url, body) => {
    assert.equal(method, 'POST');
    assert.equal(url, '/agentmemory/full/memory-consolidate-windows/plan');
    bodies.push(body);
    if (body.sessionOffset === 0) {
      return {
        success: true,
        descriptors: [],
        plannerId: body.plannerId,
        sessionOffset: 0,
        nextSessionOffset: 8,
        totalSessions: 10,
        sessionInventoryHash: 'inventory-hash',
        accumulatedDescriptorCount: 1,
      };
    }
    if (body.sessionOffset === 8) {
      return {
        success: true,
        descriptors: [],
        plannerId: body.plannerId,
        sessionOffset: 8,
        nextSessionOffset: null,
        totalSessions: 10,
        sessionInventoryHash: 'inventory-hash',
        accumulatedDescriptorCount: 2,
      };
    }
    if (body.windowOffset === 0) {
      return {
        success: true,
        plannerId: body.plannerId,
        windows: [{
          windowId: 'memory-consolidate:windows:1',
          sourceObservationIds: ['obs-1'],
        }],
        windowOffset: 0,
        nextWindowOffset: 1,
        totalWindows: 2,
      };
    }
    if (body.windowOffset === 1) {
      return {
        success: true,
        plannerId: body.plannerId,
        windows: [{
          windowId: 'memory-consolidate:windows:2',
          sourceObservationIds: ['obs-2'],
        }],
        windowOffset: 1,
        nextWindowOffset: null,
        totalWindows: 2,
      };
    }
    assert.equal(typeof body.plannerId, 'string');
    assert.equal(body.descriptors, undefined);
    assert.fail(`unexpected planner request ${JSON.stringify(body)}`);
  }, async (baseUrl) => {
    const response = await requestMemoryConsolidatePlan({
      state: { config: { memory_consolidate_char_budget: 64000 } },
      baseUrl,
      secret: 'test-secret',
      options: {},
      definition: {
        planEndpoint: '/agentmemory/full/memory-consolidate-windows/plan',
      },
    });
    assert.equal(response.ok, true);
    assert.deepEqual(
      response.data.windows.map((window) => window.windowId),
      ['memory-consolidate:windows:1', 'memory-consolidate:windows:2'],
    );
  });
  assert.equal(bodies.length, 4);
  assert.equal(bodies[0].sessionLimit, 8);
  assert.equal(bodies[0].plannerId, bodies[1].plannerId);
  assert.equal(bodies[1].plannerId, bodies[2].plannerId);
  assert.equal(bodies[2].charBudget, 64000);
  assert.equal(bodies[2].windowLimit, 8);
  assert.equal(bodies[2].plannerId, bodies[3].plannerId);
});

test('transient plan failure is retried through the runtime recovery gate before downstream planning', async () => {
  let memoryPlanCalls = 0;
  const sleeps = [];
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1 } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return { sessions: [{ id: 's1', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: 'done' } }] };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lesson-plan-retry' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lesson-plan-retry') {
      return { success: true, run: { id: 'lesson-plan-retry', status: 'succeeded' }, chunks: [] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      return { success: true, semanticMemoryIds: ['sem-plan-retry'], semanticMemoryCharSizes: { 'sem-plan-retry': 5 } };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      memoryPlanCalls += 1;
      if (memoryPlanCalls === 1) {
        return { statusCode: 503, body: { success: false, error: 'temporary plan outage' } };
      }
      return { success: true, windows: [] };
    }
    const response = defaultFullEndpointResponse(method, url, body);
    if (response) return response;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-plan-retry-'));
    const captured = await withSecret('test-secret', () => captureConsole(() => mainForTest([
      '--base-url', baseUrl,
      '--state-dir', stateDir,
      '--run-id', 'plan-retry',
      '--delay-ms', '0',
    ], {
      runtimeDiagnostics: async () => ({ runtime_healthy: true, doctor_healthy: true }),
      sleep: async (ms) => { sleeps.push(ms); },
      jitter: () => 0,
    })));

    assert.equal(captured.result, 0);
    assert.equal(memoryPlanCalls, 2);
    assert.deepEqual(sleeps, [60_000]);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'plan-retry.json'), 'utf8'));
    assert.equal(state.memory_consolidate_windows.none.status, 'skipped');
    assert.equal(state.memory_consolidate_windows.none.record_pending, undefined);
  });
});

test('none-stage record failure retries only the idempotent record without repeating the crystal plan', async () => {
  let crystalPlanCalls = 0;
  let crystalRecordCalls = 0;
  const sleeps = [];
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1 } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return { sessions: [{ id: 's1', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: 'done' } }] };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lesson-none-record' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lesson-none-record') {
      return { success: true, run: { id: 'lesson-none-record', status: 'succeeded' }, chunks: [] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      return { success: true, semanticMemoryIds: ['sem-none-record'], semanticMemoryCharSizes: { 'sem-none-record': 5 } };
    }
    if (method === 'POST' && url === '/agentmemory/full/crystals/auto' && body?.dryRun === true) {
      crystalPlanCalls += 1;
      return { success: true, dryRun: true, groups: [] };
    }
    if (
      method === 'POST'
      && url === '/agentmemory/extraction-runs/record'
      && body.stage === 'crystal'
      && body.unitId === 'none'
    ) {
      crystalRecordCalls += 1;
      if (crystalRecordCalls === 1) {
        return { statusCode: 500, body: { success: false, error: 'record temporarily unavailable' } };
      }
      return { success: true };
    }
    const response = defaultFullEndpointResponse(method, url, body);
    if (response) return response;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-none-record-retry-'));
    const captured = await withSecret('test-secret', () => captureConsole(() => mainForTest([
      '--base-url', baseUrl,
      '--state-dir', stateDir,
      '--run-id', 'none-record-retry',
      '--delay-ms', '0',
    ], {
      runtimeDiagnostics: async () => ({ runtime_healthy: true, doctor_healthy: true }),
      sleep: async (ms) => { sleeps.push(ms); },
      jitter: () => 0,
    })));

    assert.equal(captured.result, 0);
    assert.equal(crystalPlanCalls, 1);
    assert.equal(crystalRecordCalls, 2);
    assert.deepEqual(sleeps, [60_000]);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'none-record-retry.json'), 'utf8'));
    assert.equal(state.crystal_groups.none.status, 'skipped');
    assert.equal(state.crystal_groups.none.record_pending, undefined);
    assert.equal(typeof state.crystal_groups.none.recorded_at, 'string');
  });
});

test('main resume rebuilds historical provider failures into fair single-item recovery probes', async () => {
  let summaryCalls = 0;
  let firstProbeInFlight = false;
  let concurrentWithFirstProbe = false;
  let activeAfterProbe = 0;
  let peakAfterProbe = 0;
  const sessions = ['s1', 's2', 's3'].map((id, index) => ({
    id,
    status: 'completed',
    startedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
  }));

  await withMockAgentMemory(async (method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1 } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') return { sessions };
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      summaryCalls += 1;
      if (summaryCalls === 1) {
        firstProbeInFlight = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
        firstProbeInFlight = false;
      } else {
        if (firstProbeInFlight) concurrentWithFirstProbe = true;
        activeAfterProbe += 1;
        peakAfterProbe = Math.max(peakAfterProbe, activeAfterProbe);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeAfterProbe -= 1;
      }
      return {
        success: true,
        status: 'succeeded',
        completedChunks: 1,
        totalChunks: 1,
        skippedChunks: 0,
        summary: { title: `summary-${body.sessionId}` },
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: `lesson-${body.sessionIds[0]}` }] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/run?runId=lesson-')) {
      const runId = new URL(url, 'http://local').searchParams.get('runId');
      return { success: true, run: { id: runId, status: 'succeeded' }, chunks: [] };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') return { success: true };
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      return { statusCode: 400, body: { success: false, error: 'stop after recovery assertion' } };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-historical-provider-resume-'));
    const runId = 'historical-provider-resume';
    const argv = [
      '--base-url', baseUrl,
      '--state-dir', stateDir,
      '--run-id', runId,
      '--resume',
      '--reset-drifted-units',
      '--session-concurrency', '3',
      '--delay-ms', '0',
    ];
    const parsed = parseArgs(argv);
    const state = buildInitialState({
      runId,
      baseUrl,
      now: '2026-07-14T00:00:00.000Z',
      config: buildConfigFromOptions(parsed),
    });
    state.inventory_hash = computeInventoryHash(sessions, '*');
    for (const session of sessions) {
      state.sessions[session.id] = {
        session_id: session.id,
        started_at: session.startedAt,
        completed_at: '2026-01-10T00:00:00.000Z',
        session_status: 'completed',
        summary: {
          status: 'failed',
          attempt_count: 1,
          failure_class: 'transient_provider',
          failure_cause: 'pi_stream_failed',
        },
        lessons_extract: { status: 'pending', attempt_count: 0 },
      };
    }
    await writeStateAtomically(path.join(stateDir, `${runId}.json`), state);

    const captured = await withSecret('test-secret', () => captureConsole(() => mainForTest(argv, {
      sleep: async () => {},
      jitter: () => 0,
    })));
    assert.equal(captured.result, 1);
  });

  assert.equal(summaryCalls, 3);
  assert.equal(concurrentWithFirstProbe, false);
  assert.equal(peakAfterProbe, 1);
});

test('main applies session concurrency only to summary and lessons session work', async () => {
  const active = { summary: 0, lessons: 0, skill_extract: 0 };
  const peak = { summary: 0, lessons: 0, skill_extract: 0 };
  const started = { summary: [], lessons: [], skill_extract: [] };
  const wait = async (stage, sessionId) => {
    started[stage].push(sessionId);
    active[stage] += 1;
    peak[stage] = Math.max(peak[stage], active[stage]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active[stage] -= 1;
  };

  await withMockAgentMemory(async (method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1 } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: ['s1', 's2', 's3'].map((id, index) => ({
          id,
          startedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
          status: 'completed',
        })),
      };
    }
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      await wait('summary', body.sessionId);
      return {
        success: true,
        status: 'succeeded',
        completedChunks: 1,
        totalChunks: 1,
        skippedChunks: 0,
        summary: { title: `summary-${body.sessionId}` },
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      const sessionId = body.sessionIds[0];
      await wait('lessons', sessionId);
      return { success: true, runs: [{ id: `lesson-${sessionId}` }] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/run?runId=lesson-')) {
      const runId = new URL(url, 'http://local').searchParams.get('runId');
      return { success: true, run: { id: runId, status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') return { success: true };
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      return { statusCode: 400, body: { success: false, error: 'stop after session stages' } };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract') {
      await wait('skill_extract', body.sessionId);
      return { success: false, error: 'stop after session stages' };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-session-concurrency-'));
    const captured = await withSecret('test-secret', () => captureConsole(() => mainForTest([
      '--base-url', baseUrl,
      '--state-dir', stateDir,
      '--run-id', 'session-concurrency',
      '--session-concurrency', '3',
      '--delay-ms', '0',
    ])));
    assert.equal(captured.result, 1);
    const persisted = JSON.parse(await fs.readFile(path.join(stateDir, 'session-concurrency.json'), 'utf8'));
    assert.equal(persisted.config.session_concurrency, 3);
  });

  assert.equal(peak.summary, 3);
  assert.equal(peak.lessons, 3);
  assert.equal(peak.skill_extract, 0);
  assert.deepEqual(started.summary.sort(), ['s1', 's2', 's3']);
  assert.deepEqual(started.lessons.sort(), ['s1', 's2', 's3']);
});

test('Release B runs semantic windows independently and commits skills in plan order', async () => {
  let semanticActive = 0;
  let semanticPeak = 0;
  let skillPrepareActive = 0;
  let skillPreparePeak = 0;
  const skillPrepareCompleted = [];
  const skillCommitStarted = [];
  const singleStepActive = { crystal: 0, procedural: 0, reflect: 0 };
  const singleStepPeak = { crystal: 0, procedural: 0, reflect: 0 };
  const waitForSingleStep = async (stage) => {
    singleStepActive[stage] += 1;
    singleStepPeak[stage] = Math.max(singleStepPeak[stage], singleStepActive[stage]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    singleStepActive[stage] -= 1;
  };
  const prepareDelay = { s1: 80, s2: 25, s3: 0 };

  await withMockAgentMemory(async (method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return {
        success: true,
        runtime: {
          summarizeChunkConcurrency: 1,
          summarizeChunkSize: 400,
          providerName: 'test',
        },
      };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: ['s1', 's2', 's3'].map((id, index) => ({
          id,
          startedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
          completedAt: `2026-01-0${index + 1}T01:00:00.000Z`,
          status: 'completed',
          summary: {
            title: `summary-${id}`,
            narrative: `narrative-${id}`,
            concepts: [`concept-${id}`],
          },
        })),
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: `lesson-${body.sessionIds[0]}`, status: 'succeeded' }] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/run?runId=lesson-')) {
      const runId = new URL(url, 'http://local').searchParams.get('runId');
      return {
        success: true,
        run: { id: runId, status: 'succeeded' },
        chunks: [{ status: 'succeeded' }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      return { success: true, windows: [] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup' && body.kind === 'window') {
      semanticActive += 1;
      semanticPeak = Math.max(semanticPeak, semanticActive);
      await new Promise((resolve) => setTimeout(resolve, 30));
      semanticActive -= 1;
      return {
        success: true,
        semanticMemoryIds: [`semantic-${body.windowId}`],
        semanticMemoryCharSizes: { [`semantic-${body.windowId}`]: 100 },
        inputHash: stableHash(body.sessionIds),
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/prepare') {
      skillPrepareActive += 1;
      skillPreparePeak = Math.max(skillPreparePeak, skillPrepareActive);
      await new Promise((resolve) => setTimeout(resolve, prepareDelay[body.sessionId]));
      skillPrepareActive -= 1;
      skillPrepareCompleted.push(body.sessionId);
      return {
        success: true,
        status: 'prepared',
        preparedHandle: `handle-${body.sessionId}`,
        proposalHash: `proposal-${body.sessionId}`,
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/commit') {
      skillCommitStarted.push(body.unitId);
      return {
        success: true,
        status: 'succeeded',
        proceduralMemoryIds: [`procedural-${body.unitId}`],
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/crystals/auto') {
      if (body.dryRun === true) {
        return {
          success: true,
          dryRun: true,
          groups: [
            { groupId: 'cg-1', actionIds: ['action-1'], status: 'planned' },
            { groupId: 'cg-2', actionIds: ['action-2'], status: 'planned' },
          ],
        };
      }
      await waitForSingleStep('crystal');
      return {
        success: true,
        groups: [
          { groupId: 'cg-1', actionIds: ['action-1'], status: 'succeeded', crystalIds: ['crystal-1'] },
          { groupId: 'cg-2', actionIds: ['action-2'], status: 'succeeded', crystalIds: ['crystal-2'] },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/consolidation-procedural-windows/plan') {
      return {
        success: true,
        windows: [
          { windowId: 'procedural-1', sourceIds: ['crystal-1'], inputHash: 'procedural-hash-1' },
          { windowId: 'procedural-2', sourceIds: ['crystal-2'], inputHash: 'procedural-hash-2' },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/consolidation-procedural-window') {
      await waitForSingleStep('procedural');
      return { success: true, proceduralMemoryIds: [`memory-${body.unitId}`] };
    }
    if (method === 'POST' && url === '/agentmemory/full/reflect-insight-windows/plan') {
      return {
        success: true,
        windows: [
          { windowId: 'reflect-1', sourceIds: ['memory-procedural-1'], inputHash: 'reflect-hash-1' },
          { windowId: 'reflect-2', sourceIds: ['memory-procedural-2'], inputHash: 'reflect-hash-2' },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/reflect-insight-window') {
      await waitForSingleStep('reflect');
      return { success: true, insightIds: [`insight-${body.unitId}`] };
    }
    return { statusCode: 404, body: { success: false, error: `unexpected ${method} ${url}` } };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-release-b-pipeline-'));
    const captured = await withSecret('test-secret', () => captureConsole(() => mainForTest([
      '--base-url', baseUrl,
      '--state-dir', stateDir,
      '--run-id', 'release-b-pipeline',
      '--semantic-window-size', '1',
      '--delay-ms', '0',
    ])));
    assert.equal(captured.result, 0, captured.errors.join('\n'));
  });

  assert.equal(semanticPeak, 2);
  assert.equal(skillPreparePeak, 2);
  assert.notDeepEqual(skillPrepareCompleted, ['s1', 's2', 's3']);
  assert.deepEqual(skillCommitStarted, ['skill-0001', 'skill-0002', 'skill-0003']);
  assert.deepEqual(singleStepPeak, { crystal: 1, procedural: 1, reflect: 1 });
});

test('Release B drain commits already prepared skills and launches no later prepare', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-release-b-drain-'));
  const statePath = path.join(stateDir, 'release-b-drain.json');
  let drainRequested = false;
  const preparedSessions = [];
  const committedUnits = [];

  await withMockAgentMemory(async (method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return {
        success: true,
        runtime: {
          summarizeChunkConcurrency: 1,
          summarizeChunkSize: 400,
          providerName: 'test',
        },
      };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: ['s1', 's2', 's3'].map((id, index) => ({
          id,
          startedAt: `2026-02-0${index + 1}T00:00:00.000Z`,
          completedAt: `2026-02-0${index + 1}T01:00:00.000Z`,
          status: 'completed',
          summary: { title: id, narrative: `summary-${id}`, concepts: [id] },
        })),
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: `lesson-${body.sessionIds[0]}`, status: 'succeeded' }] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/run?runId=lesson-')) {
      const runId = new URL(url, 'http://local').searchParams.get('runId');
      return {
        success: true,
        run: { id: runId, status: 'succeeded' },
        chunks: [{ status: 'succeeded' }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      return { success: true, windows: [] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup' && body.kind === 'window') {
      return {
        success: true,
        semanticMemoryIds: [`semantic-${body.windowId}`],
        semanticMemoryCharSizes: { [`semantic-${body.windowId}`]: 100 },
        inputHash: stableHash(body.sessionIds),
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/prepare') {
      preparedSessions.push(body.sessionId);
      if (!drainRequested) {
        drainRequested = true;
        const lock = JSON.parse(await fs.readFile(`${statePath}.lock`, 'utf8'));
        await fs.writeFile(`${statePath}.drain-request.json`, `${JSON.stringify({
          run_id: lock.run_id,
          owner_id: lock.owner_id,
          requested_at: new Date().toISOString(),
        })}\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        success: true,
        status: 'prepared',
        preparedHandle: `handle-${body.sessionId}`,
        proposalHash: `proposal-${body.sessionId}`,
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/commit') {
      committedUnits.push(body.unitId);
      return {
        success: true,
        status: 'succeeded',
        proceduralMemoryIds: [`procedural-${body.unitId}`],
      };
    }
    return { statusCode: 404, body: { success: false, error: `unexpected ${method} ${url}` } };
  }, async (baseUrl) => {
    const captured = await withSecret('test-secret', () => captureConsole(() => mainForTest([
      '--base-url', baseUrl,
      '--state-dir', stateDir,
      '--run-id', 'release-b-drain',
      '--semantic-window-size', '1',
      '--delay-ms', '0',
    ])));
    assert.equal(captured.result, 75, captured.errors.join('\n'));
  });

  assert.deepEqual(preparedSessions.sort(), ['s1', 's2']);
  assert.deepEqual(committedUnits, ['skill-0001', 'skill-0002']);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.drain_requested_at !== undefined, true);
  assert.equal(Object.values(state.skill_extract).some((unit) =>
    ['preparing', 'prepared', 'committing'].includes(unit.status) || unit.record_pending === true), false);
  const status = JSON.parse(await fs.readFile(
    statePath.replace(/\.json$/, '.status.json'),
    'utf8',
  ));
  assert.equal(status.in_flight_gaps.total, 0);
});

test('runtime config check fails when summarizeChunkConcurrency is not 1', async () => {
  await withMockAgentMemory((method, url) => {
    assert.equal(`${method} ${url}`, 'GET /agentmemory/runtime-config');
    return { success: true, runtime: { summarizeChunkConcurrency: 6 } };
  }, async (baseUrl) => {
    await assert.rejects(
      () => assertRuntimeConcurrency({ baseUrl, secret: 'test-secret', allowed: null }),
      /SUMMARIZE_CHUNK_CONCURRENCY=6/,
    );
  });
});

test('runtime config check allows non-1 only with explicit --allow-summarize-concurrency', async () => {
  await withMockAgentMemory(() => ({ success: true, runtime: { summarizeChunkConcurrency: 6 } }), async (baseUrl) => {
    const runtime = await assertRuntimeConcurrency({ baseUrl, secret: 'test-secret', allowed: 6 });
    assert.equal(runtime.summarizeChunkConcurrency, 6);
  });
});

test('dry-run records planned semantic windows but calls no extraction endpoints', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [
          { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一' } },
          { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二' } },
        ],
      };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-full-dryrun-'));
    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
        '--base-url',
        baseUrl,
        '--state-dir',
        stateDir,
        '--run-id',
        'dry',
        '--semantic-window-size',
        '1',
        '--semantic-char-budget',
        '18000',
        '--dry-run',
    ])));
    assert.equal(captured.result, 0);
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] runtime ok')));
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] inventory sessions')));
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] coverage planned')));
    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      'GET /agentmemory/runtime-config',
      'GET /agentmemory/sessions?agentId=*',
      'POST /agentmemory/full/memory-consolidate-windows/plan',
      'POST /agentmemory/full/crystals/auto',
      'POST /agentmemory/full/consolidation-procedural-windows/plan',
      'POST /agentmemory/full/reflect-insight-windows/plan',
    ]);
    assert.equal(requests.some((request) => request.url === '/agentmemory/extraction-runs/record'), false);
    assert.equal(requests.some((request) => /\/agentmemory\/full\/(memory-consolidate-window|skill-extract|consolidation-procedural-window|reflect-insight-window)$/.test(request.url)), false);
    assert.ok(requests.some((request) => request.url === '/agentmemory/full/crystals/auto' && request.body.dryRun === true));
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'dry.json'), 'utf8'));
    assert.deepEqual(Object.keys(state.semantic_windows), ['w0001', 'w0002']);
    assert.equal(state.semantic_windows.w0001.status, 'planned');
    assert.equal(state.coverage.semantic_windows.planned, 2);
    assert.equal(state.coverage.semantic_windows.other, 0);
    assert.equal(state.coverage.memory_consolidate_windows.skipped, 1);
    assert.equal(state.coverage.skill_extract.skipped, 1);
    assert.equal(state.coverage.crystal_groups.skipped, 1);
    assert.equal(state.coverage.consolidation_procedural_windows.skipped, 1);
    assert.equal(state.coverage.reflect_insight_windows.skipped, 1);
    assert.equal(state.config.semantic_char_budget, 18000);
    assert.equal(typeof state.inventory_hash, 'string');
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'corpus_windows'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'corpus_rollup'), false);
  });
});

test('dry-run persists active-session exclusion audit and plans only terminal sessions', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1 } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [
          { id: 'active-1', status: 'active', startedAt: '2026-01-01T00:00:00.000Z' },
          {
            id: 'completed-1',
            status: 'completed',
            startedAt: '2026-01-02T00:00:00.000Z',
            summary: { title: '已完成' },
          },
          {
            id: 'abandoned-1',
            status: 'abandoned',
            startedAt: '2026-01-03T00:00:00.000Z',
            summary: { title: '已放弃' },
          },
        ],
      };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-active-exclusion-'));
    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'active-exclusion',
      '--dry-run',
    ])));

    assert.equal(captured.result, 0);
    const inventoryLog = captured.logs.find((line) => line.startsWith('[progress] inventory sessions'));
    assert.match(inventoryLog, /"excluded_count":1/);
    assert.match(inventoryLog, /"session_status_active":1/);

    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'active-exclusion.json'), 'utf8'));
    assert.deepEqual(Object.keys(state.sessions).sort(), ['abandoned-1', 'completed-1']);
    assert.deepEqual(state.inventory_audit.excluded_reason_counts, { session_status_active: 1 });
    assert.deepEqual(state.inventory_audit.excluded_sessions, [{
      session_id: 'active-1',
      session_status: 'active',
      reason: 'session_status_active',
    }]);
    assert.equal(state.coverage.sessions.total, 2);
  });
});

test('mock REST dry-run request list contains no extraction POSTs', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return { sessions: [{ id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '已完成' } }] };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-full-safe-dryrun-'));
    await withSecret('test-secret', async () => {
      await mainForTest(['--base-url', baseUrl, '--state-dir', stateDir, '--run-id', 'dry', '--dry-run']);
    });
    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      'GET /agentmemory/runtime-config',
      'GET /agentmemory/sessions?agentId=*',
      'POST /agentmemory/full/memory-consolidate-windows/plan',
      'POST /agentmemory/full/crystals/auto',
      'POST /agentmemory/full/consolidation-procedural-windows/plan',
      'POST /agentmemory/full/reflect-insight-windows/plan',
    ]);
    assert.equal(requests.some((request) => request.url === '/agentmemory/extraction-runs/record'), false);
    assert.equal(requests.some((request) => request.url === '/agentmemory/full/skill-extract'), false);
  });
});

test('dry-run plans semantic windows by summary char budget', async () => {
  const longNarrative = 'x'.repeat(1000);
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [
          { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一', narrative: longNarrative } },
          { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二', narrative: longNarrative } },
          { id: 's3', startedAt: '2026-01-03T00:00:00.000Z', summary: { title: '三', narrative: longNarrative } },
        ],
      };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-char-budget-'));
    await withSecret('test-secret', async () => {
      await captureConsole(() => mainForTest([
        '--base-url',
        baseUrl,
        '--state-dir',
        stateDir,
        '--run-id',
        'char-budget',
        '--semantic-window-size',
        '20',
        '--semantic-char-budget',
        '2700',
        '--dry-run',
      ]));
    });

    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'char-budget.json'), 'utf8'));
    assert.deepEqual(state.semantic_windows.w0001.source_session_ids, ['s1', 's2']);
    assert.deepEqual(state.semantic_windows.w0002.source_session_ids, ['s3']);
    assert.equal(Object.prototype.hasOwnProperty.call(state.semantic_windows.w0001, 'session_ids'), false);
    assert.equal(state.sessions.s1.summary.estimated_prompt_chars > 1000, true);
    assert.equal(Object.prototype.hasOwnProperty.call(state.sessions.s1.summary, 'summary'), false);
    assert.equal(JSON.stringify(state.sessions.s1.summary).includes(longNarrative), false);
  });
});

test('mock REST successful run writes generic records for all full stages', async () => {
  let memoryPrepareCalls = 0;
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [{
          id: 's1',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:30:00.000Z',
          status: 'completed',
          summary: { title: '摘要' },
        }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      assert.deepEqual(body.sessionIds, ['s1']);
      assert.equal(body.chunkConcurrency, 1);
      return { success: true, runs: [{ id: 'lex1', status: 'succeeded' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex1') {
      return {
        success: true,
        run: {
          id: 'lex1',
          status: 'succeeded',
          config: {
            model: 'lesson-env-model',
            modelSource: 'AGENTMEMORY_LESSON_MODEL',
          },
          provider: 'pi-agent-sdk',
          modelApplied: true,
          durationMs: 33,
          promptChars: 444,
        },
        chunks: [{ status: 'succeeded' }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      assert.notEqual(body.kind, 'corpus');
      if (body.kind === 'window') {
        return {
          success: true,
          semanticMemoryIds: [`sem-${body.windowId}`],
          semanticMemoryCharSizes: { [`sem-${body.windowId}`]: 4 },
          inputHash: stableHash(body.sessionIds),
          stage: 'semantic_rollup',
          model: 'semantic-env-model',
          modelSource: 'AGENTMEMORY_SEMANTIC_ROLLUP_MODEL',
          provider: 'pi-agent-sdk',
          modelApplied: true,
          promptChars: 555,
          charBudget: 24000,
          durationMs: 44,
          parseFailures: 0,
        };
      }
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      return { success: true, windows: [{ windowId: 'mcw1', sourceIds: ['s1'], inputHash: 'mcw-hash' }] };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window/prepare') {
      memoryPrepareCalls += 1;
      assert.equal(body.windowId, 'mcw1');
      return {
        success: true,
        memoryIds: ['mem1'],
        stage: 'memory_consolidate',
        model: 'memory-env-model',
        modelSource: 'AGENTMEMORY_MEMORY_CONSOLIDATE_MODEL',
        provider: 'pi-agent-sdk',
        modelApplied: true,
        promptChars: 666,
        charBudget: 18000,
        durationMs: 55,
        parseFailures: 0,
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/prepare') {
      assert.equal(body.sessionId, 's1');
      assert.equal(body.runId, 'full-test');
      assert.equal(body.stage, 'skill_extract');
      assert.equal(body.unitId, 'skill-0001');
      assert.equal(typeof body.inputHash, 'string');
      return {
        success: true,
        status: 'prepared',
        preparedHandle: 'prepared-skill1',
        proposalHash: 'proposal-skill1',
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/commit') {
      return {
        success: true,
        status: 'succeeded',
        proceduralMemoryIds: ['skill1'],
        stage: 'skill_extract',
        model: 'skill-env-model',
        modelSource: 'AGENTMEMORY_SKILL_EXTRACT_MODEL',
        provider: 'pi-agent-sdk',
        modelApplied: true,
        promptChars: 777,
        durationMs: 66,
        parseFailures: 0,
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/crystals/auto') {
      if (body.dryRun === true) {
        return {
          success: true,
          dryRun: true,
          groups: [{
            groupId: 'cg1',
            actionIds: ['act1'],
            actionUpdatedAts: ['2026-01-01T01:00:00.000Z'],
            status: 'planned',
            crystalIds: [],
          }],
        };
      }
      assert.equal(body.runId, 'full-test');
      assert.equal(body.stage, 'crystal');
      assert.equal(body.unitId, 'auto');
      assert.equal(typeof body.inputHash, 'string');
      return { success: true, groups: [{ groupId: 'cg1', actionIds: ['act1'], status: 'succeeded', crystalIds: ['crystal1'] }] };
    }
    if (method === 'POST' && url === '/agentmemory/full/consolidation-procedural-windows/plan') {
      return { success: true, windows: [{ windowId: 'cpw1', sourceIds: ['crystal1'], inputHash: 'cpw-hash' }] };
    }
    if (method === 'POST' && url === '/agentmemory/full/consolidation-procedural-window') {
      return {
        success: true,
        proceduralMemoryIds: ['proc1'],
        stage: 'memory_consolidate',
        model: 'memory-env-model',
        modelSource: 'AGENTMEMORY_MEMORY_CONSOLIDATE_MODEL',
        provider: 'pi-agent-sdk',
        modelApplied: true,
        promptChars: 888,
        durationMs: 77,
        parseFailures: 0,
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/reflect-insight-windows/plan') {
      return { success: true, windows: [{ windowId: 'riw1', sourceIds: ['proc1'], inputHash: 'riw-hash' }] };
    }
    if (method === 'POST' && url === '/agentmemory/full/reflect-insight-window') {
      assert.equal(body.useGraph, false);
      return {
        success: true,
        insightIds: ['insight1'],
        stage: 'reflect_insight',
        model: 'reflect-env-model',
        modelSource: 'AGENTMEMORY_REFLECT_INSIGHT_MODEL',
        provider: 'pi-agent-sdk',
        modelApplied: true,
        promptChars: 999,
        charBudget: 18000,
        durationMs: 88,
        parseFailures: 0,
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-full-run-'));
    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
        '--base-url',
        baseUrl,
        '--state-dir',
        stateDir,
        '--run-id',
        'full-test',
        '--semantic-window-size',
        '1',
        '--delay-ms',
        '0',
    ])));
    assert.equal(captured.result, 0);
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] summary item')));
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] lessons item')));
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] memory_consolidate_prepare item')));
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] semantic_rollup item')));
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] skill_extract item')));
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] crystal item')));
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] consolidation_procedural item')));
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] reflect_insight item')));
    assert.ok(captured.logs.some((line) => line.startsWith('[progress] coverage final')));
    const recordRequests = requests.filter((request) => request.method === 'POST' && request.url === '/agentmemory/extraction-runs/record');
    assert.ok(recordRequests.some((request) => request.body.summarySessionId === 's1'));
    assert.ok(recordRequests.some((request) => request.body.lessonRunId === 'lex1'));
    assert.ok(recordRequests.some((request) => request.body.semanticWindowId === 'w0001'));
    assert.ok(recordRequests.some((request) => request.body.stage === 'memory_consolidate' && request.body.resultIds.includes('mem1')));
    assert.ok(recordRequests.some((request) => request.body.stage === 'skill_extract' && request.body.resultIds.includes('skill1')));
    assert.ok(recordRequests.some((request) => request.body.stage === 'crystal' && request.body.resultIds.includes('crystal1')));
    assert.ok(recordRequests.some((request) => request.body.stage === 'consolidation_procedural' && request.body.resultIds.includes('proc1')));
    assert.ok(recordRequests.some((request) => request.body.stage === 'reflect_insight' && request.body.resultIds.includes('insight1')));
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'full-test.json'), 'utf8'));
    assert.equal(state.coverage.acceptance_ready, true);
    assert.deepEqual(state.memory_consolidate_windows.mcw1.memory_ids, ['mem1']);
    assert.equal(state.memory_consolidate_windows.mcw1.model, 'memory-env-model');
    assert.equal(state.memory_consolidate_windows.mcw1.model_source, 'AGENTMEMORY_MEMORY_CONSOLIDATE_MODEL');
    assert.equal(state.memory_consolidate_windows.mcw1.prompt_chars, 666);
    assert.equal(state.memory_consolidate_windows.mcw1.char_budget, 18000);
    assert.equal(state.memory_consolidate_windows.mcw1.duration_ms, 55);
    assert.equal(state.sessions.s1.lessons_extract.model, 'lesson-env-model');
    assert.equal(state.sessions.s1.lessons_extract.model_source, 'AGENTMEMORY_LESSON_MODEL');
    assert.equal(state.sessions.s1.lessons_extract.prompt_chars, 444);
    assert.equal(state.semantic_windows.w0001.model, 'semantic-env-model');
    assert.equal(state.semantic_windows.w0001.model_source, 'AGENTMEMORY_SEMANTIC_ROLLUP_MODEL');
    assert.equal(state.semantic_windows.w0001.prompt_chars, 555);
    assert.equal(state.semantic_windows.w0001.char_budget, 24000);
    assert.deepEqual(state.skill_extract['skill-0001'].skill_ids, ['skill1']);
    assert.equal(state.skill_extract['skill-0001'].model, 'skill-env-model');
    assert.equal(state.skill_extract['skill-0001'].model_source, 'AGENTMEMORY_SKILL_EXTRACT_MODEL');
    assert.equal(state.skill_extract['skill-0001'].duration_ms, 66);
    assert.deepEqual(state.crystal_groups.cg1.crystal_ids, ['crystal1']);
    assert.deepEqual(state.crystal_groups.cg1.action_ids, ['act1']);
    assert.equal(
      state.crystal_groups.cg1.input_hash,
      stableHash({ actionIds: ['act1'], actionUpdatedAts: ['2026-01-01T01:00:00.000Z'] }),
    );
    assert.deepEqual(state.consolidation_procedural_windows.cpw1.procedural_memory_ids, ['proc1']);
    assert.equal(state.consolidation_procedural_windows.cpw1.model, 'memory-env-model');
    assert.equal(state.consolidation_procedural_windows.cpw1.model_source, 'AGENTMEMORY_MEMORY_CONSOLIDATE_MODEL');
    assert.equal(state.consolidation_procedural_windows.cpw1.prompt_chars, 888);
    assert.deepEqual(state.reflect_insight_windows.riw1.insight_ids, ['insight1']);
    assert.equal(state.reflect_insight_windows.riw1.model, 'reflect-env-model');
    assert.equal(state.reflect_insight_windows.riw1.model_source, 'AGENTMEMORY_REFLECT_INSIGHT_MODEL');
    assert.equal(state.reflect_insight_windows.riw1.prompt_chars, 999);
    assert.equal(state.reflect_insight_windows.riw1.char_budget, 18000);
    const proceduralRequest = requests.find((request) =>
      request.method === 'POST' &&
      request.url === '/agentmemory/full/consolidation-procedural-window'
    );
    assert.equal(Object.hasOwn(proceduralRequest.body, 'model'), false);
    assert.equal(JSON.stringify(requests).includes('"kind":"corpus"'), false);

    state.memory_consolidate_windows.mcw1.record_pending = true;
    delete state.memory_consolidate_windows.mcw1.recorded_at;
    await fs.writeFile(
      path.join(stateDir, 'full-test.json'),
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8',
    );
    const memoryRecordCallsBeforeResume = recordRequests.filter((request) =>
      request.body.stage === 'memory_consolidate'
      && request.body.unitId === 'mcw1'
    ).length;
    const resumed = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'full-test',
      '--semantic-window-size',
      '1',
      '--delay-ms',
      '0',
      '--resume',
    ])));
    assert.equal(resumed.result, 0);
    assert.equal(memoryPrepareCalls, 1);
    const resumedState = JSON.parse(await fs.readFile(path.join(stateDir, 'full-test.json'), 'utf8'));
    assert.equal(resumedState.memory_consolidate_windows.mcw1.record_pending, undefined);
    assert.equal(typeof resumedState.memory_consolidate_windows.mcw1.recorded_at, 'string');
    assert.equal(
      requests.filter((request) =>
        request.method === 'POST'
        && request.url === '/agentmemory/extraction-runs/record'
        && request.body.stage === 'memory_consolidate'
        && request.body.unitId === 'mcw1'
      ).length,
      memoryRecordCallsBeforeResume + 1,
    );
  });
});

test('procedural CLI model is sent only to procedural consolidation windows', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [{
          id: 's1',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:10:00.000Z',
          summary: { title: '摘要' },
        }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lex1', status: 'succeeded' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex1') {
      return { success: true, run: { id: 'lex1', status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      return {
        success: true,
        semanticMemoryIds: [`sem-${body.windowId}`],
        semanticMemoryCharSizes: { [`sem-${body.windowId}`]: 4 },
        inputHash: stableHash(body.sessionIds),
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      return { success: true, windows: [{ windowId: 'mcw1', sourceIds: ['s1'], inputHash: 'mcw-hash' }] };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window/prepare') {
      return {
        success: true,
        memoryIds: ['mem1'],
        stage: 'memory_consolidate',
        model: 'memory-service-effective',
        modelSource: 'explicitModel',
        provider: 'pi-agent-sdk',
        modelApplied: true,
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/prepare') {
      return {
        success: true,
        status: 'prepared',
        preparedHandle: 'prepared-skill1',
        proposalHash: 'proposal-skill1',
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/commit') {
      return { success: true, status: 'succeeded', proceduralMemoryIds: ['skill1'] };
    }
    if (method === 'POST' && url === '/agentmemory/full/crystals/auto') {
      if (body.dryRun === true) {
        return {
          success: true,
          dryRun: true,
          groups: [{
            groupId: 'cg1',
            actionIds: ['act1'],
            actionUpdatedAts: ['2026-01-01T01:00:00.000Z'],
            status: 'planned',
            crystalIds: [],
          }],
        };
      }
      return { success: true, groups: [{ groupId: 'cg1', actionIds: ['act1'], status: 'succeeded', crystalIds: ['crystal1'] }] };
    }
    if (method === 'POST' && url === '/agentmemory/full/consolidation-procedural-windows/plan') {
      return { success: true, windows: [{ windowId: 'cpw1', sourceIds: ['mem1'], inputHash: 'cpw-hash' }] };
    }
    if (method === 'POST' && url === '/agentmemory/full/consolidation-procedural-window') {
      return {
        success: true,
        proceduralMemoryIds: ['proc1'],
        stage: 'procedural',
        model: 'procedural-service-effective',
        modelSource: 'explicitModel',
        provider: 'pi-agent-sdk',
        modelApplied: true,
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/reflect-insight-windows/plan') {
      return { success: true, windows: [] };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-full-procedural-model-'));
    await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'procedural-model',
      '--semantic-window-size',
      '1',
      '--delay-ms',
      '0',
      '--memory-consolidate-model',
      'memory-model',
      '--procedural-model',
      'procedural-model',
    ])));

    const memoryRequest = requests.find((request) =>
      request.method === 'POST' &&
      request.url === '/agentmemory/full/memory-consolidate-window/prepare'
    );
    const proceduralRequest = requests.find((request) =>
      request.method === 'POST' &&
      request.url === '/agentmemory/full/consolidation-procedural-window'
    );
    assert.equal(memoryRequest.body.model, 'memory-model');
    assert.equal(proceduralRequest.body.model, 'procedural-model');
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'procedural-model.json'), 'utf8'));
    assert.equal(state.memory_consolidate_windows.mcw1.model, 'memory-service-effective');
    assert.equal(state.memory_consolidate_windows.mcw1.model_source, 'explicitModel');
    assert.equal(state.consolidation_procedural_windows.cpw1.model, 'procedural-service-effective');
    assert.equal(state.consolidation_procedural_windows.cpw1.model_source, 'explicitModel');
  });
});

test('stage budgets are sent only to stages with real budget inputs', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [{
          id: 's1',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:10:00.000Z',
          status: 'completed',
          summary: { title: '摘要', narrative: '内容' },
        }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      assert.equal(Object.hasOwn(body, 'charBudget'), false);
      return { success: true, runs: [{ id: 'lex1', status: 'succeeded' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex1') {
      return { success: true, run: { id: 'lex1', status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      assert.equal(Object.hasOwn(body, 'charBudget'), false);
      return {
        success: true,
        semanticMemoryIds: [`sem-${body.windowId}`],
        semanticMemoryCharSizes: { [`sem-${body.windowId}`]: 4 },
        inputHash: stableHash(body.sessionIds),
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      assert.equal(body.charBudget, 18000);
      return { success: true, windows: [{ windowId: 'mcw1', sourceIds: ['s1'], inputHash: 'mcw-hash' }] };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window/prepare') {
      assert.equal(body.charBudget, 18000);
      return { success: true, memoryIds: ['mem1'] };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/prepare') {
      assert.equal(Object.hasOwn(body, 'charBudget'), false);
      return {
        success: true,
        status: 'prepared',
        preparedHandle: 'prepared-skill1',
        proposalHash: 'proposal-skill1',
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/commit') {
      return { success: true, status: 'succeeded', proceduralMemoryIds: ['skill1'] };
    }
    if (method === 'POST' && url === '/agentmemory/full/crystals/auto') {
      if (body.dryRun === true) {
        return { success: true, dryRun: true, groups: [] };
      }
      return { success: true, groups: [] };
    }
    if (method === 'POST' && url === '/agentmemory/full/consolidation-procedural-windows/plan') {
      return { success: true, windows: [{ windowId: 'cpw1', sourceIds: ['mem1'], inputHash: 'cpw-hash' }] };
    }
    if (method === 'POST' && url === '/agentmemory/full/consolidation-procedural-window') {
      assert.equal(Object.hasOwn(body, 'charBudget'), false);
      return { success: true, proceduralMemoryIds: ['proc1'] };
    }
    if (method === 'POST' && url === '/agentmemory/full/reflect-insight-windows/plan') {
      assert.equal(body.charBudget, 19000);
      return { success: true, windows: [{ windowId: 'riw1', sourceIds: ['proc1'], inputHash: 'riw-hash' }] };
    }
    if (method === 'POST' && url === '/agentmemory/full/reflect-insight-window') {
      assert.equal(body.charBudget, 19000);
      return { success: true, insightIds: ['insight1'] };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-stage-budgets-'));
    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'stage-budgets',
      '--semantic-window-size',
      '1',
      '--semantic-rollup-target-prompt-chars',
      '17000',
      '--memory-consolidate-char-budget',
      '18000',
      '--reflect-insight-char-budget',
      '19000',
      '--delay-ms',
      '0',
    ])));

    assert.equal(captured.result, 0);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'stage-budgets.json'), 'utf8'));
    assert.equal(state.config.semantic_rollup_target_prompt_chars, 17000);
    assert.equal(state.config.memory_consolidate_char_budget, 18000);
    assert.equal(state.config.reflect_insight_char_budget, 19000);
    assert.equal(requests.some((request) => request.url === '/agentmemory/semantic-rollup' && Object.hasOwn(request.body, 'charBudget')), false);
  });
});

test('summary state records service effective model metadata', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      return {
        success: true,
        status: 'succeeded',
        completedChunks: 1,
        totalChunks: 1,
        skippedChunks: 0,
        summary: { title: '摘要', narrative: '已生成' },
        stage: 'summary',
        model: 'summary-env-model',
        modelSource: 'AGENTMEMORY_SUMMARY_MODEL',
        provider: 'pi-agent-sdk',
        modelApplied: true,
        promptChars: 321,
        durationMs: 12,
        parseFailures: 0,
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-model-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: { agent_id: '*' },
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'pending', attempt_count: 0 },
          lessons_extract: { status: 'pending', attempt_count: 0 },
        },
      },
    };

    const result = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'succeeded');
    assert.equal(state.sessions.s1.summary.model, 'summary-env-model');
    assert.equal(state.sessions.s1.summary.model_source, 'AGENTMEMORY_SUMMARY_MODEL');
    assert.equal(state.sessions.s1.summary.prompt_chars, 321);
    assert.equal(state.sessions.s1.summary.duration_ms, 12);
  });
});

test('unsupported provider model response does not write CLI model as effective', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      assert.equal(body.model, 'semantic-cli-model');
      return {
        success: true,
        semanticMemoryIds: ['sem-1'],
        semanticMemoryCharSizes: { 'sem-1': 4 },
        inputHash: stableHash(body.sessionIds),
        stage: 'semantic_rollup',
        provider: 'openai',
        modelApplied: false,
        providerModelOverride: 'unsupported',
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-unsupported-model-'));
    const statePath = path.join(stateDir, 'state.json');
    const options = parseArgs([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--semantic-rollup-model',
      'semantic-cli-model',
    ]);
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: { agent_id: '*', semantic_window_size: 20, semantic_char_budget: 18000 },
      semantic_windows: {},
      semantic_memory_char_sizes: {},
    };
    const window = {
      window_id: 'w0001',
      source_session_ids: ['s1'],
      input_hash: stableHash(['s1']),
      status: 'pending',
    };

    const result = await runSemanticWindow({ state, statePath, baseUrl, secret: 'test-secret', window, options });

    assert.equal(result.status, 'succeeded');
    assert.equal(Object.hasOwn(state.semantic_windows.w0001, 'model'), false);
    assert.equal(Object.hasOwn(state.semantic_windows.w0001, 'model_source'), false);
    assert.equal(state.semantic_windows.w0001.model_applied, false);
    assert.equal(state.semantic_windows.w0001.provider_model_override, 'unsupported');
  });
});

test('successful run can resume without semantic window input_hash drift', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [{
          id: 's1',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:10:00.000Z',
          summary: { title: '摘要' },
        }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lex1', status: 'succeeded' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex1') {
      return { success: true, run: { id: 'lex1', status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      return {
        success: true,
        semanticMemoryIds: [`sem-${body.windowId}-${body.kind}`],
        semanticMemoryCharSizes: { [`sem-${body.windowId}-${body.kind}`]: 4 },
        inputHash: `service-content-hash-${body.windowId}`,
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-full-resume-'));
    await withSecret('test-secret', async () => {
      await mainForTest([
        '--base-url',
        baseUrl,
        '--state-dir',
        stateDir,
        '--run-id',
        'resume-ok',
        '--semantic-window-size',
        '1',
        '--delay-ms',
        '0',
      ]);
      const stateAfterRun = JSON.parse(await fs.readFile(path.join(stateDir, 'resume-ok.json'), 'utf8'));
      assert.equal(stateAfterRun.semantic_windows.w0001.input_hash, stableHash(['s1']));
      assert.equal(stateAfterRun.semantic_windows.w0001.semantic_rollup_input_hash, 'service-content-hash-w0001');
      const semanticCallsAfterRun = requests.filter((request) => request.method === 'POST' && request.url === '/agentmemory/semantic-rollup').length;

      await mainForTest([
        '--base-url',
        baseUrl,
        '--state-dir',
        stateDir,
        '--run-id',
        'resume-ok',
        '--semantic-window-size',
        '1',
        '--delay-ms',
        '0',
        '--resume',
      ]);

      const semanticCallsAfterResume = requests.filter((request) => request.method === 'POST' && request.url === '/agentmemory/semantic-rollup').length;
      assert.equal(semanticCallsAfterResume, semanticCallsAfterRun);
    });
  });
});

test('skill extraction treats too few observations as skipped even on non-2xx response', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [{
          id: 's1',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:10:00.000Z',
          summary: { title: '摘要' },
        }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lex1' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex1') {
      return { success: true, run: { id: 'lex1', status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      return {
        success: true,
        semanticMemoryIds: [`sem-${body.windowId}`],
        semanticMemoryCharSizes: { [`sem-${body.windowId}`]: 4 },
        inputHash: stableHash(body.sessionIds),
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/skill-extract/prepare') {
      return {
        statusCode: 400,
        body: { success: false, error: 'too few observations for skill extraction' },
      };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-skill-skip-'));
    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'skill-skip',
      '--semantic-window-size',
      '1',
      '--delay-ms',
      '0',
    ])));

    assert.equal(captured.result, 0);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'skill-skip.json'), 'utf8'));
    assert.equal(state.skill_extract['skill-0001'].status, 'skipped');
    assert.match(state.skill_extract['skill-0001'].skipped_reason, /too few observations|skipped/);
    assert.equal(state.coverage.acceptance_ready, true);
  });
});

test('memory_consolidate input_too_large splits the window and runs child windows', async () => {
  const memoryCalls = [];
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [
          { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一' } },
          { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二' } },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: `lex-${body.sessionIds[0]}` }] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/run?runId=lex-')) {
      const runId = new URL(`http://test${url}`).searchParams.get('runId');
      return { success: true, run: { id: runId, status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      return {
        success: true,
        semanticMemoryIds: [`sem-${body.windowId}`],
        semanticMemoryCharSizes: { [`sem-${body.windowId}`]: 4 },
        inputHash: stableHash(body.sessionIds),
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      return {
        success: true,
        windows: [{
          windowId: 'mcw1',
          sourceObservationIds: ['o1', 'o2', 'o3', 'o4'],
          observationIds: ['o1', 'o2', 'o3', 'o4'],
          sourceCount: 4,
          inputHash: 'mcw-hash',
        }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window/prepare') {
      memoryCalls.push(body);
      if (body.windowId === 'mcw1') {
        return {
          statusCode: 400,
          body: { success: false, error: 'input_too_large', promptChars: 28000, maxPromptChars: 24000 },
        };
      }
      return { success: true, memoryIds: [`mem-${body.windowId}`] };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-memory-split-'));
    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'memory-split',
      '--semantic-window-size',
      '20',
      '--delay-ms',
      '0',
    ])));

    assert.equal(captured.result, 0);
    assert.deepEqual(memoryCalls.map((call) => call.windowId), ['mcw1', 'mcw1a', 'mcw1b']);
    assert.deepEqual(memoryCalls.find((call) => call.windowId === 'mcw1a').sourceObservationIds, ['o1', 'o2']);
    assert.deepEqual(memoryCalls.find((call) => call.windowId === 'mcw1b').sourceObservationIds, ['o3', 'o4']);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'memory-split.json'), 'utf8'));
    assert.equal(state.memory_consolidate_windows.mcw1.status, 'split');
    assert.deepEqual(state.memory_consolidate_windows.mcw1.split_into, ['mcw1a', 'mcw1b']);
    assert.equal(state.memory_consolidate_windows.mcw1a.status, 'succeeded');
    assert.equal(state.memory_consolidate_windows.mcw1b.status, 'succeeded');
    assert.equal(state.coverage.memory_consolidate_windows.succeeded, 2);
    assert.equal(state.coverage.memory_consolidate_windows.other, 0);
    assert.equal(state.coverage.acceptance_ready, true);
  });
});

test('memory_consolidate plan over budget splits before model calls', async () => {
  const memoryCalls = [];
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [
          { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一' } },
          { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二' } },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: `lex-${body.sessionIds[0]}` }] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/run?runId=lex-')) {
      const runId = new URL(`http://test${url}`).searchParams.get('runId');
      return { success: true, run: { id: runId, status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      return {
        success: true,
        semanticMemoryIds: [`sem-${body.windowId}`],
        semanticMemoryCharSizes: { [`sem-${body.windowId}`]: 4 },
        inputHash: stableHash(body.sessionIds),
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      assert.equal(body.charBudget, 300000);
      return {
        success: true,
        charBudget: 300000,
        budgetApplied: true,
        maxWindowEstimatedChars: 1193362,
        overBudgetWindowCount: 1,
        windows: [{
          windowId: 'mcw-large',
          sourceObservationIds: ['o1', 'o2', 'o3', 'o4'],
          observationIds: ['o1', 'o2', 'o3', 'o4'],
          sourceCount: 4,
          estimatedChars: 1193362,
          inputHash: 'mcw-large-hash',
        }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window/prepare') {
      memoryCalls.push(body);
      if (body.windowId === 'mcw-large') {
        throw new Error('over-budget parent window must not run');
      }
      return { success: true, memoryIds: [`mem-${body.windowId}`] };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-memory-budget-split-'));
    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'memory-budget-split',
      '--semantic-window-size',
      '20',
      '--memory-consolidate-char-budget',
      '300000',
      '--delay-ms',
      '0',
    ])));

    assert.equal(captured.result, 0);
    assert.deepEqual(
      memoryCalls.map((call) => call.windowId),
      ['mcw-largeaa', 'mcw-largeab', 'mcw-largeba', 'mcw-largebb'],
    );
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'memory-budget-split.json'), 'utf8'));
    assert.equal(state.memory_consolidate_windows['mcw-large'].status, 'split');
    assert.equal(state.memory_consolidate_windows['mcw-largea'].status, 'split');
    for (const id of ['mcw-largeaa', 'mcw-largeab', 'mcw-largeba', 'mcw-largebb']) {
      assert.equal(state.memory_consolidate_windows[id].status, 'succeeded');
      assert.ok(state.memory_consolidate_windows[id].estimated_chars <= 300000);
    }
  });
});

test('memory stage finishes legal siblings before a deterministic budget-failure barrier blocks semantic work', async () => {
  let legalCalls = 0;
  let semanticCalls = 0;
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1 } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return { sessions: [{ id: 's1', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: 'done' } }] };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lesson-mixed-budget' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lesson-mixed-budget') {
      return { success: true, run: { id: 'lesson-mixed-budget', status: 'succeeded' }, chunks: [] };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      return {
        success: true,
        windows: [
          {
            windowId: 'mcw-too-large',
            sourceObservationIds: ['o-large'],
            sourceCount: 1,
            estimatedChars: 400000,
            inputHash: 'mcw-too-large-hash',
          },
          {
            windowId: 'mcw-legal',
            sourceObservationIds: ['o-legal'],
            sourceCount: 1,
            estimatedChars: 1000,
            inputHash: 'mcw-legal-hash',
          },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window/prepare') {
      legalCalls += 1;
      assert.equal(body.windowId, 'mcw-legal');
      return { success: true, memoryIds: ['mem-legal'] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      semanticCalls += 1;
      return { success: true, semanticMemoryIds: ['sem-unexpected'] };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') return { success: true };
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-mixed-budget-barrier-'));
    const captured = await withSecret('test-secret', () => captureConsole(() => mainForTest([
      '--base-url', baseUrl,
      '--state-dir', stateDir,
      '--run-id', 'mixed-budget-barrier',
      '--memory-consolidate-char-budget', '300000',
      '--delay-ms', '0',
    ])));

    assert.equal(captured.result, 1);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'mixed-budget-barrier.json'), 'utf8'));
    assert.equal(state.memory_consolidate_windows['mcw-too-large'].status, 'failed');
    assert.equal(state.memory_consolidate_windows['mcw-too-large'].failure_class, 'hard');
    assert.equal(state.memory_consolidate_windows['mcw-too-large'].failure_cause, 'input_too_large_single_observation');
    assert.equal(state.memory_consolidate_windows['mcw-legal'].status, 'succeeded');
  });
  assert.equal(legalCalls, 1);
  assert.equal(semanticCalls, 0);
});

test('resume repairs a budget failure record then replans and executes legal siblings in the same run', async () => {
  const controller = new AbortController();
  let memoryPlanCalls = 0;
  let budgetRecordCalls = 0;
  let legalCalls = 0;
  let semanticCalls = 0;
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1 } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return { sessions: [{ id: 's1', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: 'done' } }] };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lesson-budget-resume' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lesson-budget-resume') {
      return { success: true, run: { id: 'lesson-budget-resume', status: 'succeeded' }, chunks: [] };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      memoryPlanCalls += 1;
      return {
        success: true,
        windows: [
          {
            windowId: 'mcw-too-large',
            sourceObservationIds: ['o-large'],
            sourceCount: 1,
            estimatedChars: 400000,
            inputHash: 'mcw-too-large-hash',
          },
          {
            windowId: 'mcw-legal',
            sourceObservationIds: ['o-legal'],
            sourceCount: 1,
            estimatedChars: 1000,
            inputHash: 'mcw-legal-hash',
          },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window/prepare') {
      legalCalls += 1;
      assert.equal(body.windowId, 'mcw-legal');
      return { success: true, memoryIds: ['mem-legal'] };
    }
    if (
      method === 'POST'
      && url === '/agentmemory/extraction-runs/record'
      && body.stage === 'memory_consolidate'
      && body.unitId === 'mcw-too-large'
    ) {
      budgetRecordCalls += 1;
      if (budgetRecordCalls === 1) {
        return { statusCode: 500, body: { success: false, error: 'crash before budget receipt repair' } };
      }
      return { success: true };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      semanticCalls += 1;
      return { success: true, semanticMemoryIds: ['sem-unexpected'] };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') return { success: true };
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-budget-record-crash-resume-'));
    const args = [
      '--base-url', baseUrl,
      '--state-dir', stateDir,
      '--run-id', 'budget-record-crash-resume',
      '--memory-consolidate-char-budget', '300000',
      '--delay-ms', '0',
    ];
    const first = await withSecret('test-secret', () => captureConsole(() => mainForTest(args, {
      signal: controller.signal,
      runtimeDiagnostics: async () => ({ runtime_healthy: true, doctor_healthy: true }),
      sleep: async () => { controller.abort(new Error('simulated crash')); },
      jitter: () => 0,
    })));
    assert.equal(first.result, 130);
    const crashed = JSON.parse(await fs.readFile(path.join(stateDir, 'budget-record-crash-resume.json'), 'utf8'));
    assert.equal(crashed.memory_consolidate_windows['mcw-too-large'].record_pending, true);
    assert.equal(crashed.memory_consolidate_windows['mcw-legal'].status, 'pending');

    const resumed = await withSecret('test-secret', () => captureConsole(() => mainForTest([...args, '--resume'], {
      runtimeDiagnostics: async () => ({ runtime_healthy: true, doctor_healthy: true }),
      sleep: async () => {},
      jitter: () => 0,
    })));
    assert.equal(resumed.result, 1);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'budget-record-crash-resume.json'), 'utf8'));
    assert.equal(state.memory_consolidate_windows['mcw-too-large'].record_pending, undefined);
    assert.equal(state.memory_consolidate_windows['mcw-too-large'].failure_class, 'hard');
    assert.equal(state.memory_consolidate_windows['mcw-too-large'].failure_cause, 'input_too_large_single_observation');
    assert.equal(state.memory_consolidate_windows['mcw-legal'].status, 'succeeded');
  });

  assert.equal(memoryPlanCalls, 2);
  assert.equal(budgetRecordCalls, 2);
  assert.equal(legalCalls, 1);
  assert.equal(semanticCalls, 0);
});

test('recording a failed terminal keeps its sanitized business failure classification', async () => {
  const target = {
    status: 'failed',
    failure_class: 'hard',
    failure_cause: 'input_too_large_single_observation',
    error: 'input_too_large_single_observation',
  };
  const state = { target };
  const outcome = await persistTerminalThenRecord({
    state,
    statePath: 'unused.json',
    target,
    terminalState: { ...target },
    writeState: async () => {},
    record: async () => {},
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(target.failure_class, 'hard');
  assert.equal(target.failure_cause, 'input_too_large_single_observation');
  assert.equal(target.error, 'input_too_large_single_observation');
  assert.equal(target.record_pending, undefined);
  assert.equal(typeof target.recorded_at, 'string');
});

test('memory_consolidate single over-budget window repairs its record, replans once, and never calls the model', async () => {
  const memoryCalls = [];
  let planCalls = 0;
  let budgetRecordCalls = 0;
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return { sessions: [{ id: 's1', startedAt: '2026-01-01T00:00:00.000Z', status: 'completed', summary: { title: '一' } }] };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lex-s1' }] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/run?runId=')) {
      return { success: true, run: { id: 'lex-s1', status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      return {
        success: true,
        semanticMemoryIds: [`sem-${body.windowId}`],
        semanticMemoryCharSizes: { [`sem-${body.windowId}`]: 4 },
        inputHash: stableHash(body.sessionIds),
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-windows/plan') {
      planCalls += 1;
      return {
        success: true,
        charBudget: 300000,
        budgetApplied: true,
        maxWindowEstimatedChars: 400000,
        overBudgetWindowCount: 1,
        windows: [{
          windowId: 'mcw-single',
          sourceObservationIds: ['o1'],
          observationIds: ['o1'],
          sourceCount: 1,
          estimatedChars: 400000,
          overBudget: true,
          overBudgetReason: 'single_observation',
          inputHash: 'mcw-single-hash',
        }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/full/memory-consolidate-window/prepare') {
      memoryCalls.push(body);
      return { success: true, memoryIds: [`mem-${body.windowId}`] };
    }
    if (
      method === 'POST'
      && url === '/agentmemory/extraction-runs/record'
      && body.stage === 'memory_consolidate'
      && body.unitId === 'mcw-single'
    ) {
      budgetRecordCalls += 1;
      if (budgetRecordCalls === 1) {
        return { statusCode: 500, body: { success: false, error: 'budget record temporary failure' } };
      }
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-memory-budget-single-'));
    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'memory-budget-single',
      '--memory-consolidate-char-budget',
      '300000',
      '--delay-ms',
      '0',
    ], {
      runtimeDiagnostics: async () => ({ runtime_healthy: true, doctor_healthy: true }),
      sleep: async () => {},
      jitter: () => 0,
    })));

    assert.equal(captured.result, 1);
    assert.deepEqual(memoryCalls, []);
    assert.equal(planCalls, 2);
    assert.equal(budgetRecordCalls, 2);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'memory-budget-single.json'), 'utf8'));
    assert.equal(state.memory_consolidate_windows['mcw-single'].status, 'failed');
    assert.equal(state.memory_consolidate_windows['mcw-single'].budget_failure_reason, 'input_too_large_single_observation');
    assert.equal(state.memory_consolidate_windows['mcw-single'].recorded_at !== undefined, true);
  });
});

test('record failure after skill_extract success persists terminal state and resume only repairs record', async () => {
  let modelCalls = 0;
  let recordCalls = 0;
  await withMockAgentMemory((method, url, body) => {
    if (method === 'POST' && url === '/agentmemory/full/skill-extract') {
      modelCalls += 1;
      assert.deepEqual(body, {
        sessionId: 's1',
        runId: 'skill-record-fail',
        stage: 'skill_extract',
        unitId: 'skill-0001',
        inputHash: stableHash({ sessionId: 's1', summary_hash: null }),
      });
      return { success: true, status: 'extracted', skillIds: [`skill-${body.sessionId}`] };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      recordCalls += 1;
      if (recordCalls === 1) return { statusCode: 500, body: { success: false, error: 'record failed' } };
      return { success: true };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-skill-record-fail-'));
    const statePath = path.join(stateDir, 'skill-record-fail.json');
    const unit = {
      unit_id: 'skill-0001',
      session_id: 's1',
      source_ids: ['s1'],
      input_hash: stableHash({ sessionId: 's1', summary_hash: null }),
    };
    const state = buildInitialState({ runId: 'skill-record-fail', baseUrl });
    state.skill_extract[unit.unit_id] = { ...unit, status: 'pending' };
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const first = await runSkillExtractUnit({ state, statePath, baseUrl, secret: 'test-secret', unit });

    let persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.deepEqual(first.failure, { class: 'transient_runtime', cause: 'record_failed' });
    assert.equal(persisted.skill_extract['skill-0001'].status, 'succeeded');
    assert.deepEqual(persisted.skill_extract['skill-0001'].skill_ids, ['skill-s1']);
    assert.equal(persisted.skill_extract['skill-0001'].record_pending, true);
    assert.equal(Object.hasOwn(persisted.skill_extract['skill-0001'], 'recorded_at'), false);

    const second = await runSkillExtractUnit({ state, statePath, baseUrl, secret: 'test-secret', unit });
    persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(second.status, 'succeeded');
    assert.equal(modelCalls, 1);
    assert.equal(recordCalls, 2);
    assert.equal(Object.hasOwn(persisted.skill_extract['skill-0001'], 'record_pending'), false);
    assert.ok(persisted.skill_extract['skill-0001'].recorded_at);
    assert.equal(Object.hasOwn(persisted.skill_extract['skill-0001'], 'error'), false);
    assert.equal(Object.hasOwn(persisted.skill_extract['skill-0001'], 'failure_cause'), false);
  });
});

test('semantic input_too_large splits the window and runs child windows', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [
          { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一' } },
          { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二' } },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: `lex-${body.sessionIds[0]}` }] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/run?runId=lex-')) {
      const runId = new URL(`http://test${url}`).searchParams.get('runId');
      return { success: true, run: { id: runId, status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      if (body.kind === 'window' && body.windowId === 'w0001') {
        return {
          statusCode: 400,
          body: { success: false, error: 'input_too_large', promptChars: 28474, maxPromptChars: 24000 },
        };
      }
      return {
        success: true,
        semanticMemoryIds: [`sem-${body.windowId}`],
        semanticMemoryCharSizes: { [`sem-${body.windowId}`]: 4 },
        inputHash: stableHash(body.kind === 'window' ? body.sessionIds : body.semanticMemoryIds),
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-semantic-split-'));
    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'semantic-split',
      '--semantic-window-size',
      '20',
      '--delay-ms',
      '0',
    ])));

    assert.equal(captured.result, 0);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'semantic-split.json'), 'utf8'));
    assert.equal(state.semantic_windows.w0001.status, 'split');
    assert.deepEqual(state.semantic_windows.w0001.split_into, ['w0001a', 'w0001b']);
    assert.equal(state.semantic_windows.w0001a.status, 'succeeded');
    assert.equal(state.semantic_windows.w0001b.status, 'succeeded');
    const windowCalls = requests.filter((request) => request.method === 'POST' && request.url === '/agentmemory/semantic-rollup' && request.body.kind === 'window');
    assert.deepEqual(windowCalls.map((request) => request.body.windowId), ['w0001', 'w0001a', 'w0001b']);
  });
});

test('resume of split semantic window runs only pending leaf child', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [
          { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一' } },
          { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二' } },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      assert.notEqual(body.kind, 'corpus');
      assert.equal(body.kind, 'window');
      assert.equal(body.windowId, 'w0001b');
      assert.deepEqual(body.sessionIds, ['s2']);
      return {
        success: true,
        semanticMemoryIds: ['sem-w0001b'],
        semanticMemoryCharSizes: { 'sem-w0001b': 4 },
        inputHash: stableHash(body.sessionIds),
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const sessions = [
      { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一' } },
      { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二' } },
    ];
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-split-resume-'));
    const statePath = path.join(stateDir, 'split-resume.json');
    const state = buildInitialState({
      runId: 'split-resume',
      baseUrl,
      now: '2026-07-05T00:00:00.000Z',
    });
    state.config.delay_ms = 0;
    state.config_hash = stableHash(state.config);
    state.inventory_hash = computeInventoryHash(sessions, '*');
    state.sessions = {
      s1: {
        session_id: 's1',
        started_at: '2026-01-01T00:00:00.000Z',
        summary: { status: 'succeeded', recorded_at: '2026-07-05T00:00:00.000Z', estimated_prompt_chars: 700 },
        lessons_extract: { status: 'succeeded', recorded_at: '2026-07-05T00:00:00.000Z' },
      },
      s2: {
        session_id: 's2',
        started_at: '2026-01-02T00:00:00.000Z',
        summary: { status: 'succeeded', recorded_at: '2026-07-05T00:00:00.000Z', estimated_prompt_chars: 700 },
        lessons_extract: { status: 'succeeded', recorded_at: '2026-07-05T00:00:00.000Z' },
      },
    };
    state.semantic_windows = {
      w0001: {
        window_id: 'w0001',
        status: 'split',
        source_session_ids: ['s1', 's2'],
        source_count: 2,
        input_hash: stableHash(['s1', 's2']),
        split_into: ['w0001a', 'w0001b'],
      },
      w0001a: {
        window_id: 'w0001a',
        status: 'succeeded',
        split_from: 'w0001',
        source_session_ids: ['s1'],
        source_count: 1,
        input_hash: stableHash(['s1']),
        semantic_memory_ids: ['sem-w0001a'],
        semantic_memory_char_sizes: { 'sem-w0001a': 4 },
      },
      w0001b: {
        window_id: 'w0001b',
        status: 'pending',
        split_from: 'w0001',
        source_session_ids: ['s2'],
        source_count: 1,
        input_hash: stableHash(['s2']),
      },
    };
    state.semantic_memory_char_sizes = { 'sem-w0001a': 4 };
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'split-resume',
      '--delay-ms',
      '0',
      '--resume',
    ])));

    assert.equal(captured.result, 0);
    const windowCalls = requests.filter((request) => request.method === 'POST' && request.url === '/agentmemory/semantic-rollup' && request.body.kind === 'window');
    assert.deepEqual(windowCalls.map((request) => request.body.windowId), ['w0001b']);
    const nextState = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(nextState.semantic_windows.w0001.status, 'split');
    assert.equal(nextState.semantic_windows.w0001a.status, 'succeeded');
    assert.equal(nextState.semantic_windows.w0001b.status, 'succeeded');
  });
});

test('resume of split semantic window does not rerun non-stale running child', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [
          { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一' } },
          { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二' } },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      throw new Error(`semantic-rollup should not run while child is running: ${body.kind}`);
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const sessions = [
      { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一' } },
      { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二' } },
    ];
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-split-running-resume-'));
    const statePath = path.join(stateDir, 'split-running-resume.json');
    const state = buildInitialState({
      runId: 'split-running-resume',
      baseUrl,
      now: '2026-07-05T00:00:00.000Z',
    });
    state.config.delay_ms = 0;
    state.config_hash = stableHash(state.config);
    state.inventory_hash = computeInventoryHash(sessions, '*');
    state.sessions = {
      s1: {
        session_id: 's1',
        started_at: '2026-01-01T00:00:00.000Z',
        summary: { status: 'succeeded', recorded_at: '2026-07-05T00:00:00.000Z', estimated_prompt_chars: 700 },
        lessons_extract: { status: 'succeeded', recorded_at: '2026-07-05T00:00:00.000Z' },
      },
      s2: {
        session_id: 's2',
        started_at: '2026-01-02T00:00:00.000Z',
        summary: { status: 'succeeded', recorded_at: '2026-07-05T00:00:00.000Z', estimated_prompt_chars: 700 },
        lessons_extract: { status: 'succeeded', recorded_at: '2026-07-05T00:00:00.000Z' },
      },
    };
    state.semantic_windows = {
      w0001: {
        window_id: 'w0001',
        status: 'split',
        source_session_ids: ['s1', 's2'],
        source_count: 2,
        input_hash: stableHash(['s1', 's2']),
        split_into: ['w0001a', 'w0001b'],
      },
      w0001a: {
        window_id: 'w0001a',
        status: 'succeeded',
        split_from: 'w0001',
        source_session_ids: ['s1'],
        source_count: 1,
        input_hash: stableHash(['s1']),
        semantic_memory_ids: ['sem-w0001a'],
        semantic_memory_char_sizes: { 'sem-w0001a': 4 },
      },
      w0001b: {
        window_id: 'w0001b',
        status: 'running',
        started_at: new Date().toISOString(),
        split_from: 'w0001',
        source_session_ids: ['s2'],
        source_count: 1,
        input_hash: stableHash(['s2']),
      },
    };
    state.semantic_memory_char_sizes = { 'sem-w0001a': 4 };
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'split-running-resume',
      '--delay-ms',
      '0',
      '--resume',
    ])));

    assert.equal(captured.result, 1);
    const windowCalls = requests.filter((request) => request.method === 'POST' && request.url === '/agentmemory/semantic-rollup' && request.body.kind === 'window');
    assert.deepEqual(windowCalls, []);
    const nextState = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(nextState.semantic_windows.w0001b.status, 'running');
    assert.equal(Object.prototype.hasOwnProperty.call(nextState, 'corpus_rollup'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(nextState, 'corpus_windows'), false);
  });
});

test('resume of nested split semantic window runs pending grandchild leaf', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [
          { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一' } },
          { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二' } },
          { id: 's3', startedAt: '2026-01-03T00:00:00.000Z', summary: { title: '三' } },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      assert.notEqual(body.kind, 'corpus');
      assert.equal(body.kind, 'window');
      assert.equal(body.windowId, 'w0001ab');
      assert.deepEqual(body.sessionIds, ['s2']);
      return {
        success: true,
        semanticMemoryIds: ['sem-w0001ab'],
        semanticMemoryCharSizes: { 'sem-w0001ab': 4 },
        inputHash: stableHash(body.sessionIds),
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const sessions = [
      { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', summary: { title: '一' } },
      { id: 's2', startedAt: '2026-01-02T00:00:00.000Z', summary: { title: '二' } },
      { id: 's3', startedAt: '2026-01-03T00:00:00.000Z', summary: { title: '三' } },
    ];
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-nested-split-resume-'));
    const statePath = path.join(stateDir, 'nested-split-resume.json');
    const state = buildInitialState({
      runId: 'nested-split-resume',
      baseUrl,
      now: '2026-07-05T00:00:00.000Z',
    });
    state.config.delay_ms = 0;
    state.config_hash = stableHash(state.config);
    state.inventory_hash = computeInventoryHash(sessions, '*');
    state.sessions = Object.fromEntries(sessions.map((session) => [session.id, {
      session_id: session.id,
      started_at: session.startedAt,
      summary: { status: 'succeeded', recorded_at: '2026-07-05T00:00:00.000Z', estimated_prompt_chars: 700 },
      lessons_extract: { status: 'succeeded', recorded_at: '2026-07-05T00:00:00.000Z' },
    }]));
    state.semantic_windows = {
      w0001: {
        window_id: 'w0001',
        status: 'split',
        source_session_ids: ['s1', 's2', 's3'],
        source_count: 3,
        input_hash: stableHash(['s1', 's2', 's3']),
        split_into: ['w0001a', 'w0001b'],
      },
      w0001a: {
        window_id: 'w0001a',
        status: 'split',
        split_from: 'w0001',
        source_session_ids: ['s1', 's2'],
        source_count: 2,
        input_hash: stableHash(['s1', 's2']),
        split_into: ['w0001aa', 'w0001ab'],
      },
      w0001aa: {
        window_id: 'w0001aa',
        status: 'succeeded',
        split_from: 'w0001a',
        source_session_ids: ['s1'],
        source_count: 1,
        input_hash: stableHash(['s1']),
        semantic_memory_ids: ['sem-w0001aa'],
        semantic_memory_char_sizes: { 'sem-w0001aa': 4 },
      },
      w0001ab: {
        window_id: 'w0001ab',
        status: 'pending',
        split_from: 'w0001a',
        source_session_ids: ['s2'],
        source_count: 1,
        input_hash: stableHash(['s2']),
      },
      w0001b: {
        window_id: 'w0001b',
        status: 'succeeded',
        split_from: 'w0001',
        source_session_ids: ['s3'],
        source_count: 1,
        input_hash: stableHash(['s3']),
        semantic_memory_ids: ['sem-w0001b'],
        semantic_memory_char_sizes: { 'sem-w0001b': 4 },
      },
    };
    state.semantic_memory_char_sizes = { 'sem-w0001aa': 4, 'sem-w0001b': 4 };
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'nested-split-resume',
      '--delay-ms',
      '0',
      '--resume',
    ])));

    assert.equal(captured.result, 0);
    const windowCalls = requests.filter((request) => request.method === 'POST' && request.url === '/agentmemory/semantic-rollup' && request.body.kind === 'window');
    assert.deepEqual(windowCalls.map((request) => request.body.windowId), ['w0001ab']);
    const nextState = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(nextState.semantic_windows.w0001.status, 'split');
    assert.equal(nextState.semantic_windows.w0001a.status, 'split');
    assert.equal(nextState.semantic_windows.w0001ab.status, 'succeeded');
  });
});

test('repeated semantic split preserves succeeded child with unchanged input', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      return {
        statusCode: 400,
        body: { success: false, error: 'input_too_large', promptChars: 28000, maxPromptChars: 24000 },
      };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-repeat-split-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: { session_id: 's1', summary: { status: 'succeeded', estimated_prompt_chars: 700 } },
        s2: { session_id: 's2', summary: { status: 'succeeded', estimated_prompt_chars: 700 } },
      },
      semantic_windows: {
        w0001: {
          window_id: 'w0001',
          status: 'running',
          source_session_ids: ['s1', 's2'],
          input_hash: stableHash(['s1', 's2']),
        },
        w0001a: {
          window_id: 'w0001a',
          status: 'succeeded',
          split_from: 'w0001',
          source_session_ids: ['s1'],
          input_hash: stableHash(['s1']),
          semantic_memory_ids: ['sem-existing'],
          semantic_memory_char_sizes: { 'sem-existing': 4 },
        },
      },
    };

    const result = await runSemanticWindow({
      state,
      statePath,
      baseUrl,
      secret: 'test-secret',
      window: state.semantic_windows.w0001,
    });

    assert.equal(result.status, 'retry_planned');
    assert.equal(state.semantic_windows.w0001.status, 'split');
    assert.equal(state.semantic_windows.w0001a.status, 'succeeded');
    assert.deepEqual(state.semantic_windows.w0001a.semantic_memory_ids, ['sem-existing']);
    assert.equal(state.semantic_windows.w0001b.status, 'pending');
  });
});

test('formal run returns 1 when acceptance_ready is false', async () => {
  let sessionsReadCount = 0;
  await withMockAgentMemory((method, url) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      sessionsReadCount += 1;
      return {
        sessions: [{
          id: 's1',
          startedAt: '2026-01-01T00:00:00.000Z',
          ...(sessionsReadCount > 1 ? { summary: { title: '摘要' } } : {}),
        }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      return {
        success: true,
        status: 'succeeded',
        completedChunks: 1,
        totalChunks: 1,
        skippedChunks: 0,
        summary: { title: '摘要' },
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lex1' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex1') {
      return { success: true, run: { id: 'lex1', status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      return { success: false, error: 'provider failed' };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-not-ready-'));
    const captured = await withSecret('test-secret', async () => captureConsole(() => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'not-ready',
      '--delay-ms',
      '0',
    ])));

    assert.equal(captured.result, 1);
    assert.ok(captured.errors.some((line) => line.includes('full extraction not acceptance ready')));
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'not-ready.json'), 'utf8'));
    assert.equal(state.coverage.acceptance_ready, false);
  });
});

test('lessons extract fails instead of guessing latest run when POST omits run id', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/runs')) {
      throw new Error('latest run fallback should not be called');
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-no-run-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: { status: 'pending', attempt_count: 0 },
        },
      },
    };

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'failed');
    assert.equal(state.sessions.s1.lessons_extract.error, 'lessons extract returned no run id');
    assert.equal(requests.some((request) => request.url.startsWith('/agentmemory/lessons/extract/runs')), false);
  });
});

test('failed lesson status is retried on resume instead of skipped', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lex-new' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex-new') {
      return { success: true, run: { id: 'lex-new', status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-retry-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: { status: 'failed', run_id: 'lex-old', attempt_count: 1 },
        },
      },
    };

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'succeeded');
    assert.equal(state.sessions.s1.lessons_extract.run_id, 'lex-new');
    assert.equal(state.sessions.s1.lessons_extract.attempt_count, 2);
    const extractRequest = requests.find((request) => request.method === 'POST' && request.url === '/agentmemory/lessons/extract');
    assert.ok(extractRequest);
    assert.equal(Object.hasOwn(extractRequest.body, 'model'), false);
  });
});

test('lesson CLI model reaches lessons extract request body', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lex-model' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex-model') {
      return { success: true, run: { id: 'lex-model', status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-model-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: { status: 'pending', attempt_count: 0 },
        },
      },
    };
    const options = parseArgs([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--lesson-model',
      'lesson-model',
    ]);

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1', options });

    assert.equal(result.status, 'succeeded');
    const extractRequest = requests.find((request) => request.method === 'POST' && request.url === '/agentmemory/lessons/extract');
    assert.ok(extractRequest);
    assert.equal(extractRequest.body.model, 'lesson-model');
  });
});

test('lesson run freshness rejects missing timestamps and old timestamps', () => {
  const attemptStartedAt = '2026-07-05T10:00:00.000Z';

  assert.equal(isRunFreshForAttempt({ id: 'lex-new', createdAt: attemptStartedAt }, attemptStartedAt, null), true);
  assert.equal(isRunFreshForAttempt({ id: 'lex-new', startedAt: '2026-07-05T10:00:01.000Z' }, attemptStartedAt, null), true);
  assert.equal(isRunFreshForAttempt({ id: 'lex-updated-only', updatedAt: '2026-07-05T10:00:01.000Z' }, attemptStartedAt, null), false);
  assert.equal(isRunFreshForAttempt({ id: 'lex-missing' }, attemptStartedAt, null), false);
  assert.equal(isRunFreshForAttempt({ id: 'lex-old', startedAt: '2026-07-05T09:59:00.000Z' }, attemptStartedAt, null), false);
  assert.equal(isRunFreshForAttempt({ id: 'lex-invalid', createdAt: 'not-a-date' }, attemptStartedAt, null), false);
  assert.equal(isRunFreshForAttempt({ id: 'lex-previous', createdAt: attemptStartedAt }, attemptStartedAt, 'lex-previous'), false);
});

test('lesson 504 reconciles a fresh server run successfully', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { statusCode: 504, body: { success: false, error: 'timeout' } };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/runs?sessionId=s1&limit=1') {
      return { success: true, runs: [{ id: 'lex-fresh', sessionId: 's1', createdAt: '2999-01-01T00:00:00.000Z' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex-fresh') {
      return { success: true, run: { id: 'lex-fresh', status: 'succeeded' }, chunks: [{ status: 'succeeded' }] };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-504-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: { status: 'pending', attempt_count: 0 },
        },
      },
    };

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'succeeded');
    assert.equal(state.sessions.s1.lessons_extract.run_id, 'lex-fresh');
  });
});

test('lesson 504 does not reconcile a latest run without timestamps', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { status_code: 504, body: { success: false, error: 'timeout' } };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/runs?sessionId=s1&limit=1') {
      return { success: true, runs: [{ id: 'lex-no-time', sessionId: 's1' }] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/run')) {
      throw new Error('run detail without timestamp should not be read');
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-504-no-time-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: { status: 'pending', attempt_count: 0 },
        },
      },
    };

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'failed');
    assert.match(state.sessions.s1.lessons_extract.error, /no fresh server run/);
  });
});

test('lesson 504 does not reconcile an old previous run', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { status_code: 504, body: { success: false, error: 'timeout' } };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/runs?sessionId=s1&limit=1') {
      return { success: true, runs: [{ id: 'lex-old', sessionId: 's1' }] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/run')) {
      throw new Error('old run detail should not be read');
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-504-old-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: { status: 'failed', run_id: 'lex-old', attempt_count: 1 },
        },
      },
    };

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'failed');
    assert.match(state.sessions.s1.lessons_extract.error, /no fresh server run/);
  });
});

test('lesson HTTP failure stores a compact error in state', async () => {
  const hugeError = `timeout ${'x'.repeat(5000)} tail-marker`;
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { status_code: 504, body: { success: false, error: hugeError } };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/runs?sessionId=s1&limit=1') {
      return { success: true, runs: [] };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-error-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: { status: 'pending', attempt_count: 0 },
        },
      },
    };

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'failed');
    assert.equal(state.sessions.s1.lessons_extract.error.length < 2100, true);
    assert.equal(state.sessions.s1.lessons_extract.error.includes('tail-marker'), false);
    assert.match(state.sessions.s1.lessons_extract.error, /\[truncated\]/);
  });
});

test('lesson reconciliation failure writes failed state instead of leaving running', async () => {
  const hugeError = `runs endpoint failed ${'x'.repeat(5000)} tail-marker`;
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { status_code: 504, body: { success: false, error: 'timeout' } };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/runs?sessionId=s1&limit=1') {
      return { status_code: 500, body: { success: false, error: hugeError } };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-reconcile-error-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: { status: 'pending', attempt_count: 0 },
        },
      },
    };

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'failed');
    assert.equal(state.sessions.s1.lessons_extract.status, 'failed');
    assert.equal(state.sessions.s1.lessons_extract.error.length < 2100, true);
    assert.equal(state.sessions.s1.lessons_extract.error.includes('tail-marker'), false);
    assert.match(state.sessions.s1.lessons_extract.error, /\[truncated\]/);
  });
});

test('pending lesson run is processed with limit only and polled by run id', async () => {
  let detailReads = 0;
  await withMockAgentMemory((method, url, body) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lex-pending' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex-pending') {
      detailReads += 1;
      return {
        success: true,
        run: { id: 'lex-pending', status: detailReads === 1 ? 'running' : 'succeeded' },
        chunks: [{ status: detailReads === 1 ? 'running' : 'succeeded' }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract/process') {
      assert.deepEqual(body, { limit: 1 });
      return { success: true };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-process-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: { status: 'pending', attempt_count: 0 },
        },
      },
    };

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'succeeded');
    assert.equal(detailReads, 2);
    const processRequest = requests.find((request) => request.url === '/agentmemory/lessons/extract/process');
    assert.deepEqual(processRequest.body, { limit: 1 });
    assert.equal(Object.prototype.hasOwnProperty.call(processRequest.body, 'runId'), false);
  });
});

test('resume reconciles existing running lesson run before creating a new run', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      throw new Error('resume should not create a new lesson run before reconciling existing run id');
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex-existing') {
      return {
        success: true,
        run: { id: 'lex-existing', status: 'succeeded' },
        chunks: [{ status: 'succeeded' }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-resume-existing-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: {
            status: 'running',
            run_id: 'lex-existing',
            attempt_count: 1,
            started_at: '2026-07-06T17:03:50.173Z',
          },
        },
      },
    };

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'succeeded');
    assert.equal(state.sessions.s1.lessons_extract.status, 'succeeded');
    assert.equal(state.sessions.s1.lessons_extract.run_id, 'lex-existing');
    assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/agentmemory/extraction-runs/record' && request.body.lessonRunId === 'lex-existing'));
    assert.equal(requests.some((request) => request.method === 'POST' && request.url === '/agentmemory/lessons/extract'), false);
  });
});

test('retryable lesson run with no lesson blocks is skipped after polling budget', async () => {
  await withMockAgentMemory((method, url, body) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lex-empty' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex-empty') {
      return {
        success: true,
        run: { id: 'lex-empty', status: 'retryable', lastError: 'No <lesson> blocks' },
        chunks: [],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract/process') {
      assert.deepEqual(body, { limit: 1 });
      return { success: true };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-empty-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: { status: 'pending', attempt_count: 0 },
        },
      },
    };

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'skipped');
    assert.equal(state.sessions.s1.lessons_extract.status, 'skipped');
    assert.equal(state.sessions.s1.lessons_extract.skipped_reason, 'No <lesson> blocks');
    assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/agentmemory/extraction-runs/record' && request.body.lessonRunId === 'lex-empty'));
  });
});

test('retryable lesson provider failure enters provider recovery without exhausting terminal polls', async () => {
  const sensitive = 'sensitive-runner-error-marker';
  let detailReads = 0;
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      return { success: true, runs: [{ id: 'lex-provider-retry' }] };
    }
    if (method === 'GET' && url === '/agentmemory/lessons/extract/run?runId=lex-provider-retry') {
      detailReads += 1;
      return {
        success: true,
        run: {
          id: 'lex-provider-retry',
          status: 'retryable',
          lastError: `pi_stream_failed ${sensitive}`,
          failureDiagnostics: {
            requestPhase: 'chunk',
            providerErrorCode: 'rate_limited',
            statusCode: 429,
            retryAfterMs: 2500,
            elapsedMs: 1200,
            inputChars: 38000,
            maxOutputTokens: 4096,
            responseStarted: false,
            rawError: sensitive,
            authorization: sensitive,
          },
        },
        chunks: [],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract/process') {
      throw new Error('known provider failure must not be hot-polled');
    }
    const fullResponse = defaultFullEndpointResponse(method, url);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-provider-retry-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: {},
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'succeeded' },
          lessons_extract: { status: 'pending', attempt_count: 0 },
        },
      },
    };

    const result = await runLessonsForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.deepEqual(result.failure, {
      class: 'transient_provider',
      cause: 'rate_limited',
      diagnostics: {
        requestPhase: 'chunk',
        providerErrorCode: 'rate_limited',
        statusCode: 429,
        retryAfterMs: 2500,
        elapsedMs: 1200,
        inputChars: 38000,
        maxOutputTokens: 4096,
        responseStarted: false,
      },
    });
    assert.equal(detailReads, 1);
    assert.equal(state.sessions.s1.lessons_extract.status, 'failed');
    assert.equal(state.sessions.s1.lessons_extract.failure_class, 'transient_provider');
    assert.equal(state.sessions.s1.lessons_extract.failure_cause, 'rate_limited');
    assert.equal(state.sessions.s1.lessons_extract.error, 'rate_limited');
    assert.deepEqual(state.sessions.s1.lessons_extract.failure_diagnostics, result.failure.diagnostics);
    assert.equal(JSON.stringify(state).includes(sensitive), false);
  });
});

test('retryable lesson unit failures stop after one detail read without process polling', async (t) => {
  for (const cause of [
    'lesson_parse_failed',
    'lesson_validation_failed',
    'lesson_persist_failed',
    'empty_response',
  ]) {
    await t.test(cause, async () => {
      let detailReads = 0;
      let processCalls = 0;
      await withMockAgentMemory((method, url) => {
        if (method === 'POST' && url === '/agentmemory/lessons/extract') {
          return { success: true, runs: [{ id: `lex-${cause}` }] };
        }
        if (method === 'GET' && url === `/agentmemory/lessons/extract/run?runId=lex-${cause}`) {
          detailReads += 1;
          return {
            success: true,
            run: { id: `lex-${cause}`, status: 'retryable', lastError: cause },
            chunks: [],
          };
        }
        if (method === 'POST' && url === '/agentmemory/lessons/extract/process') {
          processCalls += 1;
          return { success: true };
        }
        const fullResponse = defaultFullEndpointResponse(method, url);
        if (fullResponse) return fullResponse;
        return { success: false, error: `unexpected ${method} ${url}` };
      }, async (baseUrl) => {
        const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `agentmemory-lesson-${cause}-`));
        const statePath = path.join(stateDir, 'state.json');
        const state = {
          run_id: 'run-1',
          mark: 'full',
          config: {},
          sessions: {
            s1: {
              session_id: 's1',
              summary: { status: 'succeeded' },
              lessons_extract: { status: 'pending', attempt_count: 0 },
            },
          },
        };

        const result = await runLessonsForSession({
          state,
          statePath,
          baseUrl,
          secret: 'test-secret',
          sessionId: 's1',
        });

        assert.deepEqual(result.failure, { class: 'unit', cause });
        assert.equal(detailReads, 1);
        assert.equal(processCalls, 0);
      });
    });
  }
});

test('retryable lesson classification falls back to lastError only for legacy runs', () => {
  assert.deepEqual(classifyRetryableLessonRun({
    run: {
      status: 'retryable',
      lastError: 'lesson_parse_failed; pi_stream_failed',
      failureDiagnostics: {
        requestPhase: 'chunk',
        providerErrorCode: 'timeout',
        elapsedMs: 25,
        inputChars: 500,
        maxOutputTokens: 4096,
        responseStarted: false,
      },
    },
  }), {
    class: 'transient_provider',
    cause: 'timeout',
    diagnostics: {
      requestPhase: 'chunk',
      providerErrorCode: 'timeout',
      elapsedMs: 25,
      inputChars: 500,
      maxOutputTokens: 4096,
      responseStarted: false,
    },
  });
  assert.deepEqual(classifyRetryableLessonRun({
    run: {
      status: 'retryable',
      lastError: 'circuit_breaker_open',
    },
  }), { class: 'transient_provider', cause: 'circuit_breaker_open' });
  assert.equal(classifyRetryableLessonRun({
    run: {
      status: 'retryable',
      lastError: 'circuit_breaker_open',
      failureDiagnostics: { providerErrorCode: 'unknown' },
    },
  }), null);
});

test('summary resumable advances in_progress one work unit per call until succeeded', async () => {
  let advanceCalls = 0;
  await withMockAgentMemory((method, url, body) => {
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      advanceCalls += 1;
      assert.deepEqual(body, { sessionId: 's1' });
      if (advanceCalls < 3) {
        return {
          success: true,
          status: 'in_progress',
          advanced: 'completed',
          completedChunks: advanceCalls,
          totalChunks: 3,
          skippedChunks: 0,
        };
      }
      return {
        success: true,
        status: 'succeeded',
        completedChunks: 3,
        totalChunks: 3,
        skippedChunks: 0,
        summary: { title: '多步摘要', narrative: '正文不应进入状态' },
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-multistep-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: { agent_id: '*', delay_ms: 0 },
      sessions: {
        s1: { session_id: 's1', summary: { status: 'pending', attempt_count: 0 } },
      },
    };

    const first = await runSummaryForSession({
      state,
      statePath,
      baseUrl,
      secret: 'test-secret',
      sessionId: 's1',
      options: { delayMs: 0, requestTimeoutMs: 1000 },
    });
    assert.equal(first.status, 'in_progress');
    assert.equal(first.advanced, 'completed');
    assert.equal(advanceCalls, 1);
    const second = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1', options: { delayMs: 0, requestTimeoutMs: 1000 } });
    assert.equal(second.status, 'in_progress');
    assert.equal(advanceCalls, 2);
    const result = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1', options: { delayMs: 0, requestTimeoutMs: 1000 } });

    assert.equal(result.status, 'succeeded');
    assert.equal(advanceCalls, 3);
    assert.equal(state.sessions.s1.summary.status, 'succeeded');
    assert.equal(state.sessions.s1.summary.completed_chunks, 3);
    assert.equal(state.sessions.s1.summary.total_chunks, 3);
    assert.equal(state.sessions.s1.summary.summary_title, '多步摘要');
    assert.equal(JSON.stringify(state.sessions.s1.summary).includes('正文不应进入状态'), false);
  });
});

test('summary resumable succeeds from response summary without reading lagging sessions', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      return {
        success: true,
        status: 'succeeded',
        completedChunks: 1,
        totalChunks: 1,
        skippedChunks: 0,
        summary: { title: '直接摘要', narrative: '安全元数据以外不落盘' },
      };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return { sessions: [{ id: 's1' }] };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-direct-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: { agent_id: '*' },
      sessions: {
        s1: { session_id: 's1', summary: { status: 'pending', attempt_count: 0 } },
      },
    };

    const result = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'succeeded');
    assert.equal(state.sessions.s1.summary.summary_title, '直接摘要');
    assert.equal(requests.some((request) => request.method === 'GET' && request.url.startsWith('/agentmemory/sessions')), false);
    const persisted = await fs.readFile(statePath, 'utf8');
    assert.equal(persisted.includes('安全元数据以外不落盘'), false);
    assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/agentmemory/extraction-runs/record'));
  });
});

test('summary resumable polls sessions only when succeeded response has no usable summary', async () => {
  let sessionReads = 0;
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      return {
        success: true,
        status: 'succeeded',
        completedChunks: 2,
        totalChunks: 2,
        skippedChunks: 0,
      };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      sessionReads += 1;
      return {
        sessions: [{
          id: 's1',
          ...(sessionReads >= 3 ? { summary: { title: '延迟可见摘要' } } : {}),
        }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') {
      return { success: true };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-poll-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: { agent_id: '*', delay_ms: 0 },
      sessions: {
        s1: { session_id: 's1', summary: { status: 'pending', attempt_count: 0 } },
      },
    };

    const result = await runSummaryForSession({
      state,
      statePath,
      baseUrl,
      secret: 'test-secret',
      sessionId: 's1',
      options: { delayMs: 0 },
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(sessionReads, 3);
    assert.equal(state.sessions.s1.summary.summary_title, '延迟可见摘要');
  });
});

test('summary resumable skips an already succeeded summary on resume', async () => {
  await withMockAgentMemory((method, url) => {
    throw new Error(`already succeeded summary should not call ${method} ${url}`);
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-skip-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: { agent_id: '*' },
      sessions: {
        s1: {
          session_id: 's1',
          summary: {
            status: 'succeeded',
            attempt_count: 2,
            recorded_at: '2026-07-10T00:00:00.000Z',
            summary_title: '已完成',
          },
        },
      },
    };

    const result = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'succeeded');
    assert.equal(state.sessions.s1.summary.attempt_count, 2);
    assert.equal(requests.length, 0);
  });
});

test('summary resumable non-2xx response is stored as failed without polling sessions', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      return { statusCode: 503, body: { success: false, error: 'worker temporarily unavailable' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      throw new Error('non-2xx response should not poll sessions');
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-http-error-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: { agent_id: '*' },
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'pending', attempt_count: 0 },
        },
      },
    };

    const result = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'failed');
    assert.equal(state.sessions.s1.summary.status, 'failed');
    assert.match(state.sessions.s1.summary.error, /worker temporarily unavailable/);
    assert.equal(requests.some((request) => request.method === 'GET' && request.url.startsWith('/agentmemory/sessions')), false);
  });
});

test('summary resumable failed status stores a compact redacted error in state', async () => {
  const hugeError = `provider failed token=super-secret-value ${'x'.repeat(5000)} tail-marker`;
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      return {
        success: true,
        status: 'failed',
        completedChunks: 2,
        totalChunks: 4,
        skippedChunks: 0,
        error: hugeError,
      };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-error-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: { agent_id: '*' },
      sessions: {
        s1: {
          session_id: 's1',
          summary: { status: 'pending', attempt_count: 0 },
        },
      },
    };

    const result = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'failed');
    assert.equal(state.sessions.s1.summary.error.length < 2100, true);
    assert.equal(state.sessions.s1.summary.error.includes('tail-marker'), false);
    assert.equal(state.sessions.s1.summary.error.includes('super-secret-value'), false);
    assert.match(state.sessions.s1.summary.error, /provider failed/);
    assert.match(state.sessions.s1.summary.error, /\[truncated\]/);
  });
});

test('summary state persists only the service sanitized failure cause', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      return {
        success: false,
        status: 'failed',
        completedChunks: 0,
        totalChunks: 1,
        skippedChunks: 1,
        error: 'too_many_chunks_skipped: 1/1 chunks unavailable after retry; failure_cause=pi_stream_failed',
        failureCause: 'pi_stream_failed',
        failure: {
          class: 'transient_provider',
          cause: 'pi_stream_failed',
          diagnostics: {
            requestPhase: 'chunk',
            providerErrorCode: 'timeout',
            elapsedMs: 25,
            inputChars: 500,
            maxOutputTokens: 4096,
            responseStarted: true,
            responseModel: 'current-model',
            stopReason: 'error',
            prompt: 'prompt-marker',
            rawError: 'raw-error-marker',
            headers: { authorization: 'credential-marker' },
            token: 'token-marker',
          },
        },
      };
    }
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-failure-cause-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: { agent_id: '*' },
      sessions: {
        s1: {
          session_id: 's1',
          summary: {
            status: 'pending',
            attempt_count: 0,
            failure_diagnostics: {
              requestPhase: 'reduce',
              providerErrorCode: 'server_error',
              elapsedMs: 99,
              inputChars: 1,
              maxOutputTokens: 1,
              responseStarted: false,
            },
          },
        },
      },
    };

    const result = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'failed');
    assert.equal(state.sessions.s1.summary.failure_cause, 'pi_stream_failed');
    assert.deepEqual(state.sessions.s1.summary.failure_diagnostics, {
      requestPhase: 'chunk',
      providerErrorCode: 'timeout',
      elapsedMs: 25,
      inputChars: 500,
      maxOutputTokens: 4096,
      responseStarted: true,
      responseModel: 'current-model',
      stopReason: 'error',
    });
    assert.match(state.sessions.s1.summary.error, /^too_many_chunks_skipped:/);
    const serialized = JSON.stringify(state.sessions.s1.summary);
    for (const marker of ['prompt-marker', 'raw-error-marker', 'credential-marker', 'token-marker']) {
      assert.equal(serialized.includes(marker), false);
    }
  });
});

test('successful summary clears stale error and failure cause', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      return {
        success: true,
        status: 'succeeded',
        completedChunks: 1,
        totalChunks: 1,
        skippedChunks: 0,
        summary: { title: 'recovered summary' },
      };
    }
    if (method === 'POST' && url === '/agentmemory/extraction-runs/record') return { success: true };
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-clear-error-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: { agent_id: '*' },
      sessions: {
        s1: {
          session_id: 's1',
          summary: {
            status: 'failed',
            attempt_count: 1,
            error: 'too_many_chunks_skipped: previous failure',
            failure_class: 'transient_provider',
            failure_cause: 'circuit_breaker_open',
            failure_diagnostics: {
              requestPhase: 'chunk',
              providerErrorCode: 'timeout',
              elapsedMs: 1,
              inputChars: 1,
              maxOutputTokens: 1,
              responseStarted: false,
            },
          },
        },
      },
    };

    const result = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'succeeded');
    assert.equal(Object.hasOwn(state.sessions.s1.summary, 'error'), false);
    assert.equal(Object.hasOwn(state.sessions.s1.summary, 'failure_class'), false);
    assert.equal(Object.hasOwn(state.sessions.s1.summary, 'failure_cause'), false);
    assert.equal(Object.hasOwn(state.sessions.s1.summary, 'failure_diagnostics'), false);
  });
});

test('resume cleanup removes stale failure metadata from an already succeeded summary', async () => {
  await withMockAgentMemory((method, url) => {
    throw new Error(`already succeeded summary should not call ${method} ${url}`);
  }, async (baseUrl) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-summary-resume-clear-error-'));
    const statePath = path.join(stateDir, 'state.json');
    const state = {
      run_id: 'run-1',
      mark: 'full',
      config: { agent_id: '*' },
      sessions: {
        s1: {
          session_id: 's1',
          summary: {
            status: 'succeeded',
            attempt_count: 2,
            recorded_at: '2026-07-10T00:00:00.000Z',
            summary_title: 'completed',
            error: 'stale error',
            failure_class: 'transient_provider',
            failure_cause: 'pi_stream_failed',
            failure_diagnostics: {
              requestPhase: 'reduce',
              providerErrorCode: 'server_error',
              elapsedMs: 1,
              inputChars: 1,
              maxOutputTokens: 1,
              responseStarted: false,
            },
          },
        },
      },
    };

    const result = await runSummaryForSession({ state, statePath, baseUrl, secret: 'test-secret', sessionId: 's1' });

    assert.equal(result.status, 'succeeded');
    assert.equal(Object.hasOwn(state.sessions.s1.summary, 'error'), false);
    assert.equal(Object.hasOwn(state.sessions.s1.summary, 'failure_class'), false);
    assert.equal(Object.hasOwn(state.sessions.s1.summary, 'failure_cause'), false);
    assert.equal(Object.hasOwn(state.sessions.s1.summary, 'failure_diagnostics'), false);
    const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(Object.hasOwn(persisted.sessions.s1.summary, 'error'), false);
    assert.equal(Object.hasOwn(persisted.sessions.s1.summary, 'failure_class'), false);
    assert.equal(Object.hasOwn(persisted.sessions.s1.summary, 'failure_diagnostics'), false);
  });
});

test('legacy consecutive-failure threshold is a no-op and unresolved summary failures trip the stage barrier', async () => {
  await withMockAgentMemory((method, url) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, summarizeChunkSize: 400, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [
          { id: 's1', startedAt: '2026-01-01T00:00:00.000Z' },
          { id: 's2', startedAt: '2026-01-02T00:00:00.000Z' },
          { id: 's3', startedAt: '2026-01-03T00:00:00.000Z' },
        ],
      };
    }
    if (method === 'POST' && url === '/agentmemory/summarize/resumable') {
      return {
        success: true,
        status: 'failed',
        completedChunks: 0,
        totalChunks: 1,
        skippedChunks: 0,
        error: 'provider_key=secret-value failed',
      };
    }
    const fullResponse = defaultFullEndpointResponse(method, url, typeof body === 'undefined' ? null : body);
    if (fullResponse) return fullResponse;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-full-fail-stop-'));
    const result = await withSecret('test-secret', () => mainForTest([
      '--base-url',
      baseUrl,
      '--state-dir',
      stateDir,
      '--run-id',
      'fail-stop',
      '--stop-after-consecutive-failures',
      '2',
      '--delay-ms',
      '0',
    ]));
    assert.equal(result, 1);
    const summarizeCalls = requests.filter((request) => request.method === 'POST' && request.url === '/agentmemory/summarize/resumable');
    assert.equal(summarizeCalls.length, 9);
    assert.equal(requests.some((request) => request.url === '/agentmemory/lessons/extract'), false);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'fail-stop.json'), 'utf8'));
    assert.equal(state.config.stop_after_consecutive_failures, 2);
    assert.match(state.health.last_error, /summary 阶段存在未解决失败/);
    assert.equal(JSON.stringify(state).includes('secret-value'), false);
  });
});

test('an isolated lesson unit does not block semantic work but acceptance remains strict', async () => {
  let lessonStarts = 0;
  await withMockAgentMemory((method, url, body) => {
    if (method === 'GET' && url === '/agentmemory/runtime-config') {
      return { success: true, runtime: { summarizeChunkConcurrency: 1, providerName: 'test' } };
    }
    if (method === 'GET' && url === '/agentmemory/sessions?agentId=*') {
      return {
        sessions: [{
          id: 's1',
          status: 'completed',
          startedAt: '2026-01-01T00:00:00.000Z',
          summary: { title: 'existing summary' },
        }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/lessons/extract') {
      lessonStarts += 1;
      return { success: true, runs: [{ id: `lesson-unit-${lessonStarts}` }] };
    }
    if (method === 'GET' && url.startsWith('/agentmemory/lessons/extract/run?runId=lesson-unit-')) {
      return {
        success: true,
        run: {
          id: new URL(url, 'http://local').searchParams.get('runId'),
          status: 'retryable',
          lastError: 'lesson_missing_root',
          failureDiagnostics: {
            requestPhase: 'chunk',
            parseErrorCode: 'lesson_missing_root',
            chunkIndex: 0,
            attempt: 2,
            responseChars: 42,
          },
        },
        chunks: [{ status: 'retryable', parseFailures: 2 }],
      };
    }
    if (method === 'POST' && url === '/agentmemory/semantic-rollup') {
      return {
        success: true,
        semanticMemoryIds: ['semantic-after-lesson-failure'],
        semanticMemoryCharSizes: { 'semantic-after-lesson-failure': 12 },
      };
    }
    const response = defaultFullEndpointResponse(method, url, body);
    if (response) return response;
    return { success: false, error: `unexpected ${method} ${url}` };
  }, async (baseUrl, requests) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-lesson-unit-isolation-'));
    const captured = await withSecret('test-secret', () => captureConsole(() => mainForTest([
      '--base-url', baseUrl,
      '--state-dir', stateDir,
      '--run-id', 'lesson-unit-isolation',
      '--delay-ms', '0',
    ])));

    assert.equal(captured.result, 1);
    assert.equal(lessonStarts, 3);
    assert.equal(
      requests.some((request) => request.method === 'POST' && request.url === '/agentmemory/semantic-rollup'),
      true,
    );
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'lesson-unit-isolation.json'), 'utf8'));
    assert.equal(state.coverage.lessons.failed, 1);
    assert.equal(state.coverage.semantic_windows.succeeded, 1);
    assert.equal(state.coverage.acceptance_ready, false);
    assert.deepEqual(state.sessions.s1.lessons_extract.failure_diagnostics, {
      requestPhase: 'chunk',
      parseErrorCode: 'lesson_missing_root',
      chunkIndex: 0,
      attempt: 2,
      responseChars: 42,
    });
  });
});

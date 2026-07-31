import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  runSinglePhaseStage,
  runTwoPhaseStage,
  validateSinglePhaseStage,
  validateTwoPhaseStage,
} from './recoverable-stage-v2.mjs';
import { buildRecoveryMigrationManifest } from './recovery-frontier-migration-v1.mjs';
import { reduceRecoveryJournal } from './recovery-journal-reducer-v1.mjs';
import { RECOVERY_POLICY_VERSION } from './recovery-policy-v1.mjs';

function makeHarness() {
  const events = [];
  const occurrences = new Map();
  let failAfterBoundary = null;
  return {
    events,
    failAfter(boundary) {
      failAfterBoundary = boundary;
    },
    async append(type, payload) {
      const event = { seq: events.length, type, payload };
      events.push(event);
      const occurrence = (occurrences.get(type) ?? 0) + 1;
      occurrences.set(type, occurrence);
      if (
        failAfterBoundary === type
        || failAfterBoundary === `${type}#${occurrence}`
      ) {
        failAfterBoundary = null;
        throw new Error(`crash_after_${type}`);
      }
      return event;
    },
  };
}

function makeExecutionBoundary(limit) {
  let remaining = limit;
  let processed = 0;
  let last = null;
  return {
    claim({ stage, unitId }) {
      if (remaining <= 0) return false;
      remaining -= 1;
      processed += 1;
      last = { stage, unitId };
      return true;
    },
    reached: () => processed > 0 && remaining === 0,
    processedCount: () => processed,
    lastUnitId: () => last?.unitId || null,
  };
}

const plan = [{ unit_id: 'unit-1', input_hash: 'input-1' }];

function legacyLessonNoBlocksEvidence(unitId) {
  const attemptId = `${unitId}-attempt`;
  const receiptKey = `xop_${createHash('sha256')
    .update(JSON.stringify([attemptId, 'lessons', unitId]))
    .digest('hex')
    .slice(0, 32)}`;
  return {
    adapter: 'lessons/legacy-safe-facts-v1',
    attempt_id: attemptId,
    operation_id: `${unitId}:legacy`,
    safe_facts: {
      failure: { cause: 'lesson_no_blocks' },
      expectedLessonRunId: `${unitId}-run`,
      expectedRunInputHash: 'a'.repeat(64),
      expectedReceiptInputHash: 'c'.repeat(64),
      expectedConfigHash: 'b'.repeat(64),
      lessonRun: {
        id: `${unitId}-run`,
        sessionId: unitId,
        status: 'failed',
        inputHash: 'a'.repeat(64),
        configHash: 'b'.repeat(64),
        createdLessonIds: [],
        replacedLessonIds: [],
        finishedAt: '2026-07-30T00:00:00.000Z',
      },
      receipt: {
        key: receiptKey,
        runId: attemptId,
        unitId,
        stage: 'lessons',
        inputHash: 'c'.repeat(64),
        status: 'failed',
        failure: { class: 'unit', cause: 'lesson_no_blocks' },
      },
      lessonChunks: [],
      formalLessonWrites: [],
      collection: {
        schema: 'legacy-lesson-safe-facts-collection/v1',
        snapshot_hash: 'd'.repeat(64),
        state_tree_hash: 'f'.repeat(64),
        engine_hash: 'e'.repeat(64),
        journal_input_summary_hash: '1'.repeat(64),
        scope_proofs: [
          `mem:extraction-operation-receipt:${receiptKey}`,
          'mem:extraction-operation-receipts',
          'mem:lesson-extraction:runs',
          `mem:lesson-extraction:chunks:${unitId}-run`,
          'mem:lessons',
          `mem:lesson-commit:receipts:${unitId}-run`,
        ].map((scope) => ({
          scope,
          exact_count: 0,
          safe_projection_hash: '2'.repeat(64),
        })),
      },
    },
  };
}

function completeMigrationEvents(events, manifest) {
  return [
    ...events,
    {
      seq: manifest.fence_seq,
      type: 'stage_recovery_contract_fenced',
      payload: manifest,
    },
    ...manifest.steps.map((step) => ({
      seq: step.expected_seq + 1,
      type: step.type,
      payload: step.payload,
    })),
  ];
}

function reconciliationBinding({
  attemptId,
  stage = 'summary',
  unitId = 'unit-1',
  inputHash = 'd'.repeat(64),
  marker = '1',
}) {
  return {
    receipt_key: `xop_${marker.repeat(32)}`,
    receipt_run_id: attemptId,
    receipt_stage: stage,
    receipt_unit_id: unitId,
    receipt_input_hash: inputHash,
    receipt_started_at: '2026-07-30T00:00:00.000Z',
  };
}

function noEffectRecovery({
  attemptsUsed,
  maxAttempts,
  notBefore,
}) {
  const retryAvailable = attemptsUsed < maxAttempts;
  return {
    policyVersion: 'effect-state-recovery/v1',
    evidence: {
      kind: 'no_effect',
      observation: 'execution_error',
      reasonCode: 'provider_unavailable',
      ...(notBefore ? { retryHint: { notBefore } } : {}),
      proof: {
        kind: 'request_not_dispatched',
        attemptId: 'attempt-proof',
        journalSeq: 0,
      },
    },
    decision: {
      policyVersion: 'effect-state-recovery/v1',
      action: retryAvailable ? 'retry' : 'isolate',
      reasonCode: 'provider_unavailable',
      ...(retryAvailable && notBefore ? { notBefore } : {}),
    },
    budget: { attemptsUsed, maxAttempts },
  };
}

function committedVerificationCandidate(label = 'verified') {
  const receiptKey = `receipt-${label}`;
  const resultRef = `results:${label}`;
  const effectHash = 'e'.repeat(64);
  return {
    recoveryCandidate: {
      candidateEvidence: {
        kind: 'committed',
        receiptKey,
        receiptVersion: 1,
        resultRef,
        effectHash,
      },
      snapshot: {
        receipt: {
          key: receiptKey,
          version: 1,
          resultRef,
          effectHash,
          status: 'succeeded',
        },
      },
      effectVerification: 'all_applied',
    },
  };
}

function authorizedBlockedEvents(reconciliationOperationId = 'unit-1:reduce') {
  const attemptId = 'a'.repeat(64);
  const runnerInputHash = 'b'.repeat(64);
  return [
    { seq: 0, type: 'unit_planned', payload: { unit_id: 'unit-1', input_hash: runnerInputHash } },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    { seq: 2, type: 'unit_started', payload: { unit_id: 'unit-1', attempt_id: attemptId } },
    {
      seq: 3,
      type: 'unit_operation_started',
      payload: { unit_id: 'unit-1', attempt_id: attemptId, operation_id: 'unit-1:reduce' },
    },
    {
      seq: 4,
      type: 'unit_operation_completed',
      payload: {
        unit_id: 'unit-1',
        attempt_id: attemptId,
        operation_id: 'unit-1:reduce',
        status: 'failed',
        error: 'pi_stream_failed',
        terminal_result: { status: 'failed', payload: { error: 'pi_stream_failed' } },
      },
    },
    {
      seq: 5,
      type: 'unit_terminal',
      payload: {
        unit_id: 'unit-1',
        attempt_id: attemptId,
        status: 'failed',
        error: 'pi_stream_failed',
      },
    },
    {
      seq: 6,
      type: 'unit_summary_failed_terminal_retry_authorized',
      payload: {
        stage: 'summary',
        unit_id: 'unit-1',
        attempt_id: attemptId,
        operation_id: 'unit-1:reduce',
        runner_input_hash: runnerInputHash,
        receipt_input_hash: 'c'.repeat(64),
        receipt_status: 'failed',
        failure_class: 'transient_provider',
        failure_cause: 'pi_stream_failed',
        failure_phase: 'provider_call',
        retry_epoch: 0,
        last_safe_failure: {
          error_class: 'transient_provider',
          cause: 'pi_stream_failed',
          phase: 'provider_call',
          timestamp: '2026-07-28T00:00:00.000Z',
        },
        superseded_operation_seq: 4,
        superseded_terminal_seq: 5,
        expected_journal_seq: 5,
      },
    },
    {
      seq: 7,
      type: 'unit_operation_started',
      payload: { unit_id: 'unit-1', attempt_id: attemptId, operation_id: 'unit-1:reduce' },
    },
    {
      seq: 8,
      type: 'unit_blocked',
      payload: {
        unit_id: 'unit-1',
        attempt_id: attemptId,
        reason: 'extraction_operation_reconciliation_required',
      },
    },
    {
      seq: 9,
      type: 'unit_reconciliation_resolved',
      payload: {
        unit_id: 'unit-1',
        attempt_id: attemptId,
        operation_id: reconciliationOperationId,
        reconciliation_id: 'xrec_0123456789abcdef0123456789abcdef',
        receipt_input_hash: 'c'.repeat(64),
        receipt_started_at: '2026-07-28T00:00:01.000Z',
        receipt_status: 'reconciled',
        result_status: 'absent',
        cause: 'orphaned_operation_result_absent',
      },
    },
  ];
}

test('single-phase recovery reuses one attempt and only repeats idempotent boundaries', async () => {
  const harness = makeHarness();
  const executeAttempts = [];
  const executeRecovery = [];
  const recordAttempts = [];
  let loseExecuteResponse = true;
  let loseRecordResponse = true;
  const invoke = () => runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'attempt-1',
    verifyRecoveredTerminal: async () => committedVerificationCandidate('single-reuse'),
    execute: async ({
      attemptId,
      recovered,
      activeOperation,
      startOperation,
      completeOperation,
    }) => {
      executeAttempts.push(attemptId);
      executeRecovery.push(recovered);
      const operation = activeOperation
        || await startOperation({ operationId: 'unit-1:execute' });
      if (loseExecuteResponse) {
        loseExecuteResponse = false;
        throw new Error('execute_response_lost');
      }
      const terminalResult = {
        status: 'succeeded',
        payload: { result_id: 'result-1' },
      };
      await completeOperation({
        operationId: operation.operation_id,
        status: 'succeeded',
        terminal_result: terminalResult,
      });
      return terminalResult;
    },
    record: async ({ attemptId }) => {
      recordAttempts.push(attemptId);
      if (loseRecordResponse) {
        loseRecordResponse = false;
        throw new Error('record_response_lost');
      }
    },
  });

  await assert.rejects(invoke, /execute_response_lost/);
  harness.failAfter('unit_terminal');
  await assert.rejects(invoke, /crash_after_unit_terminal/);
  await assert.rejects(invoke, /record_response_lost/);
  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 1 });
  assert.deepEqual(executeAttempts, ['attempt-1', 'attempt-1']);
  assert.deepEqual(executeRecovery, [false, true]);
  assert.deepEqual(recordAttempts, ['attempt-1', 'attempt-1']);
  assert.deepEqual(harness.events.map((event) => event.type), [
    'unit_planned',
    'stage_plan_completed',
    'unit_started',
    'unit_operation_started',
    'unit_operation_completed',
    'unit_terminal',
    'unit_outcome_observed',
    'unit_recorded',
    'stage_completed',
  ]);
});

test('single-phase reconciliation wait is durable and never becomes a failed terminal', async () => {
  const harness = makeHarness();
  let calls = 0;
  const invoke = (execute) => runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'attempt-blocked',
    execute,
    record: async () => assert.fail('blocked unit must not be recorded'),
  });

  assert.equal((await invoke(async () => {
    calls += 1;
    return { status: 'blocked', reason: 'extraction_operation_reconciliation_required' };
  })).status, 'pending');
  assert.equal((await invoke(async () => assert.fail('blocked unit must not redispatch'))).status, 'pending');
  assert.equal(calls, 1);
  assert.equal(harness.events.some((event) => event.type === 'unit_terminal'), false);
  assert.equal(harness.events.at(-1).type, 'unit_blocked');
});

test('single-phase generic run blocks are durable and never redispatch', async () => {
  const harness = makeHarness();
  let calls = 0;
  const recovery = {
    policyVersion: 'effect-state-recovery/v1',
    evidence: { kind: 'system_fault', code: 'receipt_integrity_error' },
    decision: {
      policyVersion: 'effect-state-recovery/v1',
      action: 'block_run',
      code: 'receipt_integrity_error',
    },
    budget: { attemptsUsed: 0, maxAttempts: 0 },
  };
  const invoke = (execute) => runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'attempt-run-blocked',
    execute,
    record: async () => assert.fail('blocked run must not be recorded'),
  });

  assert.equal((await invoke(async ({ startOperation }) => {
    calls += 1;
    await startOperation({ operationId: 'unit-1:system-check' });
    return { status: 'blocked', recovery };
  })).status, 'blocked');
  assert.equal((await invoke(async () => assert.fail('blocked run must not redispatch'))).status, 'blocked');
  assert.equal(calls, 1);
  assert.equal(harness.events.at(-1).type, 'run_blocked');
});

test('single-phase kernel normalizes adapter facts before journaling a decision', async () => {
  const harness = makeHarness();
  const result = await runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'attempt-kernel-resolution',
    execute: async ({ startOperation, resolveOutcome }) => {
      await startOperation({ operationId: 'unit-1:summary' });
      const recovery = await resolveOutcome({
        operationId: 'unit-1:summary',
        candidateEvidence: {
          kind: 'no_effect',
          observation: 'execution_error',
          reasonCode: 'provider_unavailable',
          proof: {
            kind: 'request_not_dispatched',
            attemptId: 'attempt-kernel-resolution',
            journalSeq: 3,
          },
        },
        snapshot: {
          requestDispatch: {
            state: 'dispatched',
            persisted: true,
            attemptId: 'attempt-kernel-resolution',
            journalSeq: 3,
          },
        },
      });
      return {
        status: 'pending',
        recovery,
        reconciliationBinding: reconciliationBinding({
          attemptId: 'attempt-kernel-resolution',
        }),
      };
    },
    record: async () => assert.fail('reconciling unit must not be recorded'),
  });

  assert.equal(result.status, 'pending');
  const outcome = harness.events.find((event) => event.type === 'unit_outcome_observed');
  assert.equal(outcome.payload.evidence.kind, 'unknown');
  assert.equal(outcome.payload.decision.action, 'reconcile');
  assert.match(outcome.payload.policy_hash, /^[0-9a-f]{64}$/);
  assert.match(outcome.payload.normalization.candidate_evidence_hash, /^[0-9a-f]{64}$/);
  assert.match(outcome.payload.normalization.snapshot_hash, /^[0-9a-f]{64}$/);
  assert.match(outcome.payload.normalization.normalized_evidence_hash, /^[0-9a-f]{64}$/);
});

test('single-phase reconciliation without exact binding blocks the run once', async () => {
  const harness = makeHarness();
  const result = await runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'attempt-missing-binding',
    execute: async ({ startOperation, resolveOutcome }) => {
      await startOperation({ operationId: 'unit-1:execute' });
      const recovery = await resolveOutcome({
        operationId: 'unit-1:execute',
        candidateEvidence: {
          kind: 'unknown',
          receiptKey: 'receipt-without-binding',
          reasonCode: 'response_lost',
        },
      });
      return { status: 'pending', recovery };
    },
    record: async () => assert.fail('missing reconciliation binding must not record'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.detail.reason, 'reconciliation_evidence_missing');
  assert.equal(harness.events.at(-1).type, 'run_blocked');
});

for (const [kind, action, reference] of [
  ['staged', 'resume_commit', { resultRef: 'staging:unit-1' }],
  ['committing', 'reconcile_commit', { commitPlanRef: 'commit-plan:unit-1' }],
]) {
  test(`single-phase ${kind} evidence journals the generic commit-resume action`, async () => {
    const harness = makeHarness();
    const recovery = {
      policyVersion: 'effect-state-recovery/v1',
      evidence: {
        kind,
        ...reference,
        effectHash: 'a'.repeat(64),
      },
      decision: {
        policyVersion: 'effect-state-recovery/v1',
        action,
      },
      budget: { attemptsUsed: 0, maxAttempts: 0 },
    };

    const result = await runSinglePhaseStage({
      events: harness.events,
      plan,
      append: harness.append,
      attemptIdForUnit: () => 'attempt-commit-resume',
      execute: async ({ startOperation }) => {
        await startOperation({ operationId: 'unit-1:lessons' });
        return {
          status: 'pending',
          recovery,
        };
      },
      record: async () => assert.fail('commit-resume unit must not be recorded'),
    });

    assert.equal(result.status, 'pending');
    assert.deepEqual(
      harness.events.slice(-2).map((event) => event.type),
      ['unit_outcome_observed', 'unit_commit_resumed'],
    );
    assert.equal(harness.events.at(-1).payload.decision.action, action);
  });
}

test('single-phase drains independent work and blocks only actual dependents', async () => {
  const harness = makeHarness();
  const multiPlan = [
    { unit_id: 'upstream', input_hash: 'input-upstream' },
    {
      unit_id: 'dependent',
      input_hash: 'input-dependent',
      depends_on: ['upstream'],
    },
    { unit_id: 'independent', input_hash: 'input-independent' },
  ];
  const executed = [];
  const recorded = [];

  const result = await runSinglePhaseStage({
    events: harness.events,
    plan: multiPlan,
    append: harness.append,
    attemptIdForUnit: (unit) => `attempt-${unit.unit_id}`,
    execute: async ({ unit, startOperation }) => {
      executed.push(unit.unit_id);
      if (unit.unit_id === 'upstream') {
        await startOperation({ operationId: 'upstream:dispatch' });
        return {
          status: 'failed',
          recovery: noEffectRecovery({ attemptsUsed: 0, maxAttempts: 0 }),
        };
      }
      return { status: 'succeeded' };
    },
    record: async ({ unit }) => recorded.push(unit.unit_id),
  });

  assert.equal(result.status, 'attention_required');
  assert.deepEqual(executed, ['upstream', 'independent']);
  assert.deepEqual(recorded, ['independent']);
  assert.deepEqual(
    harness.events
      .filter((event) => event.type === 'unit_dependency_blocked')
      .map((event) => event.payload.unit_id),
    ['dependent'],
  );
  assert.equal(
    harness.events.some((event) => (
      event.type === 'unit_dependency_blocked'
      && event.payload.unit_id === 'independent'
    )),
    false,
  );
  assert.equal(harness.events.at(-1).type, 'run_attention_required');
});

test('single-phase persists retry budget and Retry-After only extends backoff', async () => {
  const harness = makeHarness();
  const retryPlan = [
    { unit_id: 'retrying', input_hash: 'input-retrying' },
    { unit_id: 'independent', input_hash: 'input-independent' },
  ];
  let clock = Date.parse('2026-07-30T00:00:00.000Z');
  let configuredMaxRetryAttempts = 1;
  const retryAfter = '2026-07-30T00:00:10.000Z';
  const calls = [];

  const invoke = () => runSinglePhaseStage({
    events: harness.events,
    plan: retryPlan,
    append: harness.append,
    attemptIdForUnit: (unit, attemptNumber = 0) => (
      `attempt-${unit.unit_id}-${attemptNumber}`
    ),
    now: () => new Date(clock),
    retryBackoffMs: 5_000,
    maxRetryAttempts: configuredMaxRetryAttempts,
    verifyRecoveredTerminal: async () => committedVerificationCandidate('retry-independent'),
    execute: async ({
      unit,
      attemptId,
      recoveryBudget,
      activeOperation,
      startOperation,
      completeOperation,
    }) => {
      calls.push({ unitId: unit.unit_id, attemptId, recoveryBudget });
      if (unit.unit_id === 'independent') {
        const operation = activeOperation
          || await startOperation({ operationId: 'independent:dispatch' });
        const terminalResult = { status: 'succeeded', payload: { result_ids: ['independent'] } };
        await completeOperation({
          operationId: operation.operation_id,
          status: 'succeeded',
          terminal_result: terminalResult,
        });
        return terminalResult;
      }
      await startOperation({ operationId: 'retrying:dispatch' });
      return {
        status: recoveryBudget.attemptsUsed === 0 ? 'pending' : 'failed',
        recovery: noEffectRecovery({
          attemptsUsed: recoveryBudget.attemptsUsed,
          maxAttempts: recoveryBudget.maxAttempts,
          notBefore: retryAfter,
        }),
      };
    },
    record: async () => {},
  });

  assert.equal((await invoke()).status, 'pending');
  const scheduled = harness.events.find((event) => event.type === 'unit_retry_scheduled');
  assert.equal(scheduled.payload.attempts_used, 1);
  assert.equal(scheduled.payload.max_attempts, 1);
  assert.equal(scheduled.payload.retry_at, retryAfter);
  assert.deepEqual(calls.map((call) => call.unitId), ['retrying', 'independent']);

  clock = Date.parse('2026-07-30T00:00:09.999Z');
  assert.equal((await invoke()).status, 'pending');
  assert.equal(calls.length, 2);

  clock = Date.parse(retryAfter);
  configuredMaxRetryAttempts = 99;
  assert.equal((await invoke()).status, 'attention_required');
  const retryCall = calls.at(-1);
  assert.deepEqual(retryCall.recoveryBudget, { attemptsUsed: 1, maxAttempts: 1 });
  assert.equal(retryCall.attemptId, 'attempt-retrying-1');
  assert.equal(
    harness.events.filter((event) => event.type === 'unit_attempt_started').length,
    1,
  );
});

test('single-phase due retry consumes the boundary before starting another unit', async () => {
  const harness = makeHarness();
  const retryPlan = [
    { unit_id: 'retrying', input_hash: 'input-retrying' },
    { unit_id: 'next', input_hash: 'input-next' },
  ];
  let clock = Date.parse('2026-07-30T00:00:00.000Z');
  const calls = [];
  const execute = async ({
    unit,
    attemptId,
    recoveryBudget,
    activeOperation,
    startOperation,
    completeOperation,
  }) => {
    calls.push({ unitId: unit.unit_id, attemptId });
    if (unit.unit_id === 'retrying' && recoveryBudget.attemptsUsed === 0) {
      await startOperation({ operationId: 'retrying:dispatch:0' });
      return {
        status: 'pending',
        recovery: noEffectRecovery({
          attemptsUsed: 0,
          maxAttempts: 1,
        }),
      };
    }
    const operation = activeOperation || await startOperation({
      operationId: `${unit.unit_id}:dispatch:${recoveryBudget.attemptsUsed}`,
    });
    const terminalResult = {
      status: 'succeeded',
      payload: { result_ids: [unit.unit_id] },
    };
    await completeOperation({
      operationId: operation.operation_id,
      status: 'succeeded',
      terminal_result: terminalResult,
    });
    return terminalResult;
  };
  const invoke = (executionBoundary) => runSinglePhaseStage({
    events: harness.events,
    plan: retryPlan,
    append: harness.append,
    attemptIdForUnit: (unit, attemptNumber = 0) => (
      `attempt-${unit.unit_id}-${attemptNumber}`
    ),
    now: () => new Date(clock),
    retryBackoffMs: 1_000,
    maxRetryAttempts: 1,
    execute,
    record: async () => {},
    executionBoundary,
    stage: 'summary',
  });

  assert.equal((await invoke(makeExecutionBoundary(1))).status, 'paused');
  const retryAt = harness.events.find(
    (event) => event.type === 'unit_retry_scheduled',
  ).payload.retry_at;
  clock = Date.parse(retryAt);
  const result = await invoke(makeExecutionBoundary(1));

  assert.deepEqual(result, {
    status: 'paused',
    unitId: 'retrying',
    processedCount: 1,
  });
  assert.deepEqual(calls.map((call) => call.unitId), ['retrying', 'retrying']);
  assert.deepEqual(
    harness.events
      .filter((event) => event.type === 'unit_attempt_started')
      .map((event) => event.payload.unit_id),
    ['retrying'],
  );
  assert.equal(
    harness.events.some((event) => (
      event.type === 'unit_started' && event.payload.unit_id === 'next'
    )),
    false,
  );
});

test('single-phase recovery is scheduling-equivalent after every new journal boundary', async () => {
  const boundaries = [
    'unit_retry_scheduled',
    'unit_attempt_started',
    'unit_isolated',
    'unit_dependency_blocked',
    'run_attention_required',
  ];
  const recoveryPlan = [
    { unit_id: 'upstream', input_hash: 'input-upstream' },
    {
      unit_id: 'dependent',
      input_hash: 'input-dependent',
      depends_on: ['upstream'],
    },
    { unit_id: 'independent', input_hash: 'input-independent' },
  ];

  const runScenario = async (crashBoundary = null) => {
    const harness = makeHarness();
    let clock = Date.parse('2026-07-30T00:00:00.000Z');
    const invoke = () => runSinglePhaseStage({
      events: harness.events,
      plan: recoveryPlan,
      append: harness.append,
      attemptIdForUnit: (unit, attemptNumber = 0) => (
        `attempt-${unit.unit_id}-${attemptNumber}`
      ),
      now: () => new Date(clock),
      retryBackoffMs: 1_000,
      maxRetryAttempts: 1,
      verifyRecoveredTerminal: async () => committedVerificationCandidate('schedule-independent'),
      execute: async ({
        unit,
        recoveryBudget,
        activeOperation,
        startOperation,
        completeOperation,
      }) => {
        if (unit.unit_id === 'independent') {
          const operation = activeOperation
            || await startOperation({ operationId: 'independent:dispatch' });
          const terminalResult = {
            status: 'succeeded',
            payload: { result_ids: ['independent'] },
          };
          await completeOperation({
            operationId: operation.operation_id,
            status: 'succeeded',
            terminal_result: terminalResult,
          });
          return terminalResult;
        }
        assert.equal(unit.unit_id, 'upstream');
        await startOperation({ operationId: 'upstream:dispatch' });
        return {
          status: recoveryBudget.attemptsUsed === 0 ? 'pending' : 'failed',
          recovery: noEffectRecovery(recoveryBudget),
        };
      },
      record: async () => {},
    });

    if (crashBoundary) harness.failAfter(crashBoundary);
    try {
      await invoke();
    } catch (error) {
      assert.match(error.message, /^crash_after_/);
    }
    clock += 1_000;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const result = await invoke();
        if (result.status === 'attention_required') break;
      } catch (error) {
        assert.match(error.message, /^crash_after_/);
      }
    }
    const eventTypeCounts = Object.fromEntries(
      [...new Set(harness.events.map((event) => event.type))]
        .sort()
        .map((type) => [
          type,
          harness.events.filter((event) => event.type === type).length,
        ]),
    );
    return {
      status: (await invoke()).status,
      eventTypeCounts,
      independentTerminal: harness.events.some((event) => (
        event.type === 'unit_terminal'
        && event.payload.unit_id === 'independent'
        && event.payload.status === 'succeeded'
      )),
    };
  };

  const baseline = await runScenario();
  for (const boundary of boundaries) {
    assert.deepEqual(await runScenario(boundary), baseline, boundary);
  }
});

test('authenticated migration supersedes a legacy terminal and controlled resume claims only the next unit', async () => {
  const stagePlan = [
    { unit_id: 'lesson-a', input_hash: 'input-a' },
    { unit_id: 'lesson-b', input_hash: 'input-b' },
  ];
  const legacyEvents = [
    { seq: 0, type: 'unit_planned', payload: stagePlan[0] },
    { seq: 1, type: 'unit_planned', payload: stagePlan[1] },
    { seq: 2, type: 'stage_plan_completed', payload: { unit_count: 2 } },
    {
      seq: 3,
      type: 'unit_started',
      payload: { unit_id: 'lesson-a', attempt_id: 'lesson-a-attempt' },
    },
    {
      seq: 4,
      type: 'unit_terminal',
      payload: {
        unit_id: 'lesson-a',
        attempt_id: 'lesson-a-attempt',
        status: 'failed',
        error: 'lesson_no_blocks',
      },
    },
  ];
  const manifest = buildRecoveryMigrationManifest({
    runId: 'formal-shape',
    stage: 'lessons',
    events: legacyEvents,
    safeEvidenceByUnit: {
      'lesson-a': legacyLessonNoBlocksEvidence('lesson-a'),
    },
    originalContractVersion: 'run-state-journal-v2/legacy',
    targetContractVersion: RECOVERY_POLICY_VERSION,
    originalPolicyVersion: 'legacy-stage-recovery/v2',
    targetPolicyVersion: RECOVERY_POLICY_VERSION,
    upgradeAt: '2026-07-30T00:00:00.000Z',
    authorizedAt: '2026-07-30T00:00:00.000Z',
    authorizationSourceType: 'change_ticket',
  });
  const migratedEvents = completeMigrationEvents(legacyEvents, manifest);
  const partialEvents = migratedEvents.slice(0, -1);
  const partialResult = await runSinglePhaseStage({
    events: partialEvents,
    plan: stagePlan,
    stage: 'lessons',
    append: async () => assert.fail('partial migration must not append stage events'),
    attemptIdForUnit: () => assert.fail('partial migration must not create attempts'),
    execute: async () => assert.fail('partial migration must not execute business work'),
    record: async () => assert.fail('partial migration must not record business work'),
  });
  assert.equal(partialResult.status, 'blocked');
  assert.equal(partialResult.detail.code, 'recovery_migration_incomplete');
  const partialPlanOnly = await runSinglePhaseStage({
    events: partialEvents,
    plan: stagePlan,
    stage: 'lessons',
    planOnly: true,
    append: async () => assert.fail('partial migration plan-only must not append'),
    attemptIdForUnit: () => assert.fail('partial migration plan-only must not create attempts'),
    execute: async () => assert.fail('partial migration plan-only must not execute'),
    record: async () => assert.fail('partial migration plan-only must not record'),
  });
  assert.equal(partialPlanOnly.status, 'blocked');
  assert.equal(partialPlanOnly.detail.code, 'recovery_migration_incomplete');

  const validated = validateSinglePhaseStage(migratedEvents);
  assert.equal(validated.units.get('lesson-a').terminal, 'skipped');
  assert.equal(validated.units.get('lesson-a').recorded, true);
  const reduced = reduceRecoveryJournal(migratedEvents);
  assert.equal(reduced.units.get('lesson-a').superseded_terminals.length, 1);

  const tampered = structuredClone(migratedEvents);
  const tamperedOutcomeIndex = tampered.findIndex((event) => (
    event.type === 'unit_outcome_observed'
    && event.payload?.migration_id === manifest.migration_id
  ));
  tampered[tamperedOutcomeIndex] = {
    ...tampered[tamperedOutcomeIndex],
    payload: {
      ...tampered[tamperedOutcomeIndex].payload,
      manifest_hash: '0'.repeat(64),
    },
  };
  assert.throws(
    () => validateSinglePhaseStage(tampered),
    /recovery_migration_step_mismatch/,
  );
  const prefixTampered = structuredClone(migratedEvents);
  prefixTampered[0] = {
    ...prefixTampered[0],
    payload: { ...prefixTampered[0].payload, input_hash: 'changed-input' },
  };
  assert.throws(
    () => validateSinglePhaseStage(prefixTampered),
    /recovery_migration_input_summary_mismatch/,
  );

  const events = structuredClone(migratedEvents);
  const executed = [];
  const recorded = [];
  const result = await runSinglePhaseStage({
    events,
    plan: stagePlan,
    stage: 'lessons',
    append: async (type, payload) => {
      const event = { seq: events.length, type, payload };
      events.push(event);
      return event;
    },
    attemptIdForUnit: (unit) => `${unit.unit_id}-attempt`,
    execute: async ({ unit }) => {
      executed.push(unit.unit_id);
      return { status: 'succeeded', payload: { lesson_run_id: `${unit.unit_id}-run` } };
    },
    verifyRecoveredTerminal: async () => (
      assert.fail('authenticated migration terminal must not be re-verified')
    ),
    record: async ({ unit }) => {
      recorded.push(unit.unit_id);
    },
    executionBoundary: makeExecutionBoundary(1),
  });

  assert.deepEqual(result, {
    status: 'paused',
    unitId: 'lesson-b',
    processedCount: 1,
  });
  assert.deepEqual(executed, ['lesson-b']);
  assert.deepEqual(recorded, ['lesson-b']);
  assert.equal(
    events.filter((event) => (
      event.type === 'unit_outcome_observed'
      && event.payload?.unit_id === 'lesson-a'
    )).length,
    1,
  );
});

test('unfenced initial unit_attempt_started remains invalid', () => {
  assert.throws(
    () => validateSinglePhaseStage([
      { seq: 0, type: 'unit_planned', payload: { unit_id: 'unit-1' } },
      { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
      {
        seq: 2,
        type: 'unit_attempt_started',
        payload: { unit_id: 'unit-1', attempt_id: 'attempt-1', attempt_number: 0 },
      },
    ]),
    /retry_attempt/,
  );
});

test('two-phase partial migration blocks before plan-only or business work', async () => {
  const twoPhasePlan = [{ unit_id: 'memory-a', input_hash: 'memory-input' }];
  const legacyEvents = [
    { seq: 0, type: 'unit_planned', payload: twoPhasePlan[0] },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    {
      seq: 2,
      type: 'unit_prepare_started',
      payload: { unit_id: 'memory-a', attempt_id: 'prepare-a' },
    },
    {
      seq: 3,
      type: 'unit_prepared',
      payload: { unit_id: 'memory-a', attempt_id: 'prepare-a' },
    },
    {
      seq: 4,
      type: 'unit_committing',
      payload: {
        unit_id: 'memory-a',
        attempt_id: 'commit-a',
        prepared_attempt_id: 'prepare-a',
      },
    },
    {
      seq: 5,
      type: 'unit_terminal',
      payload: { unit_id: 'memory-a', attempt_id: 'commit-a', status: 'succeeded' },
    },
    {
      seq: 6,
      type: 'unit_recorded',
      payload: { unit_id: 'memory-a', attempt_id: 'commit-a' },
    },
  ];
  const manifest = buildRecoveryMigrationManifest({
    runId: 'two-phase-partial',
    stage: 'memory_consolidate',
    events: legacyEvents,
    safeEvidenceByUnit: {},
    originalContractVersion: 'run-state-journal-v2/legacy',
    targetContractVersion: RECOVERY_POLICY_VERSION,
    originalPolicyVersion: 'legacy-stage-recovery/v2',
    targetPolicyVersion: RECOVERY_POLICY_VERSION,
    upgradeAt: '2026-07-30T00:00:00.000Z',
    authorizedAt: '2026-07-30T00:00:00.000Z',
    authorizationSourceType: 'change_ticket',
  });
  const partialEvents = completeMigrationEvents(legacyEvents, manifest).slice(0, -1);
  const result = await runTwoPhaseStage({
    events: partialEvents,
    plan: twoPhasePlan,
    stage: 'memory_consolidate',
    planOnly: true,
    append: async () => assert.fail('partial two-phase migration must not append'),
    prepareAttemptIdForUnit: () => assert.fail('partial migration must not prepare'),
    commitAttemptIdForUnit: () => assert.fail('partial migration must not commit'),
    prepare: async () => assert.fail('partial migration must not prepare business work'),
    commit: async () => assert.fail('partial migration must not commit business work'),
    record: async () => assert.fail('partial migration must not record business work'),
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.detail.code, 'recovery_migration_incomplete');
});

test('fixed-seed crash positions match the baseline or fail closed across both recovery modes', async () => {
  const positionsFor = (boundaries) => {
    let state = 0x5eed1234;
    const remaining = [...boundaries];
    const positions = [];
    while (remaining.length > 0) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      positions.push(remaining.splice(state % remaining.length, 1)[0]);
    }
    return positions;
  };

  const typeCounts = (events) => Object.fromEntries(
    [...new Set(events.map((event) => event.type))]
      .sort()
      .map((type) => [
        type,
        events.filter((event) => event.type === type).length,
      ]),
  );

  const eventBoundaries = (events) => {
    const occurrences = new Map();
    return events.map((event) => {
      const occurrence = (occurrences.get(event.type) ?? 0) + 1;
      occurrences.set(event.type, occurrence);
      return `${event.type}#${occurrence}`;
    });
  };

  const invokeAfterInjectedCrash = async (invoke, crashState) => {
    try {
      return await invoke();
    } catch (error) {
      assert.match(error.message, /^crash_after_/);
      crashState.observed = true;
      return null;
    }
  };

  const runCommittedSingle = async (crashBoundary = null) => {
    const harness = makeHarness();
    let effectCount = 0;
    let recordCount = 0;
    let effectApplied = false;
    let recorded = false;
    const recoveryCandidate = committedVerificationCandidate(
      'fixed-seed-single',
    ).recoveryCandidate;
    const invoke = () => runSinglePhaseStage({
      events: harness.events,
      plan,
      append: harness.append,
      attemptIdForUnit: () => 'attempt-fixed-seed',
      verifyRecoveredTerminal: async () => committedVerificationCandidate('fixed-seed-single'),
      execute: async ({
        activeOperation,
        completedOperations,
        startOperation,
        completeOperation,
        resolveOutcome,
      }) => {
        const completed = completedOperations.at(-1);
        let operationId = completed?.operation_id;
        let terminalResult = completed?.terminal_result;
        if (!terminalResult) {
          const operation = activeOperation
            || await startOperation({ operationId: 'unit-1:execute' });
          operationId = operation.operation_id;
          if (!effectApplied) {
            effectApplied = true;
            effectCount += 1;
          }
          terminalResult = {
            status: 'succeeded',
            payload: { result_ids: ['single-result'] },
          };
          const recovery = await resolveOutcome({
            operationId,
            ...recoveryCandidate,
          });
          await completeOperation({
            operationId,
            status: 'succeeded',
            terminal_result: terminalResult,
          });
          return { ...terminalResult, recovery };
        }
        const recovery = await resolveOutcome({
          operationId,
          verification: true,
          ...recoveryCandidate,
        });
        return { ...terminalResult, recovery };
      },
      record: async () => {
        if (!recorded) {
          recorded = true;
          recordCount += 1;
        }
      },
    });
    if (crashBoundary) harness.failAfter(crashBoundary);
    const crashState = { observed: false };
    const interrupted = await invokeAfterInjectedCrash(invoke, crashState);
    const result = interrupted?.status === 'completed'
      ? interrupted
      : await invoke();
    if (crashBoundary) assert.equal(crashState.observed, true, crashBoundary);
    const state = validateSinglePhaseStage(harness.events);
    return {
      status: result.status,
      effectCount,
      recordCount,
      terminal: state.units.get('unit-1').terminal,
      eventTypeCounts: typeCounts(harness.events),
      eventBoundaries: eventBoundaries(harness.events),
      events: structuredClone(harness.events),
    };
  };

  const runCommittedTwoPhase = async (crashBoundary = null) => {
    const harness = makeHarness();
    let prepareEffectCount = 0;
    let commitEffectCount = 0;
    let recordCount = 0;
    let prepareApplied = false;
    let commitApplied = false;
    let recorded = false;
    const recoveryCandidate = committedVerificationCandidate(
      'fixed-seed-two-phase',
    ).recoveryCandidate;
    const invoke = () => runTwoPhaseStage({
      events: harness.events,
      plan,
      append: harness.append,
      recoverCommit: true,
      prepareAttemptIdForUnit: () => 'prepare-fixed-seed',
      commitAttemptIdForUnit: () => 'commit-fixed-seed',
      verifyRecoveredTerminal: async () => committedVerificationCandidate('fixed-seed-two-phase'),
      prepare: async () => {
        if (!prepareApplied) {
          prepareApplied = true;
          prepareEffectCount += 1;
        }
        return {
          status: 'prepared',
          prepared: {
            prepared_handle: 'fixed-handle',
            proposal_hash: 'fixed-proposal',
          },
        };
      },
      commit: async ({
        activeOperation,
        completedOperations,
        completeOperation,
        resolveOutcome,
      }) => {
        const completed = completedOperations.at(-1);
        let operationId = completed?.operation_id;
        let terminalResult = completed?.terminal_result;
        if (!terminalResult) {
          operationId = activeOperation.operation_id;
          if (!commitApplied) {
            commitApplied = true;
            commitEffectCount += 1;
          }
          terminalResult = {
            status: 'succeeded',
            payload: { result_ids: ['two-phase-result'] },
          };
          const recovery = await resolveOutcome({
            operationId,
            ...recoveryCandidate,
          });
          await completeOperation({
            operationId,
            status: 'succeeded',
            terminal_result: terminalResult,
          });
          return { ...terminalResult, recovery };
        }
        const recovery = await resolveOutcome({
          operationId,
          verification: true,
          ...recoveryCandidate,
        });
        return { ...terminalResult, recovery };
      },
      record: async () => {
        if (!recorded) {
          recorded = true;
          recordCount += 1;
        }
      },
    });
    if (crashBoundary) harness.failAfter(crashBoundary);
    const crashState = { observed: false };
    const interrupted = await invokeAfterInjectedCrash(invoke, crashState);
    const result = interrupted?.status === 'completed'
      ? interrupted
      : await invoke();
    if (crashBoundary) assert.equal(crashState.observed, true, crashBoundary);
    const state = validateTwoPhaseStage(harness.events);
    return {
      status: result.status,
      prepareEffectCount,
      commitEffectCount,
      recordCount,
      terminal: state.units.get('unit-1').terminal,
      eventTypeCounts: typeCounts(harness.events),
      eventBoundaries: eventBoundaries(harness.events),
      events: structuredClone(harness.events),
    };
  };

  const runSingleRetryIsolation = async (crashBoundary = null) => {
    const harness = makeHarness();
    const invoke = () => runSinglePhaseStage({
      events: harness.events,
      plan,
      append: harness.append,
      attemptIdForUnit: (unit, attemptNumber = 0) => (
        `fixed-seed-policy-${unit.unit_id}-${attemptNumber}`
      ),
      now: () => new Date('2026-07-30T00:00:00.000Z'),
      retryBackoffMs: 0,
      maxRetryAttempts: 1,
      execute: async ({
        attemptId,
        recoveryBudget,
        activeOperation,
        startOperation,
        resolveOutcome,
      }) => {
        const operation = activeOperation || await startOperation({
          operationId: `unit-1:no-effect:${attemptId}`,
        });
        const operationStart = [...harness.events].reverse().find((event) => (
          event.type === 'unit_operation_started'
          && event.payload.operation_id === operation.operation_id
        ));
        const requestDispatch = {
          state: 'not_dispatched',
          persisted: true,
          attemptId,
          journalSeq: operationStart.seq,
        };
        const recovery = await resolveOutcome({
          operationId: operation.operation_id,
          candidateEvidence: {
            kind: 'no_effect',
            observation: 'execution_error',
            reasonCode: 'provider_unavailable',
            proof: {
              kind: 'request_not_dispatched',
              attemptId,
              journalSeq: operationStart.seq,
            },
          },
          snapshot: { requestDispatch },
        });
        return {
          status: recovery.decision.action === 'retry' ? 'pending' : 'failed',
          recovery,
        };
      },
      record: async () => assert.fail('isolated unit must not be recorded'),
    });
    if (crashBoundary) harness.failAfter(crashBoundary);
    const crashState = { observed: false };
    let result = await invokeAfterInjectedCrash(invoke, crashState);
    for (let attempt = 0; attempt < 5 && result?.status !== 'attention_required'; attempt += 1) {
      result = await invokeAfterInjectedCrash(invoke, crashState);
    }
    if (crashBoundary) assert.equal(crashState.observed, true, crashBoundary);
    assert.equal(result?.status, 'attention_required');
    const state = validateSinglePhaseStage(harness.events);
    return {
      status: result.status,
      terminal: state.units.get('unit-1').terminal,
      decisions: harness.events
        .filter((event) => event.type === 'unit_outcome_observed')
        .map((event) => event.payload.decision.action),
      eventTypeCounts: typeCounts(harness.events),
      eventBoundaries: eventBoundaries(harness.events),
      events: structuredClone(harness.events),
    };
  };

  const runTwoPhaseReconcileBlock = async (crashBoundary = null) => {
    const harness = makeHarness();
    const invoke = () => runTwoPhaseStage({
      events: harness.events,
      plan,
      append: harness.append,
      recoverCommit: true,
      prepareAttemptIdForUnit: () => 'prepare-fixed-seed-block',
      commitAttemptIdForUnit: () => 'commit-fixed-seed-block',
      prepare: async () => ({
        status: 'prepared',
        prepared: {
          prepared_handle: 'fixed-block-handle',
          proposal_hash: 'fixed-block-proposal',
        },
      }),
      commit: async ({ activeOperation, resolveOutcome }) => {
        const recovery = await resolveOutcome({
          operationId: activeOperation.operation_id,
          candidateEvidence: {
            kind: 'unknown',
            receiptKey: 'fixed-seed-missing-reconciliation-binding',
            reasonCode: 'response_lost',
          },
        });
        return { status: 'pending', recovery };
      },
      record: async () => assert.fail('blocked run must not be recorded'),
    });
    if (crashBoundary) harness.failAfter(crashBoundary);
    const crashState = { observed: false };
    const interrupted = await invokeAfterInjectedCrash(invoke, crashState);
    const result = interrupted?.status === 'blocked'
      ? interrupted
      : await invoke();
    if (crashBoundary) assert.equal(crashState.observed, true, crashBoundary);
    return {
      status: result.status,
      reason: result.detail.reason,
      decisions: harness.events
        .filter((event) => event.type === 'unit_outcome_observed')
        .map((event) => event.payload.decision.action),
      eventTypeCounts: typeCounts(harness.events),
      eventBoundaries: eventBoundaries(harness.events),
      events: structuredClone(harness.events),
    };
  };

  const scenarios = [
    {
      name: 'single_committed',
      run: runCommittedSingle,
    },
    {
      name: 'two_phase_committed',
      run: runCommittedTwoPhase,
    },
    {
      name: 'single_retry_isolate',
      run: runSingleRetryIsolation,
    },
    {
      name: 'two_phase_reconcile_block',
      run: runTwoPhaseReconcileBlock,
    },
  ];

  for (const scenario of scenarios) {
    const baseline = await scenario.run();
    for (const boundary of positionsFor(baseline.eventBoundaries)) {
      assert.deepEqual(
        await scenario.run(boundary),
        baseline,
        `${scenario.name}:${boundary}`,
      );
    }
  }

  const singlePolicy = await runSingleRetryIsolation();
  assert.deepEqual(singlePolicy.decisions, ['retry', 'isolate']);
  assert.equal(singlePolicy.eventTypeCounts.unit_retry_scheduled, 1);
  assert.equal(singlePolicy.eventTypeCounts.unit_isolated, 1);

  const twoPhaseBlocked = await runTwoPhaseReconcileBlock();
  assert.deepEqual(twoPhaseBlocked.decisions, ['reconcile']);
  assert.equal(twoPhaseBlocked.status, 'blocked');
  assert.equal(twoPhaseBlocked.eventTypeCounts.run_blocked, 1);
});

test('single-phase orphan reconciliation clears only the matching blocked active operation', async () => {
  const harness = makeHarness();
  const invoke = (execute) => runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'attempt-reconciled',
    execute,
    record: async () => {},
  });

  assert.equal((await invoke(async ({ startOperation }) => {
    await startOperation({ operationId: 'unit-1:reduce' });
    return {
      status: 'blocked',
      reason: 'extraction_operation_reconciliation_required',
    };
  })).status, 'pending');

  await harness.append('unit_reconciliation_resolved', {
    unit_id: 'unit-1',
    attempt_id: 'attempt-reconciled',
    operation_id: 'unit-1:reduce',
    reconciliation_id: 'xrec_0123456789abcdef0123456789abcdef',
    receipt_input_hash: 'b'.repeat(64),
    receipt_started_at: '2026-07-26T17:44:07.622Z',
    receipt_status: 'reconciled',
    result_status: 'absent',
    cause: 'orphaned_operation_result_absent',
  });

  assert.deepEqual(await invoke(async ({
    activeOperation,
    completedOperations,
    startOperation,
    completeOperation,
  }) => {
    assert.equal(activeOperation, null);
    assert.deepEqual(completedOperations, []);
    const operation = await startOperation({ operationId: 'unit-1:reduce' });
    await completeOperation({
      operationId: operation.operation_id,
      status: 'succeeded',
    });
    return { status: 'succeeded' };
  }), { status: 'completed', acceptedCount: 1 });
  assert.equal(
    harness.events.filter((event) => event.type === 'unit_operation_started').length,
    2,
  );
});

test('single-phase orphan reconciliation rejects a changed operation identity', async () => {
  const harness = makeHarness();
  await runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'attempt-reconciled',
    execute: async ({ startOperation }) => {
      await startOperation({ operationId: 'unit-1:reduce' });
      return { status: 'blocked', reason: 'extraction_operation_reconciliation_required' };
    },
    record: async () => {},
  });
  await harness.append('unit_reconciliation_resolved', {
    unit_id: 'unit-1',
    attempt_id: 'attempt-reconciled',
    operation_id: 'unit-1:map:0',
    reconciliation_id: 'xrec_0123456789abcdef0123456789abcdef',
    receipt_input_hash: 'b'.repeat(64),
    receipt_started_at: '2026-07-26T17:44:07.622Z',
    receipt_status: 'reconciled',
    result_status: 'absent',
    cause: 'orphaned_operation_result_absent',
  });

  assert.throws(
    () => validateSinglePhaseStage(harness.events),
    /reconciliation_(?:operation_identity|resolution)/,
  );
});

test('single-phase orphan reconciliation consumes only the matching retry authorization', () => {
  const state = validateSinglePhaseStage(authorizedBlockedEvents());
  assert.equal(state.units.get('unit-1').retry_authorization, null);

  assert.throws(
    () => validateSinglePhaseStage(authorizedBlockedEvents('unit-1:map:0')),
    /reconciliation_(?:operation_identity|resolution)/,
  );
});

test('single-phase generic reconciliation resolves the exact request without a legacy reason', async () => {
  const harness = makeHarness();
  let calls = 0;
  const invoke = () => runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'attempt-generic-reconcile',
    execute: async ({
      activeOperation,
      startOperation,
      completeOperation,
      resolveOutcome,
    }) => {
      calls += 1;
      const operation = activeOperation
        || await startOperation({ operationId: 'unit-1:generic' });
      if (calls === 1) {
        const recovery = await resolveOutcome({
          operationId: operation.operation_id,
          candidateEvidence: {
            kind: 'unknown',
            receiptKey: 'receipt-generic',
            reasonCode: 'response_lost',
          },
        });
        return {
          status: 'pending',
          recovery,
          reconciliationBinding: reconciliationBinding({
            attemptId: 'attempt-generic-reconcile',
            marker: '2',
          }),
        };
      }
      await completeOperation({
        operationId: operation.operation_id,
        status: 'succeeded',
      });
      return { status: 'succeeded' };
    },
    record: async () => {},
  });

  assert.equal((await invoke()).status, 'pending');
  const requested = harness.events.at(-1);
  assert.equal(requested.type, 'unit_reconciliation_requested');
  assert.equal(requested.payload.phase, 'execute');
  assert.equal(requested.payload.reason, undefined);

  await harness.append('unit_reconciliation_resolved', {
    unit_id: 'unit-1',
    attempt_id: 'attempt-generic-reconcile',
    operation_id: 'unit-1:generic',
    phase: 'execute',
    reconciliation_request_seq: requested.seq,
    ...reconciliationBinding({
      attemptId: 'attempt-generic-reconcile',
      marker: '2',
    }),
    reconciliation_id: 'xrec_0123456789abcdef0123456789abcdef',
    receipt_status: 'reconciled',
    result_status: 'absent',
    cause: 'orphaned_operation_result_absent',
  });

  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 1 });
  assert.equal(calls, 2);
});

test('single-phase re-verifies a recorded terminal before completing the stage', async () => {
  const harness = makeHarness();
  harness.events.push(
    { seq: 0, type: 'unit_planned', payload: plan[0] },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    {
      seq: 2,
      type: 'unit_started',
      payload: { unit_id: 'unit-1', attempt_id: 'attempt-recorded' },
    },
    {
      seq: 3,
      type: 'unit_operation_started',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'attempt-recorded',
        operation_id: 'unit-1:execute',
      },
    },
    {
      seq: 4,
      type: 'unit_operation_completed',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'attempt-recorded',
        operation_id: 'unit-1:execute',
        status: 'succeeded',
        terminal_result: {
          status: 'succeeded',
          payload: { result_ids: ['result-1'] },
        },
      },
    },
    {
      seq: 5,
      type: 'unit_terminal',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'attempt-recorded',
        status: 'succeeded',
        result_ids: ['result-1'],
      },
    },
    {
      seq: 6,
      type: 'unit_recorded',
      payload: { unit_id: 'unit-1', attempt_id: 'attempt-recorded' },
    },
  );
  let verificationCalls = 0;

  assert.deepEqual(await runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'must-not-run',
    verifyRecoveredTerminal: async () => {
      verificationCalls += 1;
      return committedVerificationCandidate('recorded-single');
    },
    execute: async () => assert.fail('recorded terminal must not execute'),
    record: async () => assert.fail('recorded terminal must not record twice'),
  }), { status: 'completed', acceptedCount: 1 });
  assert.equal(verificationCalls, 1);
  assert.equal(harness.events.at(-1).type, 'stage_completed');
});

test('single-phase blocks completion when a recorded terminal cannot be re-verified', async () => {
  const harness = makeHarness();
  harness.events.push(
    { seq: 0, type: 'unit_planned', payload: plan[0] },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    {
      seq: 2,
      type: 'unit_started',
      payload: { unit_id: 'unit-1', attempt_id: 'attempt-unverified' },
    },
    {
      seq: 3,
      type: 'unit_operation_started',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'attempt-unverified',
        operation_id: 'unit-1:execute',
      },
    },
    {
      seq: 4,
      type: 'unit_operation_completed',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'attempt-unverified',
        operation_id: 'unit-1:execute',
        status: 'succeeded',
        terminal_result: { status: 'succeeded', payload: { result_ids: [] } },
      },
    },
    {
      seq: 5,
      type: 'unit_terminal',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'attempt-unverified',
        status: 'succeeded',
        result_ids: [],
      },
    },
    {
      seq: 6,
      type: 'unit_recorded',
      payload: { unit_id: 'unit-1', attempt_id: 'attempt-unverified' },
    },
  );

  const result = await runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'must-not-run',
    execute: async () => assert.fail('recorded terminal must not execute'),
    record: async () => assert.fail('recorded terminal must not record twice'),
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.detail.reason, 'recovered_terminal_verifier_required');
  assert.equal(harness.events.at(-1).type, 'run_blocked');
});

test('single-phase adapters can journal an exact inner operation before dispatch', async () => {
  const harness = makeHarness();
  const receiptModes = [];
  let responseLost = true;
  const invoke = () => runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'attempt-inner',
    execute: async ({
      activeOperation,
      startOperation,
      completeOperation,
    }) => {
      const operation = activeOperation
        || await startOperation({ operationId: 'unit-1:map:0' });
      receiptModes.push(Boolean(activeOperation));
      if (responseLost) {
        responseLost = false;
        throw new Error('inner_response_lost');
      }
      await completeOperation({
        operationId: operation.operation_id,
        status: 'succeeded',
      });
      return { status: 'succeeded' };
    },
    record: async () => {},
  });

  await assert.rejects(invoke, /inner_response_lost/);
  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 1 });
  assert.deepEqual(receiptModes, [false, true]);
  assert.deepEqual(harness.events.map((event) => event.type), [
    'unit_planned',
    'stage_plan_completed',
    'unit_started',
    'unit_operation_started',
    'unit_operation_completed',
    'unit_terminal',
    'unit_recorded',
    'stage_completed',
  ]);
});

test('unit_started without operation_started remains a fresh inner dispatch boundary', async () => {
  const harness = makeHarness();
  let executeCalls = 0;
  const invoke = () => runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'attempt-before-inner',
    execute: async ({ activeOperation, completedOperations }) => {
      executeCalls += 1;
      assert.equal(activeOperation, null);
      assert.deepEqual(completedOperations, []);
      return { status: 'succeeded' };
    },
    record: async () => {},
  });

  harness.failAfter('unit_started');
  await assert.rejects(invoke, /crash_after_unit_started/);
  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 1 });
  assert.equal(executeCalls, 1);
});

test('single-phase adapters can recover a terminal inner result without redispatch', async () => {
  const harness = makeHarness();
  let remoteCalls = 0;
  const invoke = () => runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: () => 'attempt-terminal-inner',
    execute: async ({
      activeOperation,
      completedOperations,
      startOperation,
      completeOperation,
    }) => {
      const recoveredTerminal = completedOperations.at(-1)?.terminal_result;
      if (recoveredTerminal) return recoveredTerminal;
      const operation = activeOperation
        || await startOperation({ operationId: 'unit-1:map:0' });
      remoteCalls += 1;
      const terminalResult = {
        status: 'succeeded',
        payload: { result_id: 'result-1' },
      };
      await completeOperation({
        operationId: operation.operation_id,
        status: 'succeeded',
        terminal_result: terminalResult,
      });
      return terminalResult;
    },
    record: async () => {},
  });

  harness.failAfter('unit_operation_completed');
  await assert.rejects(invoke, /crash_after_unit_operation_completed/);
  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 1 });
  assert.equal(remoteCalls, 1);
});

test('single-phase summary retry authorization supersedes only the named failed reduce facts', async () => {
  const harness = makeHarness();
  const attemptId = 'a'.repeat(64);
  const runnerInputHash = 'b'.repeat(64);
  const receiptInputHash = 'c'.repeat(64);
  const retryPlan = [{ unit_id: 'unit-1', input_hash: runnerInputHash }];
  const invoke = () => runSinglePhaseStage({
    events: harness.events,
    plan: retryPlan,
    append: harness.append,
    attemptIdForUnit: () => attemptId,
    execute: async ({
      completedOperations,
      retryAuthorization,
      startOperation,
      completeOperation,
    }) => {
      assert.deepEqual(
        completedOperations.map((operation) => operation.operation_id),
        ['unit-1:map:0'],
      );
      assert.equal(retryAuthorization.operation_id, 'unit-1:reduce');
      assert.equal(retryAuthorization.receipt_input_hash, receiptInputHash);
      const operation = await startOperation({ operationId: 'unit-1:reduce' });
      await completeOperation({
        operationId: operation.operation_id,
        status: 'succeeded',
        terminal_result: { status: 'succeeded', payload: { summary_hash: 'd'.repeat(64) } },
      });
      return { status: 'succeeded', payload: { summary_hash: 'd'.repeat(64) } };
    },
    record: async () => {},
  });

  await harness.append('unit_planned', retryPlan[0]);
  await harness.append('stage_plan_completed', { unit_count: 1 });
  await harness.append('unit_started', {
    unit_id: 'unit-1',
    input_hash: runnerInputHash,
    attempt_id: attemptId,
  });
  await harness.append('unit_operation_started', {
    unit_id: 'unit-1',
    attempt_id: attemptId,
    operation_id: 'unit-1:map:0',
  });
  await harness.append('unit_operation_completed', {
    unit_id: 'unit-1',
    attempt_id: attemptId,
    operation_id: 'unit-1:map:0',
    status: 'completed',
    next_operation_id: 'unit-1:reduce',
  });
  await harness.append('unit_operation_started', {
    unit_id: 'unit-1',
    attempt_id: attemptId,
    operation_id: 'unit-1:reduce',
  });
  const failedOperation = await harness.append('unit_operation_completed', {
    unit_id: 'unit-1',
    attempt_id: attemptId,
    operation_id: 'unit-1:reduce',
    status: 'failed',
    error: 'pi_stream_failed',
    terminal_result: { status: 'failed', payload: { error: 'pi_stream_failed' } },
  });
  const failedTerminal = await harness.append('unit_terminal', {
    unit_id: 'unit-1',
    attempt_id: attemptId,
    status: 'failed',
    error: 'pi_stream_failed',
  });
  await harness.append('unit_summary_failed_terminal_retry_authorized', {
    stage: 'summary',
    unit_id: 'unit-1',
    attempt_id: attemptId,
    operation_id: 'unit-1:reduce',
    runner_input_hash: runnerInputHash,
    receipt_input_hash: receiptInputHash,
    receipt_status: 'failed',
    failure_class: 'transient_provider',
    failure_cause: 'pi_stream_failed',
    failure_phase: 'provider_call',
    retry_epoch: 0,
    last_safe_failure: {
      error_class: 'transient_provider',
      cause: 'pi_stream_failed',
      phase: 'provider_call',
      timestamp: '2026-07-28T00:00:00.000Z',
    },
    superseded_operation_seq: failedOperation.seq,
    superseded_terminal_seq: failedTerminal.seq,
    expected_journal_seq: failedTerminal.seq,
  });

  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 1 });
  assert.equal(
    harness.events.filter((event) =>
      event.type === 'unit_operation_completed'
      && event.payload.operation_id === 'unit-1:reduce').length,
    2,
  );
  assert.deepEqual(
    harness.events.filter((event) => event.type === 'unit_terminal')
      .map((event) => event.payload.status),
    ['failed', 'succeeded'],
  );
});

test('single-phase lessons retry authorization supersedes only the named failed terminal', async () => {
  const harness = makeHarness();
  const attemptId = 'a'.repeat(64);
  const runnerInputHash = 'b'.repeat(64);
  const receiptInputHash = 'c'.repeat(64);
  const lessonRunInputHash = 'd'.repeat(64);
  const lessonRunConfigHash = 'e'.repeat(64);
  const retryPlan = [{ unit_id: 'unit-1', input_hash: runnerInputHash }];
  const invoke = () => runSinglePhaseStage({
    events: harness.events,
    plan: retryPlan,
    append: harness.append,
    attemptIdForUnit: () => attemptId,
    execute: async ({ retryAuthorization }) => {
      assert.equal(retryAuthorization.stage, 'lessons');
      assert.equal(retryAuthorization.receipt_input_hash, receiptInputHash);
      assert.equal(retryAuthorization.lesson_run_evidence.input_hash, lessonRunInputHash);
      return { status: 'succeeded', payload: { run_id: 'lesson-run-1' } };
    },
    record: async () => {},
  });

  await harness.append('unit_planned', retryPlan[0]);
  await harness.append('stage_plan_completed', { unit_count: 1 });
  await harness.append('unit_started', {
    unit_id: 'unit-1',
    input_hash: runnerInputHash,
    attempt_id: attemptId,
  });
  const failedTerminal = await harness.append('unit_terminal', {
    unit_id: 'unit-1',
    attempt_id: attemptId,
    status: 'failed',
    error: 'lesson_extraction_failed',
  });
  await harness.append('unit_lessons_failed_terminal_retry_authorized', {
    stage: 'lessons',
    unit_id: 'unit-1',
    attempt_id: attemptId,
    runner_input_hash: runnerInputHash,
    receipt_input_hash: receiptInputHash,
    receipt_status: 'failed',
    receipt_failure_class: 'transient_provider',
    receipt_failure_cause: 'lesson_extraction_failed',
    failure_class: 'transient_provider',
    failure_cause: 'lesson_extraction_failed',
    failure_phase: 'provider_call',
    retry_epoch: 0,
    last_safe_failure: {
      error_class: 'transient_provider',
      cause: 'lesson_extraction_failed',
      phase: 'provider_call',
      timestamp: '2026-07-28T16:23:40.115Z',
    },
    lesson_run_evidence: {
      status: 'retryable',
      input_hash: lessonRunInputHash,
      config_hash: lessonRunConfigHash,
      failure_cause: 'timeout',
      failure_phase: 'provider_call',
      failed_at: '2026-07-28T16:23:40.115Z',
      created_lesson_count: 0,
      replaced_lesson_count: 0,
      chunk_lesson_count: 0,
    },
    superseded_terminal_seq: failedTerminal.seq,
    expected_journal_seq: failedTerminal.seq,
  });

  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 1 });
  assert.deepEqual(
    harness.events.filter((event) => event.type === 'unit_terminal')
      .map((event) => event.payload.status),
    ['failed', 'succeeded'],
  );
});

test('single-phase retry authorization fails closed outside a safe summary reduce failure shape', () => {
  const attemptId = 'a'.repeat(64);
  const events = [
    { seq: 0, type: 'unit_planned', payload: { unit_id: 'unit-1', input_hash: 'b'.repeat(64) } },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    { seq: 2, type: 'unit_started', payload: { unit_id: 'unit-1', attempt_id: attemptId } },
    {
      seq: 3,
      type: 'unit_operation_started',
      payload: { unit_id: 'unit-1', attempt_id: attemptId, operation_id: 'unit-1:reduce' },
    },
    {
      seq: 4,
      type: 'unit_operation_completed',
      payload: {
        unit_id: 'unit-1',
        attempt_id: attemptId,
        operation_id: 'unit-1:reduce',
        terminal_result: { status: 'failed' },
      },
    },
    {
      seq: 5,
      type: 'unit_terminal',
      payload: { unit_id: 'unit-1', attempt_id: attemptId, status: 'failed' },
    },
    {
      seq: 6,
      type: 'unit_summary_failed_terminal_retry_authorized',
      payload: {
        stage: 'summary',
        unit_id: 'unit-1',
        attempt_id: attemptId,
        operation_id: 'unit-1:reduce',
        runner_input_hash: 'b'.repeat(64),
        receipt_input_hash: 'c'.repeat(64),
        receipt_status: 'failed',
        failure_class: 'transient_provider',
        failure_cause: 'pi_stream_failed',
        failure_phase: 'provider_preflight',
        retry_epoch: 0,
        last_safe_failure: {
          error_class: 'transient_provider',
          cause: 'pi_stream_failed',
          phase: 'provider_preflight',
          timestamp: '2026-07-28T00:00:00.000Z',
        },
        superseded_operation_seq: 4,
        superseded_terminal_seq: 5,
        expected_journal_seq: 5,
      },
    },
  ];

  assert.throws(() => validateSinglePhaseStage(events), /retry_authorization_evidence/);
});

test('two-phase recovery persists prepare and commit identities at every boundary', async () => {
  const harness = makeHarness();
  const prepareAttempts = [];
  const prepareRecovery = [];
  const commitAttempts = [];
  const recordAttempts = [];
  let losePrepareResponse = true;
  let loseCommitResponse = true;
  let loseRecordResponse = true;
  const invoke = () => runTwoPhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    prepareAttemptIdForUnit: () => 'prepare-1',
    commitAttemptIdForUnit: ({ prepared }) => `commit-${prepared.proposal_hash}`,
    verifyRecoveredTerminal: async () => committedVerificationCandidate('two-phase-reuse'),
    prepare: async ({ attemptId, recovered }) => {
      prepareAttempts.push(attemptId);
      prepareRecovery.push(recovered);
      if (losePrepareResponse) {
        losePrepareResponse = false;
        throw new Error('prepare_response_lost');
      }
      return {
        status: 'prepared',
        prepared: { prepared_handle: 'handle-1', proposal_hash: 'proposal-1' },
      };
    },
    commit: async ({ attemptId, prepared }) => {
      commitAttempts.push(attemptId);
      assert.equal(prepared.prepared_handle, 'handle-1');
      if (loseCommitResponse) {
        loseCommitResponse = false;
        throw new Error('commit_response_lost');
      }
      return { status: 'succeeded', payload: { result_ids: ['memory-1'] } };
    },
    record: async ({ commitAttemptId }) => {
      recordAttempts.push(commitAttemptId);
      if (loseRecordResponse) {
        loseRecordResponse = false;
        throw new Error('record_response_lost');
      }
    },
  });

  await assert.rejects(invoke, /prepare_response_lost/);
  harness.failAfter('unit_prepared');
  await assert.rejects(invoke, /crash_after_unit_prepared/);
  harness.failAfter('unit_committing');
  await assert.rejects(invoke, /crash_after_unit_committing/);
  await assert.rejects(invoke, /commit_response_lost/);
  harness.failAfter('unit_terminal');
  await assert.rejects(invoke, /crash_after_unit_terminal/);
  await assert.rejects(invoke, /record_response_lost/);
  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 1 });
  assert.deepEqual(prepareAttempts, ['prepare-1', 'prepare-1']);
  assert.deepEqual(prepareRecovery, [false, true]);
  assert.deepEqual(commitAttempts, ['commit-proposal-1', 'commit-proposal-1']);
  assert.deepEqual(recordAttempts, ['commit-proposal-1', 'commit-proposal-1']);
  assert.deepEqual(harness.events.map((event) => event.type), [
    'unit_planned',
    'stage_plan_completed',
    'unit_prepare_started',
    'unit_prepared',
    'unit_committing',
    'unit_terminal',
    'unit_recorded',
    'stage_completed',
  ]);
});

test('two-phase recovery resumes after prepare operation completion without starting a duplicate operation', async () => {
  const harness = makeHarness();
  const invoke = () => runTwoPhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    recoverPrepare: true,
    recoverCommit: true,
    prepareAttemptIdForUnit: () => 'prepare-response-loss',
    commitAttemptIdForUnit: () => 'commit-response-loss',
    prepare: async () => ({
      status: 'prepared',
      prepared: {
        prepared_handle: 'prepared-handle',
        proposal_hash: 'prepared-proposal',
      },
    }),
    commit: async ({
      activeOperation,
      completeOperation,
      resolveOutcome,
    }) => {
      const terminalResult = {
        status: 'succeeded',
        payload: { result_ids: ['prepared-result'] },
      };
      const recoveryCandidate = committedVerificationCandidate(
        'prepare-response-loss',
      ).recoveryCandidate;
      const recovery = await resolveOutcome({
        operationId: activeOperation.operation_id,
        ...recoveryCandidate,
      });
      await completeOperation({
        operationId: activeOperation.operation_id,
        status: 'succeeded',
        terminal_result: terminalResult,
      });
      return { ...terminalResult, recovery };
    },
    verifyRecoveredTerminal: async () => committedVerificationCandidate(
      'prepare-response-loss',
    ),
    record: async () => {},
  });

  harness.failAfter('unit_operation_completed#1');
  await assert.rejects(invoke, /crash_after_unit_operation_completed/);
  assert.deepEqual(
    harness.events.map((event) => event.type),
    [
      'unit_planned',
      'stage_plan_completed',
      'unit_prepare_started',
      'unit_operation_started',
      'unit_operation_completed',
    ],
  );
  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 1 });
  assert.equal(
    harness.events.filter((event) => (
      event.type === 'unit_operation_started'
      && event.payload.phase === 'prepare'
    )).length,
    1,
  );
  assert.equal(
    harness.events.filter((event) => event.type === 'unit_prepared').length,
    1,
  );
});

test('two-phase commit uses the shared outcome resolver before recording acceptance', async () => {
  const harness = makeHarness();
  const effectHash = 'e'.repeat(64);
  const result = await runTwoPhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    recoverCommit: true,
    prepareAttemptIdForUnit: () => 'prepare-shared',
    commitAttemptIdForUnit: () => 'commit-shared',
    prepare: async () => ({
      status: 'prepared',
      prepared: {
        prepared_handle: 'handle-shared',
        proposal_hash: 'proposal-shared',
        prepare_input_hash: 'prepare-input-shared',
      },
    }),
    commit: async ({
      activeOperation,
      completeOperation,
      resolveOutcome,
    }) => {
      const operationId = activeOperation.operation_id;
      const recovery = await resolveOutcome({
        operationId,
        candidateEvidence: {
          kind: 'committed',
          receiptKey: 'xop_shared',
          receiptVersion: 1,
          resultRef: 'memories:shared',
          effectHash,
        },
        snapshot: {
          receipt: {
            key: 'xop_shared',
            version: 1,
            resultRef: 'memories:shared',
            effectHash,
            status: 'succeeded',
          },
        },
        effectVerification: 'all_applied',
      });
      assert.equal(recovery.decision.action, 'replay');
      const terminalResult = {
        status: 'succeeded',
        payload: { result_ids: ['memory-shared'] },
      };
      await completeOperation({
        operationId,
        status: 'succeeded',
        terminal_result: terminalResult,
      });
      return { ...terminalResult, recovery };
    },
    record: async () => {},
  });

  assert.deepEqual(result, { status: 'completed', acceptedCount: 1 });
  assert.deepEqual(harness.events.map((event) => event.type), [
    'unit_planned',
    'stage_plan_completed',
    'unit_prepare_started',
    'unit_prepared',
    'unit_committing',
    'unit_operation_started',
    'unit_outcome_observed',
    'unit_operation_completed',
    'unit_effect_committed',
    'unit_resolution',
    'unit_recorded',
    'stage_completed',
  ]);
});

test('two-phase commit reconciliation resolves the exact generic request', async () => {
  const harness = makeHarness();
  const result = await runTwoPhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    recoverCommit: true,
    prepareAttemptIdForUnit: () => 'prepare-generic',
    commitAttemptIdForUnit: () => 'commit-generic',
    prepare: async () => ({
      status: 'prepared',
      prepared: {
        prepared_handle: 'handle-generic',
        proposal_hash: 'proposal-generic',
        prepare_input_hash: 'prepare-input-generic',
      },
    }),
    commit: async ({ activeOperation, resolveOutcome }) => {
      const recovery = await resolveOutcome({
        operationId: activeOperation.operation_id,
        candidateEvidence: {
          kind: 'unknown',
          receiptKey: 'receipt-generic-commit',
          reasonCode: 'response_lost',
        },
      });
      return {
        status: 'pending',
        recovery,
        reconciliationBinding: reconciliationBinding({
          attemptId: 'commit-generic',
          stage: 'memory_consolidate',
          marker: '3',
        }),
      };
    },
    record: async () => assert.fail('reconciling commit must not record'),
  });

  assert.equal(result.status, 'pending');
  const requested = harness.events.at(-1);
  assert.equal(requested.type, 'unit_reconciliation_requested');
  assert.equal(requested.payload.phase, 'commit');

  await harness.append('unit_reconciliation_resolved', {
    unit_id: 'unit-1',
    attempt_id: 'commit-generic',
    operation_id: 'unit-1:commit',
    phase: 'commit',
    reconciliation_request_seq: requested.seq,
    ...reconciliationBinding({
      attemptId: 'commit-generic',
      stage: 'memory_consolidate',
      marker: '3',
    }),
    reconciliation_id: 'xrec_0123456789abcdef0123456789abcdef',
    receipt_status: 'reconciled',
    result_status: 'absent',
    cause: 'orphaned_operation_result_absent',
  });

  const state = validateTwoPhaseStage(harness.events);
  assert.equal(state.units.get('unit-1').blocked, false);
  assert.equal(state.units.get('unit-1').active_operation, null);
  assert.equal(state.units.get('unit-1').recovery_state, 'running');
});

test('two-phase commit reconciliation without exact binding blocks the run', async () => {
  const harness = makeHarness();
  const result = await runTwoPhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    recoverCommit: true,
    prepareAttemptIdForUnit: () => 'prepare-missing-commit-binding',
    commitAttemptIdForUnit: () => 'commit-missing-binding',
    prepare: async () => ({
      status: 'prepared',
      prepared: {
        prepared_handle: 'handle-missing-binding',
        proposal_hash: 'proposal-missing-binding',
        prepare_input_hash: 'prepare-input-missing-binding',
      },
    }),
    commit: async ({ activeOperation, resolveOutcome }) => {
      const recovery = await resolveOutcome({
        operationId: activeOperation.operation_id,
        candidateEvidence: {
          kind: 'unknown',
          receiptKey: 'commit-receipt-without-binding',
          reasonCode: 'response_lost',
        },
      });
      return { status: 'pending', recovery };
    },
    record: async () => assert.fail('missing commit binding must not record'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.detail.reason, 'reconciliation_evidence_missing');
  assert.equal(harness.events.at(-1).type, 'run_blocked');
});

test('two-phase re-verifies a recorded commit terminal before completing the stage', async () => {
  const harness = makeHarness();
  harness.events.push(
    { seq: 0, type: 'unit_planned', payload: plan[0] },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    {
      seq: 2,
      type: 'unit_prepare_started',
      payload: { unit_id: 'unit-1', attempt_id: 'prepare-recorded' },
    },
    {
      seq: 3,
      type: 'unit_prepared',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'prepare-recorded',
        prepared_handle: 'handle-recorded',
        proposal_hash: 'proposal-recorded',
        prepare_input_hash: 'prepare-input-recorded',
      },
    },
    {
      seq: 4,
      type: 'unit_committing',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'commit-recorded',
        prepared_attempt_id: 'prepare-recorded',
      },
    },
    {
      seq: 5,
      type: 'unit_operation_started',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'commit-recorded',
        operation_id: 'unit-1:commit',
      },
    },
    {
      seq: 6,
      type: 'unit_operation_completed',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'commit-recorded',
        operation_id: 'unit-1:commit',
        status: 'succeeded',
        terminal_result: {
          status: 'succeeded',
          payload: { result_ids: ['memory-recorded'] },
        },
      },
    },
    {
      seq: 7,
      type: 'unit_terminal',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'commit-recorded',
        status: 'succeeded',
        result_ids: ['memory-recorded'],
      },
    },
    {
      seq: 8,
      type: 'unit_recorded',
      payload: { unit_id: 'unit-1', attempt_id: 'commit-recorded' },
    },
  );
  let verificationCalls = 0;

  assert.deepEqual(await runTwoPhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    prepareAttemptIdForUnit: () => 'must-not-prepare',
    commitAttemptIdForUnit: () => 'must-not-commit',
    prepare: async () => assert.fail('recorded terminal must not prepare'),
    commit: async () => assert.fail('recorded terminal must not commit'),
    verifyRecoveredTerminal: async () => {
      verificationCalls += 1;
      return committedVerificationCandidate('recorded-two-phase');
    },
    record: async () => assert.fail('recorded terminal must not record twice'),
  }), { status: 'completed', acceptedCount: 1 });
  assert.equal(verificationCalls, 1);
  assert.equal(harness.events.at(-1).type, 'stage_completed');
});

test('two-phase prepare can finish directly without entering commit', async () => {
  const harness = makeHarness();
  let commitCalls = 0;
  let recordCalls = 0;

  assert.deepEqual(await runTwoPhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    prepareAttemptIdForUnit: () => 'prepare-direct',
    commitAttemptIdForUnit: () => 'commit-must-not-exist',
    prepare: async () => ({ status: 'skipped', payload: { reason: 'no eligible input' } }),
    commit: async () => {
      commitCalls += 1;
      return { status: 'succeeded' };
    },
    record: async () => {
      recordCalls += 1;
    },
  }), { status: 'completed', acceptedCount: 1 });

  assert.equal(commitCalls, 0);
  assert.equal(recordCalls, 1);
  assert.deepEqual(harness.events.map((event) => event.type), [
    'unit_planned',
    'stage_plan_completed',
    'unit_prepare_started',
    'unit_terminal',
    'unit_recorded',
    'stage_completed',
  ]);
});

test('single-phase execution boundary never dispatches a second unresolved unit', async () => {
  const harness = makeHarness();
  const controlledPlan = ['unit-1', 'unit-2'].map((unitId) => ({
    unit_id: unitId,
    input_hash: `${unitId}-input`,
    skip_reason: 'no eligible input',
  }));
  const executed = [];
  const recorded = [];

  const result = await runSinglePhaseStage({
    events: harness.events,
    plan: controlledPlan,
    append: harness.append,
    attemptIdForUnit: (unit) => `${unit.unit_id}-attempt`,
    execute: async ({ unit }) => {
      executed.push(unit.unit_id);
      return { status: 'skipped', payload: { reason: 'no eligible input' } };
    },
    record: async ({ unit }) => recorded.push(unit.unit_id),
    executionBoundary: makeExecutionBoundary(1),
    stage: 'lessons',
  });

  assert.deepEqual(result, {
    status: 'paused',
    unitId: 'unit-1',
    processedCount: 1,
  });
  assert.deepEqual(executed, ['unit-1']);
  assert.deepEqual(recorded, ['unit-1']);
  assert.equal(harness.events.filter((event) => event.type === 'unit_recorded').length, 1);
  assert.equal(harness.events.some((event) => event.type === 'stage_completed'), false);
});

test('two-phase execution boundary keeps prepare and commit within one claimed unit', async () => {
  const harness = makeHarness();
  const controlledPlan = ['unit-1', 'unit-2'].map((unitId) => ({
    unit_id: unitId,
    input_hash: `${unitId}-input`,
    skip_reason: 'no eligible input',
  }));
  const prepared = [];
  const recorded = [];

  const result = await runTwoPhaseStage({
    events: harness.events,
    plan: controlledPlan,
    append: harness.append,
    prepareAttemptIdForUnit: (unit) => `${unit.unit_id}-prepare`,
    commitAttemptIdForUnit: (unit) => `${unit.unit_id}-commit`,
    prepare: async ({ unit }) => {
      prepared.push(unit.unit_id);
      return { status: 'skipped', payload: { reason: 'no eligible input' } };
    },
    commit: async () => assert.fail('skipped unit must not commit'),
    record: async ({ unit }) => recorded.push(unit.unit_id),
    executionBoundary: makeExecutionBoundary(1),
    stage: 'memory_consolidate',
  });

  assert.deepEqual(result, {
    status: 'paused',
    unitId: 'unit-1',
    processedCount: 1,
  });
  assert.deepEqual(prepared, ['unit-1']);
  assert.deepEqual(recorded, ['unit-1']);
  assert.equal(harness.events.filter((event) => event.type === 'unit_recorded').length, 1);
  assert.equal(harness.events.some((event) => event.type === 'stage_completed'), false);
});

test('two-phase prepare reconciliation stays pending and never becomes attention', async () => {
  const harness = makeHarness();
  let prepareCalls = 0;
  const invoke = (prepare) => runTwoPhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    prepareAttemptIdForUnit: () => 'prepare-blocked',
    commitAttemptIdForUnit: () => 'commit-must-not-exist',
    prepare,
    commit: async () => assert.fail('blocked prepare must not commit'),
    record: async () => assert.fail('blocked prepare must not record'),
  });

  assert.equal((await invoke(async () => {
    prepareCalls += 1;
    return { status: 'blocked', reason: 'extraction_operation_reconciliation_required' };
  })).status, 'pending');
  assert.equal(
    (await invoke(async () => assert.fail('blocked prepare must not redispatch'))).status,
    'pending',
  );
  assert.equal(prepareCalls, 1);
  assert.equal(harness.events.at(-1).type, 'unit_blocked');
  assert.equal(
    reduceRecoveryJournal(harness.events).units.get('unit-1').recovery.state,
    'reconciling',
  );
  assert.equal(harness.events.some((event) => event.type === 'unit_terminal'), false);
  assert.equal(harness.events.some((event) => event.type === 'run_attention_required'), false);
});

test('two-phase prepare reconciliation without exact binding blocks the run', async () => {
  const harness = makeHarness();
  const result = await runTwoPhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    recoverPrepare: true,
    prepareAttemptIdForUnit: () => 'prepare-missing-binding',
    commitAttemptIdForUnit: () => 'commit-must-not-exist',
    prepare: async () => ({
      status: 'blocked',
      recoveryCandidate: {
        candidateEvidence: {
          kind: 'unknown',
          receiptKey: 'prepare-receipt-without-binding',
          reasonCode: 'response_lost',
        },
      },
    }),
    commit: async () => assert.fail('missing prepare binding must not commit'),
    record: async () => assert.fail('missing prepare binding must not record'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.detail.reason, 'reconciliation_evidence_missing');
  assert.equal(harness.events.at(-1).type, 'run_blocked');
});

test('two-phase prepare reconciliation resolves the exact receipt and resumes safely', async () => {
  const harness = makeHarness();
  let prepareCalls = 0;
  const binding = reconciliationBinding({
    attemptId: 'prepare-reconciled',
    stage: 'memory_consolidate',
    marker: '4',
  });
  const invoke = () => runTwoPhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    recoverPrepare: true,
    prepareAttemptIdForUnit: () => 'prepare-reconciled',
    commitAttemptIdForUnit: () => 'commit-after-prepare-reconcile',
    prepare: async () => {
      prepareCalls += 1;
      if (prepareCalls === 1) {
        return {
          status: 'blocked',
          recoveryCandidate: {
            candidateEvidence: {
              kind: 'unknown',
              receiptKey: binding.receipt_key,
              reasonCode: 'response_lost',
            },
          },
          reconciliationBinding: binding,
        };
      }
      return {
        status: 'prepared',
        prepared: {
          prepared_handle: 'handle-after-reconcile',
          proposal_hash: 'proposal-after-reconcile',
          prepare_input_hash: 'prepare-input-after-reconcile',
        },
      };
    },
    commit: async () => ({ status: 'succeeded', payload: { result_ids: ['result-1'] } }),
    record: async () => {},
  });

  assert.equal((await invoke()).status, 'pending');
  const request = harness.events.at(-1);
  assert.equal(request.type, 'unit_reconciliation_requested');
  assert.equal(request.payload.phase, 'prepare');
  assert.equal(request.payload.operation_id, 'unit-1:prepare');

  await harness.append('unit_reconciliation_resolved', {
    unit_id: 'unit-1',
    attempt_id: 'prepare-reconciled',
    operation_id: 'unit-1:prepare',
    phase: 'prepare',
    reconciliation_request_seq: request.seq,
    ...binding,
    reconciliation_id: 'xrec_0123456789abcdef0123456789abcdef',
    receipt_status: 'reconciled',
    result_status: 'absent',
    cause: 'orphaned_operation_result_absent',
  });

  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 1 });
  assert.equal(prepareCalls, 2);
  assert.equal(
    harness.events.filter((event) => (
      event.type === 'unit_operation_started'
      && event.payload.phase === 'prepare'
    )).length,
    2,
  );
});

for (const failurePhase of ['prepare', 'commit']) {
  test(`two-phase ${failurePhase} failure drains independent work and blocks only dependents`, async () => {
    const harness = makeHarness();
    const multiPlan = [
      { unit_id: 'upstream', input_hash: 'input-upstream' },
      {
        unit_id: 'dependent',
        input_hash: 'input-dependent',
        depends_on: ['upstream'],
      },
      { unit_id: 'independent', input_hash: 'input-independent' },
    ];
    const prepared = [];
    const committed = [];
    const recorded = [];

    const result = await runTwoPhaseStage({
      events: harness.events,
      plan: multiPlan,
      stage: 'memory_consolidate',
      append: harness.append,
      prepareAttemptIdForUnit: (unit) => `prepare-${unit.unit_id}`,
      commitAttemptIdForUnit: ({ unit }) => `commit-${unit.unit_id}`,
      prepare: async ({ unit }) => {
        prepared.push(unit.unit_id);
        if (unit.unit_id === 'upstream' && failurePhase === 'prepare') {
          return { status: 'failed', payload: { error: 'prepare_failed' } };
        }
        return {
          status: 'prepared',
          prepared: {
            prepared_handle: `proposal-${unit.unit_id}`,
            proposal_hash: `hash-${unit.unit_id}`,
            prepare_input_hash: `input-${unit.unit_id}`,
          },
        };
      },
      commit: async ({ unit }) => {
        committed.push(unit.unit_id);
        if (unit.unit_id === 'upstream' && failurePhase === 'commit') {
          return { status: 'failed', payload: { error: 'commit_failed' } };
        }
        return { status: 'succeeded', payload: { result_ids: [`result-${unit.unit_id}`] } };
      },
      record: async ({ unit }) => recorded.push(unit.unit_id),
    });

    assert.equal(result.status, 'attention_required');
    assert.deepEqual(prepared, ['upstream', 'independent']);
    assert.deepEqual(
      committed,
      failurePhase === 'prepare' ? ['independent'] : ['upstream', 'independent'],
    );
    assert.deepEqual(recorded, ['independent']);
    assert.equal(
      harness.events.some((event) => (
        event.type === 'unit_dependency_blocked'
        && event.payload.unit_id === 'dependent'
      )),
      true,
    );
    assert.equal(harness.events.at(-1).type, 'run_attention_required');
  });
}

test('single-phase split becomes durable plan facts and resumes from child units', async () => {
  const harness = makeHarness();
  const executed = [];
  const recorded = [];
  const invoke = () => runSinglePhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    attemptIdForUnit: (unit) => `attempt-${unit.unit_id}`,
    execute: async ({ unit }) => {
      executed.push(unit.unit_id);
      if (unit.unit_id === 'unit-1') {
        return {
          status: 'split',
          children: [
            { unit_id: 'unit-1a', input_hash: 'input-1a' },
            { unit_id: 'unit-1b', input_hash: 'input-1b' },
          ],
        };
      }
      return { status: 'succeeded', payload: { result_ids: [`result-${unit.unit_id}`] } };
    },
    record: async ({ unit }) => recorded.push(unit.unit_id),
  });

  harness.failAfter('unit_split');
  await assert.rejects(invoke, /crash_after_unit_split/);
  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 2 });
  assert.deepEqual(await invoke(), { status: 'completed', acceptedCount: 2 });
  assert.deepEqual(executed, ['unit-1', 'unit-1a', 'unit-1b']);
  assert.deepEqual(recorded, ['unit-1a', 'unit-1b']);
  assert.equal(harness.events.filter((event) => event.type === 'unit_split').length, 1);
});

test('two-phase split never commits or records the parent unit', async () => {
  const harness = makeHarness();
  const prepared = [];
  const committed = [];
  const recorded = [];
  const result = await runTwoPhaseStage({
    events: harness.events,
    plan,
    append: harness.append,
    prepareAttemptIdForUnit: (unit) => `prepare-${unit.unit_id}`,
    commitAttemptIdForUnit: ({ unit }) => `commit-${unit.unit_id}`,
    prepare: async ({ unit }) => {
      prepared.push(unit.unit_id);
      if (unit.unit_id === 'unit-1') {
        return {
          status: 'split',
          children: [
            { unit_id: 'unit-1a', input_hash: 'input-1a' },
            { unit_id: 'unit-1b', input_hash: 'input-1b' },
          ],
        };
      }
      return {
        status: 'prepared',
        prepared: { prepared_handle: `handle-${unit.unit_id}`, proposal_hash: `proposal-${unit.unit_id}` },
      };
    },
    commit: async ({ unit }) => {
      committed.push(unit.unit_id);
      return { status: 'succeeded', payload: { result_ids: [`result-${unit.unit_id}`] } };
    },
    record: async ({ unit }) => recorded.push(unit.unit_id),
  });

  assert.deepEqual(result, { status: 'completed', acceptedCount: 2 });
  assert.deepEqual(prepared, ['unit-1', 'unit-1a', 'unit-1b']);
  assert.deepEqual(committed, ['unit-1a', 'unit-1b']);
  assert.deepEqual(recorded, ['unit-1a', 'unit-1b']);
});

test('recovery executors reject illegal lifecycle order instead of guessing', () => {
  assert.throws(() => validateSinglePhaseStage([
    { seq: 0, type: 'unit_planned', payload: { unit_id: 'unit-1' } },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    { seq: 2, type: 'unit_terminal', payload: { unit_id: 'unit-1', status: 'succeeded' } },
  ]), /before_started|legacy_terminal/);
  assert.throws(() => validateTwoPhaseStage([
    { seq: 0, type: 'unit_planned', payload: { unit_id: 'unit-1' } },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    { seq: 2, type: 'unit_prepare_started', payload: { unit_id: 'unit-1', attempt_id: 'prepare-1' } },
    {
      seq: 3,
      type: 'unit_prepared',
      payload: { unit_id: 'unit-1', attempt_id: 'prepare-1', prepared_handle: 'handle-1' },
    },
    { seq: 4, type: 'unit_terminal', payload: { unit_id: 'unit-1', status: 'succeeded' } },
  ]), /terminal_before_committing/);
  assert.throws(() => validateTwoPhaseStage([
    { seq: 0, type: 'unit_planned', payload: { unit_id: 'unit-1' } },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    { seq: 2, type: 'unit_prepare_started', payload: { unit_id: 'unit-1', attempt_id: 'prepare-1' } },
    {
      seq: 3,
      type: 'unit_prepared',
      payload: { unit_id: 'unit-1', attempt_id: 'prepare-other', prepared_handle: 'handle-1' },
    },
  ]), /prepared_attempt_identity/);
});

test('reducer and Runner validator fail closed on the same generic transition violations', () => {
  const plannedPrefix = [
    { seq: 0, type: 'unit_planned', payload: { unit_id: 'unit-1' } },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    {
      seq: 2,
      type: 'unit_started',
      payload: { unit_id: 'unit-1', attempt_id: 'attempt-1' },
    },
  ];
  const operationPrefix = [
    ...plannedPrefix,
    {
      seq: 3,
      type: 'unit_operation_started',
      payload: {
        unit_id: 'unit-1',
        attempt_id: 'attempt-1',
        operation_id: 'unit-1:reduce',
      },
    },
  ];
  const isolateRecovery = noEffectRecovery({ attemptsUsed: 0, maxAttempts: 0 });
  const isolateOutcome = {
    unit_id: 'unit-1',
    attempt_id: 'attempt-1',
    operation_id: 'unit-1:reduce',
    policy_version: isolateRecovery.policyVersion,
    evidence: isolateRecovery.evidence,
    decision: isolateRecovery.decision,
    budget: isolateRecovery.budget,
  };
  const replayOutcome = {
    unit_id: 'unit-1',
    attempt_id: 'attempt-1',
    operation_id: 'unit-1:reduce',
    policy_version: 'effect-state-recovery/v1',
    evidence: {
      kind: 'committed',
      receiptKey: 'receipt-1',
      receiptVersion: 1,
      resultRef: 'summary-resumable-runs:run-1',
      effectHash: 'a'.repeat(64),
    },
    decision: {
      policyVersion: 'effect-state-recovery/v1',
      action: 'replay',
    },
    budget: { attemptsUsed: 0, maxAttempts: 0 },
    effect_verification: 'all_applied',
  };
  const unknownOutcome = {
    unit_id: 'unit-1',
    attempt_id: 'attempt-1',
    operation_id: 'unit-1:reduce',
    policy_version: 'effect-state-recovery/v1',
    evidence: {
      kind: 'unknown',
      receiptKey: 'receipt-1',
      reasonCode: 'response_lost',
    },
    decision: {
      policyVersion: 'effect-state-recovery/v1',
      action: 'reconcile',
    },
    budget: { attemptsUsed: 0, maxAttempts: 0 },
  };
  const cases = [
    [
      'attempt without retry',
      [
        ...plannedPrefix,
        {
          seq: 3,
          type: 'unit_attempt_started',
          payload: {
            unit_id: 'unit-1',
            attempt_id: 'attempt-2',
            previous_attempt_id: 'attempt-1',
            attempt_number: 1,
          },
        },
      ],
    ],
    [
      'wrong operation',
      [
        ...operationPrefix,
        {
          seq: 4,
          type: 'unit_outcome_observed',
          payload: { ...isolateOutcome, operation_id: 'unit-1:other' },
        },
      ],
    ],
    [
      'resolution before effect',
      [
        ...operationPrefix,
        { seq: 4, type: 'unit_outcome_observed', payload: replayOutcome },
        {
          seq: 5,
          type: 'unit_resolution',
          payload: {
            unit_id: 'unit-1',
            attempt_id: 'attempt-1',
            status: 'succeeded',
          },
        },
      ],
    ],
    [
      'fake dependency',
      [
        {
          seq: 0,
          type: 'unit_planned',
          payload: { unit_id: 'unit-1', depends_on: ['upstream'] },
        },
        { seq: 1, type: 'unit_planned', payload: { unit_id: 'upstream' } },
        { seq: 2, type: 'stage_plan_completed', payload: { unit_count: 2 } },
        {
          seq: 3,
          type: 'unit_dependency_blocked',
          payload: {
            unit_id: 'unit-1',
            dependency_unit_ids: ['forged'],
            dependencies: [{
              stage: 'summary',
              unit_id: 'forged',
              state: 'isolated',
              terminal: 'failed',
              recorded: false,
            }],
          },
        },
      ],
    ],
    [
      'isolation with reconciliation decision',
      [
        ...operationPrefix,
        { seq: 4, type: 'unit_outcome_observed', payload: unknownOutcome },
        { seq: 5, type: 'unit_isolated', payload: unknownOutcome },
      ],
    ],
    [
      'reconciliation with isolation decision',
      [
        ...operationPrefix,
        { seq: 4, type: 'unit_outcome_observed', payload: isolateOutcome },
        { seq: 5, type: 'unit_reconciliation_requested', payload: isolateOutcome },
      ],
    ],
  ];

  for (const [name, events] of cases) {
    let reducerError;
    let validatorError;
    try {
      reduceRecoveryJournal(events);
    } catch (error) {
      reducerError = error;
    }
    try {
      validateSinglePhaseStage(events);
    } catch (error) {
      validatorError = error;
    }
    assert.ok(reducerError, `${name}: reducer must reject`);
    assert.ok(validatorError, `${name}: validator must reject`);
    assert.equal(validatorError.message, reducerError.message, name);
  }
});

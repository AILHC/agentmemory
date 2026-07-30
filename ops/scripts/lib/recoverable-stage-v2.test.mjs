import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runSinglePhaseStage,
  runTwoPhaseStage,
  validateSinglePhaseStage,
  validateTwoPhaseStage,
} from './recoverable-stage-v2.mjs';
import { reduceRecoveryJournal } from './recovery-journal-reducer-v1.mjs';

function makeHarness() {
  const events = [];
  let failAfterType = null;
  return {
    events,
    failAfter(type) {
      failAfterType = type;
    },
    async append(type, payload) {
      const event = { seq: events.length, type, payload };
      events.push(event);
      if (failAfterType === type) {
        failAfterType = null;
        throw new Error(`crash_after_${type}`);
      }
      return event;
    },
  };
}

const plan = [{ unit_id: 'unit-1', input_hash: 'input-1' }];

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
    execute: async ({ attemptId, recovered }) => {
      executeAttempts.push(attemptId);
      executeRecovery.push(recovered);
      if (loseExecuteResponse) {
        loseExecuteResponse = false;
        throw new Error('execute_response_lost');
      }
      return { status: 'succeeded', payload: { result_id: 'result-1' } };
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
    'unit_terminal',
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
        return { status: 'pending', recovery };
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
    execute: async ({ unit, attemptId, recoveryBudget, startOperation }) => {
      calls.push({ unitId: unit.unit_id, attemptId, recoveryBudget });
      if (unit.unit_id === 'independent') return { status: 'succeeded' };
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
      execute: async ({ unit, recoveryBudget, startOperation }) => {
        if (unit.unit_id === 'independent') return { status: 'succeeded' };
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

test('two-phase prepare blocking is durable and never enters commit', async () => {
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
  })).status, 'blocked');
  assert.equal((await invoke(async () => assert.fail('blocked prepare must not redispatch'))).status, 'blocked');
  assert.equal(prepareCalls, 1);
  assert.equal(harness.events.at(-1).type, 'unit_blocked');
  assert.equal(harness.events.some((event) => event.type === 'unit_terminal'), false);
});

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

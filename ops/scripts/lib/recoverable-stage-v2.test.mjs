import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runSinglePhaseStage,
  runTwoPhaseStage,
  validateSinglePhaseStage,
  validateTwoPhaseStage,
} from './recoverable-stage-v2.mjs';

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

test('single-phase blocked is durable and never becomes a failed terminal', async () => {
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
  })).status, 'blocked');
  assert.equal((await invoke(async () => assert.fail('blocked unit must not redispatch'))).status, 'blocked');
  assert.equal(calls, 1);
  assert.equal(harness.events.some((event) => event.type === 'unit_terminal'), false);
  assert.equal(harness.events.at(-1).type, 'unit_blocked');
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
  ]), /before_started/);
  assert.throws(() => validateTwoPhaseStage([
    { seq: 0, type: 'unit_planned', payload: { unit_id: 'unit-1' } },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    { seq: 2, type: 'unit_prepare_started', payload: { unit_id: 'unit-1', attempt_id: 'prepare-1' } },
    { seq: 3, type: 'unit_prepared', payload: { unit_id: 'unit-1', prepared_handle: 'handle-1' } },
    { seq: 4, type: 'unit_terminal', payload: { unit_id: 'unit-1', status: 'succeeded' } },
  ]), /terminal_before_committing/);
});

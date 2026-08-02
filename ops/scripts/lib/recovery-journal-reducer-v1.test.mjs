import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECOVERY_POLICY_READ_COMPATIBLE_HASHES,
  RECOVERY_POLICY_VERSION,
  decideRecovery,
  resolveOperationRecovery,
} from './recovery-policy-v1.mjs';
import { reduceRecoveryJournal } from './recovery-journal-reducer-v1.mjs';

function event(seq, type, payload) {
  return { seq, at: '2026-07-30T00:00:00.000Z', type, payload };
}

function outcome(seq, evidence, options = {}) {
  const decisionInput = {
    policyVersion: RECOVERY_POLICY_VERSION,
    evidence,
    budget: options.budget,
    effectVerification: options.effectVerification,
  };
  return event(seq, 'unit_outcome_observed', {
    unit_id: 'summary-1',
    attempt_id: options.attemptId || 'attempt-1',
    operation_id: options.operationId || 'summary-1:reduce',
    policy_version: RECOVERY_POLICY_VERSION,
    evidence,
    decision: decideRecovery(decisionInput),
    ...(options.verification ? { verification: true } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.effectVerification
      ? { effect_verification: options.effectVerification }
      : {}),
  });
}

test('generic journal deterministically reduces a successful Summary unit', () => {
  const evidence = {
    kind: 'committed',
    receiptKey: 'receipt-1',
    receiptVersion: 1,
    resultRef: 'summary-resumable-runs:run-1',
    effectHash: 'a'.repeat(64),
  };
  const observed = outcome(5, evidence, {
    effectVerification: 'all_applied',
    verification: true,
  });
  const events = [
    event(0, 'unit_planned', { unit_id: 'summary-1', input_hash: 'input-1' }),
    event(1, 'stage_plan_completed', { unit_count: 1 }),
    event(2, 'unit_attempt_started', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
    }),
    event(3, 'unit_operation_started', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
      operation_id: 'summary-1:reduce',
    }),
    event(4, 'unit_operation_completed', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
      operation_id: 'summary-1:reduce',
      terminal_result: { status: 'succeeded' },
    }),
    observed,
    event(6, 'unit_effect_committed', {
      ...observed.payload,
      receipt_key: 'receipt-1',
      receipt_version: 1,
      effect_hash: 'a'.repeat(64),
    }),
    event(7, 'unit_resolution', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
      status: 'succeeded',
    }),
    event(8, 'unit_recorded', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
    }),
    event(9, 'stage_completed', { unit_count: 1 }),
  ];

  const first = reduceRecoveryJournal(events);
  const second = reduceRecoveryJournal(structuredClone(events));
  assert.deepEqual(first, second);
  assert.equal(first.units.get('summary-1').recovery.state, 'succeeded');
  assert.equal(first.run.acceptance_ready, true);
  assert.deepEqual(first.run.projection, {
    total: 1,
    succeeded: 1,
    skipped: 0,
    retry_wait: 0,
    reconciling: 0,
    isolated: 0,
    dependency_blocked: 0,
    runnable: 0,
    running: 0,
    blocked: 0,
    system_blocked: 0,
  });
});

test('unknown outcome remains coordinating and cannot become retry', () => {
  const evidence = {
    kind: 'unknown',
    receiptKey: 'receipt-1',
    reasonCode: 'response_lost',
  };
  const events = [
    event(0, 'unit_planned', { unit_id: 'summary-1' }),
    event(1, 'stage_plan_completed', { unit_count: 1 }),
    event(2, 'unit_attempt_started', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
    }),
    event(3, 'unit_operation_started', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
      operation_id: 'summary-1:reduce',
    }),
  ];
  const observed = outcome(4, evidence);
  events.push(
    observed,
    event(5, 'unit_reconciliation_requested', {
      ...observed.payload,
      phase: 'execute',
      receipt_key: `xop_${'1'.repeat(32)}`,
      receipt_run_id: 'attempt-1',
      receipt_stage: 'summary',
      receipt_unit_id: 'summary-1:reduce',
      receipt_input_hash: 'a'.repeat(64),
      receipt_started_at: '2026-07-30T00:00:00.000Z',
    }),
  );
  const reduced = reduceRecoveryJournal(events);
  assert.equal(reduced.units.get('summary-1').recovery.state, 'reconciling');
  assert.equal(reduced.run.projection.reconciling, 1);
  assert.equal(reduced.run.projection.retry_wait, 0);
});

test('retry budget and deadline survive reduction until the next immutable attempt', () => {
  const retryAt = '2026-07-30T00:00:10.000Z';
  const evidence = {
    kind: 'no_effect',
    observation: 'execution_error',
    reasonCode: 'provider_unavailable',
    retryHint: { notBefore: retryAt },
    proof: {
      kind: 'request_not_dispatched',
      attemptId: 'attempt-1',
      journalSeq: 2,
    },
  };
  const budget = { attemptsUsed: 0, maxAttempts: 1 };
  const observed = outcome(4, evidence, { budget });
  const waitingEvents = [
    event(0, 'unit_planned', { unit_id: 'summary-1' }),
    event(1, 'stage_plan_completed', { unit_count: 1 }),
    event(2, 'unit_attempt_started', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
    }),
    event(3, 'unit_operation_started', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
      operation_id: 'summary-1:reduce',
    }),
    observed,
    event(5, 'unit_retry_scheduled', {
      ...observed.payload,
      attempts_used: 1,
      max_attempts: 1,
      attempt_number: 1,
      retry_at: retryAt,
    }),
  ];

  const waiting = reduceRecoveryJournal(waitingEvents);
  assert.equal(waiting.run.status, 'running');
  assert.equal(waiting.run.next_retry_at, retryAt);
  assert.equal(waiting.run.projection.retry_wait, 1);
  assert.equal(waiting.units.get('summary-1').recovery.retry.max_attempts, 1);

  const resumed = reduceRecoveryJournal([
    ...waitingEvents,
    event(6, 'unit_attempt_started', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-2',
      previous_attempt_id: 'attempt-1',
      attempt_number: 1,
      attempts_used: 1,
      max_attempts: 1,
    }),
  ]);
  assert.equal(resumed.run.next_retry_at, null);
  assert.equal(resumed.run.projection.retry_wait, 0);
  assert.equal(resumed.units.get('summary-1').recovery.attempts.length, 2);
  assert.equal(resumed.units.get('summary-1').recovery.attempts[1].max_attempts, 1);
});

test('reducer rejects altered decisions and unknown event structures', () => {
  const evidence = {
    kind: 'unknown',
    receiptKey: 'receipt-1',
    reasonCode: 'response_lost',
  };
  const altered = outcome(4, evidence);
  altered.payload.decision = { policyVersion: RECOVERY_POLICY_VERSION, action: 'retry' };
  const prefix = [
    event(0, 'unit_planned', { unit_id: 'summary-1' }),
    event(1, 'stage_plan_completed', { unit_count: 1 }),
    event(2, 'unit_attempt_started', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
    }),
    event(3, 'unit_operation_started', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
      operation_id: 'summary-1:reduce',
    }),
  ];
  assert.throws(
    () => reduceRecoveryJournal([...prefix, altered]),
    /recovery_journal_decision_invalid/,
  );
  assert.throws(
    () => reduceRecoveryJournal([...prefix, event(4, 'unit_future_state', { unit_id: 'summary-1' })]),
    /recovery_journal_event_unsupported/,
  );

  const recovery = resolveOperationRecovery({
    candidateEvidence: evidence,
    snapshot: {},
  });
  const bound = event(4, 'unit_outcome_observed', {
    unit_id: 'summary-1',
    attempt_id: 'attempt-1',
    operation_id: 'summary-1:reduce',
    policy_version: recovery.policyVersion,
    policy_hash: recovery.policyHash,
    evidence: recovery.evidence,
    decision: recovery.decision,
    normalization: recovery.normalization,
  });
  assert.doesNotThrow(() => reduceRecoveryJournal([...prefix, bound]));
  const historical = structuredClone(bound);
  historical.payload.policy_hash = RECOVERY_POLICY_READ_COMPATIBLE_HASHES[0];
  assert.doesNotThrow(() => reduceRecoveryJournal([...prefix, historical]));
  const unknownPolicy = structuredClone(bound);
  unknownPolicy.payload.policy_hash = 'f'.repeat(64);
  assert.throws(
    () => reduceRecoveryJournal([...prefix, unknownPolicy]),
    /recovery_journal_decision_invalid/,
  );
  bound.payload.normalization.normalized_evidence_hash = 'f'.repeat(64);
  assert.throws(
    () => reduceRecoveryJournal([...prefix, bound]),
    /recovery_journal_decision_invalid/,
  );
});

test('legacy terminal events remain readable without generating legacy authorization', () => {
  const reduced = reduceRecoveryJournal([
    event(0, 'unit_planned', { unit_id: 'summary-1' }),
    event(1, 'stage_plan_completed', { unit_count: 1 }),
    event(2, 'unit_started', { unit_id: 'summary-1', attempt_id: 'attempt-1' }),
    event(3, 'unit_terminal', {
      unit_id: 'summary-1',
      attempt_id: 'attempt-1',
      status: 'skipped',
    }),
    event(4, 'unit_recorded', { unit_id: 'summary-1', attempt_id: 'attempt-1' }),
    event(5, 'stage_completed', { unit_count: 1 }),
  ]);
  assert.equal(reduced.units.get('summary-1').terminal, 'skipped');
  assert.equal(reduced.run.acceptance_ready, true);
});

test('accepted and recorded units are not acceptance-ready before stage completion', () => {
  const events = [
    event(0, 'unit_planned', { unit_id: 'unit-1', input_hash: 'input-1' }),
    event(1, 'stage_plan_completed', { unit_count: 1 }),
    event(2, 'unit_started', { unit_id: 'unit-1', attempt_id: 'attempt-1' }),
    event(3, 'unit_terminal', {
      unit_id: 'unit-1',
      attempt_id: 'attempt-1',
      status: 'skipped',
      reason: 'no input',
      result_ids: [],
    }),
    event(4, 'unit_recorded', { unit_id: 'unit-1', attempt_id: 'attempt-1' }),
  ];

  assert.equal(reduceRecoveryJournal(events).run.acceptance_ready, false);
  events.push(event(5, 'stage_completed', { unit_count: 1, accepted_count: 1 }));
  assert.equal(reduceRecoveryJournal(events).run.acceptance_ready, true);
});

test('migration privilege cannot be forged without a validated fence manifest', () => {
  const evidence = {
    kind: 'no_effect',
    observation: 'business_empty',
    reasonCode: 'legacy_empty',
    proof: {
      kind: 'request_not_dispatched',
      attemptId: 'attempt-1',
      journalSeq: 2,
    },
  };
  assert.throws(
    () => reduceRecoveryJournal([
      event(0, 'unit_planned', { unit_id: 'summary-1' }),
      event(1, 'stage_plan_completed', { unit_count: 1 }),
      event(2, 'unit_started', {
        unit_id: 'summary-1',
        attempt_id: 'attempt-1',
      }),
      event(3, 'unit_terminal', {
        unit_id: 'summary-1',
        attempt_id: 'attempt-1',
        status: 'failed',
      }),
      event(4, 'unit_outcome_observed', {
        unit_id: 'summary-1',
        attempt_id: 'attempt-1',
        operation_id: 'summary-1:legacy',
        policy_version: RECOVERY_POLICY_VERSION,
        evidence,
        decision: decideRecovery({
          policyVersion: RECOVERY_POLICY_VERSION,
          evidence,
        }),
        migration_id: 'xmig_0123456789abcdef0123456789abcdef',
      }),
    ]),
    /recovery_migration_privilege_without_fence/,
  );
});

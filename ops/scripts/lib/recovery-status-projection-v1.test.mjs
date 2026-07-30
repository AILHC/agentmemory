import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECOVERY_POLICY_VERSION,
  decideRecovery,
} from './recovery-policy-v1.mjs';
import {
  monitorSafeRecoveryStatus,
  projectSafeRecoveryStatus,
} from './recovery-status-projection-v1.mjs';

function event(seq, type, payload, at = '2026-07-30T00:00:00.000Z') {
  return { seq, type, payload, at };
}

function coordinatingStage(secretSentinel) {
  const evidence = {
    kind: 'unknown',
    receiptKey: 'safe-receipt-key',
    reasonCode: 'response_lost',
  };
  const decision = decideRecovery({
    policyVersion: RECOVERY_POLICY_VERSION,
    evidence,
  });
  return [
    event(0, 'unit_planned', { unit_id: 'summary-a', input_hash: 'safe-hash' }),
    event(1, 'stage_plan_completed', { unit_count: 1 }),
    event(2, 'unit_attempt_started', {
      unit_id: 'summary-a',
      attempt_id: 'attempt-a',
    }),
    event(3, 'unit_operation_started', {
      unit_id: 'summary-a',
      attempt_id: 'attempt-a',
      operation_id: 'summary-a:reduce',
    }),
    event(4, 'unit_outcome_observed', {
      unit_id: 'summary-a',
      attempt_id: 'attempt-a',
      operation_id: 'summary-a:reduce',
      policy_version: RECOVERY_POLICY_VERSION,
      evidence,
      decision,
      error: secretSentinel,
    }),
    event(5, 'unit_reconciliation_requested', {
      unit_id: 'summary-a',
      attempt_id: 'attempt-a',
      operation_id: 'summary-a:reduce',
      policy_version: RECOVERY_POLICY_VERSION,
      evidence,
      decision,
      error: secretSentinel,
    }),
  ];
}

test('safe status counts are the exact projection from the unique reducer', () => {
  const status = projectSafeRecoveryStatus({
    runId: 'status-run',
    controlEvents: [event(0, 'run_started', {
      run_id: 'status-run',
      recovery_policy_version: RECOVERY_POLICY_VERSION,
    })],
    stageEvents: {
      summary: coordinatingStage('restricted-prompt-body'),
      lessons: [
        event(0, 'unit_planned', { unit_id: 'lesson-a' }),
        event(1, 'stage_plan_completed', { unit_count: 1 }),
        event(2, 'unit_started', {
          unit_id: 'lesson-a',
          attempt_id: 'legacy-attempt',
        }),
        event(3, 'unit_terminal', {
          unit_id: 'lesson-a',
          attempt_id: 'legacy-attempt',
          status: 'failed',
        }),
      ],
    },
  });
  assert.deepEqual(status.counts, {
    total: 2,
    succeeded: 0,
    skipped: 0,
    runnable: 0,
    running: 0,
    retry_wait: 0,
    reconciling: 1,
    isolated: 1,
    dependency_blocked: 0,
    blocked: 0,
    system_blocked: 0,
  });
  assert.equal(status.run_status, 'attention_required');
  assert.equal(status.acceptance_ready, false);
});

test('safe status and monitor never expose restricted payloads or raw provider errors', () => {
  const sentinel = 'SECRET_SENTINEL_PROMPT_RESPONSE_CREDENTIAL';
  const status = projectSafeRecoveryStatus({
    runId: 'blocked-run',
    controlEvents: [event(0, 'run_started', { run_id: 'blocked-run' })],
    stageEvents: {
      summary: [
        ...coordinatingStage(sentinel),
        event(6, 'run_blocked', {
          code: 'receipt_integrity_error',
          provider_error: sentinel,
          response: sentinel,
        }),
      ],
    },
  });
  const monitor = monitorSafeRecoveryStatus(status, {
    runnerAlive: false,
    runtimeHealthy: true,
  });
  assert.equal(status.run_status, 'blocked');
  assert.deepEqual(status.system_block_reason_codes, ['receipt_integrity_error']);
  assert.equal(monitor.system_blocked, true);
  assert.equal(JSON.stringify({ status, monitor }).includes(sentinel), false);
  assert.equal(JSON.stringify({ status, monitor }).includes('provider_error'), false);
});

test('monitor only reports health, stalling, attention, blocking, and acceptance facts', () => {
  const status = {
    run_status: 'running',
    last_progress_at: '2026-07-30T00:00:00.000Z',
    acceptance_ready: false,
    system_block_reason_codes: [],
  };
  const monitor = monitorSafeRecoveryStatus(status, {
    runnerAlive: true,
    runtimeHealthy: false,
    now: Date.parse('2026-07-30T00:20:00.000Z'),
    staleAfterMs: 15 * 60 * 1000,
  });
  assert.deepEqual(monitor, {
    runner_healthy: true,
    runtime_healthy: false,
    scheduling_stalled: true,
    attention_required: false,
    system_blocked: false,
    acceptance_ready: false,
    reason_codes: [],
  });
  assert.equal('retry' in monitor, false);
  assert.equal('repair' in monitor, false);
});

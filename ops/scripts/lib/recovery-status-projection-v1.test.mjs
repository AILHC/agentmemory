import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECOVERY_POLICY_VERSION,
  decideRecovery,
} from './recovery-policy-v1.mjs';
import { buildRecoveryMigrationManifest } from './recovery-frontier-migration-v1.mjs';
import { reduceRecoveryJournal } from './recovery-journal-reducer-v1.mjs';
import {
  monitorSafeRecoveryStatus,
  projectSafeRecoveryStatus,
} from './recovery-status-projection-v1.mjs';

function event(seq, type, payload, at = '2026-07-30T00:00:00.000Z') {
  return { seq, type, payload, at };
}

function coordinatingStage(secretSentinel) {
  const attemptId = 'a'.repeat(64);
  const runnerInputHash = 'b'.repeat(64);
  const receiptInputHash = 'c'.repeat(64);
  const receiptKey = `xop_${'d'.repeat(32)}`;
  const evidence = {
    kind: 'unknown',
    receiptKey,
    reasonCode: 'response_lost',
  };
  const decision = decideRecovery({
    policyVersion: RECOVERY_POLICY_VERSION,
    evidence,
  });
  return [
    event(0, 'unit_planned', { unit_id: 'summary-a', input_hash: runnerInputHash }),
    event(1, 'stage_plan_completed', { unit_count: 1 }),
    event(2, 'unit_attempt_started', {
      unit_id: 'summary-a',
      attempt_id: attemptId,
    }),
    event(3, 'unit_operation_started', {
      unit_id: 'summary-a',
      attempt_id: attemptId,
      operation_id: 'summary-a:reduce',
    }),
    event(4, 'unit_outcome_observed', {
      unit_id: 'summary-a',
      attempt_id: attemptId,
      operation_id: 'summary-a:reduce',
      policy_version: RECOVERY_POLICY_VERSION,
      evidence,
      decision,
      error: secretSentinel,
    }),
    event(5, 'unit_reconciliation_requested', {
      unit_id: 'summary-a',
      attempt_id: attemptId,
      operation_id: 'summary-a:reduce',
      phase: 'execute',
      reconciliation_request_seq: 5,
      policy_version: RECOVERY_POLICY_VERSION,
      evidence,
      decision,
      receipt_key: receiptKey,
      receipt_run_id: attemptId,
      receipt_stage: 'summary',
      receipt_unit_id: 'summary-a:reduce',
      receipt_input_hash: receiptInputHash,
      receipt_started_at: '2026-07-30T00:00:00.000Z',
      error: secretSentinel,
    }),
  ];
}

function completedStage(unitId) {
  return [
    event(0, 'unit_planned', { unit_id: unitId, input_hash: `${unitId}-input` }),
    event(1, 'stage_plan_completed', { unit_count: 1 }),
    event(2, 'unit_started', { unit_id: unitId, attempt_id: `${unitId}-attempt` }),
    event(3, 'unit_terminal', {
      unit_id: unitId,
      attempt_id: `${unitId}-attempt`,
      status: 'skipped',
      reason: 'no input',
      result_ids: [],
    }),
    event(4, 'unit_recorded', { unit_id: unitId, attempt_id: `${unitId}-attempt` }),
    event(5, 'stage_completed', { unit_count: 1, accepted_count: 1 }),
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

test('reducer and safe projection are deterministic for identical journal input', () => {
  const stageEvents = completedStage('deterministic-unit');
  const input = {
    runId: 'deterministic-run',
    controlEvents: [event(0, 'run_started', {
      run_id: 'deterministic-run',
      recovery_policy_version: RECOVERY_POLICY_VERSION,
    })],
    stageEvents: { summary: stageEvents },
    requiredStages: ['summary'],
  };

  const firstReduced = reduceRecoveryJournal(stageEvents);
  const secondReduced = reduceRecoveryJournal(structuredClone(stageEvents));
  assert.deepEqual(firstReduced, secondReduced);

  const firstProjection = projectSafeRecoveryStatus(input);
  const secondProjection = projectSafeRecoveryStatus(structuredClone(input));
  assert.deepEqual(firstProjection, secondProjection);
  assert.deepEqual(firstProjection.counts, firstReduced.run.projection);
  assert.equal(firstProjection.acceptance_ready, firstReduced.run.acceptance_ready);
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

test('safe status cannot accept a run while any required stage is absent', () => {
  const status = projectSafeRecoveryStatus({
    runId: 'missing-stage-run',
    stageEvents: {
      summary: completedStage('summary-a'),
    },
    requiredStages: ['summary', 'lessons', 'summary'],
  });

  assert.equal(status.acceptance_ready, false);
  assert.equal(status.run_status, 'running');
  assert.deepEqual(status.missing_required_stages, ['lessons']);
  assert.equal(status.stages[0].acceptance_ready, true);
});

test('migration reason clears only after every frozen migration step is durable', () => {
  const runId = 'migrated-status-run';
  const legacyEvents = completedStage('summary-a');
  const manifest = buildRecoveryMigrationManifest({
    runId,
    stage: 'summary',
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
  const fencedEvents = [
    ...legacyEvents,
    event(manifest.fence_seq, 'stage_recovery_contract_fenced', manifest),
  ];
  const controlEvents = [event(0, 'run_started', { run_id: runId })];

  const fenced = projectSafeRecoveryStatus({
    runId,
    controlEvents,
    stageEvents: { summary: fencedEvents },
    requiredStages: ['summary'],
  });
  assert.equal(fenced.run_status, 'blocked');
  assert.deepEqual(fenced.system_block_reason_codes, ['recovery_migration_incomplete']);

  const migrated = projectSafeRecoveryStatus({
    runId,
    controlEvents,
    stageEvents: {
      summary: [
        ...fencedEvents,
        ...manifest.steps.map((step) => event(
          step.expected_seq + 1,
          step.type,
          step.payload,
        )),
      ],
    },
    requiredStages: ['summary'],
  });
  assert.equal(migrated.run_status, 'completed');
  assert.deepEqual(migrated.system_block_reason_codes, []);
  assert.equal(migrated.stages[0].system_block_reason_code, null);
});

test('the latest control event distinguishes an operator pause from a resumed run', () => {
  const stageEvents = {
    summary: [
      event(0, 'unit_planned', { unit_id: 'summary-a' }),
      event(1, 'stage_plan_completed', { unit_count: 1 }),
    ],
  };
  const pausedControl = [
    event(0, 'run_started', { run_id: 'paused-run' }),
    event(1, 'run_paused', {
      run_id: 'paused-run',
      reason_code: 'resume_unit_limit_reached',
      stage: 'summary',
      unit_id: 'summary-a',
      processed_unit_count: 1,
      max_units_per_resume: 1,
    }),
  ];
  const paused = projectSafeRecoveryStatus({
    runId: 'paused-run',
    controlEvents: pausedControl,
    stageEvents,
    requiredStages: ['summary'],
  });
  assert.equal(paused.run_status, 'paused');

  const resumed = projectSafeRecoveryStatus({
    runId: 'paused-run',
    controlEvents: [
      ...pausedControl,
      event(2, 'run_resumed', { run_id: 'paused-run', previous_pause_seq: 1 }),
    ],
    stageEvents,
    requiredStages: ['summary'],
  });
  assert.equal(resumed.run_status, 'running');
});

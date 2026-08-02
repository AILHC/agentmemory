import {
  RECOVERY_POLICY_VERSION,
  RECOVERY_SYSTEM_FAULT_CODES,
} from './recovery-policy-v1.mjs';
import { reduceRecoveryJournal } from './recovery-journal-reducer-v1.mjs';
import { reduceRunControlLifecycle } from './run-state-journal-v2.mjs';

const SAFE_SYSTEM_CODES = new Set([
  ...RECOVERY_SYSTEM_FAULT_CODES,
  'recovery_migration_incomplete',
  'recovery_contract_version_unsupported',
]);

function latestTimestamp(events) {
  return events
    .map((event) => event.at)
    .filter((value) => Number.isFinite(Date.parse(value || '')))
    .sort()
    .at(-1) || null;
}

function safeSystemCode(reduced) {
  const candidate = reduced.run.block?.code
    || reduced.run.block?.decision?.code;
  return SAFE_SYSTEM_CODES.has(candidate) ? candidate : null;
}

function projectStage(stage, events) {
  const reduced = reduceRecoveryJournal(events);
  return {
    stage,
    run_status: reduced.run.status,
    recovery_contract_version: reduced.run.fence?.recovery_contract_version
      || RECOVERY_POLICY_VERSION,
    counts: { ...reduced.run.projection },
    last_progress_at: latestTimestamp(events),
    next_retry_at: reduced.run.next_retry_at,
    acceptance_ready: reduced.run.acceptance_ready,
    system_block_reason_code: safeSystemCode(reduced),
  };
}

export function projectSafeRecoveryStatus({
  runId,
  controlEvents = [],
  stageEvents = {},
  requiredStages = [],
  incrementalStatus = null,
}) {
  if (
    incrementalStatus
    && (
      incrementalStatus.schema !== 'agentmemory-incremental-extraction-status/v1'
      || incrementalStatus.run_id !== runId
      || !Array.isArray(incrementalStatus.stages)
    )
  ) throw new Error('incremental_recovery_status_invalid');
  const controlLifecycle = reduceRunControlLifecycle(controlEvents);
  const normalizedRequiredStages = [...new Set(
    requiredStages.filter((stage) => typeof stage === 'string' && stage),
  )];
  const incrementalByStage = new Map(
    (incrementalStatus?.stages ?? []).map((stage) => [stage.stage, stage]),
  );
  const stages = Object.keys(stageEvents)
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((stage) => {
      const projected = projectStage(stage, stageEvents[stage]);
      const incremental = incrementalByStage.get(stage);
      return incremental
        ? {
            ...projected,
            acceptance_ready: projected.acceptance_ready
              && incremental.acceptance_ready === true,
            incremental,
          }
        : projected;
    });
  const selectedStages = normalizedRequiredStages.length > 0
    ? stages.filter((entry) => normalizedRequiredStages.includes(entry.stage))
    : stages;
  const presentStageNames = new Set(stages.map((entry) => entry.stage));
  const missingRequiredStages = normalizedRequiredStages.filter(
    (stage) => !presentStageNames.has(stage),
  );
  const counts = {
    total: 0,
    succeeded: 0,
    skipped: 0,
    runnable: 0,
    running: 0,
    retry_wait: 0,
    reconciling: 0,
    isolated: 0,
    dependency_blocked: 0,
    blocked: 0,
    system_blocked: 0,
  };
  for (const stage of selectedStages) {
    for (const key of Object.keys(counts)) counts[key] += stage.counts[key] || 0;
  }
  const runCompleted = controlLifecycle.state === 'completed';
  const recoveryAcceptanceReady = (
    selectedStages.length > 0
    && missingRequiredStages.length === 0
    && (
      normalizedRequiredStages.length === 0
      || selectedStages.length === normalizedRequiredStages.length
    )
    && selectedStages.every((stage) => stage.acceptance_ready)
    && (normalizedRequiredStages.length > 0 || runCompleted)
  );
  const acceptanceReady = recoveryAcceptanceReady
    && (!incrementalStatus || incrementalStatus.acceptance_ready === true);
  const lastProgressAt = latestTimestamp([
    ...controlEvents,
    ...Object.values(stageEvents).flat(),
  ]);
  const systemCodes = stages
    .map((stage) => stage.system_block_reason_code)
    .filter(Boolean);
  const incrementalAttention = Boolean(incrementalStatus && !incrementalStatus.acceptance_ready);
  const status = counts.system_blocked > 0
    ? 'blocked'
    : controlLifecycle.state === 'paused'
      ? 'paused'
      : counts.isolated > 0 || counts.dependency_blocked > 0 || incrementalAttention
        ? 'attention_required'
        : acceptanceReady
          ? 'completed'
          : counts.runnable > 0 || counts.running > 0
            ? 'running'
            : counts.retry_wait > 0 || counts.reconciling > 0
              ? 'waiting'
              : 'running';
  const started = controlEvents.find((event) => event.type === 'run_started');
  const contractVersions = new Set(
    stages.map((stage) => stage.recovery_contract_version).filter(Boolean),
  );
  if (started?.payload?.recovery_policy_version) {
    contractVersions.add(started.payload.recovery_policy_version);
  }
  return {
    run_id: runId,
    run_status: status,
    pause_reason_code: controlLifecycle.state === 'paused'
      ? controlLifecycle.pause.payload.reason_code
      : null,
    recovery_contract_version: contractVersions.size === 1
      ? [...contractVersions][0]
      : contractVersions.size === 0
        ? null
        : 'mixed',
    counts,
    last_progress_at: lastProgressAt,
    next_retry_at: stages
      .map((stage) => stage.next_retry_at)
      .filter(Boolean)
      .sort()
      .at(0) || null,
    acceptance_ready: acceptanceReady,
    missing_required_stages: missingRequiredStages,
    system_block_reason_codes: [...new Set(systemCodes)].sort(),
    ...(incrementalStatus ? { incremental: incrementalStatus } : {}),
    stages,
  };
}

export function monitorSafeRecoveryStatus(
  status,
  { runnerAlive, runtimeHealthy, now = Date.now(), staleAfterMs = 15 * 60 * 1000 },
) {
  const lastProgressMs = Date.parse(status.last_progress_at || '');
  const stalled = (
    status.run_status === 'running'
    && Number.isFinite(lastProgressMs)
    && now - lastProgressMs > staleAfterMs
  );
  return {
    runner_healthy: runnerAlive === true,
    runtime_healthy: runtimeHealthy === true,
    scheduling_stalled: stalled,
    attention_required: status.run_status === 'attention_required',
    system_blocked: status.run_status === 'blocked',
    acceptance_ready: status.acceptance_ready === true,
    reason_codes: status.system_block_reason_codes,
  };
}

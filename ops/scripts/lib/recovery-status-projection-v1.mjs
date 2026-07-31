import {
  RECOVERY_POLICY_VERSION,
  RECOVERY_SYSTEM_FAULT_CODES,
} from './recovery-policy-v1.mjs';
import { reduceRecoveryJournal } from './recovery-journal-reducer-v1.mjs';

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
    || reduced.run.block?.decision?.code
    || reduced.run.fence && 'recovery_migration_incomplete';
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
}) {
  const normalizedRequiredStages = [...new Set(
    requiredStages.filter((stage) => typeof stage === 'string' && stage),
  )];
  const stages = Object.keys(stageEvents)
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((stage) => projectStage(stage, stageEvents[stage]));
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
  const runCompleted = controlEvents.some((event) => event.type === 'run_completed');
  const acceptanceReady = (
    selectedStages.length > 0
    && missingRequiredStages.length === 0
    && (
      normalizedRequiredStages.length === 0
      || selectedStages.length === normalizedRequiredStages.length
    )
    && selectedStages.every((stage) => stage.acceptance_ready)
    && (normalizedRequiredStages.length > 0 || runCompleted)
  );
  const lastProgressAt = latestTimestamp([
    ...controlEvents,
    ...Object.values(stageEvents).flat(),
  ]);
  const systemCodes = stages
    .map((stage) => stage.system_block_reason_code)
    .filter(Boolean);
  const status = counts.system_blocked > 0
    ? 'blocked'
    : counts.isolated > 0 || counts.dependency_blocked > 0
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

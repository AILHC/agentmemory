import {
  RECOVERY_POLICY_VERSION,
  decideRecovery,
} from './recovery-policy-v1.mjs';
import {
  assertRecoveryMigrationPrivileges,
  inspectRecoveryMigrationGate,
} from './recovery-migration-contract-v1.mjs';

const ACCEPTED_RESOLUTIONS = new Set(['succeeded', 'skipped']);

function transitionError(event, reason) {
  throw new Error(`recovery_journal_transition_invalid_at_seq_${event.seq}:${event.type}:${reason}`);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ensureMutableUnit(event, unit) {
  if (!unit?.planned) transitionError(event, 'unit_not_planned');
  if (unit.recorded) transitionError(event, 'after_recorded');
  const migrationStep = typeof event.payload?.migration_id === 'string';
  if (unit.terminal && !migrationStep) transitionError(event, 'after_terminal');
  if (unit.blocked && !migrationStep) transitionError(event, 'after_blocked');
}

function latestOutcome(unit) {
  return unit?.recovery.outcomes.at(-1) || null;
}

function validateRecoveryAction(event, unit, action) {
  const payload = event.payload;
  const outcome = latestOutcome(unit);
  if (
    !outcome
    || payload.attempt_id !== unit.attempt_id
    || payload.operation_id !== outcome.operation_id
    || payload.policy_version !== outcome.policy_version
    || !same(payload.evidence, outcome.evidence)
    || !same(payload.decision, outcome.decision)
    || !same(payload.budget, outcome.budget)
    || payload.effect_verification !== outcome.effect_verification
    || payload.decision?.action !== action
  ) {
    transitionError(event, `recovery_action_${action}`);
  }
}

function declaredDependency(unit, dependency) {
  return (unit.depends_on || []).find((declared) => (
    typeof declared === 'string'
      ? declared === dependency.unit_id
      : declared?.stage === dependency.stage && declared?.unit_id === dependency.unit_id
  ));
}

function unitFor(units, unitId) {
  const unit = units.get(unitId) || {
    unit_id: unitId,
    started: false,
    prepared: false,
    committing: false,
    terminal: null,
    blocked: false,
    recorded: false,
    active_operation: null,
    completed_operations: [],
    recovery: {
      attempts: [],
      outcomes: [],
      decisions: [],
      state: 'planned',
    },
  };
  units.set(unitId, unit);
  return unit;
}

function assertEvent(event, expectedSeq) {
  if (
    !event
    || !Number.isSafeInteger(event.seq)
    || event.seq !== expectedSeq
    || typeof event.type !== 'string'
    || !event.type
    || !event.payload
    || typeof event.payload !== 'object'
    || Array.isArray(event.payload)
  ) {
    throw new Error(`recovery_journal_integrity_error_at_seq_${expectedSeq}`);
  }
}

function requireUnit(event) {
  const unitId = event.payload.unit_id;
  if (typeof unitId !== 'string' || !unitId) {
    throw new Error(`recovery_journal_unit_id_invalid_at_seq_${event.seq}`);
  }
  return unitId;
}

function validLegacySummaryAuthorization(event, unit) {
  const payload = event.payload;
  const completed = unit.completed_operations.at(-1);
  const lastSafe = payload.last_safe_failure;
  return (
    !unit.blocked
    && !unit.recorded
    && !unit.active_operation
    && unit.terminal === 'failed'
    && payload.stage === 'summary'
    && payload.attempt_id === unit.attempt_id
    && payload.operation_id === `${unit.unit_id}:reduce`
    && payload.runner_input_hash === unit.input_hash
    && /^[0-9a-f]{64}$/.test(String(payload.receipt_input_hash || ''))
    && payload.receipt_status === 'failed'
    && ['transient_provider', 'transient_runtime'].includes(payload.failure_class)
    && typeof payload.failure_cause === 'string'
    && payload.failure_cause.length > 0
    && ['provider_call', 'before_final_persistence'].includes(payload.failure_phase)
    && Number.isSafeInteger(payload.retry_epoch)
    && payload.retry_epoch >= 0
    && lastSafe?.error_class === payload.failure_class
    && lastSafe?.cause === payload.failure_cause
    && lastSafe?.phase === payload.failure_phase
    && Number.isFinite(Date.parse(lastSafe?.timestamp || ''))
    && completed?.attempt_id === unit.attempt_id
    && completed?.operation_id === payload.operation_id
    && completed?.status === 'failed'
    && completed?.error === payload.failure_cause
    && completed?.terminal_result?.status === 'failed'
    && completed?.terminal_result?.payload?.error === payload.failure_cause
    && unit.terminal_payload?.error === payload.failure_cause
    && payload.superseded_operation_seq === completed.seq
    && payload.superseded_terminal_seq === unit.terminal_seq
    && payload.expected_journal_seq === unit.terminal_seq
    && event.seq === unit.terminal_seq + 1
  );
}

function validLegacyLessonsAuthorization(event, unit) {
  const payload = event.payload;
  const lastSafe = payload.last_safe_failure;
  const proof = payload.lesson_run_evidence;
  return (
    !unit.blocked
    && !unit.recorded
    && !unit.active_operation
    && unit.terminal === 'failed'
    && payload.stage === 'lessons'
    && payload.attempt_id === unit.attempt_id
    && payload.runner_input_hash === unit.input_hash
    && /^[0-9a-f]{64}$/.test(String(payload.receipt_input_hash || ''))
    && payload.receipt_status === 'failed'
    && payload.receipt_failure_class === 'transient_provider'
    && payload.receipt_failure_cause === 'lesson_extraction_failed'
    && payload.failure_class === 'transient_provider'
    && payload.failure_cause === 'lesson_extraction_failed'
    && payload.failure_phase === 'provider_call'
    && payload.retry_epoch === 0
    && lastSafe?.error_class === payload.failure_class
    && lastSafe?.cause === payload.failure_cause
    && lastSafe?.phase === payload.failure_phase
    && Number.isFinite(Date.parse(lastSafe?.timestamp || ''))
    && proof?.status === 'retryable'
    && /^[0-9a-f]{64}$/.test(String(proof?.input_hash || ''))
    && /^[0-9a-f]{64}$/.test(String(proof?.config_hash || ''))
    && ['rate_limited', 'timeout', 'network_error', 'server_error'].includes(
      proof?.failure_cause,
    )
    && proof?.failure_phase === 'provider_call'
    && proof?.failed_at === lastSafe.timestamp
    && proof?.created_lesson_count === 0
    && proof?.replaced_lesson_count === 0
    && proof?.chunk_lesson_count === 0
    && unit.terminal_payload?.error === payload.receipt_failure_cause
    && payload.superseded_terminal_seq === unit.terminal_seq
    && payload.expected_journal_seq === unit.terminal_seq
    && event.seq === unit.terminal_seq + 1
  );
}

function applyGenericEvent(event, unit, run, units) {
  const payload = event.payload;
  if (event.type === 'unit_attempt_started') {
    const migrationAttemptRepair = (
      typeof payload.migration_id === 'string'
      && unit.started
      && !unit.attempt_id
      && unit.recovery.attempts.length === 0
    );
    const initialAttempt = (
      (!unit.started && !unit.recovery.retry)
      || migrationAttemptRepair
    );
    const retryAttempt = (
      unit.recovery.retry
      && payload.attempt_id !== unit.attempt_id
      && payload.previous_attempt_id === unit.attempt_id
      && payload.attempt_number === unit.recovery.retry.attempt_number
    );
    if (
      typeof payload.attempt_id !== 'string'
      || !payload.attempt_id
      || (!initialAttempt && !retryAttempt)
      || !unit.planned
      || unit.recorded
      || unit.terminal
      || unit.blocked
    ) {
      throw new Error(`recovery_journal_attempt_invalid_at_seq_${event.seq}`);
    }
    unit.started = true;
    unit.attempt_id = payload.attempt_id;
    unit.active_operation = null;
    unit.blocked = false;
    unit.blocked_payload = undefined;
    unit.recovery.attempts.push({
      seq: event.seq,
      ...payload,
      attempt_number: payload.attempt_number ?? 0,
    });
    unit.recovery.retry = null;
    unit.recovery.state = 'running';
    return true;
  }
  if (event.type === 'unit_outcome_observed') {
    const completedOperation = unit.completed_operations.at(-1);
    const verifiesCompletedOperation = (
      payload.verification === true
      && payload.operation_id === completedOperation?.operation_id
      && ACCEPTED_RESOLUTIONS.has(completedOperation?.terminal_result?.status)
    );
    const migrationStep = typeof payload.migration_id === 'string';
    const decision = decideRecovery({
      policyVersion: payload.policy_version,
      evidence: payload.evidence,
      budget: payload.budget,
      effectVerification: payload.effect_verification,
    });
    if (
      payload.policy_version !== RECOVERY_POLICY_VERSION
      || JSON.stringify(decision) !== JSON.stringify(payload.decision)
      || !unit.planned
      || !unit.started
      || unit.recorded
      || (unit.blocked && !migrationStep)
      || (unit.terminal && !verifiesCompletedOperation && !migrationStep)
      || payload.attempt_id !== unit.attempt_id
      || typeof payload.operation_id !== 'string'
      || !payload.operation_id
      || (
        !verifiesCompletedOperation
        && !migrationStep
        && payload.operation_id !== unit.active_operation?.operation_id
      )
    ) {
      throw new Error(`recovery_journal_decision_invalid_at_seq_${event.seq}`);
    }
    unit.recovery.outcomes.push({ seq: event.seq, ...payload });
    unit.recovery.decisions.push({ seq: event.seq, ...decision });
    if (migrationStep) {
      if (unit.terminal) {
        unit.superseded_terminals = [...(unit.superseded_terminals || []), {
          seq: unit.terminal_seq,
          payload: unit.terminal_payload,
        }];
      }
      unit.terminal = null;
      unit.terminal_payload = undefined;
      unit.blocked = false;
      unit.blocked_payload = undefined;
      unit.recovery.state = 'running';
    }
    return true;
  }
  if (event.type === 'unit_retry_scheduled') {
    ensureMutableUnit(event, unit);
    validateRecoveryAction(event, unit, 'retry');
    if (
      payload.attempt_id !== unit.attempt_id
      || payload.decision?.action !== 'retry'
      || !Number.isSafeInteger(payload.attempts_used)
      || !Number.isSafeInteger(payload.max_attempts)
      || payload.attempts_used < 1
      || payload.attempts_used > payload.max_attempts
      || payload.attempts_used !== payload.budget?.attemptsUsed + 1
      || payload.max_attempts !== payload.budget?.maxAttempts
      || !Number.isSafeInteger(payload.attempt_number)
      || !Number.isFinite(Date.parse(payload.retry_at || ''))
    ) {
      throw new Error(`recovery_journal_retry_invalid_at_seq_${event.seq}`);
    }
    unit.recovery.state = 'retry_wait';
    unit.recovery.retry = payload;
    return true;
  }
  if (event.type === 'unit_reconciliation_requested') {
    ensureMutableUnit(event, unit);
    validateRecoveryAction(event, unit, 'reconcile');
    if (
      typeof payload.migration_id !== 'string'
      && payload.operation_id !== unit.active_operation?.operation_id
    ) {
      transitionError(event, 'reconciliation_operation');
    }
    unit.terminal = null;
    unit.terminal_payload = undefined;
    unit.blocked = true;
    unit.blocked_payload = payload;
    unit.recovery.state = 'reconciling';
    return true;
  }
  if (event.type === 'unit_reconciliation_resolved') {
    const legacyResolution = (
      unit?.planned
      && unit.blocked
      && !unit.active_operation
      && payload.result_status === 'absent'
    );
    if (
      !legacyResolution
      && (
        !unit?.planned
        || !unit.blocked
        || !unit.active_operation
        || payload.attempt_id !== unit.attempt_id
        || payload.operation_id !== unit.active_operation.operation_id
        || !/^xrec_[0-9a-f]{32}$/.test(String(payload.reconciliation_id || ''))
        || !/^[0-9a-f]{64}$/.test(String(payload.receipt_input_hash || ''))
        || payload.receipt_status !== 'reconciled'
        || payload.result_status !== 'absent'
        || payload.cause !== 'orphaned_operation_result_absent'
      )
    ) {
      transitionError(event, 'reconciliation_resolution');
    }
    unit.blocked = false;
    unit.blocked_payload = undefined;
    unit.active_operation = null;
    if (legacyResolution) unit.started = false;
    unit.recovery.reconciliation = payload;
    unit.recovery.state = 'running';
    return true;
  }
  if (event.type === 'unit_commit_resumed') {
    ensureMutableUnit(event, unit);
    const action = payload.decision?.action;
    if (!['resume_commit', 'reconcile_commit'].includes(action)) {
      transitionError(event, 'commit_resume_action');
    }
    validateRecoveryAction(event, unit, action);
    unit.recovery.state = 'committing';
    unit.recovery.commit = payload;
    return true;
  }
  if (event.type === 'unit_effect_committed') {
    ensureMutableUnit(event, unit);
    validateRecoveryAction(event, unit, 'replay');
    unit.recovery.effect = payload;
    unit.recovery.state = 'committed';
    return true;
  }
  if (event.type === 'unit_resolution') {
    ensureMutableUnit(event, unit);
    const outcome = latestOutcome(unit);
    const action = outcome?.decision?.action;
    const resolutionValid = (
      action === 'replay'
      && payload.status === 'succeeded'
      && unit.recovery.effect
      && unit.recovery.effect.attempt_id === payload.attempt_id
    ) || (
      action === 'skipped'
      && payload.status === 'skipped'
    );
    if (
      !resolutionValid
      || payload.attempt_id !== unit.attempt_id
      || !['succeeded', 'skipped', 'failed'].includes(payload.status)
    ) {
      throw new Error(`recovery_journal_resolution_invalid_at_seq_${event.seq}`);
    }
    unit.terminal = payload.status;
    unit.terminal_payload = payload;
    unit.terminal_seq = event.seq;
    unit.recovery.state = payload.status;
    return true;
  }
  if (event.type === 'unit_isolated') {
    ensureMutableUnit(event, unit);
    validateRecoveryAction(event, unit, 'isolate');
    unit.blocked = false;
    unit.blocked_payload = undefined;
    unit.terminal = 'failed';
    unit.terminal_payload = payload;
    unit.terminal_seq = event.seq;
    unit.recovery.state = 'isolated';
    return true;
  }
  if (event.type === 'unit_dependency_blocked') {
    const dependencies = payload.dependencies;
    if (
      !unit?.planned
      || unit.started
      || unit.terminal
      || unit.blocked
      || !Array.isArray(dependencies)
      || dependencies.length === 0
      || !Array.isArray(payload.dependency_unit_ids)
      || dependencies.length !== payload.dependency_unit_ids.length
      || dependencies.some((dependency, index) => {
        const declared = declaredDependency(unit, dependency);
        if (
          !declared
          || dependency.unit_id !== payload.dependency_unit_ids[index]
          || !(
            dependency.terminal === 'failed'
            || ['isolated', 'dependency_blocked'].includes(dependency.state)
          )
        ) return true;
        if (typeof declared !== 'string') return false;
        const source = units.get(dependency.unit_id);
        return !source || !(
          source.terminal === 'failed'
          || ['isolated', 'dependency_blocked'].includes(source.recovery.state)
        );
      })
    ) {
      transitionError(event, 'dependency_block');
    }
    unit.blocked = true;
    unit.blocked_payload = payload;
    unit.recovery.state = 'dependency_blocked';
    return true;
  }
  if (event.type === 'run_attention_required') {
    const attentionUnits = [...units.values()].filter((candidate) => (
      candidate.terminal === 'failed'
      || ['isolated', 'dependency_blocked'].includes(candidate.recovery.state)
    ));
    if (
      attentionUnits.length === 0
      || !Array.isArray(payload.unit_ids)
      || payload.unit_ids.some((unitId) => (
        !attentionUnits.some((candidate) => candidate.unit_id === unitId)
      ))
    ) {
      transitionError(event, 'attention_without_units');
    }
    run.status = 'attention_required';
    return true;
  }
  if (event.type === 'run_blocked') {
    if (payload.unit_id) {
      const blockedUnit = units.get(payload.unit_id);
      validateRecoveryAction(event, blockedUnit, 'block_run');
    }
    run.status = 'blocked';
    run.block = payload;
    return true;
  }
  if (event.type === 'run_completed') {
    run.status = 'completed';
    return true;
  }
  return false;
}

export function reduceRecoveryJournal(events) {
  const migrationGate = inspectRecoveryMigrationGate(events);
  assertRecoveryMigrationPrivileges(events, migrationGate);
  const units = new Map();
  const run = { status: 'running' };
  let planCompleted = false;
  let completed = false;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    assertEvent(event, index);
    if (event.type === 'stage_plan_completed') {
      if (planCompleted) transitionError(event, 'duplicate_plan_completed');
      planCompleted = true;
      continue;
    }
    if (event.type === 'stage_completed') {
      if (
        !planCompleted
        || completed
        || [...units.values()].some((unit) => (
          !unit.split
          && (!ACCEPTED_RESOLUTIONS.has(unit.terminal) || !unit.recorded)
        ))
      ) {
        transitionError(event, 'stage_completion');
      }
      completed = true;
      continue;
    }
    if (event.type === 'stage_recovery_contract_fenced') {
      run.status = 'blocked';
      run.fence = event.payload;
      continue;
    }
    if (
      event.type === 'stage_recovery_migration_started'
      || event.type === 'stage_recovery_migration_completed'
    ) {
      run.migration = { type: event.type, ...event.payload };
      if (event.type === 'stage_recovery_migration_completed' && !run.block) {
        run.status = 'running';
      }
      continue;
    }
    const unitId = event.payload?.unit_id || null;
    if (event.type.startsWith('run_')) {
      const runUnit = unitId ? units.get(unitId) : null;
      if (applyGenericEvent(event, runUnit, run, units)) continue;
      throw new Error(`recovery_journal_event_unsupported_at_seq_${event.seq}:${event.type}`);
    }
    if (!unitId) {
      if (applyGenericEvent(event, null, run, units)) continue;
      throw new Error(`recovery_journal_event_unsupported_at_seq_${event.seq}:${event.type}`);
    }
    const unit = unitFor(units, requireUnit(event));
    if (applyGenericEvent(event, unit, run, units)) continue;

    if (event.type === 'unit_planned') {
      if (planCompleted || unit.planned) transitionError(event, 'duplicate_or_late_plan');
      Object.assign(unit, event.payload, { planned: true });
    }
    else if (event.type === 'unit_started') {
      if (
        !planCompleted
        || !unit.planned
        || unit.started
        || typeof event.payload.attempt_id !== 'string'
        || !event.payload.attempt_id
      ) {
        transitionError(event, 'unit_start');
      }
      unit.started = true;
      unit.attempt_id = event.payload.attempt_id;
      unit.recovery.attempts.push({
        seq: event.seq,
        ...event.payload,
        attempt_number: 0,
      });
      unit.recovery.state = 'running';
    } else if (event.type === 'unit_prepare_started') {
      unit.started = true;
      unit.prepare_attempt_id = event.payload.attempt_id;
    } else if (event.type === 'unit_operation_started') {
      ensureMutableUnit(event, unit);
      if (
        !unit.started
        || unit.active_operation
        || event.payload.attempt_id !== unit.attempt_id
        || typeof event.payload.operation_id !== 'string'
        || !event.payload.operation_id
        || unit.completed_operations.some((operation) => (
          operation.operation_id === event.payload.operation_id
        ))
      ) {
        transitionError(event, 'operation_start');
      }
      unit.active_operation = event.payload;
      unit.recovery.state = 'running';
    } else if (event.type === 'unit_operation_completed') {
      ensureMutableUnit(event, unit);
      if (
        !unit.active_operation
        || event.payload.attempt_id !== unit.attempt_id
        || event.payload.operation_id !== unit.active_operation.operation_id
      ) {
        transitionError(event, 'operation_completion');
      }
      unit.completed_operations.push({ ...event.payload, seq: event.seq });
      unit.active_operation = null;
    } else if (event.type === 'unit_prepared') {
      unit.prepared = true;
      unit.prepared_payload = event.payload;
    } else if (event.type === 'unit_committing') {
      unit.committing = true;
      unit.commit_attempt_id = event.payload.attempt_id;
    } else if (event.type === 'unit_terminal') {
      ensureMutableUnit(event, unit);
      if (
        !unit.started
        || unit.active_operation
        || event.payload.attempt_id !== unit.attempt_id
        || !['succeeded', 'skipped', 'failed'].includes(event.payload.status)
      ) {
        transitionError(event, 'legacy_terminal');
      }
      unit.terminal = event.payload.status;
      unit.terminal_payload = event.payload;
      unit.terminal_seq = event.seq;
      unit.recovery.state = event.payload.status === 'failed'
        ? 'isolated'
        : event.payload.status;
    } else if (event.type === 'unit_blocked') {
      ensureMutableUnit(event, unit);
      if (
        !unit.started
        || event.payload.attempt_id !== unit.attempt_id
      ) {
        transitionError(event, 'legacy_block');
      }
      unit.blocked = true;
      unit.blocked_payload = event.payload;
      unit.recovery.state = 'reconciling';
    } else if (event.type === 'unit_split') {
      ensureMutableUnit(event, unit);
      if (
        !unit.started
        || unit.active_operation
        || event.payload.attempt_id !== unit.attempt_id
        || !Array.isArray(event.payload.children)
        || event.payload.children.length < 2
      ) {
        transitionError(event, 'unit_split');
      }
      unit.split = true;
      unit.split_payload = event.payload;
      for (const child of event.payload.children) {
        if (
          typeof child?.unit_id !== 'string'
          || !child.unit_id
          || units.has(child.unit_id)
        ) {
          transitionError(event, 'split_child');
        }
        const childUnit = unitFor(units, child.unit_id);
        Object.assign(childUnit, child, {
          planned: true,
          split_from: unit.unit_id,
        });
      }
    } else if (
      event.type === 'unit_summary_failed_terminal_retry_authorized'
      || event.type === 'unit_lessons_failed_terminal_retry_authorized'
    ) {
      const valid = event.type === 'unit_summary_failed_terminal_retry_authorized'
        ? validLegacySummaryAuthorization(event, unit)
        : validLegacyLessonsAuthorization(event, unit);
      if (!valid) continue;
      if (event.type === 'unit_summary_failed_terminal_retry_authorized') {
        unit.superseded_operations = [...(unit.superseded_operations || []), {
          seq: event.payload?.superseded_operation_seq,
          payload: unit.completed_operations.pop(),
        }];
      }
      unit.superseded_terminals = [...(unit.superseded_terminals || []), {
        seq: unit.terminal_seq,
        payload: unit.terminal_payload,
      }];
      unit.terminal = null;
      unit.terminal_payload = undefined;
      unit.retry_authorization = event.payload;
      unit.recovery.state = 'planned';
    } else if (event.type === 'unit_recorded') {
      if (
        unit.recorded
        || !ACCEPTED_RESOLUTIONS.has(unit.terminal)
        || event.payload.attempt_id !== unit.terminal_payload?.attempt_id
      ) {
        transitionError(event, 'unit_record');
      }
      unit.recorded = true;
    } else {
      throw new Error(`recovery_journal_event_unsupported_at_seq_${event.seq}:${event.type}`);
    }
  }

  if (run.status === 'running' && completed) run.status = 'completed';
  if (migrationGate.state === 'fenced') {
    run.status = 'blocked';
    run.block = {
      code: 'recovery_migration_incomplete',
      migration_id: migrationGate.manifest.migration_id,
      manifest_hash: migrationGate.manifest.manifest_hash,
    };
  }
  const states = [...units.values()].map((unit) => unit.recovery.state);
  const projection = {
    total: units.size,
    succeeded: [...units.values()].filter((unit) => unit.terminal === 'succeeded').length,
    skipped: [...units.values()].filter((unit) => unit.terminal === 'skipped').length,
    retry_wait: states.filter((state) => state === 'retry_wait').length,
    reconciling: states.filter((state) => state === 'reconciling').length,
    isolated: states.filter((state) => state === 'isolated').length,
    dependency_blocked: states.filter((state) => state === 'dependency_blocked').length,
    runnable: [...units.values()].filter((unit) => (
      !unit.split
      && !unit.terminal
      && !unit.blocked
      && unit.recovery.state !== 'retry_wait'
      && (!unit.started || unit.recovery.state === 'planned')
    )).length,
    running: [...units.values()].filter((unit) => (
      !unit.split
      && unit.started
      && !unit.terminal
      && !unit.blocked
      && unit.recovery.state === 'running'
    )).length,
    blocked: run.status === 'blocked' ? 1 : 0,
    system_blocked: run.status === 'blocked' ? 1 : 0,
  };
  const retryTimes = [...units.values()]
    .map((unit) => unit.recovery.retry?.retry_at)
    .filter(Boolean)
    .sort();
  const acceptanceReady = (
    units.size > 0
    && [...units.values()].every((unit) => (
      unit.split || (ACCEPTED_RESOLUTIONS.has(unit.terminal) && unit.recorded)
    ))
  );
  return {
    units,
    planCompleted,
    completed,
    run: {
      ...run,
      acceptance_ready: acceptanceReady,
      projection,
      next_retry_at: retryTimes[0] || null,
    },
  };
}

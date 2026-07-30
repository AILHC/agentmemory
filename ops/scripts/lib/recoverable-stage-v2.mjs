import { foldRecoveryStageEvents } from './run-state-journal-v2.mjs';
import { reduceRecoveryJournal } from './recovery-journal-reducer-v1.mjs';

const ACCEPTED_TERMINALS = new Set(['succeeded', 'skipped']);
const TERMINALS = new Set([...ACCEPTED_TERMINALS, 'failed']);
const PLAN_EVENTS = new Set(['unit_planned', 'stage_plan_completed']);
const SINGLE_EVENTS = new Set([
  ...PLAN_EVENTS,
  'unit_started',
  'unit_attempt_started',
  'unit_operation_started',
  'unit_operation_completed',
  'unit_outcome_observed',
  'unit_retry_scheduled',
  'unit_reconciliation_requested',
  'unit_commit_resumed',
  'unit_effect_committed',
  'unit_resolution',
  'unit_isolated',
  'unit_dependency_blocked',
  'run_attention_required',
  'run_blocked',
  'stage_recovery_contract_fenced',
  'stage_recovery_migration_started',
  'stage_recovery_migration_completed',
  'unit_split',
  'unit_terminal',
  'unit_blocked',
  'unit_reconciliation_resolved',
  'unit_summary_failed_terminal_retry_authorized',
  'unit_lessons_failed_terminal_retry_authorized',
  'unit_recorded',
  'stage_completed',
]);
const TWO_PHASE_EVENTS = new Set([
  ...PLAN_EVENTS,
  'unit_prepare_started',
  'unit_split',
  'unit_prepared',
  'unit_committing',
  'unit_terminal',
  'unit_blocked',
  'unit_recorded',
  'stage_completed',
]);

function transitionError(mode, event, reason) {
  throw new Error(`v2_${mode}_transition_invalid_at_seq_${String(event.seq ?? '?')}:${event.type}:${reason}`);
}

function assertUnitId(event, mode) {
  const unitId = event.payload?.unit_id;
  if (typeof unitId !== 'string' || !unitId) transitionError(mode, event, 'unit_id');
  return unitId;
}

function createUnit(unitId) {
  return {
    unit_id: unitId,
    planned: false,
    started: false,
    prepared: false,
    committing: false,
    split: false,
    terminal: null,
    blocked: false,
    recorded: false,
    active_operation: null,
    completed_operations: [],
    completed_operation_events: [],
    superseded_operations: [],
    superseded_terminals: [],
    attempt_number: 0,
  };
}

function acceptedUnitCount(units) {
  return [...units.values()].filter((unit) => !unit.split).length;
}

function validateStageEvents(events, mode) {
  if (mode === 'single') reduceRecoveryJournal(events);
  const allowed = mode === 'single' ? SINGLE_EVENTS : TWO_PHASE_EVENTS;
  const units = new Map();
  let planCompleted = false;
  let completed = false;
  let runBlocked = null;
  let runAttentionRequired = null;
  for (const event of events) {
    if (!allowed.has(event.type)) transitionError(mode, event, 'event_type');
    if (completed) transitionError(mode, event, 'after_stage_completed');
    if (
      event.type === 'stage_recovery_contract_fenced'
      || event.type === 'stage_recovery_migration_started'
      || event.type === 'stage_recovery_migration_completed'
    ) {
      continue;
    }
    if (event.type === 'unit_planned') {
      if (planCompleted) transitionError(mode, event, 'planned_after_plan_completed');
      const unitId = assertUnitId(event, mode);
      if (units.has(unitId)) transitionError(mode, event, 'duplicate_plan');
      units.set(unitId, { ...createUnit(unitId), ...event.payload, planned: true });
      continue;
    }
    if (event.type === 'stage_plan_completed') {
      if (planCompleted) transitionError(mode, event, 'duplicate_plan_completed');
      planCompleted = true;
      continue;
    }
    if (event.type === 'stage_completed') {
      if (!planCompleted) transitionError(mode, event, 'before_plan_completed');
      if ([...units.values()].some((unit) =>
        !unit.split && (!ACCEPTED_TERMINALS.has(unit.terminal) || !unit.recorded))) {
        transitionError(mode, event, 'units_not_accepted');
      }
      completed = true;
      continue;
    }
    if (event.type === 'run_blocked') {
      if (!planCompleted) transitionError(mode, event, 'before_plan_completed');
      runBlocked = event.payload;
      continue;
    }
    if (event.type === 'run_attention_required') {
      if (!planCompleted) transitionError(mode, event, 'before_plan_completed');
      runAttentionRequired = event.payload;
      continue;
    }
    if (!planCompleted) transitionError(mode, event, 'before_plan_completed');
    const unitId = assertUnitId(event, mode);
    const unit = units.get(unitId);
    if (!unit) transitionError(mode, event, 'unit_not_planned');
    if (event.type === 'unit_attempt_started') {
      if (
        mode !== 'single'
        || !unit.retry_scheduled
        || event.payload?.previous_attempt_id !== unit.attempt_id
        || typeof event.payload?.attempt_id !== 'string'
        || !event.payload.attempt_id
        || event.payload.attempt_id === unit.attempt_id
        || event.payload?.attempt_number !== unit.retry_scheduled.attempt_number
      ) {
        transitionError(mode, event, 'retry_attempt');
      }
      unit.started = true;
      unit.attempt_id = event.payload.attempt_id;
      unit.attempt_number = event.payload.attempt_number;
      unit.retry_attempts_used = unit.retry_scheduled.attempts_used;
      unit.retry_max_attempts = unit.retry_scheduled.max_attempts;
      unit.retry_scheduled = null;
      unit.active_operation = null;
      unit.blocked = false;
      unit.blocked_payload = undefined;
      unit.recovery_state = 'running';
      continue;
    }
    if (event.type === 'unit_reconciliation_resolved') {
      if (mode !== 'single') transitionError(mode, event, 'reconciliation_mode');
      if (!unit.blocked) transitionError(mode, event, 'reconciliation_without_block');
      if (!unit.active_operation) transitionError(mode, event, 'reconciliation_without_active_operation');
      if (
        event.payload?.attempt_id !== unit.attempt_id
        || event.payload?.operation_id !== unit.active_operation.operation_id
      ) {
        transitionError(mode, event, 'reconciliation_operation_identity');
      }
      if (
        unit.blocked_payload?.reason !== 'extraction_operation_reconciliation_required'
        || !/^xrec_[0-9a-f]{32}$/.test(String(event.payload?.reconciliation_id || ''))
        || !/^[0-9a-f]{64}$/.test(String(event.payload?.receipt_input_hash || ''))
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          String(event.payload?.receipt_started_at || ''),
        )
        || event.payload?.receipt_status !== 'reconciled'
        || event.payload?.result_status !== 'absent'
        || event.payload?.cause !== 'orphaned_operation_result_absent'
      ) {
        transitionError(mode, event, 'reconciliation_evidence');
      }
      unit.blocked = false;
      unit.blocked_payload = undefined;
      if (unit.retry_authorization?.operation_id === event.payload.operation_id) {
        unit.retry_authorization = null;
      }
      unit.active_operation = null;
      unit.reconciliations = [...(unit.reconciliations || []), event.payload];
      continue;
    }
    if (event.type === 'unit_reconciliation_requested') {
      if (
        mode !== 'single'
        || event.payload?.attempt_id !== unit.attempt_id
        || event.payload?.decision?.action !== 'reconcile'
      ) {
        transitionError(mode, event, 'reconciliation_request');
      }
      unit.blocked = true;
      unit.blocked_payload = event.payload;
      unit.recovery_state = 'reconciling';
      continue;
    }
    if (event.type === 'unit_commit_resumed') {
      if (
        mode !== 'single'
        || event.payload?.attempt_id !== unit.attempt_id
        || !['resume_commit', 'reconcile_commit'].includes(event.payload?.decision?.action)
      ) {
        transitionError(mode, event, 'commit_resume');
      }
      unit.recovery_state = 'committing';
      continue;
    }
    if (mode === 'single' && event.type === 'unit_outcome_observed') {
      const activeOperationId = unit.active_operation?.operation_id;
      const completedOperation = unit.completed_operations.at(-1);
      const completedOperationId = completedOperation?.operation_id;
      const verifiesCompletedOperation = event.payload?.verification === true
        && event.payload?.operation_id === completedOperationId
        && ACCEPTED_TERMINALS.has(completedOperation?.terminal_result?.status);
      if (
        event.payload?.attempt_id !== unit.attempt_id
        || (!verifiesCompletedOperation && event.payload?.operation_id !== activeOperationId)
        || !event.payload?.evidence
        || !event.payload?.decision
      ) {
        transitionError(mode, event, 'outcome_identity');
      }
      unit.recovery_outcomes = [...(unit.recovery_outcomes || []), event.payload];
      continue;
    }
    if (event.type === 'unit_retry_scheduled') {
      if (
        mode !== 'single'
        || event.payload?.attempt_id !== unit.attempt_id
        || event.payload?.decision?.action !== 'retry'
        || !Number.isSafeInteger(event.payload?.attempts_used)
        || !Number.isSafeInteger(event.payload?.max_attempts)
        || event.payload.attempts_used < 1
        || event.payload.attempts_used > event.payload.max_attempts
        || event.payload.attempts_used !== event.payload.budget?.attemptsUsed + 1
        || event.payload.max_attempts !== event.payload.budget?.maxAttempts
        || !Number.isSafeInteger(event.payload?.attempt_number)
        || event.payload.attempt_number !== unit.attempt_number + 1
        || !Number.isFinite(Date.parse(event.payload?.retry_at || ''))
      ) {
        transitionError(mode, event, 'retry_schedule');
      }
      unit.retry_scheduled = event.payload;
      unit.recovery_state = 'retry_wait';
      continue;
    }
    if (event.type === 'unit_effect_committed') {
      if (
        mode !== 'single'
        || event.payload?.attempt_id !== unit.attempt_id
        || event.payload?.decision?.action !== 'replay'
      ) {
        transitionError(mode, event, 'effect_commit');
      }
      unit.effect_committed = event.payload;
      continue;
    }
    if (event.type === 'unit_isolated') {
      if (
        mode !== 'single'
        || event.payload?.attempt_id !== unit.attempt_id
        || event.payload?.decision?.action !== 'isolate'
      ) {
        transitionError(mode, event, 'isolation');
      }
      unit.terminal = 'failed';
      unit.terminal_payload = event.payload;
      unit.terminal_seq = event.seq;
      unit.recovery_state = 'isolated';
      continue;
    }
    if (event.type === 'unit_dependency_blocked') {
      const dependencyIds = event.payload?.dependency_unit_ids;
      const dependencies = event.payload?.dependencies;
      const declaredDependency = (dependency) => (unit.depends_on || []).find((declared) => (
        typeof declared === 'string'
          ? declared === dependency.unit_id
          : declared.stage === dependency.stage && declared.unit_id === dependency.unit_id
      ));
      if (
        mode !== 'single'
        || unit.started
        || !Array.isArray(dependencyIds)
        || dependencyIds.length === 0
        || !Array.isArray(dependencies)
        || dependencies.length !== dependencyIds.length
        || dependencies.some((dependency, index) => {
          const declared = declaredDependency(dependency);
          if (
            !dependency
            || typeof dependency.stage !== 'string'
            || !dependency.stage
            || dependency.unit_id !== dependencyIds[index]
            || !declared
            || !dependencyFailed(dependency)
          ) return true;
          const local = typeof declared === 'string'
            ? units.get(dependency.unit_id)
            : null;
          if (!local) return false;
          return !(
            local.terminal === 'failed'
            || ['isolated', 'dependency_blocked'].includes(local.recovery_state)
          );
        })
      ) {
        transitionError(mode, event, 'dependency_block');
      }
      unit.blocked = true;
      unit.blocked_payload = event.payload;
      unit.recovery_state = 'dependency_blocked';
      continue;
    }
    if (event.type === 'unit_summary_failed_terminal_retry_authorized') {
      const completedOperation = unit.completed_operation_events.at(-1);
      const lastSafeFailure = event.payload?.last_safe_failure;
      if (
        mode !== 'single'
        || unit.blocked
        || unit.recorded
        || unit.active_operation
        || unit.terminal !== 'failed'
        || event.payload?.stage !== 'summary'
        || event.payload?.attempt_id !== unit.attempt_id
        || event.payload?.operation_id !== `${unitId}:reduce`
        || event.payload?.runner_input_hash !== unit.input_hash
        || !/^[0-9a-f]{64}$/.test(String(event.payload?.receipt_input_hash || ''))
        || event.payload?.receipt_status !== 'failed'
        || !['transient_provider', 'transient_runtime'].includes(event.payload?.failure_class)
        || typeof event.payload?.failure_cause !== 'string'
        || !event.payload.failure_cause
        || !['provider_call', 'before_final_persistence'].includes(event.payload?.failure_phase)
        || !Number.isSafeInteger(event.payload?.retry_epoch)
        || event.payload.retry_epoch < 0
        || lastSafeFailure?.error_class !== event.payload.failure_class
        || lastSafeFailure?.cause !== event.payload.failure_cause
        || lastSafeFailure?.phase !== event.payload.failure_phase
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          String(lastSafeFailure?.timestamp || ''),
        )
        || !completedOperation
        || completedOperation.payload?.attempt_id !== unit.attempt_id
        || completedOperation.payload?.operation_id !== event.payload.operation_id
        || completedOperation.payload?.status !== 'failed'
        || completedOperation.payload?.error !== event.payload.failure_cause
        || completedOperation.payload?.terminal_result?.status !== 'failed'
        || completedOperation.payload?.terminal_result?.payload?.error
          !== event.payload.failure_cause
        || unit.terminal_payload?.error !== event.payload.failure_cause
        || event.payload?.superseded_operation_seq !== completedOperation.seq
        || event.payload?.superseded_terminal_seq !== unit.terminal_seq
        || event.payload?.expected_journal_seq !== unit.terminal_seq
        || event.seq !== unit.terminal_seq + 1
      ) {
        transitionError(mode, event, 'retry_authorization_evidence');
      }
      unit.completed_operations.pop();
      unit.completed_operation_events.pop();
      unit.superseded_operations.push(completedOperation);
      unit.superseded_terminals.push({
        seq: unit.terminal_seq,
        payload: unit.terminal_payload,
      });
      unit.terminal = null;
      unit.terminal_payload = undefined;
      unit.terminal_seq = undefined;
      unit.retry_authorization = event.payload;
      continue;
    }
    if (event.type === 'unit_lessons_failed_terminal_retry_authorized') {
      const lastSafeFailure = event.payload?.last_safe_failure;
      const lessonEvidence = event.payload?.lesson_run_evidence;
      if (
        mode !== 'single'
        || unit.blocked
        || unit.recorded
        || unit.active_operation
        || unit.terminal !== 'failed'
        || event.payload?.stage !== 'lessons'
        || event.payload?.attempt_id !== unit.attempt_id
        || event.payload?.runner_input_hash !== unit.input_hash
        || !/^[0-9a-f]{64}$/.test(String(event.payload?.receipt_input_hash || ''))
        || event.payload?.receipt_status !== 'failed'
        || event.payload?.receipt_failure_class !== 'transient_provider'
        || event.payload?.receipt_failure_cause !== 'lesson_extraction_failed'
        || event.payload?.failure_class !== 'transient_provider'
        || event.payload?.failure_cause !== 'lesson_extraction_failed'
        || event.payload?.failure_phase !== 'provider_call'
        || event.payload?.retry_epoch !== 0
        || lastSafeFailure?.error_class !== event.payload.failure_class
        || lastSafeFailure?.cause !== event.payload.failure_cause
        || lastSafeFailure?.phase !== event.payload.failure_phase
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          String(lastSafeFailure?.timestamp || ''),
        )
        || lessonEvidence?.status !== 'retryable'
        || !/^[0-9a-f]{64}$/.test(String(lessonEvidence?.input_hash || ''))
        || !/^[0-9a-f]{64}$/.test(String(lessonEvidence?.config_hash || ''))
        || !['rate_limited', 'timeout', 'network_error', 'server_error'].includes(
          lessonEvidence?.failure_cause,
        )
        || lessonEvidence?.failure_phase !== 'provider_call'
        || lessonEvidence?.failed_at !== lastSafeFailure.timestamp
        || lessonEvidence?.created_lesson_count !== 0
        || lessonEvidence?.replaced_lesson_count !== 0
        || lessonEvidence?.chunk_lesson_count !== 0
        || unit.terminal_payload?.error !== event.payload.receipt_failure_cause
        || event.payload?.superseded_terminal_seq !== unit.terminal_seq
        || event.payload?.expected_journal_seq !== unit.terminal_seq
        || event.seq !== unit.terminal_seq + 1
      ) {
        transitionError(mode, event, 'lessons_retry_authorization_evidence');
      }
      unit.superseded_terminals.push({
        seq: unit.terminal_seq,
        payload: unit.terminal_payload,
      });
      unit.terminal = null;
      unit.terminal_payload = undefined;
      unit.terminal_seq = undefined;
      unit.retry_authorization = event.payload;
      continue;
    }
    if (unit.recorded) transitionError(mode, event, 'after_recorded');
    if (unit.blocked) transitionError(mode, event, 'after_blocked');
    if (unit.terminal && event.type !== 'unit_recorded') transitionError(mode, event, 'after_terminal');
    if (unit.split) transitionError(mode, event, 'after_split');

    if (mode === 'single' && event.type === 'unit_started') {
      if (unit.started) transitionError(mode, event, 'duplicate_started');
      if (typeof event.payload?.attempt_id !== 'string' || !event.payload.attempt_id) {
        transitionError(mode, event, 'attempt_id');
      }
      unit.started = true;
      unit.attempt_id = event.payload.attempt_id;
      continue;
    }
    if (mode === 'two_phase' && event.type === 'unit_prepare_started') {
      if (unit.started) transitionError(mode, event, 'duplicate_prepare_started');
      if (typeof event.payload?.attempt_id !== 'string' || !event.payload.attempt_id) {
        transitionError(mode, event, 'attempt_id');
      }
      unit.started = true;
      unit.prepare_attempt_id = event.payload.attempt_id;
      continue;
    }
    if (!unit.started) transitionError(mode, event, 'before_started');
    if (mode === 'single' && event.type === 'unit_operation_started') {
      if (unit.active_operation) transitionError(mode, event, 'operation_already_started');
      if (event.payload?.attempt_id !== unit.attempt_id) {
        transitionError(mode, event, 'operation_attempt_identity');
      }
      if (typeof event.payload?.operation_id !== 'string' || !event.payload.operation_id) {
        transitionError(mode, event, 'operation_id');
      }
      if (unit.completed_operations.some((operation) =>
        operation.operation_id === event.payload.operation_id)) {
        transitionError(mode, event, 'duplicate_operation');
      }
      unit.active_operation = event.payload;
      continue;
    }
    if (mode === 'single' && event.type === 'unit_operation_completed') {
      if (!unit.active_operation) transitionError(mode, event, 'operation_not_started');
      if (
        event.payload?.attempt_id !== unit.attempt_id
        || event.payload?.operation_id !== unit.active_operation.operation_id
      ) {
        transitionError(mode, event, 'operation_identity');
      }
      unit.completed_operations.push(event.payload);
      unit.completed_operation_events.push({ seq: event.seq, payload: event.payload });
      unit.active_operation = null;
      continue;
    }
    if (event.type === 'unit_split') {
      if (unit.active_operation) transitionError(mode, event, 'split_with_active_operation');
      const expectedAttemptId = mode === 'single' ? unit.attempt_id : unit.prepare_attempt_id;
      if (event.payload?.attempt_id !== expectedAttemptId) {
        transitionError(mode, event, 'split_attempt_identity');
      }
      const children = event.payload?.children;
      if (!Array.isArray(children) || children.length < 2) {
        transitionError(mode, event, 'split_children');
      }
      for (const child of children) {
        const childId = child?.unit_id;
        if (typeof childId !== 'string' || !childId || typeof child?.input_hash !== 'string' || !child.input_hash) {
          transitionError(mode, event, 'split_child_identity');
        }
        if (units.has(childId)) transitionError(mode, event, 'duplicate_split_child');
        units.set(childId, {
          ...createUnit(childId),
          ...child,
          planned: true,
          split_from: unitId,
        });
      }
      unit.split = true;
      unit.split_payload = event.payload;
      continue;
    }
    if (mode === 'two_phase' && event.type === 'unit_prepared') {
      if (unit.prepared) transitionError(mode, event, 'duplicate_prepared');
      if (event.payload?.attempt_id !== unit.prepare_attempt_id) {
        transitionError(mode, event, 'prepared_attempt_identity');
      }
      unit.prepared = true;
      unit.prepared_payload = event.payload;
      continue;
    }
    if (mode === 'two_phase' && event.type === 'unit_committing') {
      if (!unit.prepared) transitionError(mode, event, 'before_prepared');
      if (unit.committing) transitionError(mode, event, 'duplicate_committing');
      if (typeof event.payload?.attempt_id !== 'string' || !event.payload.attempt_id) {
        transitionError(mode, event, 'attempt_id');
      }
      if (event.payload?.prepared_attempt_id !== unit.prepare_attempt_id) {
        transitionError(mode, event, 'commit_prepare_identity');
      }
      unit.committing = true;
      unit.commit_attempt_id = event.payload.attempt_id;
      continue;
    }
    if (event.type === 'unit_blocked') {
      if (mode === 'two_phase' && unit.prepared && !unit.committing) {
        transitionError(mode, event, 'blocked_before_committing');
      }
      const expectedAttemptId = mode === 'single'
        ? unit.attempt_id
        : unit.committing
          ? unit.commit_attempt_id
          : unit.prepare_attempt_id;
      if (event.payload?.attempt_id !== expectedAttemptId) {
        transitionError(mode, event, 'blocked_attempt_identity');
      }
      unit.blocked = true;
      unit.blocked_payload = event.payload;
      continue;
    }
    if (event.type === 'unit_terminal' || event.type === 'unit_resolution') {
      if (unit.active_operation) transitionError(mode, event, 'terminal_with_active_operation');
      if (!TERMINALS.has(event.payload?.status)) transitionError(mode, event, 'terminal_status');
      if (mode === 'two_phase' && unit.prepared && !unit.committing) {
        transitionError(mode, event, 'terminal_before_committing');
      }
      const expectedAttemptId = mode === 'single'
        ? unit.attempt_id
        : unit.committing
          ? unit.commit_attempt_id
          : unit.prepare_attempt_id;
      if (event.payload?.attempt_id !== expectedAttemptId) {
        transitionError(mode, event, 'terminal_attempt_identity');
      }
      unit.terminal = event.payload.status;
      unit.terminal_payload = event.payload;
      unit.terminal_seq = event.seq;
      continue;
    }
    if (event.type === 'unit_recorded') {
      if (!ACCEPTED_TERMINALS.has(unit.terminal)) transitionError(mode, event, 'record_before_accepted_terminal');
      if (event.payload?.attempt_id !== unit.terminal_payload?.attempt_id) {
        transitionError(mode, event, 'record_attempt_identity');
      }
      unit.recorded = true;
      continue;
    }
    transitionError(mode, event, 'unhandled_event');
  }
  return {
    units,
    planCompleted,
    completed,
    runBlocked,
    runAttentionRequired,
  };
}

function assertPlan(plan) {
  const ids = new Set();
  for (const unit of plan) {
    if (typeof unit?.unit_id !== 'string' || !unit.unit_id) throw new Error('v2_stage_plan_unit_id_invalid');
    if (ids.has(unit.unit_id)) throw new Error(`v2_stage_plan_duplicate_unit:${unit.unit_id}`);
    ids.add(unit.unit_id);
  }
  for (const unit of plan) {
    const dependencies = unit.depends_on;
    if (
      dependencies !== undefined
      && (
        !Array.isArray(dependencies)
        || new Set(dependencies.map((dependency) => JSON.stringify(dependency))).size
          !== dependencies.length
        || dependencies.some((dependency) => {
          if (typeof dependency === 'string') {
            return !dependency || dependency === unit.unit_id || !ids.has(dependency);
          }
          return (
            !dependency
            || typeof dependency !== 'object'
            || Array.isArray(dependency)
            || typeof dependency.stage !== 'string'
            || !dependency.stage
            || typeof dependency.unit_id !== 'string'
            || !dependency.unit_id
          );
        })
      )
    ) {
      throw new Error(`v2_stage_plan_dependencies_invalid:${unit.unit_id}`);
    }
  }
}

function samePlanUnit(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function orderUnitsByDependencies(units) {
  const remaining = [...units];
  const remainingIds = new Set(remaining.map((unit) => unit.unit_id));
  const ordered = [];
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((unit) => (
      (unit.depends_on || []).every((dependency) => (
        typeof dependency !== 'string' || !remainingIds.has(dependency)
      ))
    ));
    if (readyIndex < 0) throw new Error('v2_stage_plan_dependency_cycle');
    const [ready] = remaining.splice(readyIndex, 1);
    remainingIds.delete(ready.unit_id);
    ordered.push(ready);
  }
  return ordered;
}

function dependencySnapshot({
  dependency,
  stage,
  state,
  dependencyStates,
}) {
  if (typeof dependency === 'string') {
    const unit = state.units.get(dependency);
    return {
      stage,
      unit_id: dependency,
      state: unit?.recovery_state || (unit?.terminal ? unit.terminal : 'planned'),
      terminal: unit?.terminal || null,
      recorded: unit?.recorded === true,
    };
  }
  const key = `${dependency.stage}:${dependency.unit_id}`;
  const external = dependencyStates.get(key);
  return {
    stage: dependency.stage,
    unit_id: dependency.unit_id,
    state: external?.state || 'planned',
    terminal: external?.terminal || null,
    recorded: external?.recorded === true,
    ...(Number.isSafeInteger(external?.source_seq)
      ? { source_seq: external.source_seq }
      : {}),
  };
}

function dependencyFailed(snapshot) {
  return snapshot.terminal === 'failed'
    || ['isolated', 'dependency_blocked'].includes(snapshot.state);
}

function dependencyAccepted(snapshot) {
  return ACCEPTED_TERMINALS.has(snapshot.terminal) && snapshot.recorded;
}

async function appendAndTrack(events, append, type, payload) {
  const event = await append(type, payload);
  events.push(event);
  return event;
}

async function ensurePlan({ events, plan, planMetadata, append, mode }) {
  assertPlan(plan);
  const recovered = validateStageEvents(events, mode);
  const existingPlan = events.filter((event) => event.type === 'unit_planned').map((event) => event.payload);
  if (
    existingPlan.length > plan.length
    || existingPlan.some((unit, index) => !samePlanUnit(unit, plan[index]))
    || (recovered.planCompleted && existingPlan.length !== plan.length)
  ) {
    throw new Error('v2_stage_plan_drifted');
  }
  if (!recovered.planCompleted) {
    for (const unit of plan.slice(existingPlan.length)) {
      await appendAndTrack(events, append, 'unit_planned', unit);
    }
    await appendAndTrack(events, append, 'stage_plan_completed', {
      unit_count: plan.length,
      ...planMetadata,
    });
  }
  return validateStageEvents(events, mode);
}

function normalizeAdapterResult(result) {
  if (!result || typeof result !== 'object') throw new Error('v2_stage_adapter_result_invalid');
  if (!['succeeded', 'skipped', 'failed', 'blocked', 'pending', 'split'].includes(result.status)) {
    throw new Error(`v2_stage_adapter_status_invalid:${String(result.status)}`);
  }
  if (result.status === 'split' && (!Array.isArray(result.children) || result.children.length < 2)) {
    throw new Error('v2_stage_split_children_invalid');
  }
  return result;
}

function normalizePrepareResult(result) {
  if (result?.status === 'prepared') {
    if (!result.prepared || typeof result.prepared !== 'object') {
      throw new Error('v2_stage_prepared_payload_invalid');
    }
    return result;
  }
  return normalizeAdapterResult(result);
}

function terminalPayload(unit, attemptId, result) {
  return {
    ...(result.payload || {}),
    unit_id: unit.unit_id,
    attempt_id: attemptId,
    status: result.status,
  };
}

function blockedPayload(unit, attemptId, result) {
  return {
    ...(result.payload || {}),
    unit_id: unit.unit_id,
    attempt_id: attemptId,
    reason: result.reason || 'reconciliation_required',
  };
}

export async function runSinglePhaseStage({
  events: initialEvents,
  plan,
  planMetadata = {},
  append,
  attemptIdForUnit,
  execute,
  verifyRecoveredTerminal,
  record,
  planOnly = false,
  now = () => new Date(),
  retryBackoffMs = 1_000,
  maxRetryAttempts = 1,
  stage = 'stage',
  dependencyStates = new Map(),
}) {
  const events = [...initialEvents];
  let state = await ensurePlan({ events, plan, planMetadata, append, mode: 'single' });
  if (planOnly) return { status: 'planned', unitCount: plan.length };
  if (state.completed) return { status: 'completed', acceptedCount: acceptedUnitCount(state.units) };
  if (state.runBlocked) return { status: 'blocked', detail: state.runBlocked };
  if (state.runAttentionRequired) {
    return { status: 'attention_required', detail: state.runAttentionRequired };
  }

  const work = orderUnitsByDependencies([...state.units.values()]);
  for (let cursor = 0; cursor < work.length; cursor += 1) {
    const plannedUnit = work[cursor];
    let unit = state.units.get(plannedUnit.unit_id);
    let retryAttemptStartedNow = false;
    if (unit.split) continue;
    if (unit.retry_scheduled) {
      if (Date.parse(unit.retry_scheduled.retry_at) > now().getTime()) continue;
      const previousAttemptId = unit.attempt_id;
      const attemptNumber = unit.retry_scheduled.attempt_number;
      const retryAttemptId = attemptIdForUnit(plannedUnit, attemptNumber);
      await appendAndTrack(events, append, 'unit_attempt_started', {
        unit_id: unit.unit_id,
        input_hash: unit.input_hash,
        attempt_id: retryAttemptId,
        previous_attempt_id: previousAttemptId,
        attempt_number: attemptNumber,
        attempts_used: unit.retry_scheduled.attempts_used,
        max_attempts: unit.retry_scheduled.max_attempts,
      });
      unit = {
        ...unit,
        attempt_id: retryAttemptId,
        attempt_number: attemptNumber,
        retry_attempts_used: unit.retry_scheduled.attempts_used,
        retry_max_attempts: unit.retry_scheduled.max_attempts,
        retry_scheduled: null,
        active_operation: null,
        blocked: false,
        blocked_payload: undefined,
        recovery_state: 'running',
      };
      state.units.set(unit.unit_id, unit);
      retryAttemptStartedNow = true;
    }
    if (unit.blocked) {
      continue;
    }
    if (unit.terminal === 'failed') {
      continue;
    }
    const dependencies = (unit.depends_on || []).map((dependency) => (
      dependencySnapshot({
        dependency,
        stage,
        state,
        dependencyStates,
      })
    ));
    const failedDependencies = dependencies.filter(dependencyFailed);
    if (failedDependencies.length > 0) {
      const dependencyPayload = {
        unit_id: unit.unit_id,
        dependencies: failedDependencies,
        dependency_unit_ids: failedDependencies.map((dependency) => dependency.unit_id),
        reason: 'dependency_not_accepted',
      };
      await appendAndTrack(
        events,
        append,
        'unit_dependency_blocked',
        dependencyPayload,
      );
      unit = {
        ...unit,
        blocked: true,
        blocked_payload: dependencyPayload,
        recovery_state: 'dependency_blocked',
      };
      state.units.set(unit.unit_id, unit);
      continue;
    }
    const dependenciesReady = dependencies.every(dependencyAccepted);
    if (!dependenciesReady) {
      continue;
    }
    const attemptId = unit.attempt_id || attemptIdForUnit(plannedUnit);
    const recovered = unit.started && !retryAttemptStartedNow;
    if (!unit.started) {
      await appendAndTrack(events, append, 'unit_started', {
        unit_id: unit.unit_id,
        input_hash: unit.input_hash,
        attempt_id: attemptId,
      });
      unit = { ...unit, started: true, attempt_id: attemptId };
      state.units.set(unit.unit_id, unit);
    }
    if (
      recovered
      && ACCEPTED_TERMINALS.has(unit.terminal)
      && !unit.recorded
      && typeof verifyRecoveredTerminal === 'function'
    ) {
      const completedOperation = unit.completed_operations.at(-1);
      if (completedOperation?.operation_id) {
        const verification = await verifyRecoveredTerminal({
        unit: plannedUnit,
        attemptId,
        terminal: unit.terminal_payload,
        completedOperations: [...unit.completed_operations],
        recoveryBudget: {
          attemptsUsed: unit.retry_attempts_used || 0,
          maxAttempts: unit.retry_max_attempts ?? maxRetryAttempts,
        },
        });
        const recovery = verification?.recovery;
        if (!recovery?.decision || !recovery?.evidence) {
          throw new Error('v2_recovered_terminal_verification_invalid');
        }
        const actionPayload = {
          unit_id: unit.unit_id,
          attempt_id: attemptId,
          operation_id: completedOperation.operation_id,
          policy_version: recovery.policyVersion,
          evidence: recovery.evidence,
          decision: recovery.decision,
          budget: recovery.budget,
          ...(recovery.effectVerification
            ? { effect_verification: recovery.effectVerification }
            : {}),
        };
        const outcomeAlreadyObserved = (unit.recovery_outcomes || []).some((outcome) => (
          outcome.operation_id === actionPayload.operation_id
          && outcome.policy_version === actionPayload.policy_version
          && JSON.stringify(outcome.evidence) === JSON.stringify(actionPayload.evidence)
          && JSON.stringify(outcome.decision) === JSON.stringify(actionPayload.decision)
        ));
        if (!outcomeAlreadyObserved) {
          await appendAndTrack(events, append, 'unit_outcome_observed', {
            ...actionPayload,
            verification: true,
          });
        }
        if (recovery.decision.action === 'replay') {
          const effectAlreadyCommitted = unit.effect_committed?.operation_id
            === actionPayload.operation_id
            && JSON.stringify(unit.effect_committed.evidence)
              === JSON.stringify(actionPayload.evidence);
          if (!effectAlreadyCommitted) {
            await appendAndTrack(events, append, 'unit_effect_committed', actionPayload);
          }
        } else if (recovery.decision.action === 'reconcile') {
          await appendAndTrack(events, append, 'unit_reconciliation_requested', actionPayload);
          unit = {
            ...unit,
            blocked: true,
            blocked_payload: actionPayload,
            recovery_state: 'reconciling',
          };
          state.units.set(unit.unit_id, unit);
          continue;
        } else if (recovery.decision.action === 'block_run') {
          await appendAndTrack(events, append, 'run_blocked', actionPayload);
          return { status: 'blocked', unitId: unit.unit_id, detail: actionPayload };
        } else {
          throw new Error(`v2_recovered_terminal_verification_rejected:${recovery.decision.action}`);
        }
      }
    }
    if (!unit.terminal) {
      const startOperation = async ({ operationId, ...payload }) => {
        if (unit.active_operation) throw new Error('v2_single_operation_already_started');
        if (typeof operationId !== 'string' || !operationId) {
          throw new Error('v2_single_operation_id_invalid');
        }
        const eventPayload = {
          ...payload,
          unit_id: unit.unit_id,
          attempt_id: attemptId,
          operation_id: operationId,
        };
        await appendAndTrack(events, append, 'unit_operation_started', eventPayload);
        unit = { ...unit, active_operation: eventPayload };
        state.units.set(unit.unit_id, unit);
        return eventPayload;
      };
      const completeOperation = async ({ operationId, ...payload }) => {
        if (!unit.active_operation) throw new Error('v2_single_operation_not_started');
        if (operationId !== unit.active_operation.operation_id) {
          throw new Error('v2_single_operation_identity_mismatch');
        }
        const eventPayload = {
          ...payload,
          unit_id: unit.unit_id,
          attempt_id: attemptId,
          operation_id: operationId,
        };
        await appendAndTrack(events, append, 'unit_operation_completed', eventPayload);
        unit = {
          ...unit,
          active_operation: null,
          completed_operations: [...unit.completed_operations, eventPayload],
        };
        state.units.set(unit.unit_id, unit);
        return eventPayload;
      };
      const observeOutcome = async ({ operationId, ...payload }) => {
        const verifiesCompletedOperation = payload.verification === true
          && operationId === unit.completed_operations.at(-1)?.operation_id
          && ACCEPTED_TERMINALS.has(
            unit.completed_operations.at(-1)?.terminal_result?.status,
          );
        if (!unit.active_operation && !verifiesCompletedOperation) {
          throw new Error('v2_single_operation_not_started');
        }
        if (
          !verifiesCompletedOperation
          && operationId !== unit.active_operation?.operation_id
        ) {
          throw new Error('v2_single_operation_identity_mismatch');
        }
        const eventPayload = {
          ...payload,
          unit_id: unit.unit_id,
          attempt_id: attemptId,
          operation_id: operationId,
        };
        await appendAndTrack(events, append, 'unit_outcome_observed', eventPayload);
        unit = {
          ...unit,
          recovery_outcomes: [...(unit.recovery_outcomes || []), eventPayload],
        };
        state.units.set(unit.unit_id, unit);
        return eventPayload;
      };
      const result = normalizeAdapterResult(await execute({
        unit: plannedUnit,
        attemptId,
        recovered,
        activeOperation: unit.active_operation,
        completedOperations: [...unit.completed_operations],
        observedOutcomes: [...(unit.recovery_outcomes || [])],
        retryAuthorization: unit.retry_authorization || null,
        recoveryBudget: {
          attemptsUsed: unit.retry_attempts_used || 0,
          maxAttempts: unit.retry_max_attempts ?? maxRetryAttempts,
        },
        startOperation,
        completeOperation,
        observeOutcome,
      }));
      const recovery = result.recovery;
      if (recovery) {
        const actionPayload = {
          unit_id: unit.unit_id,
          attempt_id: attemptId,
          operation_id: unit.active_operation?.operation_id
            || unit.completed_operations.at(-1)?.operation_id,
          policy_version: recovery.policyVersion,
          evidence: recovery.evidence,
          decision: recovery.decision,
          budget: recovery.budget,
          ...(recovery.effectVerification
            ? { effect_verification: recovery.effectVerification }
            : {}),
        };
        const actionOutcomeObserved = (unit.recovery_outcomes || []).some((outcome) => (
          outcome.attempt_id === actionPayload.attempt_id
          && outcome.operation_id === actionPayload.operation_id
          && outcome.policy_version === actionPayload.policy_version
          && JSON.stringify(outcome.evidence) === JSON.stringify(actionPayload.evidence)
          && JSON.stringify(outcome.decision) === JSON.stringify(actionPayload.decision)
          && JSON.stringify(outcome.budget) === JSON.stringify(actionPayload.budget)
        ));
        if (!actionOutcomeObserved) {
          await appendAndTrack(events, append, 'unit_outcome_observed', actionPayload);
          unit = {
            ...unit,
            recovery_outcomes: [...(unit.recovery_outcomes || []), actionPayload],
          };
          state.units.set(unit.unit_id, unit);
        }
        if (recovery.decision.action === 'reconcile') {
          await appendAndTrack(
            events,
            append,
            'unit_reconciliation_requested',
            actionPayload,
          );
          continue;
        }
        if (recovery.decision.action === 'retry') {
          const attemptsUsed = recovery.budget.attemptsUsed + 1;
          const baseRetryAt = now().getTime() + retryBackoffMs;
          const hintedRetryAt = Date.parse(recovery.decision.notBefore || '');
          const retryAt = Math.max(
            baseRetryAt,
            Number.isFinite(hintedRetryAt) ? hintedRetryAt : 0,
          );
          const retryPayload = {
            ...actionPayload,
            attempts_used: attemptsUsed,
            max_attempts: recovery.budget.maxAttempts,
            attempt_number: unit.attempt_number + 1,
            retry_at: new Date(retryAt).toISOString(),
          };
          await appendAndTrack(events, append, 'unit_retry_scheduled', retryPayload);
          unit = {
            ...unit,
            retry_scheduled: retryPayload,
            recovery_state: 'retry_wait',
          };
          state.units.set(unit.unit_id, unit);
          continue;
        }
        if (['resume_commit', 'reconcile_commit'].includes(recovery.decision.action)) {
          await appendAndTrack(events, append, 'unit_commit_resumed', actionPayload);
          unit = {
            ...unit,
            recovery_state: 'committing',
          };
          state.units.set(unit.unit_id, unit);
          continue;
        }
        if (recovery.decision.action === 'block_run') {
          await appendAndTrack(events, append, 'run_blocked', actionPayload);
          return { status: 'blocked', unitId: unit.unit_id, detail: actionPayload };
        }
        if (recovery.decision.action === 'isolate') {
          await appendAndTrack(events, append, 'unit_isolated', actionPayload);
          unit = {
            ...unit,
            terminal: 'failed',
            terminal_payload: actionPayload,
            recovery_state: 'isolated',
          };
          state.units.set(unit.unit_id, unit);
          continue;
        }
        if (recovery.decision.action === 'replay') {
          const effectAlreadyCommitted = unit.effect_committed?.operation_id
            === actionPayload.operation_id
            && unit.effect_committed?.policy_version === actionPayload.policy_version
            && JSON.stringify(unit.effect_committed.evidence)
              === JSON.stringify(actionPayload.evidence)
            && unit.effect_committed?.effect_verification
              === actionPayload.effect_verification;
          if (!effectAlreadyCommitted) {
            await appendAndTrack(events, append, 'unit_effect_committed', actionPayload);
          }
        }
      }
      if (result.status === 'pending') {
        continue;
      }
      if (result.status === 'blocked') {
        const payload = blockedPayload(unit, attemptId, result);
        await appendAndTrack(events, append, 'unit_blocked', payload);
        unit = { ...unit, blocked: true, blocked_payload: payload };
        state.units.set(unit.unit_id, unit);
        continue;
      }
      if (result.status === 'split') {
        await appendAndTrack(events, append, 'unit_split', {
          unit_id: unit.unit_id,
          attempt_id: attemptId,
          children: result.children,
        });
        unit = { ...unit, split: true };
        state.units.set(unit.unit_id, unit);
        for (const child of result.children) {
          const childUnit = {
            ...createUnit(child.unit_id),
            ...child,
            planned: true,
            split_from: unit.unit_id,
          };
          state.units.set(child.unit_id, childUnit);
          work.push(childUnit);
        }
        continue;
      }
      const payload = terminalPayload(unit, attemptId, result);
      await appendAndTrack(
        events,
        append,
        result.recovery ? 'unit_resolution' : 'unit_terminal',
        payload,
      );
      unit = { ...unit, terminal: result.status, terminal_payload: payload };
      state.units.set(unit.unit_id, unit);
      if (result.status === 'failed') {
        continue;
      }
    }
    if (!unit.recorded) {
      await record({
        unit: plannedUnit,
        attemptId,
        terminal: unit.terminal_payload,
      });
      await appendAndTrack(events, append, 'unit_recorded', {
        unit_id: unit.unit_id,
        attempt_id: attemptId,
      });
      unit = { ...unit, recorded: true };
      state.units.set(unit.unit_id, unit);
    }
  }

  state = validateStageEvents(events, 'single');
  const requiredUnits = [...state.units.values()].filter((unit) => !unit.split);
  const acceptanceReady = requiredUnits.every((unit) => (
    ACCEPTED_TERMINALS.has(unit.terminal) && unit.recorded
  ));
  if (!acceptanceReady) {
    const attentionUnits = requiredUnits.filter((unit) => (
      unit.terminal === 'failed'
      || ['isolated', 'dependency_blocked'].includes(unit.recovery_state)
    ));
    if (attentionUnits.length > 0) {
      const detail = {
        unit_ids: attentionUnits.map((unit) => unit.unit_id),
        isolated_count: attentionUnits.filter((unit) => (
          unit.terminal === 'failed' || unit.recovery_state === 'isolated'
        )).length,
        dependency_blocked_count: attentionUnits.filter((unit) => (
          unit.recovery_state === 'dependency_blocked'
        )).length,
      };
      const hasUnifiedAttentionState = attentionUnits.some((unit) => (
        ['isolated', 'dependency_blocked'].includes(unit.recovery_state)
      ));
      if (hasUnifiedAttentionState) {
        await appendAndTrack(events, append, 'run_attention_required', detail);
      }
      return { status: 'attention_required', detail };
    }
    const waitingUnit = requiredUnits.find((unit) => (
      unit.retry_scheduled || unit.blocked || !unit.terminal
    ));
    return {
      status: 'pending',
      ...(waitingUnit ? { unitId: waitingUnit.unit_id } : {}),
    };
  }

  await appendAndTrack(events, append, 'stage_completed', {
    unit_count: state.units.size,
    accepted_count: [...state.units.values()].filter((unit) => !unit.split).length,
    ...planMetadata,
  });
  validateStageEvents(events, 'single');
  return {
    status: 'completed',
    acceptedCount: acceptedUnitCount(state.units),
  };
}

export async function runTwoPhaseStage({
  events: initialEvents,
  plan,
  planMetadata = {},
  append,
  prepareAttemptIdForUnit,
  commitAttemptIdForUnit,
  prepare,
  commit,
  record,
  planOnly = false,
}) {
  const events = [...initialEvents];
  let state = await ensurePlan({ events, plan, planMetadata, append, mode: 'two_phase' });
  if (planOnly) return { status: 'planned', unitCount: plan.length };
  if (state.completed) return { status: 'completed', acceptedCount: acceptedUnitCount(state.units) };

  const work = [...state.units.values()];
  for (let cursor = 0; cursor < work.length; cursor += 1) {
    const plannedUnit = work[cursor];
    let unit = state.units.get(plannedUnit.unit_id);
    if (unit.split) continue;
    if (unit.blocked) {
      return { status: 'blocked', unitId: unit.unit_id, detail: unit.blocked_payload };
    }
    if (unit.terminal === 'failed') {
      return { status: 'failed', unitId: unit.unit_id, detail: unit.terminal_payload };
    }
    const prepareAttemptId = unit.prepare_attempt_id || prepareAttemptIdForUnit(plannedUnit);
    const prepareRecovered = unit.started;
    if (!unit.started) {
      await appendAndTrack(events, append, 'unit_prepare_started', {
        unit_id: unit.unit_id,
        input_hash: unit.input_hash,
        attempt_id: prepareAttemptId,
      });
      unit = { ...unit, started: true, prepare_attempt_id: prepareAttemptId };
      state.units.set(unit.unit_id, unit);
    }
    if (!unit.prepared && !unit.terminal) {
      const result = normalizePrepareResult(await prepare({
        unit: plannedUnit,
        attemptId: prepareAttemptId,
        recovered: prepareRecovered,
      }));
      if (result.status === 'pending') {
        return { status: 'pending', unitId: unit.unit_id };
      }
      if (result.status === 'blocked') {
        const payload = blockedPayload(unit, prepareAttemptId, result);
        await appendAndTrack(events, append, 'unit_blocked', payload);
        return { status: 'blocked', unitId: unit.unit_id, detail: payload };
      }
      if (result.status === 'split') {
        await appendAndTrack(events, append, 'unit_split', {
          unit_id: unit.unit_id,
          attempt_id: prepareAttemptId,
          children: result.children,
        });
        unit = { ...unit, split: true };
        state.units.set(unit.unit_id, unit);
        for (const child of result.children) {
          const childUnit = {
            ...createUnit(child.unit_id),
            ...child,
            planned: true,
            split_from: unit.unit_id,
          };
          state.units.set(child.unit_id, childUnit);
          work.push(childUnit);
        }
        continue;
      }
      if (result.status === 'prepared') {
        const payload = {
          ...result.prepared,
          unit_id: unit.unit_id,
          attempt_id: prepareAttemptId,
        };
        await appendAndTrack(events, append, 'unit_prepared', payload);
        unit = { ...unit, prepared: true, prepared_payload: payload };
        state.units.set(unit.unit_id, unit);
      } else {
        const payload = terminalPayload(unit, prepareAttemptId, result);
        await appendAndTrack(events, append, 'unit_terminal', payload);
        unit = { ...unit, terminal: result.status, terminal_payload: payload };
        state.units.set(unit.unit_id, unit);
        if (result.status === 'failed') {
          return { status: 'failed', unitId: unit.unit_id, detail: payload };
        }
      }
    }
    if (unit.prepared && !unit.terminal) {
      const commitAttemptId = unit.commit_attempt_id || commitAttemptIdForUnit({
        unit: plannedUnit,
        prepared: unit.prepared_payload,
      });
      if (!unit.committing) {
        await appendAndTrack(events, append, 'unit_committing', {
          unit_id: unit.unit_id,
          attempt_id: commitAttemptId,
          prepared_attempt_id: prepareAttemptId,
        });
        unit = { ...unit, committing: true, commit_attempt_id: commitAttemptId };
        state.units.set(unit.unit_id, unit);
      }
      const result = normalizeAdapterResult(await commit({
        unit: plannedUnit,
        attemptId: commitAttemptId,
        prepared: unit.prepared_payload,
      }));
      if (result.status === 'pending') {
        return { status: 'pending', unitId: unit.unit_id };
      }
      if (result.status === 'blocked') {
        const payload = blockedPayload(unit, commitAttemptId, result);
        await appendAndTrack(events, append, 'unit_blocked', payload);
        return { status: 'blocked', unitId: unit.unit_id, detail: payload };
      }
      const payload = terminalPayload(unit, commitAttemptId, result);
      await appendAndTrack(events, append, 'unit_terminal', payload);
      unit = { ...unit, terminal: result.status, terminal_payload: payload };
      state.units.set(unit.unit_id, unit);
      if (result.status === 'failed') {
        return { status: 'failed', unitId: unit.unit_id, detail: payload };
      }
    }
    if (!unit.recorded) {
      await record({
        unit: plannedUnit,
        prepareAttemptId,
        commitAttemptId: unit.commit_attempt_id || null,
        prepared: unit.prepared_payload || null,
        terminal: unit.terminal_payload,
      });
      await appendAndTrack(events, append, 'unit_recorded', {
        unit_id: unit.unit_id,
        attempt_id: unit.commit_attempt_id || prepareAttemptId,
      });
      unit = { ...unit, recorded: true };
      state.units.set(unit.unit_id, unit);
    }
  }

  await appendAndTrack(events, append, 'stage_completed', {
    unit_count: state.units.size,
    accepted_count: [...state.units.values()].filter((unit) => !unit.split).length,
    ...planMetadata,
  });
  validateStageEvents(events, 'two_phase');
  return {
    status: 'completed',
    acceptedCount: acceptedUnitCount(state.units),
  };
}

export function validateSinglePhaseStage(events) {
  validateStageEvents(events, 'single');
  return foldRecoveryStageEvents(events);
}

export function validateTwoPhaseStage(events) {
  validateStageEvents(events, 'two_phase');
  return foldRecoveryStageEvents(events);
}

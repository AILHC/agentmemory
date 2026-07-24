import { foldStageEvents } from './run-state-journal-v2.mjs';

const ACCEPTED_TERMINALS = new Set(['succeeded', 'skipped']);
const TERMINALS = new Set([...ACCEPTED_TERMINALS, 'failed']);
const PLAN_EVENTS = new Set(['unit_planned', 'stage_plan_completed']);
const SINGLE_EVENTS = new Set([
  ...PLAN_EVENTS,
  'unit_started',
  'unit_split',
  'unit_terminal',
  'unit_blocked',
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
  };
}

function validateStageEvents(events, mode) {
  const allowed = mode === 'single' ? SINGLE_EVENTS : TWO_PHASE_EVENTS;
  const units = new Map();
  let planCompleted = false;
  let completed = false;
  for (const event of events) {
    if (!allowed.has(event.type)) transitionError(mode, event, 'event_type');
    if (completed) transitionError(mode, event, 'after_stage_completed');
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
    if (!planCompleted) transitionError(mode, event, 'before_plan_completed');
    const unitId = assertUnitId(event, mode);
    const unit = units.get(unitId);
    if (!unit) transitionError(mode, event, 'unit_not_planned');
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
    if (event.type === 'unit_split') {
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
      unit.committing = true;
      unit.commit_attempt_id = event.payload.attempt_id;
      continue;
    }
    if (event.type === 'unit_blocked') {
      unit.blocked = true;
      unit.blocked_payload = event.payload;
      continue;
    }
    if (event.type === 'unit_terminal') {
      if (!TERMINALS.has(event.payload?.status)) transitionError(mode, event, 'terminal_status');
      if (mode === 'two_phase' && unit.prepared && !unit.committing) {
        transitionError(mode, event, 'terminal_before_committing');
      }
      unit.terminal = event.payload.status;
      unit.terminal_payload = event.payload;
      continue;
    }
    if (event.type === 'unit_recorded') {
      if (!ACCEPTED_TERMINALS.has(unit.terminal)) transitionError(mode, event, 'record_before_accepted_terminal');
      unit.recorded = true;
      continue;
    }
    transitionError(mode, event, 'unhandled_event');
  }
  return { units, planCompleted, completed };
}

function assertPlan(plan) {
  const ids = new Set();
  for (const unit of plan) {
    if (typeof unit?.unit_id !== 'string' || !unit.unit_id) throw new Error('v2_stage_plan_unit_id_invalid');
    if (ids.has(unit.unit_id)) throw new Error(`v2_stage_plan_duplicate_unit:${unit.unit_id}`);
    ids.add(unit.unit_id);
  }
}

function samePlanUnit(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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
  record,
  planOnly = false,
}) {
  const events = [...initialEvents];
  let state = await ensurePlan({ events, plan, planMetadata, append, mode: 'single' });
  if (planOnly) return { status: 'planned', unitCount: plan.length };
  if (state.completed) return { status: 'completed', acceptedCount: plan.length };

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
    const attemptId = unit.attempt_id || attemptIdForUnit(plannedUnit);
    const recovered = unit.started;
    if (!unit.started) {
      await appendAndTrack(events, append, 'unit_started', {
        unit_id: unit.unit_id,
        input_hash: unit.input_hash,
        attempt_id: attemptId,
      });
      unit = { ...unit, started: true, attempt_id: attemptId };
      state.units.set(unit.unit_id, unit);
    }
    if (!unit.terminal) {
      const result = normalizeAdapterResult(await execute({
        unit: plannedUnit,
        attemptId,
        recovered,
      }));
      if (result.status === 'pending') {
        return { status: 'pending', unitId: unit.unit_id };
      }
      if (result.status === 'blocked') {
        const payload = blockedPayload(unit, attemptId, result);
        await appendAndTrack(events, append, 'unit_blocked', payload);
        return { status: 'blocked', unitId: unit.unit_id, detail: payload };
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

  await appendAndTrack(events, append, 'stage_completed', {
    unit_count: state.units.size,
    accepted_count: [...state.units.values()].filter((unit) => !unit.split).length,
    ...planMetadata,
  });
  validateStageEvents(events, 'single');
  return {
    status: 'completed',
    acceptedCount: [...state.units.values()].filter((unit) => !unit.split).length,
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
  if (state.completed) return { status: 'completed', acceptedCount: plan.length };

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
    acceptedCount: [...state.units.values()].filter((unit) => !unit.split).length,
  };
}

export function validateSinglePhaseStage(events) {
  validateStageEvents(events, 'single');
  return foldStageEvents(events);
}

export function validateTwoPhaseStage(events) {
  validateStageEvents(events, 'two_phase');
  return foldStageEvents(events);
}

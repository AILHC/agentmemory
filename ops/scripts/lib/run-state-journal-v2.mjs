import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertLegacyRecoveryContractCompatible,
} from './recovery-migration-contract-v1.mjs';

const LARGE_EVENTS = new Set(['stage_plan_completed', 'unit_planned', 'unit_prepared', 'unit_split']);
const MAX_NORMAL_LINE_BYTES = 64 * 1024;
const MAX_LARGE_LINE_BYTES = 1024 * 1024;
const SENSITIVE_KEY = /(?:token|secret|password|authorization|api[_-]?key|provider[_-]?key|cookie)/i;
const SAFE_AUTHORIZATION_METADATA_KEYS = new Set(['authorization_source_type']);
const ERROR_KEYS = new Set(['error', 'message', 'error_text', 'provider_error']);
const MAX_ERROR_CHARS = 2000;
const STAGE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const APPEND_OPEN_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];
const RETRYABLE_APPEND_OPEN_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalEvent(event) {
  return JSON.stringify({
    seq: event.seq,
    at: event.at,
    type: event.type,
    payload: event.payload,
  });
}

function sanitize(value, key = '') {
  if (
    SENSITIVE_KEY.test(key)
    && !SAFE_AUTHORIZATION_METADATA_KEYS.has(key)
  ) return '[REDACTED]';
  if (typeof value === 'string') {
    return ERROR_KEYS.has(key) && value.length > MAX_ERROR_CHARS
      ? `${value.slice(0, MAX_ERROR_CHARS)}...[truncated]`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitize(childValue, childKey),
    ]));
  }
  return value;
}

function lineLimit(type) {
  return LARGE_EVENTS.has(type) ? MAX_LARGE_LINE_BYTES : MAX_NORMAL_LINE_BYTES;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function openForAppend(filePath, fsApi) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fsApi.open(filePath, 'a');
    } catch (error) {
      if (
        !RETRYABLE_APPEND_OPEN_CODES.has(error?.code)
        || attempt >= APPEND_OPEN_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, APPEND_OPEN_RETRY_DELAYS_MS[attempt]));
    }
  }
}

class JournalFile {
  constructor(filePath, fsApi) {
    this.filePath = filePath;
    this.fs = fsApi;
    this.seq = -1;
    this.tail = Promise.resolve();
  }

  async append(type, payload) {
    const operation = async () => {
      const event = {
        seq: this.seq + 1,
        at: new Date().toISOString(),
        type,
        payload: sanitize(payload),
      };
      event.checksum = sha256(canonicalEvent(event));
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line) > lineLimit(type)) throw new Error(`v2_journal_line_too_large:${type}`);
      await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await openForAppend(this.filePath, this.fs);
      try {
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.seq = event.seq;
      return event;
    };
    const current = this.tail.then(operation);
    this.tail = current.catch(() => {});
    return current;
  }
}

async function readJournal(filePath, fsApi) {
  let handle;
  try {
    handle = await fsApi.open(filePath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const events = [];
  let validBytes = 0;
  let lineNumber = 0;
  let expectedSeq = 0;
  const acceptLine = (line, endOffset, isFinal) => {
    lineNumber += 1;
    let text = line.toString('utf8');
    if (text.endsWith('\r')) text = text.slice(0, -1);
    let event;
    try {
      event = JSON.parse(text);
    } catch (error) {
      if (isFinal) return { torn: true, error };
      throw new Error(`v2_journal_corrupt_at_line_${lineNumber}`, { cause: error });
    }
    if (
      !Number.isInteger(event.seq)
      || event.seq !== expectedSeq
      || typeof event.type !== 'string'
      || event.checksum !== sha256(canonicalEvent(event))
    ) {
      throw new Error(`v2_journal_integrity_failed_at_line_${lineNumber}`);
    }
    events.push(event);
    expectedSeq += 1;
    validBytes = endOffset;
    return { torn: false };
  };
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let carry = Buffer.alloc(0);
  let offset = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const dataStart = offset - carry.length;
      offset += bytesRead;
      const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      let cursor = 0;
      while (cursor < data.length) {
        const newline = data.indexOf(0x0a, cursor);
        if (newline < 0) break;
        const result = acceptLine(data.subarray(cursor, newline), dataStart + newline + 1, false);
        if (result.torn) throw new Error(`v2_journal_corrupt_at_line_${lineNumber}`);
        cursor = newline + 1;
      }
      carry = Buffer.from(data.subarray(cursor));
    }
  } finally {
    await handle.close();
  }
  if (carry.length > 0) {
    const result = acceptLine(carry, offset, true);
    if (result.torn) {
      await fsApi.truncate(filePath, validBytes);
    } else {
      const appendHandle = await openForAppend(filePath, fsApi);
      try {
        await appendHandle.writeFile('\n', 'utf8');
        await appendHandle.sync();
      } finally {
        await appendHandle.close();
      }
    }
  }
  return events;
}

export class RunStateJournalV2 {
  constructor({ rootDir, runId, fsApi = fs }) {
    this.rootDir = path.resolve(rootDir);
    this.runId = runId;
    this.fs = fsApi;
    this.controlPath = path.join(this.rootDir, 'control.jsonl');
    this.statusPath = path.join(this.rootDir, 'status.json');
    this.lockPath = path.join(this.rootDir, 'writer.lock.json');
    this.control = new JournalFile(this.controlPath, fsApi);
    this.stages = new Map();
    this.lock = null;
    this.statusTail = Promise.resolve();
  }

  stagePath(stage) {
    this.assertStage(stage);
    return path.join(this.rootDir, `${stage}.jsonl`);
  }

  assertStage(stage) {
    if (!STAGE_NAME.test(stage)) throw new Error(`v2_invalid_stage:${stage}`);
  }

  stageWriter(stage) {
    this.assertStage(stage);
    if (!this.stages.has(stage)) this.stages.set(stage, new JournalFile(this.stagePath(stage), this.fs));
    return this.stages.get(stage);
  }

  async acquireLock({ takeover = null } = {}) {
    await this.fs.mkdir(this.rootDir, { recursive: true });
    const metadata = {
      run_id: this.runId,
      pid: process.pid,
      created_at: new Date().toISOString(),
      owner_id: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    };
    try {
      const handle = await this.fs.open(this.lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const raw = await this.fs.readFile(this.lockPath, 'utf8');
      let current;
      try { current = JSON.parse(raw); } catch { throw new Error('v2_writer_lock_invalid'); }
      if (!current || current.run_id !== this.runId || isPidAlive(current.pid)) {
        throw new Error('v2_writer_lock_active');
      }
      if (typeof takeover !== 'function') throw new Error('v2_writer_lock_stale_requires_verified_takeover');
      const approved = await takeover({ lockPath: this.lockPath, owner: sanitize(current) });
      if (approved !== true) throw new Error('v2_writer_lock_takeover_rejected');
      const confirmed = await this.fs.readFile(this.lockPath, 'utf8');
      let confirmedOwner;
      try { confirmedOwner = JSON.parse(confirmed); } catch { throw new Error('v2_writer_lock_changed'); }
      if (confirmed !== raw || confirmedOwner.owner_id !== current.owner_id || confirmedOwner.run_id !== this.runId) {
        throw new Error('v2_writer_lock_changed');
      }
      await this.fs.unlink(this.lockPath);
      return this.acquireLock({ takeover });
    }
    this.lock = metadata;
    return metadata;
  }

  async releaseLock() {
    if (!this.lock) return false;
    const raw = await this.fs.readFile(this.lockPath, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (raw === null) return false;
    let current;
    try { current = JSON.parse(raw); } catch { return false; }
    if (current.owner_id !== this.lock.owner_id) return false;
    await this.fs.unlink(this.lockPath);
    this.lock = null;
    return true;
  }

  async open() {
    const controlEvents = await readJournal(this.controlPath, this.fs);
    this.control.seq = controlEvents.at(-1)?.seq ?? -1;
    return controlEvents;
  }

  async appendControl(type, payload = {}) {
    return this.control.append(type, payload);
  }

  async appendStage(stage, type, payload = {}) {
    return this.stageWriter(stage).append(type, payload);
  }

  async appendStageExpectedSeq(stage, expectedSeq, type, payload = {}) {
    if (!this.lock) throw new Error('v2_writer_lock_required');
    if (!Number.isSafeInteger(expectedSeq) || expectedSeq < -1) {
      throw new Error('v2_expected_stage_seq_invalid');
    }
    const events = await this.readStage(stage);
    const currentSeq = events.at(-1)?.seq ?? -1;
    if (currentSeq !== expectedSeq) throw new Error('v2_stage_journal_seq_drifted');
    return this.appendStage(stage, type, payload);
  }

  async readControl() { return readJournal(this.controlPath, this.fs); }
  async readStage(stage) {
    const events = await readJournal(this.stagePath(stage), this.fs);
    if (events.length > 0) this.stageWriter(stage).seq = events.at(-1).seq;
    return events;
  }

  async writeStatus(status) {
    const task = async () => {
      const stage = typeof status.current_stage === 'string' ? this.stages.get(status.current_stage) : null;
      const safeStatus = sanitize({
        ...status,
        run_id: this.runId,
        control_seq: this.control.seq,
        ...(stage ? { stage_seq: stage.seq } : {}),
      });
      const temp = `${this.statusPath}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      await this.fs.writeFile(temp, `${JSON.stringify(safeStatus, null, 2)}\n`, 'utf8');
      await this.fs.rename(temp, this.statusPath);
    };
    const current = this.statusTail.then(task);
    this.statusTail = current.catch(() => {});
    return current;
  }

}

function foldStageEventsUnchecked(events) {
  const units = new Map();
  let planCompleted = false;
  let completed = false;
  let runBlocked = null;
  let runAttentionRequired = null;
  for (const event of events) {
    const unitId = event.payload?.unit_id;
    if (event.type === 'stage_plan_completed') planCompleted = true;
    if (event.type === 'stage_completed') completed = true;
    if (event.type === 'run_blocked') runBlocked = event.payload;
    if (event.type === 'run_attention_required') runAttentionRequired = event.payload;
    if (!unitId) continue;
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
    };
    if (event.type === 'unit_planned') Object.assign(unit, event.payload, { planned: true });
    if (event.type === 'unit_started') {
      unit.started = true;
      unit.attempt_id = event.payload.attempt_id;
    }
    if (event.type === 'unit_attempt_started') {
      unit.started = true;
      unit.attempt_id = event.payload.attempt_id;
      unit.attempt_number = event.payload.attempt_number;
      unit.retry_attempts_used = event.payload.attempts_used;
      unit.retry_max_attempts = event.payload.max_attempts;
      unit.retry_scheduled = null;
      unit.active_operation = null;
      unit.blocked = false;
      unit.blocked_payload = undefined;
      unit.recovery_state = 'running';
    }
    if (event.type === 'unit_prepare_started') {
      unit.started = true;
      unit.prepare_attempt_id = event.payload.attempt_id;
    }
    if (event.type === 'unit_operation_started') {
      unit.active_operation = event.payload;
    }
    if (event.type === 'unit_operation_completed') {
      unit.completed_operations.push(event.payload);
      unit.active_operation = null;
    }
    if (event.type === 'unit_outcome_observed') {
      unit.recovery_outcomes = [...(unit.recovery_outcomes || []), event.payload];
    }
    if (event.type === 'unit_retry_scheduled') {
      unit.retry_scheduled = event.payload;
      unit.recovery_state = 'retry_wait';
    }
    if (event.type === 'unit_reconciliation_requested') {
      unit.blocked = true;
      unit.blocked_payload = event.payload;
      unit.recovery_state = 'reconciling';
    }
    if (event.type === 'unit_effect_committed') {
      unit.effect_committed = event.payload;
      unit.recovery_state = 'committed';
    }
    if (event.type === 'unit_prepared') {
      unit.prepared = true;
      unit.prepared_payload = event.payload;
    }
    if (event.type === 'unit_committing') {
      unit.committing = true;
      unit.commit_attempt_id = event.payload.attempt_id;
    }
    if (event.type === 'unit_terminal' || event.type === 'unit_resolution') {
      unit.terminal = event.payload.status;
      unit.terminal_payload = event.payload;
    }
    if (event.type === 'unit_isolated') {
      unit.terminal = 'failed';
      unit.terminal_payload = event.payload;
      unit.recovery_state = 'isolated';
    }
    if (event.type === 'unit_dependency_blocked') {
      unit.blocked = true;
      unit.blocked_payload = event.payload;
      unit.recovery_state = 'dependency_blocked';
    }
    if (event.type === 'unit_blocked') {
      unit.blocked = true;
      unit.blocked_payload = event.payload;
    }
    if (event.type === 'unit_reconciliation_resolved') {
      unit.blocked = false;
      unit.blocked_payload = undefined;
      if (
        unit.active_operation?.operation_id === event.payload.operation_id
        && unit.retry_authorization?.operation_id === event.payload.operation_id
      ) {
        unit.retry_authorization = null;
      }
      unit.active_operation = null;
      unit.reconciliations = [...(unit.reconciliations || []), event.payload];
    }
    if (event.type === 'unit_summary_failed_terminal_retry_authorized') {
      const supersededOperation = unit.completed_operations.pop();
      if (supersededOperation) {
        unit.superseded_operations = [...(unit.superseded_operations || []), {
          seq: event.payload?.superseded_operation_seq,
          payload: supersededOperation,
        }];
      }
      unit.superseded_terminals = [...(unit.superseded_terminals || []), {
        seq: event.payload?.superseded_terminal_seq,
        payload: unit.terminal_payload,
      }];
      unit.terminal = null;
      unit.terminal_payload = undefined;
      unit.retry_authorization = event.payload;
    }
    if (event.type === 'unit_recorded') unit.recorded = true;
    units.set(unitId, unit);
  }
  return {
    units,
    planCompleted,
    completed,
    runBlocked,
    runAttentionRequired,
  };
}

export function foldStageEvents(events) {
  assertLegacyRecoveryContractCompatible(events);
  return foldStageEventsUnchecked(events);
}

export function foldRecoveryStageEvents(events) {
  return foldStageEventsUnchecked(events);
}

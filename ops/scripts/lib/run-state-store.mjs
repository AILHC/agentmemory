import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function eventBody(event) {
  return JSON.stringify({
    seq: event.seq,
    previous_hash: event.previous_hash,
    at: event.at,
    type: event.type,
    payload: event.payload,
  });
}

function summarizeInFlightGaps(state) {
  const byStage = {};
  let total = 0;
  for (const [stage, containerKey] of [
    ['memory_consolidate', 'memory_consolidate_windows'],
    ['skill_extract', 'skill_extract'],
  ]) {
    let count = 0;
    for (const unit of Object.values(state[containerKey] || {})) {
      if (
        ['preparing', 'prepared', 'committing'].includes(unit?.status)
        || unit?.record_pending === true
      ) {
        count += 1;
      }
    }
    byStage[stage] = count;
    total += count;
  }
  return { total, by_stage: byStage };
}

export class RunStateStore {
  constructor({ statePath, writeSnapshot, fsApi = fs }) {
    this.statePath = statePath;
    this.journalPath = statePath.replace(/\.json$/i, '.journal.jsonl');
    this.statusPath = statePath.replace(/\.json$/i, '.status.json');
    this.writeSnapshot = writeSnapshot;
    this.fs = fsApi;
    this.seq = 0;
    this.lastHash = null;
    this.tail = Promise.resolve();
  }

  async append(type, payload, { durable = false } = {}) {
    const task = async () => {
      const event = {
        seq: this.seq + 1,
        previous_hash: this.lastHash,
        at: new Date().toISOString(),
        type,
        payload,
      };
      event.hash = sha256(eventBody(event));
      await this.fs.mkdir(path.dirname(this.journalPath), { recursive: true });
      const handle = await this.fs.open(this.journalPath, 'a');
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
        if (durable) await handle.sync();
      } finally {
        await handle.close();
      }
      this.seq = event.seq;
      this.lastHash = event.hash;
      return event;
    };
    const current = this.tail.then(task);
    this.tail = current.catch(() => {});
    return current;
  }

  async loadJournal() {
    const raw = await this.fs.readFile(this.journalPath, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    const lines = raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    let previous = null;
    const events = [];
    for (let index = 0; index < lines.length; index += 1) {
      let event;
      try {
        event = JSON.parse(lines[index]);
      } catch (error) {
        if (index === lines.length - 1) {
          const validPrefix = index === 0 ? '' : `${lines.slice(0, index).join('\n')}\n`;
          await this.fs.truncate(this.journalPath, Buffer.byteLength(validPrefix, 'utf8'));
          break;
        }
        throw new Error(`journal_corrupt_at_line_${index + 1}`, { cause: error });
      }
      if (event.seq !== events.length + 1 || event.previous_hash !== previous || event.hash !== sha256(eventBody(event))) {
        throw new Error(`journal_integrity_failed_at_seq_${event.seq}`);
      }
      events.push(event);
      previous = event.hash;
    }
    this.seq = events.at(-1)?.seq || 0;
    this.lastHash = events.at(-1)?.hash || null;
    return events;
  }

  replay(state, events) {
    const includedSeq = Number(state.orchestration_journal?.included_seq || 0);
    const includedHash = state.orchestration_journal?.included_hash || null;
    if (
      includedSeq < 0
      || includedSeq > events.length
      || (includedSeq > 0 && events[includedSeq - 1]?.hash !== includedHash)
      || (includedSeq === 0 && includedHash !== null)
    ) {
      throw new Error('journal_snapshot_boundary_mismatch');
    }
    for (const event of events) {
      if (event.seq <= includedSeq) continue;
      if (event.type === 'scheduler_state') {
        state.stage_work_queues = event.payload.stage_work_queues || state.stage_work_queues;
        state.last_failure_cause = event.payload.last_failure_cause || state.last_failure_cause;
        state.provider_limiter = event.payload.provider_limiter || state.provider_limiter;
        continue;
      }
      if (event.type !== 'unit_state') continue;
      const { container_key: containerKey, unit_id: unitId, unit } = event.payload || {};
      if (!containerKey || !unitId || !unit || typeof unit !== 'object') {
        throw new Error(`journal_invalid_unit_state_at_seq_${event.seq}`);
      }
      state[containerKey] ??= {};
      state[containerKey][unitId] = unit;
      if (
        containerKey === 'semantic_windows'
        && event.payload?.semantic_memory_char_sizes
        && typeof event.payload.semantic_memory_char_sizes === 'object'
      ) {
        state.semantic_memory_char_sizes = {
          ...(state.semantic_memory_char_sizes || {}),
          ...event.payload.semantic_memory_char_sizes,
        };
      }
    }
    return state;
  }

  async checkpoint(state) {
    await this.tail;
    const includedSeq = this.seq;
    const includedHash = this.lastHash;
    state.orchestration_journal = {
      included_seq: includedSeq,
      included_hash: includedHash,
    };
    await this.writeSnapshot(this.statePath, state);
    const snapshot = await this.fs.readFile(this.statePath);
    await this.append('checkpoint', {
      included_seq: includedSeq,
      included_hash: includedHash,
      snapshot_sha256: sha256(snapshot),
      scheduler_epoch: state.scheduler_epoch,
    }, { durable: true });
  }

  async writeStatus(state) {
    const manifest = {
      run_id: state.run_id,
      current_stage: state.current_stage || null,
      coverage: state.coverage,
      scheduler_epoch: state.scheduler_epoch,
      next_retry_at: state.next_retry_at || null,
      runner_pid: process.pid,
      snapshot_at: state.updated_at || null,
      journal_seq: this.seq,
      in_flight_gaps: summarizeInFlightGaps(state),
    };
    const temp = `${this.statusPath}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    await this.fs.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await this.fs.rename(temp, this.statusPath);
  }
}

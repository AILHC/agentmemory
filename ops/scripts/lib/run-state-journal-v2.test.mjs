import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { foldStageEvents, RunStateJournalV2 } from './run-state-journal-v2.mjs';

async function makeJournal(name) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const journal = new RunStateJournalV2({ rootDir, runId: 'v2-test' });
  await journal.acquireLock();
  await journal.open();
  return { rootDir, journal };
}

test('v2 journal uses independent zero-based sequences and only repairs a torn final line', async () => {
  const { journal } = await makeJournal('agentmemory-v2-journal');
  try {
    await journal.appendControl('run_started', { token: 'must-not-persist' });
    await journal.appendStage('summary', 'unit_planned', { unit_id: 's1', input_hash: 'hash' });
    await journal.appendStage('summary', 'stage_plan_completed', { unit_count: 1 });
    const control = await journal.readControl();
    const stage = await journal.readStage('summary');
    assert.equal(control[0].seq, 0);
    assert.equal(stage[0].seq, 0);
    assert.equal(control[0].payload.token, '[REDACTED]');
    await fs.appendFile(journal.stagePath('summary'), '{"seq":2');
    assert.equal((await journal.readStage('summary')).length, 2);
    await fs.appendFile(journal.stagePath('summary'), '{"seq":2}\n');
    await assert.rejects(() => journal.readStage('summary'), /v2_journal_integrity_failed_at_line_3/);
  } finally {
    await journal.releaseLock();
  }
});

test('v2 journal retries transient sharing violations when opening an append handle', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-append-ebusy-'));
  let appendOpenAttempts = 0;
  const fsApi = {
    ...fs,
    open: async (filePath, flags, ...args) => {
      if (String(filePath).endsWith('summary.jsonl') && flags === 'a') {
        appendOpenAttempts += 1;
        if (appendOpenAttempts === 1) {
          const error = new Error('resource busy');
          error.code = 'EBUSY';
          throw error;
        }
      }
      return fs.open(filePath, flags, ...args);
    },
  };
  const journal = new RunStateJournalV2({ rootDir, runId: 'v2-append-ebusy', fsApi });
  try {
    await journal.acquireLock();
    await journal.open();
    await journal.appendStage('summary', 'unit_planned', { unit_id: 's1' });
    assert.equal(appendOpenAttempts, 2);
    assert.equal((await journal.readStage('summary')).length, 1);
  } finally {
    await journal.releaseLock();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('v2 journal rejects complete checksum and sequence corruption', async () => {
  const { journal } = await makeJournal('agentmemory-v2-integrity');
  try {
    await journal.appendStage('summary', 'unit_planned', { unit_id: 's1' });
    const event = JSON.parse((await fs.readFile(journal.stagePath('summary'), 'utf8')).trim());
    event.seq = 4;
    await fs.writeFile(journal.stagePath('summary'), `${JSON.stringify(event)}\n`);
    await assert.rejects(() => journal.readStage('summary'), /v2_journal_integrity_failed/);
  } finally {
    await journal.releaseLock();
  }
});

test('v2 journal redacts and bounds error payloads before durable append', async () => {
  const { journal } = await makeJournal('agentmemory-v2-redaction');
  try {
    await journal.appendStage('summary', 'unit_terminal', {
      unit_id: 's1',
      status: 'failed',
      provider_key: 'hidden',
      authorization: 'hidden',
      authorization_source_type: 'change_ticket',
      error: 'x'.repeat(5000),
    });
    const [event] = await journal.readStage('summary');
    assert.equal(event.payload.provider_key, '[REDACTED]');
    assert.equal(event.payload.authorization, '[REDACTED]');
    assert.equal(event.payload.authorization_source_type, 'change_ticket');
    assert.match(event.payload.error, /\[truncated\]$/);
    await assert.rejects(
      () => journal.appendStage('summary', 'unit_terminal', { unit_id: 's2', detail: 'x'.repeat(70 * 1024) }),
      /v2_journal_line_too_large/,
    );
  } finally {
    await journal.releaseLock();
  }
});

test('journal fold projects durable facts without owning lifecycle validation', () => {
  const state = foldStageEvents([
    { type: 'unit_planned', payload: { unit_id: 's1', input_hash: 'hash' } },
    { type: 'unit_started', payload: { unit_id: 's1', attempt_id: 'attempt-1' } },
    {
      type: 'unit_operation_started',
      payload: { unit_id: 's1', attempt_id: 'attempt-1', operation_id: 's1:map:0' },
    },
    {
      type: 'unit_operation_completed',
      payload: { unit_id: 's1', attempt_id: 'attempt-1', operation_id: 's1:map:0' },
    },
    { type: 'unit_terminal', payload: { unit_id: 's1', status: 'succeeded' } },
  ]);
  assert.deepEqual(state.units.get('s1'), {
    unit_id: 's1',
    input_hash: 'hash',
    planned: true,
    started: true,
    prepared: false,
    committing: false,
    attempt_id: 'attempt-1',
    terminal: 'succeeded',
    terminal_payload: { unit_id: 's1', status: 'succeeded' },
    blocked: false,
    recorded: false,
    active_operation: null,
    completed_operations: [{
      unit_id: 's1',
      attempt_id: 'attempt-1',
      operation_id: 's1:map:0',
    }],
  });
});

test('journal fold clears a blocked active operation only after durable reconciliation', () => {
  const state = foldStageEvents([
    { type: 'unit_planned', payload: { unit_id: 's1', input_hash: 'hash' } },
    { type: 'unit_started', payload: { unit_id: 's1', attempt_id: 'attempt-1' } },
    {
      type: 'unit_summary_failed_terminal_retry_authorized',
      payload: { unit_id: 's1', operation_id: 's1:reduce' },
    },
    {
      type: 'unit_operation_started',
      payload: { unit_id: 's1', attempt_id: 'attempt-1', operation_id: 's1:reduce' },
    },
    {
      type: 'unit_blocked',
      payload: {
        unit_id: 's1',
        attempt_id: 'attempt-1',
        reason: 'extraction_operation_reconciliation_required',
      },
    },
    {
      type: 'unit_reconciliation_resolved',
      payload: {
        unit_id: 's1',
        attempt_id: 'attempt-1',
        operation_id: 's1:reduce',
        reconciliation_id: 'xrec_0123456789abcdef0123456789abcdef',
        receipt_input_hash: 'b'.repeat(64),
        receipt_started_at: '2026-07-26T17:44:07.622Z',
        receipt_status: 'reconciled',
        result_status: 'absent',
        cause: 'orphaned_operation_result_absent',
      },
    },
  ]);
  assert.equal(state.units.get('s1').blocked, false);
  assert.equal(state.units.get('s1').active_operation, null);
  assert.equal(state.units.get('s1').retry_authorization, null);
  assert.equal(
    state.units.get('s1').reconciliations[0].reconciliation_id,
    'xrec_0123456789abcdef0123456789abcdef',
  );
});

test('journal fold does not clear retry authorization for a mismatched reconciliation identity', () => {
  const state = foldStageEvents([
    { type: 'unit_planned', payload: { unit_id: 's1', input_hash: 'hash' } },
    { type: 'unit_started', payload: { unit_id: 's1', attempt_id: 'attempt-1' } },
    {
      type: 'unit_summary_failed_terminal_retry_authorized',
      payload: { unit_id: 's1', operation_id: 's1:reduce' },
    },
    {
      type: 'unit_operation_started',
      payload: { unit_id: 's1', attempt_id: 'attempt-1', operation_id: 's1:reduce' },
    },
    {
      type: 'unit_blocked',
      payload: {
        unit_id: 's1',
        attempt_id: 'attempt-1',
        reason: 'extraction_operation_reconciliation_required',
      },
    },
    {
      type: 'unit_reconciliation_resolved',
      payload: {
        unit_id: 's1',
        attempt_id: 'attempt-1',
        operation_id: 's1:map:0',
      },
    },
  ]);

  assert.equal(state.units.get('s1').retry_authorization.operation_id, 's1:reduce');
});

test('v2 journal repairs a complete final line without newline before the next append', async () => {
  const { journal } = await makeJournal('agentmemory-v2-newline');
  try {
    await journal.appendStage('summary', 'unit_planned', { unit_id: 's1' });
    const stagePath = journal.stagePath('summary');
    const withoutNewline = (await fs.readFile(stagePath, 'utf8')).trimEnd();
    await fs.writeFile(stagePath, withoutNewline);
    assert.equal((await journal.readStage('summary')).length, 1);
    assert.match(await fs.readFile(stagePath, 'utf8'), /\n$/);
    await journal.appendStage('summary', 'stage_plan_completed', { unit_count: 1 });
    assert.equal((await journal.readStage('summary')).length, 2);
  } finally {
    await journal.releaseLock();
  }
});

test('v2 journal growth is linear in unit events and status stays bounded', async () => {
  const { journal } = await makeJournal('agentmemory-v2-scale');
  try {
    const b0 = 0;
    const sizes = [];
    for (const target of [20, 40]) {
      for (let index = sizes.length === 0 ? 0 : 20; index < target; index += 1) {
        const unitId = `unit-${String(index).padStart(4, '0')}`;
        await journal.appendStage('summary', 'unit_planned', { unit_id: unitId, input_hash: `hash-${index}` });
        await journal.appendStage('summary', 'unit_started', { unit_id: unitId, attempt_id: `attempt-${index}` });
        await journal.appendStage('summary', 'unit_terminal', { unit_id: unitId, status: 'succeeded' });
        await journal.appendStage('summary', 'unit_recorded', { unit_id: unitId });
      }
      await journal.writeStatus({ current_stage: 'summary', processed: target });
      sizes.push((await fs.stat(journal.stagePath('summary'))).size);
    }
    const ratio = (sizes[1] - b0) / (sizes[0] - b0);
    assert.ok(ratio > 1.9);
    assert.ok(ratio < 2.1);
    assert.ok((await fs.stat(journal.statusPath)).size < 1024);
  } finally {
    await journal.releaseLock();
  }
});

test('v2 journal accepts canonical extraction stage names with underscores', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-journal-v2-stage-name-'));
  const journal = new RunStateJournalV2({ rootDir, runId: 'stage-name' });
  await journal.appendStage('memory_consolidate', 'unit_planned', {
    unit_id: 'mcw-1',
    input_hash: 'input-1',
  });
  assert.equal((await journal.readStage('memory_consolidate')).length, 1);
});

test('v2 recovery streams only the requested journal and status writes stay ordered', async () => {
  const { rootDir, journal } = await makeJournal('agentmemory-v2-streaming');
  try {
    await journal.appendControl('run_started', { format: 'run-state-journal-v2' });
    await journal.appendStage('summary', 'unit_planned', { unit_id: 's1' });
    await journal.releaseLock();
    const streamFs = {
      ...fs,
      readFile: async (file, ...args) => {
        if (String(file).endsWith('.jsonl')) throw new Error('whole_journal_read_forbidden');
        return fs.readFile(file, ...args);
      },
    };
    const resumed = new RunStateJournalV2({ rootDir, runId: 'v2-test', fsApi: streamFs });
    const control = await resumed.open();
    assert.equal(control.length, 1);
    const stage = await resumed.readStage('summary');
    assert.equal(stage.length, 1);
    await Promise.all([
      resumed.writeStatus({ current_stage: 'summary', marker: 'first', control_seq: 999 }),
      resumed.writeStatus({ current_stage: 'summary', marker: 'second', control_seq: 999 }),
    ]);
    const status = JSON.parse(await fs.readFile(resumed.statusPath, 'utf8'));
    assert.equal(status.marker, 'second');
    assert.equal(status.control_seq, 0);
    assert.equal(status.stage_seq, 0);
  } finally {
    await journal.releaseLock();
  }
});

test('stale v2 locks require an injected verified takeover and retain the lock on rejection', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-takeover-'));
  const lockPath = path.join(rootDir, 'writer.lock.json');
  await fs.writeFile(lockPath, JSON.stringify({ run_id: 'v2-test', pid: -1, owner_id: 'stale-owner' }));
  const journal = new RunStateJournalV2({ rootDir, runId: 'v2-test' });
  await assert.rejects(() => journal.acquireLock(), /v2_writer_lock_stale_requires_verified_takeover/);
  await fs.access(lockPath);
  await assert.rejects(() => journal.acquireLock({ takeover: async () => false }), /v2_writer_lock_takeover_rejected/);
  await fs.access(lockPath);
  await journal.acquireLock({ takeover: async ({ owner }) => owner.owner_id === 'stale-owner' });
  await journal.releaseLock();
});

test('v2 journal CAS append requires the writer lock and the exact durable stage sequence', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-cas-'));
  const journal = new RunStateJournalV2({ rootDir, runId: 'v2-cas' });
  await assert.rejects(
    () => journal.appendStageExpectedSeq('summary', -1, 'unit_planned', { unit_id: 's1' }),
    /v2_writer_lock_required/,
  );
  await journal.acquireLock();
  try {
    await journal.open();
    const planned = await journal.appendStageExpectedSeq(
      'summary',
      -1,
      'unit_planned',
      { unit_id: 's1' },
    );
    assert.equal(planned.seq, 0);
    await assert.rejects(
      () => journal.appendStageExpectedSeq(
        'summary',
        -1,
        'stage_plan_completed',
        { unit_count: 1 },
      ),
      /v2_stage_journal_seq_drifted/,
    );
    assert.deepEqual((await journal.readStage('summary')).map((event) => event.type), [
      'unit_planned',
    ]);
  } finally {
    await journal.releaseLock();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('legacy journal fold explicitly rejects a recovery contract fence', () => {
  assert.throws(
    () => foldStageEvents([{
      seq: 0,
      type: 'stage_recovery_contract_fenced',
      payload: {},
    }]),
    /legacy_runner_recovery_contract_fenced_at_seq_0/,
  );
});

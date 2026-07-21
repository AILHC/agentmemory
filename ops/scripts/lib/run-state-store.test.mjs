import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunStateStore } from './run-state-store.mjs';

test('journal rejects a damaged middle line and tolerates a torn final line', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-'));
  const statePath = path.join(dir, 'run.json');
  const store = new RunStateStore({
    statePath,
    writeSnapshot: (file, state) => fs.writeFile(file, JSON.stringify(state)),
  });
  await store.append('unit', { id: 'a' }, { durable: true });
  await store.append('unit', { id: 'b' }, { durable: true });
  await fs.appendFile(store.journalPath, '{"seq":3');
  assert.equal((await store.loadJournal()).length, 2);
  await store.append('unit', { id: 'c' }, { durable: true });
  assert.equal((await store.loadJournal()).length, 3);
  const lines = (await fs.readFile(store.journalPath, 'utf8')).split('\n');
  lines[0] = lines[0].replace('"id":"a"', '"id":"x"');
  await fs.writeFile(store.journalPath, lines.join('\n'));
  await assert.rejects(() => store.loadJournal(), /journal_integrity_failed/);
});

test('journal loading streams the file and retains only the snapshot boundary onward', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-'));
  const statePath = path.join(dir, 'run.json');
  const writer = new RunStateStore({
    statePath,
    writeSnapshot: (file, state) => fs.writeFile(file, JSON.stringify(state)),
  });
  await writer.append('unit_state', {
    container_key: 'memory_consolidate_windows',
    unit_id: 'mcw-1',
    unit: { status: 'succeeded', payload: 'x'.repeat(70_000) },
  }, { durable: true });
  const boundary = await writer.append('unit_state', {
    container_key: 'memory_consolidate_windows',
    unit_id: 'mcw-2',
    unit: { status: 'prepared' },
  }, { durable: true });
  await writer.append('unit_state', {
    container_key: 'memory_consolidate_windows',
    unit_id: 'mcw-3',
    unit: { status: 'succeeded' },
  }, { durable: true });

  const boundedFs = Object.create(fs);
  boundedFs.readFile = async (file, ...args) => {
    if (path.resolve(file) === path.resolve(writer.journalPath)) {
      throw new Error('unbounded_journal_read');
    }
    return fs.readFile(file, ...args);
  };
  const reader = new RunStateStore({
    statePath,
    writeSnapshot: (file, state) => fs.writeFile(file, JSON.stringify(state)),
    fsApi: boundedFs,
  });

  const events = await reader.loadJournal({ retainFromSeq: boundary.seq });

  assert.deepEqual(events.map((event) => event.seq), [2, 3]);
  assert.equal(reader.seq, 3);
  const state = {
    orchestration_journal: {
      included_seq: boundary.seq,
      included_hash: boundary.hash,
    },
    memory_consolidate_windows: {},
  };
  reader.replay(state, events);
  assert.deepEqual(Object.keys(state.memory_consolidate_windows), ['mcw-3']);
});

test('replay rejects a snapshot boundary that does not match the journal hash', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-'));
  const statePath = path.join(dir, 'run.json');
  const store = new RunStateStore({
    statePath,
    writeSnapshot: (file, state) => fs.writeFile(file, JSON.stringify(state)),
  });
  const event = await store.append('unit_state', {
    container_key: 'memory_consolidate_windows',
    unit_id: 'mcw-1',
    unit: { status: 'prepared' },
  }, { durable: true });

  assert.throws(() => store.replay({
    orchestration_journal: { included_seq: 1, included_hash: `${event.hash}-wrong` },
  }, [event]), /journal_snapshot_boundary_mismatch/);
});

test('checkpoint compacts the active journal into a fresh recovery baseline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-'));
  const statePath = path.join(dir, 'run.json');
  const store = new RunStateStore({
    statePath,
    writeSnapshot: (file, state) => fs.writeFile(file, JSON.stringify(state)),
  });
  const units = {};
  for (let index = 1; index <= 20; index += 1) {
    const unitId = `reflect-${index}`;
    units[unitId] = { status: 'succeeded', payload: 'x'.repeat(4_000) };
    await store.append('unit_state', {
      container_key: 'reflect_insight_windows',
      unit_id: unitId,
      unit: units[unitId],
    }, { durable: true });
  }
  const beforeBytes = (await fs.stat(store.journalPath)).size;
  const state = {
    run_id: 'compact-run',
    scheduler_epoch: 1,
    orchestration_journal: { included_seq: 0, included_hash: null },
    reflect_insight_windows: units,
  };

  await store.checkpoint(state);

  const afterBytes = (await fs.stat(store.journalPath)).size;
  assert.equal(afterBytes < beforeBytes / 10, true);
  assert.deepEqual(state.orchestration_journal, { included_seq: 0, included_hash: null });
  const snapshot = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const reader = new RunStateStore({
    statePath,
    writeSnapshot: (file, nextState) => fs.writeFile(file, JSON.stringify(nextState)),
  });
  const events = await reader.loadJournal();
  assert.deepEqual(events.map((event) => event.type), ['journal_base']);
  assert.equal(reader.seq, 21);
  reader.replay(snapshot, events);
  assert.equal(snapshot.reflect_insight_windows['reflect-20'].status, 'succeeded');
});

test('checkpoint replacement failure leaves the previous journal recoverable from the new snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-'));
  const statePath = path.join(dir, 'run.json');
  const writer = new RunStateStore({
    statePath,
    writeSnapshot: (file, state) => fs.writeFile(file, JSON.stringify(state)),
  });
  const unit = { status: 'succeeded', insight_ids: ['insight-1'] };
  await writer.append('unit_state', {
    container_key: 'reflect_insight_windows',
    unit_id: 'reflect-1',
    unit,
  }, { durable: true });

  const failingFs = Object.create(fs);
  failingFs.rename = async (_from, to) => {
    if (path.resolve(to) === path.resolve(writer.journalPath)) throw new Error('injected_journal_replace_failure');
    return fs.rename(_from, to);
  };
  const checkpointing = new RunStateStore({
    statePath,
    writeSnapshot: (file, state) => fs.writeFile(file, JSON.stringify(state)),
    fsApi: failingFs,
  });
  await checkpointing.loadJournal();
  const state = {
    run_id: 'recoverable-checkpoint',
    scheduler_epoch: 1,
    orchestration_journal: { included_seq: 0, included_hash: null },
    reflect_insight_windows: { 'reflect-1': unit },
  };

  await assert.rejects(() => checkpointing.checkpoint(state), /injected_journal_replace_failure/);

  const snapshot = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const reader = new RunStateStore({
    statePath,
    writeSnapshot: (file, nextState) => fs.writeFile(file, JSON.stringify(nextState)),
  });
  const events = await reader.loadJournal();
  reader.replay(snapshot, events);
  assert.deepEqual(snapshot.orchestration_journal, { included_seq: 0, included_hash: null });
  assert.deepEqual(snapshot.reflect_insight_windows['reflect-1'].insight_ids, ['insight-1']);
});

test('semantic unit replay restores result char sizes used by later stable window planning', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-'));
  const statePath = path.join(dir, 'run.json');
  const store = new RunStateStore({
    statePath,
    writeSnapshot: (file, state) => fs.writeFile(file, JSON.stringify(state)),
  });
  const event = await store.append('unit_state', {
    container_key: 'semantic_windows',
    unit_id: 'sem-1',
    unit: {
      window_id: 'sem-1',
      input_hash: 'input-1',
      status: 'succeeded',
      semantic_memory_ids: ['semantic-memory-1'],
    },
    semantic_memory_char_sizes: {
      'semantic-memory-1': 2400,
    },
  }, { durable: true });
  const state = {
    orchestration_journal: { included_seq: 0, included_hash: null },
    semantic_windows: {},
    semantic_memory_char_sizes: { existing: 1200 },
  };

  store.replay(state, [event]);

  assert.equal(state.semantic_windows['sem-1'].input_hash, 'input-1');
  assert.deepEqual(state.semantic_memory_char_sizes, {
    existing: 1200,
    'semantic-memory-1': 2400,
  });
});

test('status manifest exposes ordered-stage in-flight gaps for managed drain verification', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-'));
  const statePath = path.join(dir, 'run.json');
  const store = new RunStateStore({
    statePath,
    writeSnapshot: (file, state) => fs.writeFile(file, JSON.stringify(state)),
  });

  await store.writeStatus({
    run_id: 'release-b',
    memory_consolidate_windows: {
      prepared: { status: 'prepared' },
      recorded: { status: 'succeeded', record_pending: true },
      done: { status: 'succeeded' },
    },
    skill_extract: {
      committing: { status: 'committing' },
      skipped: { status: 'skipped' },
    },
  });

  const manifest = JSON.parse(await fs.readFile(store.statusPath, 'utf8'));
  assert.deepEqual(manifest.in_flight_gaps, {
    total: 3,
    by_stage: {
      memory_consolidate: 2,
      skill_extract: 1,
    },
  });
});

test('concurrent status writes cannot let an older manifest overwrite newer progress', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-state-'));
  const statePath = path.join(dir, 'run.json');
  let statusRenameCount = 0;
  const reorderedFs = Object.create(fs);
  reorderedFs.rename = async (from, to) => {
    if (path.resolve(to) === path.resolve(statePath.replace(/\.json$/i, '.status.json'))) {
      statusRenameCount += 1;
      const content = await fs.readFile(from);
      if (statusRenameCount === 1) await new Promise((resolve) => setTimeout(resolve, 30));
      await fs.writeFile(to, content);
      await fs.unlink(from);
      return;
    }
    return fs.rename(from, to);
  };
  const store = new RunStateStore({
    statePath,
    writeSnapshot: (file, state) => fs.writeFile(file, JSON.stringify(state)),
    fsApi: reorderedFs,
  });
  const stateWith = (succeeded, pending) => ({
    run_id: 'status-order',
    scheduler_epoch: 1,
    updated_at: `2026-07-22T00:00:0${succeeded}.000Z`,
    coverage: {
      reflect_insight_windows: { succeeded, pending, failed: 0, skipped: 0, running: 0 },
      acceptance_ready: false,
    },
  });

  await Promise.all([
    store.writeStatus(stateWith(1, 1)),
    store.writeStatus(stateWith(2, 0)),
  ]);

  const manifest = JSON.parse(await fs.readFile(store.statusPath, 'utf8'));
  assert.equal(manifest.coverage.reflect_insight_windows.succeeded, 2);
  assert.equal(manifest.coverage.reflect_insight_windows.pending, 0);
});

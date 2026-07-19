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

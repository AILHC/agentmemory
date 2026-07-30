import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createOfflineStateKvSnapshot,
  verifyOfflineStateKvSnapshot,
} from './offline-statekv-snapshot-v1.mjs';

async function fixture(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const stateDir = path.join(root, 'source-state');
  await fs.mkdir(stateDir);
  await fs.writeFile(path.join(stateDir, 'mem%3Alessons.bin'), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(stateDir, 'mem%3Ametrics.bin'), Buffer.from([4, 5, 6]));
  const journalPath = path.join(root, 'lessons.jsonl');
  const enginePath = path.join(root, 'iii.exe');
  await fs.writeFile(journalPath, '{"seq":0}\n');
  await fs.writeFile(enginePath, Buffer.from([7, 8, 9]));
  return {
    root,
    stateDir,
    journalPath,
    enginePath,
    destinationDir: path.join(root, 'snapshot'),
    expectedJournal: {
      run_id: 'run-1',
      stage: 'lessons',
      journal_seq: 0,
      input_summary_hash: 'a'.repeat(64),
    },
  };
}

test('creates and re-verifies an exact two-pass opaque StateKV snapshot', async (context) => {
  const input = await fixture('offline-statekv-snapshot');
  context.after(() => fs.rm(input.root, { recursive: true, force: true }));
  const manifest = await createOfflineStateKvSnapshot({
    ...input,
    capturedAt: '2026-07-30T00:00:00.000Z',
    expectedJournal: {
      run_id: 'run-1',
      stage: 'lessons',
      journal_seq: 0,
      input_summary_hash: 'a'.repeat(64),
    },
  });
  assert.equal(manifest.completeness.two_pass_source_match, true);
  assert.equal(manifest.state_files.length, 2);
  assert.deepEqual(
    await verifyOfflineStateKvSnapshot({ snapshotDir: input.destinationDir }),
    manifest,
  );
});

test('rejects source drift between inventory passes and leaves no destination', async (context) => {
  const input = await fixture('offline-statekv-drift');
  context.after(() => fs.rm(input.root, { recursive: true, force: true }));
  await assert.rejects(
    () => createOfflineStateKvSnapshot({
      ...input,
      afterFirstInventory: async () => {
        await fs.writeFile(path.join(input.stateDir, 'mem%3Alessons.bin'), 'changed');
      },
    }),
    /offline_snapshot_source_drifted/,
  );
  await assert.rejects(() => fs.access(input.destinationDir), { code: 'ENOENT' });
});

test('rejects temporary, unknown, and nested state entries', async (context) => {
  const cases = [
    ['mem%3Alessons.tmp.bin', 'x', /offline_snapshot_temporary_file_rejected/],
    ['README.txt', 'x', /offline_snapshot_unknown_state_file_rejected/],
  ];
  for (const [name, body, pattern] of cases) {
    const input = await fixture(`offline-statekv-invalid-${name.replaceAll(/[^a-z]/gi, '')}`);
    context.after(() => fs.rm(input.root, { recursive: true, force: true }));
    await fs.writeFile(path.join(input.stateDir, name), body);
    await assert.rejects(() => createOfflineStateKvSnapshot(input), pattern);
  }

  const nested = await fixture('offline-statekv-nested');
  context.after(() => fs.rm(nested.root, { recursive: true, force: true }));
  await fs.mkdir(path.join(nested.stateDir, 'nested'));
  await assert.rejects(
    () => createOfflineStateKvSnapshot(nested),
    /offline_snapshot_state_entry_invalid/,
  );
});

test('rejects a symbolic-link state entry', async (context) => {
  const linked = await fixture('offline-statekv-link');
  context.after(() => fs.rm(linked.root, { recursive: true, force: true }));
  try {
    await fs.symlink(
      path.join(linked.stateDir, 'mem%3Alessons.bin'),
      path.join(linked.stateDir, 'linked.bin'),
      'file',
    );
  } catch (error) {
    if (error?.code === 'EPERM') {
      context.skip('当前 Windows 权限不允许创建文件符号链接');
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => createOfflineStateKvSnapshot(linked),
    /offline_snapshot_state_entry_invalid/,
  );
});

test('verification rejects a snapshot reached through a symbolic-link ancestor', async (context) => {
  const input = await fixture('offline-statekv-ancestor-link');
  context.after(() => fs.rm(input.root, { recursive: true, force: true }));
  await createOfflineStateKvSnapshot(input);
  const alias = `${input.root}-alias`;
  context.after(() => fs.rm(alias, { recursive: true, force: true }));
  try {
    await fs.symlink(input.root, alias, 'junction');
  } catch (error) {
    if (error?.code === 'EPERM') {
      context.skip('当前 Windows 权限不允许创建目录联接');
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => verifyOfflineStateKvSnapshot({
      snapshotDir: path.join(alias, path.basename(input.destinationDir)),
    }),
    /offline_snapshot_symbolic_link_ancestor_rejected/,
  );
});

test('verification rejects missing, extra, and changed copied state', async (context) => {
  for (const mutation of ['missing', 'extra', 'top-level-extra', 'changed']) {
    const input = await fixture(`offline-statekv-copy-${mutation}`);
    context.after(() => fs.rm(input.root, { recursive: true, force: true }));
    await createOfflineStateKvSnapshot(input);
    const target = path.join(input.destinationDir, 'state', 'mem%3Alessons.bin');
    if (mutation === 'missing') await fs.unlink(target);
    if (mutation === 'extra') {
      await fs.writeFile(path.join(input.destinationDir, 'state', 'extra.bin'), 'extra');
    }
    if (mutation === 'top-level-extra') {
      await fs.writeFile(path.join(input.destinationDir, 'unexpected.bin'), 'extra');
    }
    if (mutation === 'changed') await fs.writeFile(target, 'changed');
    await assert.rejects(
      () => verifyOfflineStateKvSnapshot({ snapshotDir: input.destinationDir }),
      /offline_snapshot_(?:content_drifted|layout_invalid)/,
    );
  }
});

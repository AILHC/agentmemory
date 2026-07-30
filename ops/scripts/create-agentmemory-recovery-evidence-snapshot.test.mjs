import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from './create-agentmemory-recovery-evidence-snapshot.mjs';

async function argsFixture() {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'agentmemory-evidence-snapshot-cli-',
  ));
  const stateDir = path.join(root, 'state');
  const journalPath = path.join(root, 'lessons.jsonl');
  const enginePath = path.join(root, 'iii.exe');
  const destination = path.join(root, 'snapshot');
  await fs.mkdir(stateDir);
  await fs.writeFile(path.join(stateDir, 'mem%3Alessons.bin'), 'opaque');
  await fs.writeFile(journalPath, '{"seq":0}\n');
  await fs.writeFile(enginePath, 'engine');
  const base = [
    '--state-dir', stateDir,
    '--journal', journalPath,
    '--engine', enginePath,
    '--destination', destination,
    '--run-id', 'run-1',
    '--stage', 'lessons',
    '--journal-seq', '0',
    '--input-summary-hash', 'a'.repeat(64),
    '--captured-at', '2026-07-30T00:00:00.000Z',
  ];
  return { root, destination, base };
}

test('CLI requires all three explicit stopped-writer confirmations', async (context) => {
  const fixture = await argsFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    () => main([...fixture.base, '--confirm-old-runner-stopped']),
    /snapshot_all_writers_stopped_confirmation_required/,
  );
  await assert.rejects(() => fs.access(fixture.destination), { code: 'ENOENT' });
});

test('CLI creates a local snapshot only after complete confirmation', async (context) => {
  const fixture = await argsFixture();
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    assert.equal(await main([
      ...fixture.base,
      '--confirm-old-runner-stopped',
      '--confirm-all-state-writers-stopped',
      '--confirm-journal-writers-stopped',
    ]), 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = JSON.parse(chunks.join(''));
  assert.equal(output.state_file_count, 1);
  assert.equal('destination' in output, false);
  assert.equal(
    JSON.parse(await fs.readFile(
      path.join(fixture.destination, 'snapshot-manifest.json'),
      'utf8',
    )).expected_journal.run_id,
    'run-1',
  );
});

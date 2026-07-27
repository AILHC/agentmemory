import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertV1ReleaseGate, inspectV1ReleaseGate } from './v2-release-gate.mjs';

test('v2 release gate blocks locks, incomplete runs, and completion without bounded proof', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-release-blocked-'));
  await fs.writeFile(path.join(stateDir, 'active.json.lock'), '{}\n');
  await fs.writeFile(path.join(stateDir, 'unfinished.status.json'), JSON.stringify({
    current_stage: 'summary',
    coverage: { acceptance_ready: false },
    in_flight_gaps: { total: 1 },
  }));
  await fs.writeFile(path.join(stateDir, 'unknown.journal.jsonl'), '{}\n');
  await fs.writeFile(path.join(stateDir, 'invalid.status.json'), '{');

  const result = await inspectV1ReleaseGate(stateDir);
  assert.deepEqual(result, {
    ready: false,
    blockers: [
      { run_id: 'active', reason: 'v1_lock_present' },
      { run_id: 'invalid', reason: 'v1_status_invalid' },
      { run_id: 'unfinished', reason: 'v1_run_incomplete' },
      { run_id: 'unknown', reason: 'v1_completion_unproven' },
    ],
  });
  await assert.rejects(() => assertV1ReleaseGate(stateDir), /v2_v1_release_gate_blocked/);
});

test('v2 release gate allows completed v1 status without reading the large snapshot', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-release-ready-'));
  await fs.writeFile(path.join(stateDir, 'complete.json'), 'not parsed by the release gate');
  await fs.writeFile(path.join(stateDir, 'complete.journal.jsonl'), 'not parsed by the release gate');
  await fs.writeFile(path.join(stateDir, 'complete.status.json'), JSON.stringify({
    run_id: 'complete',
    current_stage: null,
    coverage: { acceptance_ready: true },
    in_flight_gaps: { total: 0, by_stage: {} },
  }));

  assert.deepEqual(await assertV1ReleaseGate(stateDir), { ready: true, blockers: [] });
});

test('v2 release gate ignores exit diagnostics but still blocks real v1 snapshots', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-release-diagnostics-'));
  await fs.writeFile(path.join(stateDir, 'resume-attempt.exit.json'), JSON.stringify({
    pid: 123,
    exit_code: 1,
    error_name: 'Error',
  }));
  await fs.writeFile(path.join(stateDir, 'resume-attempt.stdout.log'), '');
  await fs.writeFile(path.join(stateDir, 'resume-attempt.stderr.log'), '');
  await fs.writeFile(path.join(stateDir, 'resume-attempt.launch.mjs'), 'export {};\n');
  await fs.writeFile(path.join(stateDir, 'legacy-run.json'), '{}\n');

  assert.deepEqual(await inspectV1ReleaseGate(stateDir), {
    ready: false,
    blockers: [
      { run_id: 'legacy-run', reason: 'v1_completion_unproven' },
    ],
  });
});

test('v2 release gate allows a state directory containing only exit diagnostics', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-release-exit-only-'));
  await fs.writeFile(path.join(stateDir, 'resume-attempt.exit.json'), '{}\n');
  await fs.writeFile(path.join(stateDir, 'another-attempt.exit.json'), '{}\n');

  assert.deepEqual(await assertV1ReleaseGate(stateDir), { ready: true, blockers: [] });
});

test('v2 release gate treats a missing state directory as drained', async () => {
  const stateDir = path.join(os.tmpdir(), `agentmemory-v2-release-missing-${Date.now()}`);
  assert.deepEqual(await inspectV1ReleaseGate(stateDir), { ready: true, blockers: [] });
});

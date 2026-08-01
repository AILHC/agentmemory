import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const drainScript = path.resolve(
  'ops',
  'scripts',
  'request-agentmemory-full-extraction-drain.ps1',
);
const journalModuleUrl = pathToFileURL(path.resolve(
  'ops',
  'scripts',
  'lib',
  'run-state-journal-v2.mjs',
)).href;

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

test('drain command binds a v2 request to the live writer and verifies the durable pause', async (context) => {
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (pwsh.status !== 0) {
    context.skip('pwsh 不可用');
    return;
  }

  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-drain-command-'));
  const runId = 'drain-command';
  const runRoot = path.join(runtimeRoot, 'extraction-runs', `${runId}.v2`);
  const helperPath = path.join(runtimeRoot, 'cooperative-runner.mjs');
  await fs.writeFile(helperPath, `
import fs from 'node:fs/promises';
import path from 'node:path';
import { RunStateJournalV2 } from ${JSON.stringify(journalModuleUrl)};

const [runRoot, runId] = process.argv.slice(2);
const journal = new RunStateJournalV2({ rootDir: runRoot, runId });
await journal.acquireLock();
await journal.appendControl('run_started', { run_id: runId });
await journal.appendControl('stage_opened', { stage: 'summary' });
await journal.appendStage('summary', 'unit_planned', { unit_id: 'session-a' });
await journal.appendStage('summary', 'stage_plan_completed', { unit_count: 1 });
await journal.writeStatus({ status: 'running', current_stage: 'summary' });
const requestPath = path.join(runRoot, 'drain-request.json');
let request = null;
for (let attempt = 0; attempt < 400 && request === null; attempt += 1) {
  request = await fs.readFile(requestPath, 'utf8').then(JSON.parse).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (request === null) await new Promise((resolve) => setTimeout(resolve, 25));
}
if (request === null) throw new Error('drain_request_missing');
if (request.run_id !== runId || request.owner_id !== journal.lock.owner_id) {
  throw new Error('drain_request_identity_mismatch');
}
await journal.appendControl('run_paused', {
  run_id: runId,
  reason_code: 'operator_drain_requested',
  stage: 'summary',
  next_unit_id: 'session-a',
  processed_unit_count: 0,
  requested_at: request.requested_at,
});
await journal.writeStatus({
  status: 'paused',
  current_stage: 'summary',
  pause_reason_code: 'operator_drain_requested',
  processed_units_this_invocation: 0,
  next_unit_id: 'session-a',
});
await journal.releaseLock();
`, 'utf8');

  const child = spawn(process.execPath, [helperPath, runRoot, runId], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += chunk; });
  const childExit = once(child, 'exit');
  context.after(async () => {
    if (child.exitCode === null) child.kill();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });
  await waitForFile(path.join(runRoot, 'writer.lock.json'));

  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-File', drainScript,
    '-RunId', runId,
    '-RuntimeRoot', runtimeRoot,
    '-TimeoutSeconds', '10',
    '-PollIntervalMs', '50',
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const [childCode] = await childExit;

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(childCode, 0, childStderr);
  assert.match(result.stdout, /drain\.requested .*format=v2/);
  assert.match(result.stdout, /drain\.completed .*format=v2/);
  await assert.rejects(
    fs.access(path.join(runRoot, 'drain-request.json')),
    (error) => error?.code === 'ENOENT',
  );
  await assert.rejects(
    fs.access(path.join(runRoot, 'writer.lock.json')),
    (error) => error?.code === 'ENOENT',
  );
  const control = (await fs.readFile(path.join(runRoot, 'control.jsonl'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  assert.equal(control.at(-1).type, 'run_paused');
  assert.equal(control.at(-1).payload.reason_code, 'operator_drain_requested');
});

test('drain command accepts an owner that exits after the request only with zero in-flight work', async (context) => {
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (pwsh.status !== 0) {
    context.skip('pwsh 不可用');
    return;
  }

  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-drain-race-'));
  const runId = 'drain-owner-exit';
  const runRoot = path.join(runtimeRoot, 'extraction-runs', `${runId}.v2`);
  const helperPath = path.join(runtimeRoot, 'exiting-runner.mjs');
  await fs.writeFile(helperPath, `
import fs from 'node:fs/promises';
import path from 'node:path';
import { RunStateJournalV2 } from ${JSON.stringify(journalModuleUrl)};

const [runRoot, runId] = process.argv.slice(2);
const journal = new RunStateJournalV2({ rootDir: runRoot, runId });
await journal.acquireLock();
await journal.appendControl('run_started', { run_id: runId });
await journal.appendControl('stage_opened', { stage: 'summary' });
await journal.appendStage('summary', 'unit_planned', { unit_id: 'session-a' });
await journal.appendStage('summary', 'stage_plan_completed', { unit_count: 1 });
await journal.writeStatus({ status: 'running', current_stage: 'summary' });
const requestPath = path.join(runRoot, 'drain-request.json');
for (let attempt = 0; attempt < 400; attempt += 1) {
  try {
    await fs.access(requestPath);
    await journal.releaseLock();
    process.exit(0);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}
throw new Error('drain_request_missing');
`, 'utf8');

  const child = spawn(process.execPath, [helperPath, runRoot, runId], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += chunk; });
  const childExit = once(child, 'exit');
  context.after(async () => {
    if (child.exitCode === null) child.kill();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });
  await waitForFile(path.join(runRoot, 'writer.lock.json'));

  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-File', drainScript,
    '-RunId', runId,
    '-RuntimeRoot', runtimeRoot,
    '-TimeoutSeconds', '10',
    '-PollIntervalMs', '50',
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const [childCode] = await childExit;

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(childCode, 0, childStderr);
  assert.match(result.stdout, /reason=owner_exited_without_in_flight/);
  await assert.rejects(
    fs.access(path.join(runRoot, 'drain-request.json')),
    (error) => error?.code === 'ENOENT',
  );
});

test('drain command preserves the v1 request and in-flight-gap verification contract', async (context) => {
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (pwsh.status !== 0) {
    context.skip('pwsh 不可用');
    return;
  }

  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v1-drain-command-'));
  const runId = 'v1-drain-command';
  const runsRoot = path.join(runtimeRoot, 'extraction-runs');
  const statePath = path.join(runsRoot, `${runId}.json`);
  const lockPath = `${statePath}.lock`;
  const helperPath = path.join(runtimeRoot, 'v1-cooperative-runner.mjs');
  await fs.writeFile(helperPath, `
import fs from 'node:fs/promises';
import path from 'node:path';

const [statePath, runId] = process.argv.slice(2);
const lockPath = \`${'${statePath}'}.lock\`;
const requestPath = \`${'${statePath}'}.drain-request.json\`;
await fs.mkdir(path.dirname(statePath), { recursive: true });
await fs.writeFile(statePath, '{}\\n', 'utf8');
await fs.writeFile(lockPath, \`${'${JSON.stringify({'}
  run_id: runId,
  pid: process.pid,
  owner_id: 'v1-test-owner',
  created_at: new Date().toISOString(),
})}\\n\`, 'utf8');
let request = null;
for (let attempt = 0; attempt < 400 && request === null; attempt += 1) {
  request = await fs.readFile(requestPath, 'utf8').then(JSON.parse).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (request === null) await new Promise((resolve) => setTimeout(resolve, 25));
}
if (request === null) throw new Error('v1_drain_request_missing');
if (request.run_id !== runId || request.owner_id !== 'v1-test-owner') {
  throw new Error('v1_drain_request_identity_mismatch');
}
await fs.writeFile(statePath.replace(/\\.json$/u, '.status.json'), \`${'${JSON.stringify({'}
  run_id: runId,
  in_flight_gaps: { total: 0 },
})}\\n\`, 'utf8');
await fs.unlink(lockPath);
`, 'utf8');

  const child = spawn(process.execPath, [helperPath, statePath, runId], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += chunk; });
  const childExit = once(child, 'exit');
  context.after(async () => {
    if (child.exitCode === null) child.kill();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });
  await waitForFile(lockPath);

  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-File', drainScript,
    '-RunId', runId,
    '-RuntimeRoot', runtimeRoot,
    '-TimeoutSeconds', '10',
    '-PollIntervalMs', '50',
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const [childCode] = await childExit;

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(childCode, 0, childStderr);
  assert.match(result.stdout, /drain\.requested .*format=v1/);
  assert.match(result.stdout, /drain\.completed .*format=v1/);
  await assert.rejects(
    fs.access(`${statePath}.drain-request.json`),
    (error) => error?.code === 'ENOENT',
  );
});

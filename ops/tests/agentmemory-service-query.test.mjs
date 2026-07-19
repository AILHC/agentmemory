import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const commonScript = path.resolve(
  'ops',
  'scripts',
  '_agentmemory-local-common.ps1',
);
const doctorScripts = [
  'doctor-agentmemory.ps1',
  'doctor-agentmemory-console.ps1',
];

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(body, cwd = process.cwd()) {
  const encoded = Buffer.from(body, 'utf16le').toString('base64');
  return spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runPowerShellFile(scriptPath, cwd = process.cwd()) {
  return spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('deployed scripts infer a relocated runtime from app current', async (context) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-relocated-runtime-'));
  context.after(() => fs.rm(runtime, { recursive: true, force: true }));
  const scripts = path.join(runtime, 'app', 'current', 'scripts');
  await fs.mkdir(scripts, { recursive: true });
  const relocatedCommon = path.join(scripts, '_agentmemory-local-common.ps1');
  await fs.copyFile(commonScript, relocatedCommon);
  await fs.writeFile(path.join(runtime, 'app', 'current', 'DEPLOYMENT.json'), '{}\n');

  const result = runPowerShell(`
. ${quotePowerShell(relocatedCommon)}
[pscustomobject]@{
  formalRoot = $script:AmFormalRoot
  appCurrent = $script:AmAppCurrent
  devApp = $script:AmDevApp
} | ConvertTo-Json -Compress
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const facts = JSON.parse(result.stdout.trim());
  assert.equal(path.resolve(facts.formalRoot), path.resolve(runtime));
  assert.equal(path.resolve(facts.appCurrent), path.resolve(runtime, 'app', 'current'));
  assert.equal(path.resolve(facts.devApp), path.resolve(runtime, 'app', 'current'));
});

test('service query distinguishes present, absent, and backend failure without CIM', () => {
  const script = `
$ErrorActionPreference = 'Stop'
. ${quotePowerShell(commonScript)}
$script:AmServiceName = 'EventLog'
$present = Get-AmServiceQuery
$script:AmServiceName = 'AgentMemory-Definitely-Missing-Service'
$absent = Get-AmServiceQuery
$script:AmServiceName = 'bad/service/name'
$failed = Get-AmServiceQuery
[pscustomobject]@{
  present = $present.QueryState
  presentState = $present.State
  presentPid = $present.ProcessId
  absent = $absent.QueryState
  failed = $failed.QueryState
} | ConvertTo-Json -Compress
`;
  const result = runPowerShell(script);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const facts = JSON.parse(result.stdout.trim());
  assert.equal(facts.present, 'present');
  assert.equal(facts.presentState, 'Running');
  assert.equal(facts.presentPid > 0, true);
  assert.equal(facts.absent, 'absent');
  assert.equal(facts.failed, 'query_failed');
  assert.doesNotMatch(readFileSync(commonScript, 'utf8'), /Get-CimInstance\s+Win32_Service/i);
});

test('both doctors report a stable diagnostic backend failure', async (context) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-doctor-service-query-'));
  context.after(() => fs.rm(fixture, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(fixture, '_agentmemory-local-common.ps1'),
    `function Get-AmServiceQuery {
  [pscustomobject]@{ QueryState = 'query_failed'; Name = 'agentmemory'; State = 'Unknown'; ProcessId = 0 }
}
`,
  );

  for (const doctorName of doctorScripts) {
    await fs.copyFile(
      path.resolve('ops', 'scripts', doctorName),
      path.join(fixture, doctorName),
    );
    const result = runPowerShellFile(path.join(fixture, doctorName), fixture);
    assert.equal(result.status, 2, `${doctorName}\n${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /service\.query=failed/);
    assert.match(result.stdout, /diagnosis=BAD_DIAGNOSTIC_BACKEND/);
    assert.doesNotMatch(result.stdout, /页面文件|CIM|Win32_Service/i);
  }
});

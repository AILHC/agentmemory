import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const deployScript = path.resolve(
  'ops',
  'scripts',
  'deploy-agentmemory-current.ps1',
);
const drainScript = path.resolve(
  'ops',
  'scripts',
  'request-agentmemory-full-extraction-drain.ps1',
);
const statusScript = path.resolve(
  'ops',
  'scripts',
  'status-agentmemory-full-extraction.ps1',
);

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(body) {
  const script = `
$ErrorActionPreference = 'Stop'
. ${quotePowerShell(deployScript)}
${body}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('部署入口只依赖 AgentMemory 仓库，不引用使用方仓库路径', async () => {
  const source = await fs.readFile(deployScript, 'utf8');
  assert.doesNotMatch(source, /tool-adoptions[\\/]agentmemory/i);
  assert.doesNotMatch(source, /vendor[\\/]agentmemory/i);
  assert.doesNotMatch(source, /ai-workflow-lab/i);

  const result = runPowerShell(`
if (-not [string]::Equals(
  [System.IO.Path]::GetFullPath($RepositoryRoot),
  [System.IO.Path]::GetFullPath(${quotePowerShell(path.resolve('.'))}),
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  throw "unexpected repository root: $RepositoryRoot"
}
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('目录替换成功后 current 是完整新目录，previous 是旧目录', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-deploy-swap-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'current');
  const next = path.join(root, 'current.new');
  const previous = path.join(root, 'current.previous');
  await fs.mkdir(current);
  await fs.mkdir(next);
  await fs.writeFile(path.join(current, 'marker.txt'), 'old');
  await fs.writeFile(path.join(next, 'marker.txt'), 'new');

  const result = runPowerShell(`
Switch-AmCurrentDirectories -CurrentPath ${quotePowerShell(current)} -NewPath ${quotePowerShell(next)} -PreviousPath ${quotePowerShell(previous)}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await fs.readFile(path.join(current, 'marker.txt'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(previous, 'marker.txt'), 'utf8'), 'old');
  await assert.rejects(fs.access(next));
});

test('第二次改名失败时自动恢复旧 current', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-deploy-restore-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'current');
  const next = path.join(root, 'current.new');
  const previous = path.join(root, 'current.previous');
  await fs.mkdir(current);
  await fs.mkdir(next);
  await fs.writeFile(path.join(current, 'marker.txt'), 'old');

  const result = runPowerShell(`
$caught = $false
try {
  Switch-AmCurrentDirectories -CurrentPath ${quotePowerShell(current)} -NewPath ${quotePowerShell(next)} -PreviousPath ${quotePowerShell(previous)} -AfterCurrentMoved { throw 'injected failure' }
} catch {
  $caught = $true
}
if (-not $caught) { throw 'expected injected failure' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await fs.readFile(path.join(current, 'marker.txt'), 'utf8'), 'old');
  assert.equal((await fs.stat(next)).isDirectory(), true);
  await assert.rejects(fs.access(previous));
});

test('部署锁排斥第二个部署并且只允许所有者释放', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-deploy-lock-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'deploy.lock.json');

  const result = runPowerShell(`
$first = Enter-AmDeploymentLock -LockPath ${quotePowerShell(lockPath)}
try {
  try {
    [void](Enter-AmDeploymentLock -LockPath ${quotePowerShell(lockPath)})
    throw 'second lock unexpectedly succeeded'
  } catch {
    if (-not $_.Exception.Message.Contains('deployment lock is active')) { throw }
  }
  $wrong = [pscustomobject]@{ LockPath = $first.LockPath; OwnerId = 'wrong-owner' }
  if (Exit-AmDeploymentLock -Lock $wrong) { throw 'wrong owner removed lock' }
  if (-not (Test-Path -LiteralPath ${quotePowerShell(lockPath)})) { throw 'lock disappeared' }
} finally {
  if (-not (Exit-AmDeploymentLock -Lock $first)) { throw 'owner failed to release lock' }
}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  await assert.rejects(fs.access(lockPath));
});

test('KeepStopped 参数必须与自动化暂停确认成对出现', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-deploy-mode-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'tmp', 'deploy-current.lock.json');

  const result = runPowerShell(`
$RuntimeRoot = ${quotePowerShell(root)}
foreach ($arguments in @(
  @{ KeepStopped = $true; ConfirmAutomationPaused = $false },
  @{ KeepStopped = $false; ConfirmAutomationPaused = $true }
)) {
  $caught = $false
  try {
    Invoke-AmDeployment -KeepStopped:$arguments.KeepStopped -ConfirmAutomationPaused:$arguments.ConfirmAutomationPaused
  } catch {
    $caught = $true
  }
  if (-not $caught) { throw 'invalid deployment mode arguments were accepted' }
}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  await assert.rejects(fs.access(lockPath));
});

test('任何全量提炼 lock 都阻止部署', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-deploy-run-lock-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'formal.json.lock'), '{}');

  const result = runPowerShell(`
$caught = $false
try {
  Assert-AmNoExtractionLocks -ExtractionRunsPath ${quotePowerShell(root)}
} catch {
  $caught = $true
}
if (-not $caught) { throw 'runner lock unexpectedly accepted' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('嵌套 v2 writer lock 和 drain 请求都阻止离线部署且不会被删除', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-deploy-v2-lock-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const runRoot = path.join(root, 'formal.v2');
  const lockPath = path.join(runRoot, 'writer.lock.json');
  const drainPath = path.join(root, 'formal.json.drain-request.json');
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(lockPath, '{}');

  let result = runPowerShell(`
$caught = $false
try {
  Assert-AmNoExtractionLocks -ExtractionRunsPath ${quotePowerShell(root)}
} catch {
  $caught = $true
}
if (-not $caught) { throw 'nested v2 writer lock unexpectedly accepted' }
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal((await fs.stat(lockPath)).isFile(), true);

  await fs.rm(lockPath);
  await fs.writeFile(drainPath, '{}');
  result = runPowerShell(`
$caught = $false
try {
  Assert-AmNoExtractionControlRequests -ExtractionRunsPath ${quotePowerShell(root)}
} catch {
  $caught = $true
}
if (-not $caught) { throw 'drain request unexpectedly accepted' }
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal((await fs.stat(drainPath)).isFile(), true);
});

test('KeepStopped 前置条件拒绝未停止、未禁用或未确认自动化暂停', () => {
  const result = runPowerShell(`
foreach ($case in @(
  @{ Service = [pscustomobject]@{ Status = 'Running'; StartType = 'Disabled' }; Pattern = 'Stopped' },
  @{ Service = [pscustomobject]@{ Status = 'Stopped'; StartType = 'Automatic' }; Pattern = 'Disabled' }
)) {
  $caught = $false
  try {
    Assert-AmKeepStoppedServiceState -Service $case.Service
  } catch {
    if (-not $_.Exception.Message.Contains($case.Pattern)) { throw }
    $caught = $true
  }
  if (-not $caught) { throw 'unsafe service state unexpectedly accepted' }
}
$caught = $false
try {
  Assert-AmKeepStoppedPreconditions -CurrentPath 'C:/missing-current' -ExtractionRunsPath 'C:/missing-runs'
} catch {
  if (-not $_.Exception.Message.Contains('paused automation confirmation')) { throw }
  $caught = $true
}
if (-not $caught) { throw 'missing automation confirmation unexpectedly accepted' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('首次迁移只把 Service stop hook 更新到 current scripts', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-deploy-service-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const servicePath = path.join(root, 'agentmemory.xml');
  const current = path.join(root, 'app', 'current');
  await fs.mkdir(current, { recursive: true });
  await fs.writeFile(servicePath, `<?xml version="1.0" encoding="utf-8"?>
<service>
  <workingdirectory>${root}\\app\\current</workingdirectory>
  <stopargument>-File</stopargument>
  <stopargument>${root}\\scripts\\stop-agentmemory-service-hook.ps1</stopargument>
</service>
`);

  const result = runPowerShell(`
$backup = Update-AmServiceConfigForCurrent -ServiceConfigPath ${quotePowerShell(servicePath)} -CurrentPath ${quotePowerShell(current)}
if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw 'service backup missing' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const updated = await fs.readFile(servicePath, 'utf8');
  assert.match(
    updated.replaceAll('/', '\\'),
    new RegExp(`${current.replaceAll('\\', '\\\\')}\\\\scripts\\\\stop-agentmemory-service-hook\\.ps1`, 'i'),
  );
  assert.equal(updated.includes(`${root}\\scripts\\stop-agentmemory-service-hook.ps1`), false);
});

test('发布依赖锁从 AgentMemory 版本化输入复制到应用构建目录', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-deploy-lockfile-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceExport = path.join(root, 'source');
  const appSource = path.join(root, 'app');
  const lockSource = path.join(
    sourceExport,
    'ops',
    'deployment-package-lock.json',
  );
  await fs.mkdir(path.dirname(lockSource), { recursive: true });
  await fs.mkdir(appSource, { recursive: true });
  await fs.writeFile(lockSource, '{"lockfileVersion":3}\n');

  const result = runPowerShell(`
Copy-AmDeploymentPackageLock -SourceExport ${quotePowerShell(sourceExport)} -AppSource ${quotePowerShell(appSource)}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    await fs.readFile(path.join(appSource, 'package-lock.json'), 'utf8'),
    '{"lockfileVersion":3}\n',
  );
});

test('正式 current 只包含显式白名单运维脚本', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-deploy-scripts-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.dirname(deployScript);

  const result = runPowerShell(`
Copy-AmReleaseScripts -Source ${quotePowerShell(source)} -Destination ${quotePowerShell(root)}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(
    (await fs.readdir(root)).sort(),
    [
      '_agentmemory-local-common.ps1',
      'agentmemory-deployment-manifest.mjs',
      'authorize-agentmemory-lessons-failed-terminal-retry.mjs',
      'create-agentmemory-recovery-evidence-snapshot.mjs',
      'doctor-agentmemory-console.ps1',
      'doctor-agentmemory.ps1',
      'lib',
      'migrate-agentmemory-recovery-frontier.mjs',
      'project-agentmemory-recovery-status.mjs',
      'request-agentmemory-full-extraction-drain.ps1',
      'run-agentmemory-cli-import-batch.mjs',
      'run-agentmemory-full-extraction.mjs',
      'start-agentmemory-console.ps1',
      'start-agentmemory.ps1',
      'stop-agentmemory-console.ps1',
      'stop-agentmemory-service-hook.ps1',
      'stop-agentmemory.ps1',
      'status-agentmemory-full-extraction.ps1',
      'validate-agentmemory-worker-supervision.mjs',
    ].sort(),
  );
  assert.deepEqual(
    (await fs.readdir(path.join(root, 'lib'))).sort(),
    [
      'adaptive-provider-limiter.mjs',
      'consolidation-procedural-recovery-adapter-v1.mjs',
      'crystal-recovery-adapter-v1.mjs',
      'effect-state-recovery-stage-catalog-v1.mjs',
      'full-extraction-stage-adapters-v2.mjs',
      'iii-state-read-only-adapter-v1.mjs',
      'legacy-lesson-safe-facts-collector-v1.mjs',
      'lesson-recovery-adapter-v1.mjs',
      'offline-statekv-snapshot-v1.mjs',
      'recoverable-stage-v2.mjs',
      'recovery-frontier-migration-v1.mjs',
      'recovery-journal-reducer-v1.mjs',
      'recovery-migration-contract-v1.mjs',
      'recovery-policy-v1.mjs',
      'recovery-status-projection-v1.mjs',
      'reflect-insight-recovery-adapter-v1.mjs',
      'run-state-journal-v2.mjs',
      'run-state-store.mjs',
      'safe-stage-recovery-adapters-v1.mjs',
      'semantic-rollup-recovery-adapter-v1.mjs',
      'stage-pipeline.mjs',
      'summary-recovery-adapter-v1.mjs',
      'v2-release-gate.mjs',
    ],
  );

  const runnerImport = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(path.join(root, 'run-agentmemory-full-extraction.mjs')).href)})`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(runnerImport.status, 0, runnerImport.stderr || runnerImport.stdout);

  await fs.symlink(
    path.resolve('node_modules'),
    path.join(root, 'node_modules'),
    'junction',
  );
  const migrationImport = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(path.join(root, 'migrate-agentmemory-recovery-frontier.mjs')).href)})`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(
    migrationImport.status,
    0,
    migrationImport.stderr || migrationImport.stdout,
  );
});

test('只读状态入口优先读取 manifest 并校验 lock PID', async (context) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-status-entry-'));
  context.after(() => fs.rm(runtime, { recursive: true, force: true }));
  const runs = path.join(runtime, 'extraction-runs');
  await fs.mkdir(runs);
  await fs.writeFile(path.join(runs, 'formal.status.json'), `${JSON.stringify({
    run_id: 'formal',
    current_stage: 'semantic_rollup',
    coverage: { acceptance_ready: false },
    scheduler_epoch: 3,
    runner_pid: process.pid,
    snapshot_at: '2026-07-18T00:00:00.000Z',
    journal_seq: 7,
    in_flight_gaps: { total: 0, by_stage: {} },
  })}\n`);
  await fs.writeFile(path.join(runs, 'formal.json.lock'), `${JSON.stringify({
    run_id: 'formal',
    pid: process.pid,
    owner_id: 'owner',
    created_at: '2026-07-18T00:00:00.000Z',
  })}\n`);

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-File',
    statusScript,
    '-RunId',
    'formal',
    '-RuntimeRoot',
    runtime,
  ], { encoding: 'utf8', windowsHide: true });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /source=status_manifest/);
  assert.match(result.stdout, /lock_present=true/);
  assert.match(result.stdout, /lock_pid_alive=true/);
  assert.match(result.stdout, /journal_seq=7/);
  assert.match(result.stdout, /in_flight_gaps=0/);
});

test('只读状态入口在 manifest 陈旧时降级读取主快照', async (context) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-status-stale-'));
  context.after(() => fs.rm(runtime, { recursive: true, force: true }));
  const runs = path.join(runtime, 'extraction-runs');
  await fs.mkdir(runs);
  const statusPath = path.join(runs, 'formal.status.json');
  await fs.writeFile(statusPath, `${JSON.stringify({
    run_id: 'formal',
    current_stage: 'reflect_insight',
    coverage: {
      acceptance_ready: false,
      reflect_insight_windows: { succeeded: 1, skipped: 0, failed: 0, pending: 2, running: 0 },
    },
    scheduler_epoch: 3,
    runner_pid: process.pid,
    snapshot_at: '2026-07-21T00:00:00.000Z',
    journal_seq: 7,
  })}\n`);
  const staleAt = new Date(Date.now() - 60_000);
  await fs.utimes(statusPath, staleAt, staleAt);
  await fs.writeFile(path.join(runs, 'formal.json'), `${JSON.stringify({
    run_id: 'formal',
    current_stage: 'reflect_insight',
    coverage: {
      acceptance_ready: false,
      reflect_insight_windows: { succeeded: 2, skipped: 0, failed: 0, pending: 1, running: 0 },
    },
    scheduler_epoch: 3,
    updated_at: new Date().toISOString(),
    orchestration_journal: { included_seq: 8, included_hash: 'hash-8' },
  })}\n`);
  await fs.writeFile(path.join(runs, 'formal.json.lock'), `${JSON.stringify({
    run_id: 'formal',
    pid: process.pid,
    owner_id: 'owner',
    created_at: new Date().toISOString(),
  })}\n`);

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-File',
    statusScript,
    '-RunId',
    'formal',
    '-RuntimeRoot',
    runtime,
    '-StatusStaleAfterSeconds',
    '30',
  ], { encoding: 'utf8', windowsHide: true });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /source=snapshot_fallback_stale_manifest/);
  assert.match(result.stdout, /status_manifest_stale=true/);
  assert.match(result.stdout, /stage\.reflect_insight_windows=succeeded:2,skipped:0,failed:0,pending:1,running:0/);
});

test('受管 drain 超时只报告未排空且不删除活动 lock', async (context) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-drain-entry-'));
  context.after(() => fs.rm(runtime, { recursive: true, force: true }));
  const runs = path.join(runtime, 'extraction-runs');
  await fs.mkdir(runs);
  const lockPath = path.join(runs, 'formal.json.lock');
  await fs.writeFile(lockPath, `${JSON.stringify({
    run_id: 'formal',
    pid: process.pid,
    owner_id: 'owner',
    created_at: new Date(Date.now() - 1000).toISOString(),
  })}\n`);

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-File',
    drainScript,
    '-RunId',
    'formal',
    '-RuntimeRoot',
    runtime,
    '-TimeoutSeconds',
    '1',
    '-PollIntervalMs',
    '50',
  ], { encoding: 'utf8', windowsHide: true });

  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.match(result.stdout, /drain.incomplete/);
  assert.equal((await fs.stat(lockPath)).isFile(), true);
  assert.equal((await fs.stat(path.join(runs, 'formal.json.drain-request.json'))).isFile(), true);
});

test('Windows PowerShell 严格模式可以解析 AgentMemory 源提交', () => {
  const repositoryRoot = path.resolve('.');
  const result = runPowerShell(`
$sourceCommit = Resolve-AmGitCommit -Repo ${quotePowerShell(repositoryRoot)} -Commit 'HEAD'
if ($sourceCommit -notmatch '^[0-9a-f]{40}$') { throw 'invalid source commit' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('生命周期 owner 不依赖 CIM，并自动选择运行中的 Service，否则使用 Console', async () => {
  const source = await fs.readFile(deployScript, 'utf8');
  assert.doesNotMatch(source, /Get-CimInstance/);

  const result = runPowerShell(`
if ((Resolve-AmDeploymentOwner -Service $null) -cne 'Console') { throw 'missing service owner mismatch' }
if ((Resolve-AmDeploymentOwner -Service ([pscustomobject]@{ State = 'Stopped' })) -cne 'Console') { throw 'stopped service owner mismatch' }
if ((Resolve-AmDeploymentOwner -Service ([pscustomobject]@{ Status = 'Running' })) -cne 'Service') { throw 'running service owner mismatch' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('同步调用能取得真实退出码', () => {
  const result = runPowerShell(`
Invoke-AmDeploymentCommand -FilePath 'pwsh.exe' -ArgumentList @('-NoProfile', '-Command', 'exit 0')
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('同步调用失败时报告真实退出码', () => {
  const result = runPowerShell(`
Invoke-AmDeploymentCommand -FilePath 'pwsh.exe' -ArgumentList @('-NoProfile', '-Command', 'exit 7')
`);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exit code 7/);
});

test('已准备目录只在 AgentMemory 源提交一致时允许复用', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-prepared-current-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, 'DEPLOYMENT.json'),
    `${JSON.stringify({ sourceCommit: '1'.repeat(40) })}\n`,
  );

  const result = runPowerShell(`
if (Test-AmPreparedCurrent -CurrentPath ${quotePowerShell(root)} -SourceCommit $('2' * 40)) {
  throw 'mismatched prepared current was reused'
}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('KeepStopped 成功切换全程不启动或停止 runtime', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-keep-stopped-success-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'app', 'current');
  const next = path.join(root, 'app', 'current.new');
  const lockPath = path.join(root, 'tmp', 'deploy-current.lock.json');
  await fs.mkdir(current, { recursive: true });
  await fs.mkdir(next, { recursive: true });
  await fs.mkdir(path.join(root, 'extraction-runs'), { recursive: true });
  await fs.writeFile(path.join(current, 'marker.txt'), 'old');
  await fs.writeFile(path.join(next, 'marker.txt'), 'new');
  await fs.writeFile(
    path.join(next, 'DEPLOYMENT.json'),
    `${JSON.stringify({ sourceCommit: '2'.repeat(40) })}\n`,
  );

  const result = runPowerShell(`
$RuntimeRoot = ${quotePowerShell(root)}
$RepositoryRoot = ${quotePowerShell(path.resolve('.'))}
$script:startCalls = 0
$script:stopCalls = 0
$script:doctorCalls = 0
$script:manifestChecks = 0
function Get-AmDeploymentService { return [pscustomobject]@{ Status = 'Stopped'; StartType = 'Disabled' } }
function Resolve-AmGitCommit { return (('2' * 40) -join '') }
function Invoke-AmStoppedDeploymentDoctor { param($CurrentPath); $script:doctorCalls += 1 }
function Invoke-AmCurrentManifestVerification { param($CurrentPath); $script:manifestChecks += 1 }
function Update-AmServiceConfigForCurrent { param($ServiceConfigPath, $CurrentPath); return $null }
function Move-AmLegacyScriptsToArchive { param($Runtime); return $null }
function Start-AmDeploymentRuntime { $script:startCalls += 1; throw 'runtime start is forbidden' }
function Stop-AmDeploymentRuntime { $script:stopCalls += 1; throw 'runtime stop is forbidden' }
Invoke-AmDeployment -KeepStopped -ConfirmAutomationPaused
if ($script:startCalls -ne 0 -or $script:stopCalls -ne 0) { throw 'runtime lifecycle function was called' }
if ($script:doctorCalls -ne 3) { throw "unexpected stopped doctor calls: $script:doctorCalls" }
if ($script:manifestChecks -ne 2) { throw "unexpected manifest checks: $script:manifestChecks" }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /deployment\.keepStopped=true/);
  assert.equal(await fs.readFile(path.join(current, 'marker.txt'), 'utf8'), 'new');
  await assert.rejects(fs.access(path.join(root, 'app', 'current.previous')));
  await assert.rejects(fs.access(lockPath));
});

test('KeepStopped 在 build 期间状态漂移时拒绝切换且不启动', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-keep-stopped-drift-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'app', 'current');
  const next = path.join(root, 'app', 'current.new');
  const lockPath = path.join(root, 'tmp', 'deploy-current.lock.json');
  await fs.mkdir(current, { recursive: true });
  await fs.mkdir(next, { recursive: true });
  await fs.mkdir(path.join(root, 'extraction-runs'), { recursive: true });
  await fs.writeFile(path.join(current, 'marker.txt'), 'old');
  await fs.writeFile(
    path.join(next, 'DEPLOYMENT.json'),
    `${JSON.stringify({ sourceCommit: '3'.repeat(40) })}\n`,
  );

  const result = runPowerShell(`
$RuntimeRoot = ${quotePowerShell(root)}
$RepositoryRoot = ${quotePowerShell(path.resolve('.'))}
$script:serviceCalls = 0
$script:startCalls = 0
$script:stopCalls = 0
function Get-AmDeploymentService {
  $script:serviceCalls += 1
  if ($script:serviceCalls -ge 3) {
    return [pscustomobject]@{ Status = 'Running'; StartType = 'Disabled' }
  }
  return [pscustomobject]@{ Status = 'Stopped'; StartType = 'Disabled' }
}
function Resolve-AmGitCommit { return (('3' * 40) -join '') }
function Invoke-AmStoppedDeploymentDoctor { param($CurrentPath) }
function Invoke-AmCurrentManifestVerification { param($CurrentPath) }
function Start-AmDeploymentRuntime { $script:startCalls += 1; throw 'runtime start is forbidden' }
function Stop-AmDeploymentRuntime { $script:stopCalls += 1; throw 'runtime stop is forbidden' }
$caught = $false
try {
  Invoke-AmDeployment -KeepStopped -ConfirmAutomationPaused
} catch {
  if (-not $_.Exception.Message.Contains('requires service Stopped')) { throw }
  $caught = $true
}
if (-not $caught) { throw 'service drift unexpectedly accepted' }
if ($script:startCalls -ne 0 -or $script:stopCalls -ne 0) { throw 'runtime lifecycle function was called' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await fs.readFile(path.join(current, 'marker.txt'), 'utf8'), 'old');
  await assert.rejects(fs.access(path.join(root, 'app', 'current.previous')));
  await assert.rejects(fs.access(lockPath));
});

test('KeepStopped 切换后验证失败会回滚且不会重启旧 runtime', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-keep-stopped-rollback-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'app', 'current');
  const next = path.join(root, 'app', 'current.new');
  const lockPath = path.join(root, 'tmp', 'deploy-current.lock.json');
  await fs.mkdir(current, { recursive: true });
  await fs.mkdir(next, { recursive: true });
  await fs.mkdir(path.join(root, 'extraction-runs'), { recursive: true });
  await fs.writeFile(path.join(current, 'marker.txt'), 'old');
  await fs.writeFile(path.join(next, 'marker.txt'), 'new');
  await fs.writeFile(
    path.join(next, 'DEPLOYMENT.json'),
    `${JSON.stringify({ sourceCommit: '4'.repeat(40) })}\n`,
  );

  const result = runPowerShell(`
$RuntimeRoot = ${quotePowerShell(root)}
$RepositoryRoot = ${quotePowerShell(path.resolve('.'))}
$script:startCalls = 0
$script:stopCalls = 0
$script:manifestChecks = 0
function Get-AmDeploymentService { return [pscustomobject]@{ Status = 'Stopped'; StartType = 'Disabled' } }
function Resolve-AmGitCommit { return (('4' * 40) -join '') }
function Invoke-AmStoppedDeploymentDoctor { param($CurrentPath) }
function Invoke-AmCurrentManifestVerification {
  param($CurrentPath)
  $script:manifestChecks += 1
  if ($script:manifestChecks -ge 2) { throw 'injected post-switch manifest failure' }
}
function Update-AmServiceConfigForCurrent { param($ServiceConfigPath, $CurrentPath); return $null }
function Move-AmLegacyScriptsToArchive { param($Runtime); return $null }
function Start-AmDeploymentRuntime { $script:startCalls += 1; throw 'runtime start is forbidden' }
function Stop-AmDeploymentRuntime { $script:stopCalls += 1; throw 'runtime stop is forbidden' }
$caught = $false
try {
  Invoke-AmDeployment -KeepStopped -ConfirmAutomationPaused
} catch {
  if (-not $_.Exception.Message.Contains('injected post-switch manifest failure')) { throw }
  $caught = $true
}
if (-not $caught) { throw 'post-switch failure unexpectedly accepted' }
if ($script:startCalls -ne 0 -or $script:stopCalls -ne 0) { throw 'runtime lifecycle function was called' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await fs.readFile(path.join(current, 'marker.txt'), 'utf8'), 'old');
  const failed = (await fs.readdir(path.join(root, 'app')))
    .filter((name) => name.startsWith('current.failed-'));
  assert.equal(failed.length, 1);
  await assert.rejects(fs.access(path.join(root, 'app', 'current.previous')));
  await assert.rejects(fs.access(lockPath));
});

test('KeepStopped 回滚约束失败时同时保留部署错误和回滚错误', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-keep-stopped-dual-error-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'app', 'current');
  const next = path.join(root, 'app', 'current.new');
  const lockPath = path.join(root, 'tmp', 'deploy-current.lock.json');
  await fs.mkdir(current, { recursive: true });
  await fs.mkdir(next, { recursive: true });
  await fs.mkdir(path.join(root, 'extraction-runs'), { recursive: true });
  await fs.writeFile(path.join(current, 'marker.txt'), 'old');
  await fs.writeFile(path.join(next, 'marker.txt'), 'new');
  await fs.writeFile(
    path.join(next, 'DEPLOYMENT.json'),
    `${JSON.stringify({ sourceCommit: '5'.repeat(40) })}\n`,
  );

  const result = runPowerShell(`
$RuntimeRoot = ${quotePowerShell(root)}
$RepositoryRoot = ${quotePowerShell(path.resolve('.'))}
$script:doctorCalls = 0
$script:startCalls = 0
$script:stopCalls = 0
function Get-AmDeploymentService { return [pscustomobject]@{ Status = 'Stopped'; StartType = 'Disabled' } }
function Resolve-AmGitCommit { return (('5' * 40) -join '') }
function Invoke-AmStoppedDeploymentDoctor {
  param($CurrentPath)
  $script:doctorCalls += 1
  if ($script:doctorCalls -eq 3) { throw 'injected post-switch doctor failure' }
  if ($script:doctorCalls -eq 4) { throw 'injected rollback invariant failure' }
}
function Invoke-AmCurrentManifestVerification { param($CurrentPath) }
function Update-AmServiceConfigForCurrent { param($ServiceConfigPath, $CurrentPath); return $null }
function Move-AmLegacyScriptsToArchive { param($Runtime); return $null }
function Start-AmDeploymentRuntime { $script:startCalls += 1; throw 'runtime start is forbidden' }
function Stop-AmDeploymentRuntime { $script:stopCalls += 1; throw 'runtime stop is forbidden' }
$caught = $false
try {
  Invoke-AmDeployment -KeepStopped -ConfirmAutomationPaused
} catch {
  if (-not $_.Exception.Message.Contains('injected post-switch doctor failure')) { throw }
  if (-not $_.Exception.Message.Contains('injected rollback invariant failure')) { throw }
  $caught = $true
}
if (-not $caught) { throw 'dual failure unexpectedly accepted' }
if ($script:doctorCalls -ne 4) { throw "unexpected stopped doctor calls: $script:doctorCalls" }
if ($script:startCalls -ne 0 -or $script:stopCalls -ne 0) { throw 'runtime lifecycle function was called' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await fs.readFile(path.join(current, 'marker.txt'), 'utf8'), 'old');
  const failed = (await fs.readdir(path.join(root, 'app')))
    .filter((name) => name.startsWith('current.failed-'));
  assert.equal(failed.length, 1);
  await assert.rejects(fs.access(path.join(root, 'app', 'current.previous')));
  await assert.rejects(fs.access(lockPath));
});

test('普通部署模式仍执行停止、启动和 Running Doctor', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-normal-deployment-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'app', 'current');
  const next = path.join(root, 'app', 'current.new');
  const lockPath = path.join(root, 'tmp', 'deploy-current.lock.json');
  await fs.mkdir(current, { recursive: true });
  await fs.mkdir(next, { recursive: true });
  await fs.mkdir(path.join(root, 'extraction-runs'), { recursive: true });
  await fs.writeFile(path.join(current, 'marker.txt'), 'old');
  await fs.writeFile(path.join(next, 'marker.txt'), 'new');
  await fs.writeFile(
    path.join(next, 'DEPLOYMENT.json'),
    `${JSON.stringify({ sourceCommit: '6'.repeat(40) })}\n`,
  );

  const result = runPowerShell(`
$RuntimeRoot = ${quotePowerShell(root)}
$RepositoryRoot = ${quotePowerShell(path.resolve('.'))}
$script:startCalls = 0
$script:stopCalls = 0
$script:doctorCalls = 0
function Get-AmDeploymentService { return [pscustomobject]@{ Status = 'Stopped'; StartType = 'Automatic' } }
function Resolve-AmGitCommit { return (('6' * 40) -join '') }
function Stop-AmDeploymentRuntime { param($SelectedOwner, $CurrentPath, $RepoScripts, $Runtime); $script:stopCalls += 1 }
function Start-AmDeploymentRuntime { param($SelectedOwner, $CurrentPath, $Runtime); $script:startCalls += 1; return $null }
function Invoke-AmDeploymentDoctor { param($SelectedOwner, $CurrentPath); $script:doctorCalls += 1 }
function Invoke-AmCurrentManifestVerification { param($CurrentPath) }
function Update-AmServiceConfigForCurrent { param($ServiceConfigPath, $CurrentPath); return $null }
function Move-AmLegacyScriptsToArchive { param($Runtime); return $null }
Invoke-AmDeployment
if ($script:stopCalls -ne 1) { throw "unexpected stop calls: $script:stopCalls" }
if ($script:startCalls -ne 1) { throw "unexpected start calls: $script:startCalls" }
if ($script:doctorCalls -ne 1) { throw "unexpected doctor calls: $script:doctorCalls" }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /deployment\.keepStopped=false/);
  assert.equal(await fs.readFile(path.join(current, 'marker.txt'), 'utf8'), 'new');
  await assert.rejects(fs.access(path.join(root, 'app', 'current.previous')));
  await assert.rejects(fs.access(lockPath));
});

test('普通部署切换后失败会停止候选、恢复旧 current 并重启旧 runtime', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-normal-rollback-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'app', 'current');
  const next = path.join(root, 'app', 'current.new');
  const lockPath = path.join(root, 'tmp', 'deploy-current.lock.json');
  await fs.mkdir(current, { recursive: true });
  await fs.mkdir(next, { recursive: true });
  await fs.mkdir(path.join(root, 'extraction-runs'), { recursive: true });
  await fs.writeFile(path.join(current, 'marker.txt'), 'old');
  await fs.writeFile(path.join(next, 'marker.txt'), 'new');
  await fs.writeFile(
    path.join(next, 'DEPLOYMENT.json'),
    `${JSON.stringify({ sourceCommit: '7'.repeat(40) })}\n`,
  );

  const result = runPowerShell(`
$RuntimeRoot = ${quotePowerShell(root)}
$RepositoryRoot = ${quotePowerShell(path.resolve('.'))}
$script:startCalls = 0
$script:stopCalls = 0
$script:doctorCalls = 0
function Get-AmDeploymentService { return [pscustomobject]@{ Status = 'Stopped'; StartType = 'Automatic' } }
function Resolve-AmGitCommit { return (('7' * 40) -join '') }
function Stop-AmDeploymentRuntime { param($SelectedOwner, $CurrentPath, $RepoScripts, $Runtime); $script:stopCalls += 1 }
function Start-AmDeploymentRuntime { param($SelectedOwner, $CurrentPath, $Runtime); $script:startCalls += 1; return $null }
function Invoke-AmDeploymentDoctor {
  param($SelectedOwner, $CurrentPath)
  $script:doctorCalls += 1
  throw 'injected normal doctor failure'
}
function Invoke-AmCurrentManifestVerification { param($CurrentPath) }
function Update-AmServiceConfigForCurrent { param($ServiceConfigPath, $CurrentPath); return $null }
function Move-AmLegacyScriptsToArchive { param($Runtime); return $null }
$caught = $false
try {
  Invoke-AmDeployment
} catch {
  if (-not $_.Exception.Message.Contains('injected normal doctor failure')) { throw }
  $caught = $true
}
if (-not $caught) { throw 'normal post-switch failure unexpectedly accepted' }
if ($script:stopCalls -ne 2) { throw "unexpected stop calls: $script:stopCalls" }
if ($script:startCalls -ne 2) { throw "unexpected start calls: $script:startCalls" }
if ($script:doctorCalls -ne 1) { throw "unexpected doctor calls: $script:doctorCalls" }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await fs.readFile(path.join(current, 'marker.txt'), 'utf8'), 'old');
  const failed = (await fs.readdir(path.join(root, 'app')))
    .filter((name) => name.startsWith('current.failed-'));
  assert.equal(failed.length, 1);
  await assert.rejects(fs.access(path.join(root, 'app', 'current.previous')));
  await assert.rejects(fs.access(lockPath));
});

test('KeepStopped 在切换后源提交漂移时恢复旧 current 且不启动', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-keep-stopped-source-drift-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'app', 'current');
  const next = path.join(root, 'app', 'current.new');
  const lockPath = path.join(root, 'tmp', 'deploy-current.lock.json');
  await fs.mkdir(current, { recursive: true });
  await fs.mkdir(next, { recursive: true });
  await fs.mkdir(path.join(root, 'extraction-runs'), { recursive: true });
  await fs.writeFile(path.join(current, 'marker.txt'), 'old');
  await fs.writeFile(path.join(next, 'marker.txt'), 'new');
  await fs.writeFile(
    path.join(next, 'DEPLOYMENT.json'),
    `${JSON.stringify({ sourceCommit: '8'.repeat(40) })}\n`,
  );

  const result = runPowerShell(`
$RuntimeRoot = ${quotePowerShell(root)}
$RepositoryRoot = ${quotePowerShell(path.resolve('.'))}
$script:startCalls = 0
$script:stopCalls = 0
$script:doctorCalls = 0
function Get-AmDeploymentService { return [pscustomobject]@{ Status = 'Stopped'; StartType = 'Disabled' } }
function Resolve-AmGitCommit { return (('8' * 40) -join '') }
function Invoke-AmStoppedDeploymentDoctor { param($CurrentPath); $script:doctorCalls += 1 }
function Invoke-AmCurrentManifestVerification {
  param($CurrentPath)
  @{ sourceCommit = (('9' * 40) -join '') } |
    ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $CurrentPath 'DEPLOYMENT.json') -Encoding utf8
}
function Update-AmServiceConfigForCurrent { param($ServiceConfigPath, $CurrentPath); return $null }
function Move-AmLegacyScriptsToArchive { param($Runtime); return $null }
function Start-AmDeploymentRuntime { $script:startCalls += 1; throw 'runtime start is forbidden' }
function Stop-AmDeploymentRuntime { $script:stopCalls += 1; throw 'runtime stop is forbidden' }
$caught = $false
try {
  Invoke-AmDeployment -KeepStopped -ConfirmAutomationPaused
} catch {
  if (-not $_.Exception.Message.Contains('deployed source commit does not match')) { throw }
  $caught = $true
}
if (-not $caught) { throw 'source commit drift unexpectedly accepted' }
if ($script:doctorCalls -ne 4) { throw "unexpected stopped doctor calls: $script:doctorCalls" }
if ($script:startCalls -ne 0 -or $script:stopCalls -ne 0) { throw 'runtime lifecycle function was called' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await fs.readFile(path.join(current, 'marker.txt'), 'utf8'), 'old');
  const failed = (await fs.readdir(path.join(root, 'app')))
    .filter((name) => name.startsWith('current.failed-'));
  assert.equal(failed.length, 1);
  await assert.rejects(fs.access(path.join(root, 'app', 'current.previous')));
  await assert.rejects(fs.access(lockPath));
});

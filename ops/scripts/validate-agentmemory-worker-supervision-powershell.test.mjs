import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const commonPath = fileURLToPath(new URL('./_agentmemory-local-common.ps1', import.meta.url));

function runPowerShell(body) {
  const script = `
$ErrorActionPreference = 'Stop'
. '${commonPath.replaceAll("'", "''")}'
${body}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
    cwd: path.dirname(commonPath),
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('PowerShell 身份匹配拒绝实例前缀、entry 漂移和额外参数', () => {
  const result = runPowerShell(`
$valid = [pscustomobject]@{
  ProcessId = 100
  ParentProcessId = 90
  Name = 'node.exe'
  ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'
  CommandLine = '"C:\\Program Files\\nodejs\\node.exe" F:\\ai-runtime\\agentmemory\\app\\current\\dist\\worker-supervisor.mjs --instance-id formal --worker-entry F:\\ai-runtime\\agentmemory\\app\\current\\dist\\index.mjs'
  CreationDate = Get-Date
}
if (-not (Test-AmSupervisorProcess -Process $valid -InstanceId 'formal' -AppDirectory $script:AmAppCurrent)) { throw 'valid supervisor rejected' }
$prefix = $valid.PSObject.Copy()
$prefix.CommandLine = $valid.CommandLine.Replace('--instance-id formal', '--instance-id formal-old')
if (Test-AmSupervisorProcess -Process $prefix -InstanceId 'formal' -AppDirectory $script:AmAppCurrent) { throw 'instance prefix accepted' }
$drift = $valid.PSObject.Copy()
$drift.CommandLine = $valid.CommandLine.Replace('app\\current\\dist\\index.mjs', 'app\\old\\dist\\index.mjs')
if (Test-AmSupervisorProcess -Process $drift -InstanceId 'formal' -AppDirectory $script:AmAppCurrent) { throw 'worker entry drift accepted' }
$extra = $valid.PSObject.Copy()
$extra.CommandLine = $valid.CommandLine + ' --extra value'
if (Test-AmSupervisorProcess -Process $extra -InstanceId 'formal' -AppDirectory $script:AmAppCurrent) { throw 'extra arguments accepted' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PowerShell iii 身份匹配拒绝 config 后缀和额外参数', () => {
  const result = runPowerShell(`
$valid = [pscustomobject]@{
  ProcessId = 80
  ParentProcessId = 70
  Name = 'iii.exe'
  ExecutablePath = 'F:\\ai-runtime\\agentmemory\\install\\bin\\iii.exe'
  CommandLine = 'F:\\ai-runtime\\agentmemory\\install\\bin\\iii.exe --config F:\\ai-runtime\\agentmemory\\home\\iii-config.yaml'
  CreationDate = Get-Date
}
if (-not (Test-AmFormalIiiProcess -Process $valid)) { throw 'valid iii rejected' }
$suffix = $valid.PSObject.Copy()
$suffix.CommandLine = $valid.CommandLine + '.bak'
if (Test-AmFormalIiiProcess -Process $suffix) { throw 'config suffix accepted' }
$extra = $valid.PSObject.Copy()
$extra.CommandLine = $valid.CommandLine + ' --other value'
if (Test-AmFormalIiiProcess -Process $extra) { throw 'extra iii arguments accepted' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PowerShell 身份匹配对不可读 ExecutablePath 保守返回 false', () => {
  const result = runPowerShell(`
$process = [pscustomobject]@{
  ProcessId = 80
  ParentProcessId = 70
  Name = 'iii.exe'
  ExecutablePath = $null
  CommandLine = 'iii.exe --config F:\\ai-runtime\\agentmemory\\home\\iii-config.yaml'
  CreationDate = Get-Date
}
if (Test-AmFormalIiiProcess -Process $process) { throw 'unreadable path accepted' }
if (Test-AmDevProcess -Process $process) { throw 'unreadable dev path accepted' }
$process.Name = 'node.exe'
$process.CommandLine = 'node F:\\ai-runtime\\agentmemory\\app\\current\\dist\\worker-supervisor.mjs --instance-id formal --worker-entry F:\\ai-runtime\\agentmemory\\app\\current\\dist\\index.mjs'
if (Test-AmSupervisorProcess -Process $process -InstanceId 'formal' -AppDirectory $script:AmAppCurrent) { throw 'unreadable node path accepted' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PID 创建时间复用时强制停止目标为空', () => {
  const result = runPowerShell(`
$state = [pscustomobject]@{
  SupervisorRecordValid = $false
  WorkerRecordIdentityValid = $false
  WorkerRecordValid = $false
  Supervisors = @([pscustomobject]@{ ProcessId = 100 })
  Workers = @([pscustomobject]@{ ProcessId = 101 })
  CommandHosts = @([pscustomobject]@{ ProcessId = 90 })
}
$targets = Get-AmVerifiedResidualStopTargets -State $state
if ($targets.Supervisors.Count -ne 0 -or $targets.Workers.Count -ne 0 -or $targets.CommandHosts.Count -ne 0) {
  throw 'PID reuse produced force-stop targets'
}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('没有 supervisor 时关闭请求明确返回 NoSupervisor', () => {
  const result = runPowerShell(`
$homePath = Join-Path ([System.IO.Path]::GetTempPath()) ('am-no-supervisor-' + [guid]::NewGuid().ToString('N'))
$appPath = Join-Path $homePath 'app'
New-Item -ItemType Directory -Path $homePath,$appPath -Force | Out-Null
try {
  $result = Invoke-AmSupervisorShutdownRequest -InstanceHome $homePath -InstanceId 'formal' -AppDirectory $appPath -SupervisorEntry (Join-Path $appPath 'dist\\worker-supervisor.mjs')
  if ($result -cne 'NoSupervisor') { throw "unexpected result: $result" }
} finally {
  Remove-Item -LiteralPath $homePath -Recurse -Force
}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('supervisor 已消失时仍允许收口身份完整的孤儿 worker', () => {
  const result = runPowerShell(`
$worker = [pscustomobject]@{ ProcessId = 101; ParentProcessId = 100 }
$hostProcess = [pscustomobject]@{ ProcessId = 90 }
$state = [pscustomobject]@{
  SupervisorRecordValid = $false
  WorkerRecordIdentityValid = $true
  WorkerRecordValid = $false
  RecordSupervisorPid = 100
  RecordWorkerPid = 101
  Supervisors = @()
  Workers = @($worker)
  CommandHosts = @($hostProcess)
}
$targets = Get-AmVerifiedResidualStopTargets -State $state
if ($targets.Supervisors.Count -ne 0) { throw 'invalid supervisor target' }
if ($targets.Workers.Count -ne 1 -or $targets.Workers[0].ProcessId -ne 101) { throw 'orphan worker was not selected' }
if ($targets.CommandHosts.Count -ne 1 -or $targets.CommandHosts[0].ProcessId -ne 90) { throw 'verified command host was not selected' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PowerShell dev 身份显式使用独立 AppDirectory', () => {
  const result = runPowerShell(`
$devApp = 'F:\\projs_space\\ai\\ai-workflow-lab\\vendor\\agentmemory'
$process = [pscustomobject]@{
  ProcessId = 100
  ParentProcessId = 90
  Name = 'node.exe'
  ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'
  CommandLine = '"C:\\Program Files\\nodejs\\node.exe" F:\\projs_space\\ai\\ai-workflow-lab\\vendor\\agentmemory\\dist\\worker-supervisor.mjs --instance-id dev-isolated --worker-entry F:\\projs_space\\ai\\ai-workflow-lab\\vendor\\agentmemory\\dist\\index.mjs'
  CreationDate = Get-Date
}
if (-not (Test-AmSupervisorProcess -Process $process -InstanceId 'dev-isolated' -AppDirectory $devApp)) {
  throw 'explicit dev app rejected'
}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PowerShell 接受由 cmd 解析为 node.exe 的扩展名省略 argv0', () => {
  const result = runPowerShell(`
$devApp = 'F:\\projs_space\\ai\\ai-workflow-lab\\vendor\\agentmemory'
$process = [pscustomobject]@{
  ProcessId = 100
  ParentProcessId = 90
  Name = 'node.exe'
  ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'
  CommandLine = 'node F:\\projs_space\\ai\\ai-workflow-lab\\vendor\\agentmemory\\dist\\worker-supervisor.mjs --instance-id dev-isolated --worker-entry F:\\projs_space\\ai\\ai-workflow-lab\\vendor\\agentmemory\\dist\\index.mjs'
  CreationDate = Get-Date
}
if (-not (Test-AmSupervisorProcess -Process $process -InstanceId 'dev-isolated' -AppDirectory $devApp)) {
  throw 'extensionless node argv0 rejected'
}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PowerShell PID 创建时间容差不超过一秒', () => {
  const result = runPowerShell(`
$process = [pscustomobject]@{ CreationDate = Get-Date }
$twoSecondsEarlier = (Get-Date).AddSeconds(-2).ToUniversalTime().ToString('o')
if (Test-AmProcessCreationMatches -Process $process -StartedAt $twoSecondsEarlier) {
  throw 'two-second PID reuse window accepted'
}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PowerShell 原生进程快照提供当前进程身份和父子关系', () => {
  const result = runPowerShell(`
$process = Get-AmProcessById -ProcessId $PID -AllProcesses (Get-AmProcesses)
if (-not $process) { throw 'current process missing from native snapshot' }
if ($process.ParentProcessId -le 0) { throw 'parent process id missing' }
if (-not $process.ExecutablePath.EndsWith('powershell.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "unexpected executable path: $($process.ExecutablePath)"
}
if ([string]::IsNullOrWhiteSpace($process.CommandLine)) { throw 'command line missing' }
if ($process.CreationDate -eq [DateTime]::MinValue) { throw 'creation date missing' }
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PowerShell 端口快照不依赖 CIM 并返回监听进程', () => {
  const result = runPowerShell(`
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
try {
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $matches = @(Get-AmListeners -Ports @($port))
  if ($matches.Count -ne 1) { throw "unexpected listener count: $($matches.Count)" }
  if ($matches[0].OwningProcess -ne $PID) { throw "unexpected listener pid: $($matches[0].OwningProcess)" }
} finally {
  $listener.Stop()
}
`);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

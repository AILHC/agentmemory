$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. "$PSScriptRoot\_agentmemory-local-common.ps1"

if (Test-AmSamePath -Left $script:AmDevHome -Right $script:AmFormalHome) {
  throw 'Refusing dev isolated stop: DevHome equals formal AGENTMEMORY_HOME.'
}
if (Test-AmSamePath -Left $script:AmDevConfig -Right $script:AmFormalConfig) {
  throw 'Refusing dev isolated stop: DevConfig equals formal AGENTMEMORY_III_CONFIG.'
}
Assert-AmPathInside -Path $script:AmDevRun -Root $script:AmDevRoot -Name 'DevRun'
Assert-AmPathInside -Path $script:AmDevHome -Root $script:AmDevRoot -Name 'DevHome'

$env:AGENTMEMORY_HOME = $script:AmDevHome
$env:AGENTMEMORY_INSTALL_HOME = $script:AmFormalInstall
$env:AGENTMEMORY_III_CONFIG = $script:AmDevConfig
$env:III_REST_PORT = '3211'
$env:III_STREAM_PORT = '3212'
$env:III_VIEWER_PORT = '3213'
$env:III_ENGINE_URL = 'ws://localhost:49234'
$env:AGENTMEMORY_URL = 'http://localhost:3211'
$env:TEMP = $script:AmDevTmp
$env:TMP = $script:AmDevTmp
$env:npm_config_cache = Join-Path $script:AmFormalRoot 'cache\npm'
$env:CI = '1'

$all = Get-AmProcesses
$listeners = @(Get-AmListeners -Ports $script:AmDevPorts)
$verifiedRootIds = New-Object 'System.Collections.Generic.HashSet[int]'

foreach ($listener in $listeners) {
  $ownerId = [int]$listener.OwningProcess
  $rootId = Get-AmVerifiedDevRootId -ProcessId $ownerId -AllProcesses $all
  if ($null -ne $rootId) {
    [void]$verifiedRootIds.Add([int]$rootId)
  } else {
    throw "Refusing dev isolated stop: dev port $($listener.LocalPort) is owned by unverified pid $ownerId."
  }
}

$pidFiles = @(
  (Join-Path $script:AmDevRun 'agentmemory-dev-iii.pid')
)

foreach ($pidPath in $pidFiles) {
  $pidValue = Read-AmPidFile -Path $pidPath
  if ($null -eq $pidValue) { continue }
  $rootId = Get-AmVerifiedDevRootId -ProcessId ([int]$pidValue) -AllProcesses $all
  if ($null -ne $rootId) {
    [void]$verifiedRootIds.Add([int]$rootId)
  }
}

foreach ($process in @($all | Where-Object { Test-AmDevProcess -Process $_ })) {
  [void]$verifiedRootIds.Add([int]$process.ProcessId)
}

$supervisorEntry = Join-Path $script:AmDevApp 'dist\worker-supervisor.mjs'
$requestResult = Invoke-AmSupervisorShutdownRequest -InstanceHome $script:AmDevHome -InstanceId 'dev-isolated' -AppDirectory $script:AmDevApp -SupervisorEntry $supervisorEntry
if ($requestResult -eq 'Accepted') {
  [void](Wait-AmInstanceProcessesStopped -InstanceHome $script:AmDevHome -InstanceId 'dev-isolated' -AppDirectory $script:AmDevApp -TimeoutSeconds 15)
}

Write-Output 'Stopping verified dev isolated process trees.'
$all = Get-AmProcesses
foreach ($pidValue in $verifiedRootIds) {
  $proc = Get-AmProcessById -ProcessId ([int]$pidValue) -AllProcesses $all
  if ($proc -and (Test-AmDevProcess -Process $proc)) {
    Stop-AmVerifiedProcessTree -RootProcessId ([int]$pidValue) -AllProcesses $all
  }
}


if (-not (Wait-AmInstanceProcessesStopped -InstanceHome $script:AmDevHome -InstanceId 'dev-isolated' -AppDirectory $script:AmDevApp -TimeoutSeconds 2)) {
  Write-Output 'supervisor.stop=fallback_force'
  Stop-AmVerifiedInstanceResiduals -InstanceHome $script:AmDevHome -InstanceId 'dev-isolated' -AppDirectory $script:AmDevApp
}

if ((Wait-AmPortsClosed -Ports $script:AmDevPorts -TimeoutSeconds 10) -and
    (Wait-AmInstanceProcessesStopped -InstanceHome $script:AmDevHome -InstanceId 'dev-isolated' -AppDirectory $script:AmDevApp -TimeoutSeconds 2)) {
  [void](Remove-AmStoppedInstanceShutdownRequest -InstanceHome $script:AmDevHome -InstanceId 'dev-isolated' -AppDirectory $script:AmDevApp)
  Write-Output 'diagnosis=OK_DEV_ISOLATED_STOPPED'
  exit 0
}

$remaining = @(Get-AmListeners -Ports $script:AmDevPorts)
$details = ($remaining | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid=$($_.OwningProcess)" }) -join '; '
$state = Get-AmInstanceProcessState -InstanceHome $script:AmDevHome -InstanceId 'dev-isolated' -AppDirectory $script:AmDevApp
throw "Dev isolated stop incomplete: ports='$details' supervisor=$($state.Supervisors.Count) commandHost=$($state.CommandHosts.Count) worker=$($state.Workers.Count)"

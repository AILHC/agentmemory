$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

. "$PSScriptRoot\_agentmemory-local-common.ps1"

$failed = $false
$all = Get-AmProcesses
$listeners = @(Get-AmListeners -Ports ($script:AmDevPorts + 49134))
$instanceState = Get-AmInstanceProcessState -InstanceHome $script:AmDevHome -InstanceId 'dev-isolated' -AppDirectory $script:AmDevApp -AllProcesses $all
$devProcesses = @($all | Where-Object { Test-AmDevProcess -Process $_ })

Write-Output 'AgentMemory dev isolated doctor'
Write-Output '==============================='
Write-Output "dev.home=$script:AmDevHome"
Write-Output "dev.config=$script:AmDevConfig"
Write-Output 'dev.ports=3211,3212,3213,49234'
Write-Output "formal.home=$script:AmFormalHome"
Write-Output "formal.config=$script:AmFormalConfig"
Write-AmInstanceProcessReport -State $instanceState -Prefix 'process'
Write-Output "process.iiiCount=$($devProcesses.Count)"

if (Test-AmSamePath -Left $script:AmDevHome -Right $script:AmFormalHome) {
  Write-Output 'check.devHomeBoundary=bad'
  $failed = $true
} else {
  Write-Output 'check.devHomeBoundary=ok'
}

if (Test-AmSamePath -Left $script:AmDevConfig -Right $script:AmFormalConfig) {
  Write-Output 'check.devConfigBoundary=bad'
  $failed = $true
} else {
  Write-Output 'check.devConfigBoundary=ok'
}

if (-not (Test-Path -LiteralPath $script:AmDevConfig -PathType Leaf)) {
  Write-Output 'check.devConfig=missing'
  $failed = $true
} else {
  Write-Output 'check.devConfig=ok'
  $workerPort = Get-AmWorkerPortFromConfig -ConfigPath $script:AmDevConfig -WorkerName 'iii-worker-manager'
  Write-Output "check.iiiWorkerManagerPort=$workerPort"
  if ($workerPort -ne 49234) { $failed = $true }
  $hasFormalState = Test-AmConfigContainsText -ConfigPath $script:AmDevConfig -Text ((Join-Path $script:AmFormalHome 'data').Replace('\', '/'))
  Write-Output "check.formalStatePathPresent=$hasFormalState"
  if ($hasFormalState) { $failed = $true }
  $hasDevState = Test-AmConfigContainsText -ConfigPath $script:AmDevConfig -Text ((Join-Path $script:AmDevHome 'data').Replace('\', '/'))
  Write-Output "check.devStatePathPresent=$hasDevState"
  if (-not $hasDevState) { $failed = $true }
  try {
    Invoke-AmWorkerSupervisionValidation `
      -ConfigPath $script:AmDevConfig `
      -AppDirectory $script:AmDevApp `
      -InstanceId 'dev-isolated' `
      -ExpectedStatePath $script:AmDevStatePath `
      -ExpectedStreamPath $script:AmDevStreamPath
    Write-Output 'check.workerSupervisionConfig=ok'
  } catch {
    Write-Output 'check.workerSupervisionConfig=bad'
    $failed = $true
  }
}

Write-AmPortReport -Ports ($script:AmDevPorts + 49134) -Listeners $listeners -AllProcesses $all

$devOpen = @($listeners | Where-Object { $script:AmDevPorts -contains [int]$_.LocalPort })
if ($devOpen.Count -eq 0) {
  if ($devProcesses.Count -ne 0 -or $instanceState.Supervisors.Count -ne 0 -or $instanceState.CommandHosts.Count -ne 0 -or $instanceState.Workers.Count -ne 0 -or
      $instanceState.SupervisorRecordProcessAlive -or $instanceState.WorkerRecordProcessAlive) {
    Write-Output 'diagnosis=BAD_DEV_ISOLATED_STOP_INCOMPLETE'
    exit 2
  }
  if ($failed) {
    Write-Output 'diagnosis=BAD_DEV_ISOLATED_CONFIG'
    exit 2
  }
  Write-Output 'diagnosis=DEV_ISOLATED_NOT_RUNNING'
  exit 1
}

$badOwners = New-Object 'System.Collections.Generic.List[string]'
foreach ($listener in $devOpen) {
  $ownerId = [int]$listener.OwningProcess
  $rootId = Get-AmVerifiedDevRootId -ProcessId $ownerId -AllProcesses $all
  if ($null -eq $rootId) {
    [void]$badOwners.Add("$($listener.LocalPort)/pid=$ownerId")
  }
}

if ($badOwners.Count -gt 0) {
  Write-Output "diagnosis=BAD_DEV_PORT_OWNER $($badOwners -join ',')"
  exit 2
}

$rootIds = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($listener in $devOpen) {
  $rootId = Get-AmVerifiedDevRootId -ProcessId ([int]$listener.OwningProcess) -AllProcesses $all
  if ($null -ne $rootId) { [void]$rootIds.Add([int]$rootId) }
}
$topologyOk = $rootIds.Count -eq 1 -and
  $instanceState.Supervisors.Count -eq 1 -and
  $instanceState.CommandHosts.Count -eq 1 -and
  $instanceState.Workers.Count -eq 1 -and
  $instanceState.SupervisorRecordValid -and
  $instanceState.WorkerRecordValid
if ($topologyOk) {
  $rootId = [int]@($rootIds)[0]
  $supervisor = $instanceState.Supervisors[0]
  $hostProcess = $instanceState.CommandHosts[0]
  $worker = $instanceState.Workers[0]
  $topologyOk = [int]$supervisor.ParentProcessId -eq [int]$hostProcess.ProcessId -and
    [int]$worker.ParentProcessId -eq [int]$supervisor.ProcessId -and
    (Test-AmUnderProcessTree -TargetProcessId ([int]$hostProcess.ProcessId) -RootProcessId $rootId -AllProcesses $all)
}
Write-Output "check.processTopology=$topologyOk"
if (-not $topologyOk) {
  Write-Output 'diagnosis=BAD_WORKER_SUPERVISION_TOPOLOGY'
  exit 2
}

if (@($devOpen | Select-Object -ExpandProperty LocalPort -Unique).Count -ne $script:AmDevPorts.Count) {
  Write-Output 'diagnosis=BAD_DEV_PORT_SET'
  exit 2
}

$devEngine = @($listeners | Where-Object { [int]$_.LocalPort -eq 49234 })
if ($devEngine.Count -eq 0) {
  Write-Output 'diagnosis=BAD_DEV_ENGINE_PORT_CLOSED'
  exit 2
}

$formalEngineOwnedByDev = $false
foreach ($listener in @($listeners | Where-Object { [int]$_.LocalPort -eq 49134 })) {
  $rootId = Get-AmVerifiedDevRootId -ProcessId ([int]$listener.OwningProcess) -AllProcesses $all
  if ($null -ne $rootId) {
    $formalEngineOwnedByDev = $true
  }
}
Write-Output "check.devOwnsFormalEnginePort49134=$formalEngineOwnedByDev"
if ($formalEngineOwnedByDev) {
  Write-Output 'diagnosis=BAD_DEV_OWNS_FORMAL_ENGINE_PORT'
  exit 2
}

Write-AmRuntimeConfigSummary -BaseUrl 'http://127.0.0.1:3211'
if (-not $script:AmLastRuntimeConfigOk) {
  Write-Output 'diagnosis=BAD_RUNTIME_CONFIG_UNAVAILABLE'
  exit 2
}

if ($failed) {
  Write-Output 'diagnosis=BAD_DEV_ISOLATED_CONFIG'
  exit 2
}

Write-Output 'diagnosis=OK_DEV_ISOLATED_AGENTMEMORY'
exit 0

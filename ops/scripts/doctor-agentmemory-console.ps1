param(
  [ValidateSet('Running', 'Stopped')]
  [string]$ExpectedState = 'Running'
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

. "$PSScriptRoot\_agentmemory-local-common.ps1"

$failed = $false
$serviceQuery = Get-AmServiceQuery
if ($serviceQuery.QueryState -eq 'query_failed') {
  Write-Output 'AgentMemory formal console doctor'
  Write-Output '================================='
  Write-Output "expectedState=$ExpectedState"
  Write-Output 'service.query=failed'
  Write-Output 'diagnosis=BAD_DIAGNOSTIC_BACKEND'
  exit 2
}
$service = if ($serviceQuery.QueryState -eq 'present') { $serviceQuery } else { $null }
$servicePid = if ($service) { [int]$service.ProcessId } else { 0 }
$all = Get-AmProcesses
$listeners = @(Get-AmListeners -Ports $script:AmFormalPorts)
$roots = New-Object 'System.Collections.Generic.HashSet[int]'
$badOwners = New-Object 'System.Collections.Generic.List[string]'
$formalIii = @($all | Where-Object {
  Test-AmFormalConsoleProcess -Process $_ -AllProcesses $all -ServiceProcessId $servicePid
})
$state = Get-AmInstanceProcessState `
  -InstanceHome $script:AmFormalHome -InstanceId 'formal' `
  -AppDirectory $script:AmAppCurrent -AllProcesses $all
$hasSupervisor = Test-AmConfigContainsText -ConfigPath $script:AmFormalConfig -Text 'worker-supervisor.mjs'
$hasWorkerEntry = Test-AmConfigContainsText -ConfigPath $script:AmFormalConfig -Text 'dist/index.mjs'
$mode = if ($hasSupervisor) { 'supervisor' } elseif ($hasWorkerEntry) { 'legacy-direct-transition' } else { 'invalid' }

Write-Output 'AgentMemory formal console doctor'
Write-Output '================================='
Write-Output "expectedState=$ExpectedState"
Write-Output "service.query=$($serviceQuery.QueryState)"
Write-Output "formal.workerMode=$mode"
Write-Output "formal.home=$script:AmFormalHome"
Write-Output "formal.config=$script:AmFormalConfig"
Write-Output 'formal.ports=3111,3112,3113,49134'
Write-AmDeploymentManifestSummary -AppDirectory $script:AmAppCurrent
Write-AmInstanceProcessReport -State $state -Prefix 'process'
Write-Output "process.iiiCount=$($formalIii.Count)"

if ($service) {
  Write-Output "service.name=$($service.Name)"
  Write-Output "service.state=$($service.State)"
  Write-Output "service.processId=$servicePid"
  if ($service.State -ne 'Stopped') {
    Write-Output "diagnosis=BAD_SERVICE_NOT_STOPPED state=$($service.State)"
    exit 2
  }
} else {
  Write-Output 'service.missing=true'
}

$residual = $formalIii.Count -ne 0 -or $state.Supervisors.Count -ne 0 -or
  $state.CommandHosts.Count -ne 0 -or $state.Workers.Count -ne 0 -or
  $state.SupervisorRecordProcessAlive -or $state.WorkerRecordProcessAlive
if ($ExpectedState -eq 'Stopped') {
  if ($listeners.Count -ne 0 -or $residual) {
    Write-Output 'diagnosis=BAD_FORMAL_CONSOLE_STOP_INCOMPLETE'
    exit 2
  }
  Write-Output 'diagnosis=OK_FORMAL_CONSOLE_STOPPED'
  exit 0
}

if (-not $script:AmLastDeploymentManifestOk) {
  Write-Output 'diagnosis=BAD_DEPLOYMENT_MANIFEST'
  exit 2
}

if (-not (Test-Path -LiteralPath $script:AmFormalHome -PathType Container)) {
  Write-Output 'check.formalHome=missing'
  $failed = $true
} else { Write-Output 'check.formalHome=ok' }

if (-not (Test-Path -LiteralPath $script:AmFormalConfig -PathType Leaf)) {
  Write-Output 'check.formalConfig=missing'
  $failed = $true
} else {
  Write-Output 'check.formalConfig=ok'
  $hasStatePath = Test-AmConfigContainsText -ConfigPath $script:AmFormalConfig -Text ((Join-Path $script:AmFormalHome 'data').Replace('\', '/'))
  Write-Output "check.formalStatePath=$hasStatePath"
  if (-not $hasStatePath) { $failed = $true }
  $workerPort = Get-AmWorkerPortFromConfig -ConfigPath $script:AmFormalConfig -WorkerName 'iii-worker-manager'
  if ($null -eq $workerPort) {
    Write-Output 'check.iiiWorkerManagerPort=default:49134'
  } else {
    Write-Output "check.iiiWorkerManagerPort=$workerPort"
    if ($workerPort -ne 49134) { $failed = $true }
  }
  if ($mode -eq 'supervisor') {
    try {
      Invoke-AmWorkerSupervisionValidation `
        -ConfigPath $script:AmFormalConfig -AppDirectory $script:AmAppCurrent -InstanceId 'formal' `
        -ExpectedStatePath $script:AmFormalStatePath `
        -ExpectedStreamPath $script:AmFormalStreamPath
      Write-Output 'check.workerSupervisionConfig=ok'
    } catch {
      Write-Output 'check.workerSupervisionConfig=bad'
      $failed = $true
    }
  } elseif ($mode -eq 'legacy-direct-transition') {
    Write-Output 'check.workerSupervisionConfig=legacy-transition'
  } else {
    Write-Output 'check.workerSupervisionConfig=bad'
    $failed = $true
  }
}

Write-AmPortReport -Ports $script:AmFormalPorts -Listeners $listeners -AllProcesses $all -ServiceProcessId $servicePid
foreach ($listener in $listeners) {
  $rootId = Get-AmVerifiedFormalConsoleRootId `
    -ProcessId ([int]$listener.OwningProcess) -AllProcesses $all -ServiceProcessId $servicePid
  if ($null -eq $rootId) {
    [void]$badOwners.Add("$($listener.LocalPort)/pid=$($listener.OwningProcess)")
  } else { [void]$roots.Add([int]$rootId) }
}
if ($badOwners.Count -gt 0) {
  Write-Output "diagnosis=BAD_NON_CONSOLE_PORT_OWNER $($badOwners -join ',')"
  exit 2
}
if ($listeners.Count -eq 0 -and -not $residual) {
  Write-Output 'diagnosis=BAD_RUNTIME_STOPPED'
  exit 2
}
if (@($listeners | Select-Object -ExpandProperty LocalPort -Unique).Count -ne $script:AmFormalPorts.Count) {
  Write-Output 'diagnosis=BAD_FORMAL_PORT_SET'
  exit 2
}
if ($roots.Count -ne 1) {
  Write-Output 'diagnosis=BAD_FORMAL_CONSOLE_ROOT_COUNT'
  exit 2
}
$rootId = [int]@($roots)[0]

if ($mode -eq 'supervisor') {
  $topologyOk = $state.Supervisors.Count -eq 1 -and $state.CommandHosts.Count -eq 1 -and
    $state.Workers.Count -eq 1 -and $state.SupervisorRecordValid -and $state.WorkerRecordValid
  if ($topologyOk) {
    $topologyOk = [int]$state.Supervisors[0].ParentProcessId -eq [int]$state.CommandHosts[0].ProcessId -and
      [int]$state.Workers[0].ParentProcessId -eq [int]$state.Supervisors[0].ProcessId -and
      (Test-AmUnderProcessTree -TargetProcessId ([int]$state.CommandHosts[0].ProcessId) -RootProcessId $rootId -AllProcesses $all)
  }
} elseif ($mode -eq 'legacy-direct-transition') {
  $legacyWorkers = @($all | Where-Object {
    (Test-AmWorkerProcess -Process $_ -AppDirectory $script:AmAppCurrent) -and
    (Test-AmUnderProcessTree -TargetProcessId ([int]$_.ProcessId) -RootProcessId $rootId -AllProcesses $all)
  })
  $topologyOk = $legacyWorkers.Count -eq 1 -and $state.Supervisors.Count -eq 0 -and -not $state.SupervisorRecordProcessAlive
} else { $topologyOk = $false }
Write-Output "check.processTopology=$topologyOk"
if (-not $topologyOk) {
  Write-Output 'diagnosis=BAD_WORKER_SUPERVISION_TOPOLOGY'
  exit 2
}

Write-AmRuntimeConfigSummary -BaseUrl 'http://127.0.0.1:3111'
if (-not $script:AmLastRuntimeConfigOk) {
  Write-Output 'diagnosis=BAD_RUNTIME_CONFIG_UNAVAILABLE'
  exit 2
}
if ($failed) {
  Write-Output 'diagnosis=BAD_FORMAL_CONSOLE_CONFIG'
  exit 2
}
Write-Output 'diagnosis=OK_FORMAL_CONSOLE_OWNS_AGENTMEMORY_PORTS'
exit 0

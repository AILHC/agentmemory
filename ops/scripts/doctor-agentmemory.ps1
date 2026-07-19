param(
  [ValidateSet('Running', 'Stopped')]
  [string]$ExpectedState = 'Running'
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

. "$PSScriptRoot\_agentmemory-local-common.ps1"

$serviceQuery = Get-AmServiceQuery
if ($serviceQuery.QueryState -eq 'query_failed') {
  Write-Output 'AgentMemory service doctor'
  Write-Output '=========================='
  Write-Output "expectedState=$ExpectedState"
  Write-Output 'service.query=failed'
  Write-Output 'diagnosis=BAD_DIAGNOSTIC_BACKEND'
  exit 2
}
$service = if ($serviceQuery.QueryState -eq 'present') { $serviceQuery } else { $null }
$servicePid = if ($service) { [int]$service.ProcessId } else { 0 }
$all = Get-AmProcesses
$listeners = @(Get-AmListeners -Ports $script:AmFormalPorts)
$state = Get-AmInstanceProcessState `
  -InstanceHome $script:AmFormalHome -InstanceId 'formal' `
  -AppDirectory $script:AmAppCurrent -AllProcesses $all

Write-Output 'AgentMemory service doctor'
Write-Output '=========================='
Write-Output "expectedState=$ExpectedState"
Write-Output "service.query=$($serviceQuery.QueryState)"
Write-AmDeploymentManifestSummary -AppDirectory $script:AmAppCurrent
Write-AmInstanceProcessReport -State $state -Prefix 'process'

if (-not $service) {
  Write-Output 'service.missing=true'
  exit 2
}
Write-Output "service.name=$($service.Name)"
Write-Output "service.state=$($service.State)"
Write-Output "service.processId=$servicePid"

if ($ExpectedState -eq 'Stopped') {
  $residual = $listeners.Count -ne 0 -or $state.Supervisors.Count -ne 0 -or
    $state.CommandHosts.Count -ne 0 -or $state.Workers.Count -ne 0 -or
    $state.SupervisorRecordProcessAlive -or $state.WorkerRecordProcessAlive
  if ($service.State -ne 'Stopped' -or $residual) {
    Write-Output 'diagnosis=BAD_FORMAL_SERVICE_STOP_INCOMPLETE'
    exit 2
  }
  Write-Output 'diagnosis=OK_FORMAL_SERVICE_STOPPED'
  exit 0
}

if ($service.State -ne 'Running') {
  Write-Output "diagnosis=BAD_SERVICE_NOT_RUNNING state=$($service.State)"
  exit 2
}
if (-not $script:AmLastDeploymentManifestOk) {
  Write-Output 'diagnosis=BAD_DEPLOYMENT_MANIFEST'
  exit 2
}

$badOwners = New-Object 'System.Collections.Generic.List[string]'
Write-AmPortReport `
  -Ports $script:AmFormalPorts -Listeners $listeners `
  -AllProcesses $all -ServiceProcessId $servicePid
foreach ($listener in $listeners) {
  if (-not (Test-AmUnderProcessTree `
      -TargetProcessId ([int]$listener.OwningProcess) `
      -RootProcessId $servicePid -AllProcesses $all)) {
    [void]$badOwners.Add("$($listener.LocalPort)/pid=$($listener.OwningProcess)")
  }
}
if ($badOwners.Count -gt 0) {
  Write-Output "diagnosis=BAD_NON_SERVICE_PORT_OWNER $($badOwners -join ',')"
  exit 2
}
if (@($listeners | Select-Object -ExpandProperty LocalPort -Unique).Count -ne $script:AmFormalPorts.Count) {
  Write-Output 'diagnosis=BAD_FORMAL_PORT_SET'
  exit 2
}

Write-AmRuntimeConfigSummary -BaseUrl 'http://127.0.0.1:3111'
if (-not $script:AmLastRuntimeConfigOk) {
  Write-Output 'diagnosis=BAD_RUNTIME_CONFIG_UNAVAILABLE'
  exit 2
}
Write-Output 'diagnosis=OK_FORMAL_SERVICE_OWNS_AGENTMEMORY_PORTS'
exit 0

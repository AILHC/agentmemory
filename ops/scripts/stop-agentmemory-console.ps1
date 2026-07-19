$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. "$PSScriptRoot\_agentmemory-local-common.ps1"

$svc = Get-AmService
if ($svc -and $svc.State -ne 'Stopped') {
  throw "Refusing console stop: Windows Service '$script:AmServiceName' is $($svc.State). Use the formal service stop entry for service mode."
}

$all = Get-AmProcesses
$servicePid = if ($svc) { [int]$svc.ProcessId } else { 0 }
$listeners = @(Get-AmListeners -Ports $script:AmFormalPorts | Where-Object { $null -ne $_ -and $_.PSObject.Properties['OwningProcess'] })

$badOwners = New-Object 'System.Collections.Generic.List[string]'
$verifiedRootIds = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($listener in $listeners) {
  $ownerId = [int]$listener.OwningProcess
  $rootId = Get-AmVerifiedFormalConsoleRootId -ProcessId $ownerId -AllProcesses $all -ServiceProcessId $servicePid
  if ($null -eq $rootId) {
    [void]$badOwners.Add("$($listener.LocalPort)/pid=$ownerId")
    continue
  }
  [void]$verifiedRootIds.Add([int]$rootId)
}

foreach ($process in @($all | Where-Object { Test-AmFormalConsoleProcess -Process $_ -AllProcesses $all -ServiceProcessId $servicePid })) {
  [void]$verifiedRootIds.Add([int]$process.ProcessId)
}

if ($badOwners.Count -gt 0) {
  throw "Refusing console stop: formal port owner is not a verified user-mode AgentMemory console process: $($badOwners -join ', ')"
}

$supervisorEntry = Join-Path $script:AmAppCurrent 'dist\worker-supervisor.mjs'
$requestResult = Invoke-AmSupervisorShutdownRequest -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent -SupervisorEntry $supervisorEntry
if ($requestResult -eq 'Accepted') {
  [void](Wait-AmInstanceProcessesStopped -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent -TimeoutSeconds 15)
}

Write-Output 'Stopping verified formal console process trees.'
$all = Get-AmProcesses
foreach ($pidValue in $verifiedRootIds) {
  $proc = Get-AmProcessById -ProcessId ([int]$pidValue) -AllProcesses $all
  if ($proc -and (Test-AmFormalConsoleProcess -Process $proc -AllProcesses $all -ServiceProcessId $servicePid)) {
    Stop-AmVerifiedProcessTree -RootProcessId ([int]$pidValue) -AllProcesses $all
  }
}


if (-not (Wait-AmInstanceProcessesStopped -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent -TimeoutSeconds 2)) {
  Write-Output 'supervisor.stop=fallback_force'
  Stop-AmVerifiedInstanceResiduals -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent
}

if ((Wait-AmPortsClosed -Ports $script:AmFormalPorts -TimeoutSeconds 10) -and
    (Wait-AmInstanceProcessesStopped -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent -TimeoutSeconds 2)) {
  [void](Remove-AmStoppedInstanceShutdownRequest -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent)
  Write-Output 'diagnosis=OK_FORMAL_CONSOLE_STOPPED'
  exit 0
}

$remaining = @(Get-AmListeners -Ports $script:AmFormalPorts | Where-Object { $null -ne $_ -and $_.PSObject.Properties['OwningProcess'] })
$details = ($remaining | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid=$($_.OwningProcess)" }) -join '; '
$state = Get-AmInstanceProcessState -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent
throw "Formal console stop incomplete: ports='$details' supervisor=$($state.Supervisors.Count) commandHost=$($state.CommandHosts.Count) worker=$($state.Workers.Count)"

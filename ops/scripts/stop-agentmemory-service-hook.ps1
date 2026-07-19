$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. "$PSScriptRoot\_agentmemory-local-common.ps1"

$env:AGENTMEMORY_HOME = $script:AmFormalHome
$env:AGENTMEMORY_INSTALL_HOME = $script:AmFormalInstall
$env:AGENTMEMORY_III_CONFIG = $script:AmFormalConfig

$supervisorEntry = Join-Path $script:AmAppCurrent 'dist\worker-supervisor.mjs'
$requestResult = Invoke-AmSupervisorShutdownRequest -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent -SupervisorEntry $supervisorEntry
if ($requestResult -eq 'Accepted') {
  [void](Wait-AmInstanceProcessesStopped -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent -TimeoutSeconds 15)
}

$all = Get-AmProcesses
$formalIiiProcesses = @($all | Where-Object { Test-AmFormalIiiProcess -Process $_ })
foreach ($process in $formalIiiProcesses) {
  if (Test-AmFormalIiiProcess -Process $process) {
    Stop-AmVerifiedProcessTree -RootProcessId ([int]$process.ProcessId) -AllProcesses $all
  }
}

if (-not (Wait-AmInstanceProcessesStopped -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent -TimeoutSeconds 2)) {
  Write-Output 'supervisor.stop=fallback_force'
  Stop-AmVerifiedInstanceResiduals -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent
}

$portsClosed = Wait-AmPortsClosed -Ports $script:AmFormalPorts -TimeoutSeconds 10
$processesStopped = Wait-AmInstanceProcessesStopped -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent -TimeoutSeconds 2
if ($portsClosed -and $processesStopped) {
  [void](Remove-AmStoppedInstanceShutdownRequest -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent)
  Write-Output 'diagnosis=OK_FORMAL_SERVICE_HOOK_STOPPED'
  exit 0
}

$state = Get-AmInstanceProcessState -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent
Write-AmInstanceProcessReport -State $state -Prefix 'process'
Write-Output "ports.closed=$portsClosed"
throw 'AgentMemory service stop hook did not close the verified process topology.'

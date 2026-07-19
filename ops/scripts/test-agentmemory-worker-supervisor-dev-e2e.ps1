$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. "$PSScriptRoot\_agentmemory-local-common.ps1"

$repoApp = Get-AmFullPath (Join-Path $PSScriptRoot '..\..')
$e2eRoot = Join-Path $script:AmDevRoot 'worker-supervisor-e2e'
$e2eHome = Join-Path $e2eRoot 'home'
$e2eLogs = Join-Path $e2eRoot 'logs'
$e2eTmp = Join-Path $e2eRoot 'tmp'
$primaryConfig = Join-Path $e2eRoot 'iii-config.yaml'
$gateConfig = Join-Path $e2eRoot 'iii-config-orphan-gate.yaml'
$hiddenSupervisorPid = Join-Path $e2eHome 'supervisor.pid.e2e-hidden'
$supervisorLog = Join-Path $e2eLogs 'worker-supervisor.jsonl'
$primaryPorts = @(3211, 3212, 3213, 49234)
$gatePorts = @(3221, 3222, 49235)
$allE2EPorts = @($primaryPorts + $gatePorts)
$knownWorkerIds = New-Object 'System.Collections.Generic.HashSet[int]'
$knownIiiIds = New-Object 'System.Collections.Generic.HashSet[int]'
$knownIiiConfigs = @{}
$managedEnvironmentNames = @(
  'AGENTMEMORY_HOME', 'AGENTMEMORY_INSTALL_HOME', 'AGENTMEMORY_III_CONFIG',
  'AGENTMEMORY_WORKER_SUPERVISOR_LOG', 'III_REST_PORT', 'III_STREAM_PORT',
  'III_VIEWER_PORT', 'III_ENGINE_URL', 'AGENTMEMORY_URL',
  'AGENTMEMORY_OUTPUT_LANGUAGE', 'TEMP', 'TMP', 'CI'
)
$originalEnvironment = @{}
foreach ($name in $managedEnvironmentNames) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Assert-AmPathInside -Path $e2eRoot -Root $script:AmDevRoot -Name 'E2ERoot'
Assert-AmRequiredFile -Path $script:AmIiiExe -Name 'iii.exe'
Assert-AmRequiredFile -Path (Join-Path $repoApp 'dist\worker-supervisor.mjs') -Name 'repository worker supervisor build'
Assert-AmRequiredFile -Path (Join-Path $repoApp 'dist\index.mjs') -Name 'repository worker build'

function Wait-E2ECondition {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Condition,
    [Parameter(Mandatory = $true)][string]$Description,
    [int]$TimeoutSeconds = 30
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for $Description."
}

function Get-E2EState {
  return Get-AmInstanceProcessState -InstanceHome $e2eHome -InstanceId 'dev-isolated' -AppDirectory $repoApp
}

function Get-E2EEvents {
  if (-not (Test-Path -LiteralPath $supervisorLog -PathType Leaf)) { return @() }
  $events = New-Object 'System.Collections.Generic.List[object]'
  foreach ($line in Get-Content -LiteralPath $supervisorLog) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try { [void]$events.Add(($line | ConvertFrom-Json -ErrorAction Stop)) } catch {}
  }
  return @($events | ForEach-Object { $_ })
}

function Test-E2ETopology {
  param([Parameter(Mandatory = $true)][int]$IiiProcessId)
  $all = Get-AmProcesses
  $iii = Get-AmProcessById -ProcessId $IiiProcessId -AllProcesses $all
  if (-not $iii -or -not (Test-AmSamePath -Left ([string]$iii.ExecutablePath) -Right $script:AmIiiExe)) { return $false }
  $state = Get-AmInstanceProcessState -InstanceHome $e2eHome -InstanceId 'dev-isolated' -AppDirectory $repoApp -AllProcesses $all
  if ($state.Supervisors.Count -ne 1 -or $state.CommandHosts.Count -ne 1 -or $state.Workers.Count -ne 1 -or
      -not $state.SupervisorRecordValid -or -not $state.WorkerRecordValid) { return $false }
  $supervisor = $state.Supervisors[0]
  $hostProcess = $state.CommandHosts[0]
  $worker = $state.Workers[0]
  if ([int]$supervisor.ParentProcessId -ne [int]$hostProcess.ProcessId -or
      [int]$worker.ParentProcessId -ne [int]$supervisor.ProcessId -or
      -not (Test-AmUnderProcessTree -TargetProcessId ([int]$hostProcess.ProcessId) -RootProcessId $IiiProcessId -AllProcesses $all)) {
    return $false
  }
  $listeners = @(Get-AmListeners -Ports $primaryPorts)
  if (@($listeners | Select-Object -ExpandProperty LocalPort -Unique).Count -ne $primaryPorts.Count) { return $false }
  foreach ($listener in $listeners) {
    if (-not (Test-AmUnderProcessTree -TargetProcessId ([int]$listener.OwningProcess) -RootProcessId $IiiProcessId -AllProcesses $all)) {
      return $false
    }
  }
  return $true
}

function Start-E2EIii {
  param([string]$ConfigPath = $primaryConfig)
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
  $process = Start-Process -FilePath $script:AmIiiExe `
    -ArgumentList @('--config', $ConfigPath) `
    -WorkingDirectory $repoApp `
    -RedirectStandardOutput (Join-Path $e2eLogs "iii-$timestamp.out.log") `
    -RedirectStandardError (Join-Path $e2eLogs "iii-$timestamp.err.log") `
    -WindowStyle Hidden `
    -PassThru
  [void]$knownIiiIds.Add([int]$process.Id)
  $knownIiiConfigs[[int]$process.Id] = $ConfigPath
  return $process
}

function Stop-E2EVerifiedIiiTrees {
  $all = Get-AmProcesses
  foreach ($iiiId in $knownIiiIds) {
    $process = Get-AmProcessById -ProcessId $iiiId -AllProcesses $all
    if (-not $process -or -not (Test-AmSamePath -Left ([string]$process.ExecutablePath) -Right $script:AmIiiExe)) { continue }
    $arguments = @(ConvertFrom-AmWindowsCommandLine -CommandLine ([string]$process.CommandLine))
    $expectedConfig = [string]$knownIiiConfigs[$iiiId]
    if ($arguments.Count -eq 3 -and $arguments[1] -ceq '--config' -and
        (Test-AmExactPathArgument -Actual $arguments[2] -Expected $expectedConfig)) {
      Stop-AmVerifiedProcessTree -RootProcessId $iiiId -AllProcesses $all
    }
  }
}

function Stop-E2EKnownWorkers {
  $all = Get-AmProcesses
  foreach ($workerId in $knownWorkerIds) {
    $worker = Get-AmProcessById -ProcessId $workerId -AllProcesses $all
    if ($worker -and (Test-AmWorkerProcess -Process $worker -AppDirectory $repoApp)) {
      Stop-Process -Id $workerId -Force -ErrorAction SilentlyContinue
    }
  }
}

$formalBefore = @(Get-AmListeners -Ports $script:AmFormalPorts | Sort-Object LocalPort | Select-Object LocalPort, OwningProcess)
if (@($formalBefore | Select-Object -ExpandProperty LocalPort -Unique).Count -ne $script:AmFormalPorts.Count) {
  throw 'Formal AgentMemory ports are not all listening; refusing isolated fault injection.'
}
$doctorHost = (Get-Command pwsh.exe -ErrorAction Stop).Source
$doctorProcess = Start-Process -FilePath $doctorHost `
  -ArgumentList @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'doctor-agentmemory-console.ps1')) `
  -WindowStyle Hidden -Wait -PassThru
if ($doctorProcess.ExitCode -ne 0) { throw 'Formal doctor is not healthy; refusing isolated fault injection.' }
if (@(Get-AmListeners -Ports $allE2EPorts).Count -ne 0) { throw 'Dev E2E ports are already occupied.' }
if (Test-Path -LiteralPath $e2eRoot) { throw "Dev E2E root already exists: $e2eRoot" }

New-Item -ItemType Directory -Path $e2eHome, $e2eLogs, $e2eTmp, (Join-Path $e2eHome 'data') -Force | Out-Null
$repoAppYaml = $repoApp.Replace('\', '/')
$stateYaml = (Join-Path $e2eHome 'data\state_store.db').Replace('\', '/')
$streamYaml = (Join-Path $e2eHome 'data\stream_store').Replace('\', '/')
$primaryConfigText = @"
workers:
  - name: iii-worker-manager
    config:
      host: 127.0.0.1
      port: 49234
  - name: iii-http
    config:
      port: 3211
      host: 127.0.0.1
      default_timeout: 180000
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: $stateYaml
  - name: iii-queue
    config:
      adapter:
        name: builtin
  - name: iii-pubsub
    config:
      adapter:
        name: local
  - name: iii-cron
    config:
      adapter:
        name: kv
  - name: iii-stream
    config:
      port: 3212
      host: 127.0.0.1
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: $streamYaml
  - name: iii-exec
    config:
      exec:
        - node $repoAppYaml/dist/worker-supervisor.mjs --instance-id dev-isolated --worker-entry $repoAppYaml/dist/index.mjs
"@
Set-Content -LiteralPath $primaryConfig -Value $primaryConfigText -Encoding UTF8
$gateConfigText = $primaryConfigText `
  -replace 'port: 49234', 'port: 49235' `
  -replace 'port: 3211', 'port: 3221' `
  -replace 'port: 3212', 'port: 3222' `
  -replace [regex]::Escape($stateYaml), ((Join-Path $e2eHome 'data\gate_state_store.db').Replace('\', '/')) `
  -replace [regex]::Escape($streamYaml), ((Join-Path $e2eHome 'data\gate_stream_store').Replace('\', '/'))
Set-Content -LiteralPath $gateConfig -Value $gateConfigText -Encoding UTF8

$env:AGENTMEMORY_HOME = $e2eHome
$env:AGENTMEMORY_INSTALL_HOME = $script:AmFormalInstall
$env:AGENTMEMORY_III_CONFIG = $primaryConfig
$env:AGENTMEMORY_WORKER_SUPERVISOR_LOG = $supervisorLog
$env:III_REST_PORT = '3211'
$env:III_STREAM_PORT = '3212'
$env:III_VIEWER_PORT = '3213'
$env:III_ENGINE_URL = 'ws://localhost:49234'
$env:AGENTMEMORY_URL = 'http://localhost:3211'
$env:AGENTMEMORY_OUTPUT_LANGUAGE = 'zh-CN'
$env:TEMP = $e2eTmp
$env:TMP = $e2eTmp
$env:CI = '1'

$failure = $null
try {
  $firstIii = Start-E2EIii
  Wait-E2ECondition -Description 'initial legal topology' -TimeoutSeconds 60 -Condition {
    Test-E2ETopology -IiiProcessId ([int]$firstIii.Id)
  }
  $firstState = Get-E2EState
  $firstWorkerId = [int]$firstState.Workers[0].ProcessId
  $firstSupervisorId = [int]$firstState.Supervisors[0].ProcessId
  [void]$knownWorkerIds.Add($firstWorkerId)
  Stop-Process -Id $firstWorkerId -Force
  Wait-E2ECondition -Description 'unique worker replacement' -TimeoutSeconds 30 -Condition {
    $state = Get-E2EState
    $state.Supervisors.Count -eq 1 -and [int]$state.Supervisors[0].ProcessId -eq $firstSupervisorId -and
      $state.Workers.Count -eq 1 -and [int]$state.Workers[0].ProcessId -ne $firstWorkerId -and $state.WorkerRecordValid
  }
  $replacementState = Get-E2EState
  [void]$knownWorkerIds.Add([int]$replacementState.Workers[0].ProcessId)
  $restartEvents = @(Get-E2EEvents)
  if (-not ($restartEvents | Where-Object { $_.event -eq 'worker_exited' -and [int]$_.workerPid -eq $firstWorkerId }) -or
      -not ($restartEvents | Where-Object { $_.event -eq 'worker_started' -and [int]$_.workerPid -ne $firstWorkerId })) {
    throw 'Worker restart telemetry was incomplete.'
  }

  $staleLockCount = @(Get-ChildItem -LiteralPath $e2eHome -Filter 'worker.lock.json.stale-*' -File -ErrorAction SilentlyContinue).Count
  $requestResult = Invoke-AmSupervisorShutdownRequest `
    -InstanceHome $e2eHome -InstanceId 'dev-isolated' -AppDirectory $repoApp `
    -SupervisorEntry (Join-Path $repoApp 'dist\worker-supervisor.mjs')
  if ($requestResult -ne 'Accepted') { throw 'Graceful shutdown request was rejected.' }
  Wait-E2ECondition -Description 'graceful worker lock cleanup' -TimeoutSeconds 20 -Condition {
    -not (Test-Path -LiteralPath (Join-Path $e2eHome 'worker.lock.json') -PathType Leaf)
  }
  $newStaleLockCount = @(Get-ChildItem -LiteralPath $e2eHome -Filter 'worker.lock.json.stale-*' -File -ErrorAction SilentlyContinue).Count
  if ($newStaleLockCount -ne $staleLockCount) { throw 'Graceful stop was satisfied by stale lock archival.' }
  Wait-E2ECondition -Description 'supervisor graceful exit' -TimeoutSeconds 20 -Condition {
    $state = Get-E2EState
    $state.Supervisors.Count -eq 0 -and $state.Workers.Count -eq 0
  }
  Stop-E2EVerifiedIiiTrees
  Wait-E2ECondition -Description 'primary port shutdown' -TimeoutSeconds 20 -Condition {
    @(Get-AmListeners -Ports $primaryPorts).Count -eq 0
  }

  Remove-AmStoppedInstanceShutdownRequest -InstanceHome $e2eHome -InstanceId 'dev-isolated' -AppDirectory $repoApp | Out-Null
  $secondIii = Start-E2EIii
  Wait-E2ECondition -Description 'second legal topology' -TimeoutSeconds 60 -Condition {
    Test-E2ETopology -IiiProcessId ([int]$secondIii.Id)
  }
  $orphanState = Get-E2EState
  $orphanWorkerId = [int]$orphanState.Workers[0].ProcessId
  $orphanSupervisorId = [int]$orphanState.Supervisors[0].ProcessId
  [void]$knownWorkerIds.Add($orphanWorkerId)
  if (Test-Path -LiteralPath $hiddenSupervisorPid) { throw 'Hidden supervisor PID fixture already exists.' }
  Move-Item -LiteralPath (Join-Path $e2eHome 'supervisor.pid') -Destination $hiddenSupervisorPid
  $eventCountBeforeGate = @(Get-E2EEvents).Count
  $env:AGENTMEMORY_III_CONFIG = $gateConfig
  $env:III_REST_PORT = '3221'
  $env:III_STREAM_PORT = '3222'
  $env:III_ENGINE_URL = 'ws://localhost:49235'
  $env:AGENTMEMORY_URL = 'http://localhost:3221'
  $thirdIii = Start-E2EIii -ConfigPath $gateConfig
  $env:AGENTMEMORY_III_CONFIG = $primaryConfig
  $env:III_REST_PORT = '3211'
  $env:III_STREAM_PORT = '3212'
  $env:III_ENGINE_URL = 'ws://localhost:49234'
  $env:AGENTMEMORY_URL = 'http://localhost:3211'
  Wait-E2ECondition -Description 'orphan worker gate' -TimeoutSeconds 45 -Condition {
    $newEvents = @(Get-E2EEvents | Select-Object -Skip $eventCountBeforeGate)
    [bool]($newEvents | Where-Object { $_.event -eq 'supervisor_started' -and [int]$_.iiiPid -eq [int]$thirdIii.Id }) -and
      [bool]($newEvents | Where-Object { $_.event -eq 'orphan_worker_detected' })
  }
  if (-not (Get-Process -Id $orphanWorkerId -ErrorAction SilentlyContinue)) { throw 'Original orphan worker exited before gate verification.' }
  Wait-E2ECondition -Description 'gate supervisor exit' -TimeoutSeconds 15 -Condition {
    $state = Get-E2EState
    $state.Supervisors.Count -eq 1 -and [int]$state.Supervisors[0].ProcessId -eq $orphanSupervisorId
  }
  if (Test-Path -LiteralPath (Join-Path $e2eHome 'supervisor.pid')) {
    throw 'Gate supervisor did not release its PID file.'
  }
  Move-Item -LiteralPath $hiddenSupervisorPid -Destination (Join-Path $e2eHome 'supervisor.pid')
  $afterGate = Get-E2EState
  if ($afterGate.Workers.Count -ne 1 -or [int]$afterGate.Workers[0].ProcessId -ne $orphanWorkerId -or
      -not $afterGate.SupervisorRecordValid -or -not $afterGate.WorkerRecordValid) {
    throw 'Orphan gate allowed a second worker.'
  }
  $newWorkerStarts = @(Get-E2EEvents | Select-Object -Skip $eventCountBeforeGate | Where-Object { $_.event -eq 'worker_started' })
  if ($newWorkerStarts.Count -ne 0) { throw 'Orphan gate emitted worker_started.' }

  Write-Output 'e2e.workerRestart=ok'
  Write-Output 'e2e.gracefulStop=ok'
  Write-Output 'e2e.orphanGate=ok'
} catch {
  $failure = $_
} finally {
  if ((Test-Path -LiteralPath $hiddenSupervisorPid) -and
      -not (Test-Path -LiteralPath (Join-Path $e2eHome 'supervisor.pid'))) {
    Move-Item -LiteralPath $hiddenSupervisorPid -Destination (Join-Path $e2eHome 'supervisor.pid') -ErrorAction SilentlyContinue
  }
  Stop-E2EVerifiedIiiTrees
  Stop-E2EKnownWorkers
  Start-Sleep -Milliseconds 500
  Stop-E2EVerifiedIiiTrees
  Stop-E2EKnownWorkers

  $remainingPorts = @(Get-AmListeners -Ports $allE2EPorts)
  $remainingState = Get-E2EState
  foreach ($name in $managedEnvironmentNames) {
    $originalValue = $originalEnvironment[$name]
    if ($null -eq $originalValue) {
      [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    } else {
      [Environment]::SetEnvironmentVariable($name, [string]$originalValue, 'Process')
    }
  }
  if ($remainingPorts.Count -ne 0 -or $remainingState.Supervisors.Count -ne 0 -or
      $remainingState.CommandHosts.Count -ne 0 -or $remainingState.Workers.Count -ne 0) {
    if ($null -eq $failure) { $failure = [RuntimeException]::new('Dev E2E cleanup left a process or listener.') }
  } elseif ($null -eq $failure) {
    Remove-AmStoppedInstanceShutdownRequest -InstanceHome $e2eHome -InstanceId 'dev-isolated' -AppDirectory $repoApp | Out-Null
    if (Test-Path -LiteralPath $e2eRoot) {
      Assert-AmPathInside -Path $e2eRoot -Root $script:AmDevRoot -Name 'E2ECleanupRoot'
      Remove-Item -LiteralPath $e2eRoot -Recurse -Force
    }
  }

  $formalAfter = @(Get-AmListeners -Ports $script:AmFormalPorts | Sort-Object LocalPort | Select-Object LocalPort, OwningProcess)
  $formalBeforeText = @($formalBefore | ForEach-Object { "$($_.LocalPort):$($_.OwningProcess)" }) -join ','
  $formalAfterText = @($formalAfter | ForEach-Object { "$($_.LocalPort):$($_.OwningProcess)" }) -join ','
  if ($formalBeforeText -ne $formalAfterText -and $null -eq $failure) {
    $failure = [RuntimeException]::new('Formal port ownership changed during isolated E2E.')
  }
}

if ($null -ne $failure) { throw $failure }
Write-Output 'diagnosis=OK_DEV_WORKER_SUPERVISOR_E2E'

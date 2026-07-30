param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$RunId,
  [string]$RuntimeRoot = '',
  [string]$RequiredStages = '',
  [ValidateRange(1, 86400)]
  [int]$StatusStaleAfterSeconds = 900
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $deployedApp = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  $RuntimeRoot = if ($env:AGENTMEMORY_RUNTIME_ROOT) {
    [System.IO.Path]::GetFullPath($env:AGENTMEMORY_RUNTIME_ROOT)
  } elseif (Test-Path -LiteralPath (Join-Path $deployedApp 'DEPLOYMENT.json') -PathType Leaf) {
    [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
  } else {
    'F:\ai-runtime\agentmemory'
  }
}

function Get-AmStatusProperty {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function ConvertFrom-AmSnapshotStatus {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    $RunnerPid = $null
  )
  $snapshotNames = @($Snapshot.PSObject.Properties.Name)
  $journalSeq = if ($snapshotNames -contains 'orchestration_journal' -and
      $null -ne $Snapshot.orchestration_journal) {
    $Snapshot.orchestration_journal.included_seq
  } else { 0 }
  return [pscustomobject]@{
    run_id = $Snapshot.run_id
    current_stage = if ($snapshotNames -contains 'current_stage') { $Snapshot.current_stage } else { $null }
    coverage = $Snapshot.coverage
    scheduler_epoch = if ($snapshotNames -contains 'scheduler_epoch') { $Snapshot.scheduler_epoch } else { $null }
    next_retry_at = if ($snapshotNames -contains 'next_retry_at') { $Snapshot.next_retry_at } else { $null }
    runner_pid = $RunnerPid
    snapshot_at = if ($snapshotNames -contains 'updated_at') { $Snapshot.updated_at } else { $null }
    journal_seq = $journalSeq
  }
}

function Read-AmV2Journal {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
  $events = [System.Collections.Generic.List[object]]::new()
  $supportsDateKind = (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')
  foreach ($line in [System.IO.File]::ReadLines($Path)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $event = if ($supportsDateKind) {
      ConvertFrom-Json -InputObject $line -DateKind String
    } else {
      ConvertFrom-Json -InputObject $line
    }
    $events.Add($event)
  }
  return $events
}

function Test-AmStatusSafeNonNegativeInteger {
  param($Value)
  if ($null -eq $Value) { return $false }
  $integralTypes = @(
    [byte], [sbyte],
    [int16], [uint16],
    [int32], [uint32],
    [int64], [uint64]
  )
  if ($integralTypes -notcontains $Value.GetType()) { return $false }
  return [decimal]$Value -ge 0 -and [decimal]$Value -le 9007199254740991
}

function Test-AmV2SummaryRetryAuthorization {
  param(
    [Parameter(Mandatory = $true)]$Event,
    $CompletedOperation,
    $FailedTerminal,
    [string]$PlannedInputHash = '',
    [string]$StartedAttemptId = ''
  )
  if ($null -eq $CompletedOperation -or $null -eq $FailedTerminal) { return $false }
  $payload = $Event.payload
  $operationPayload = $CompletedOperation.payload
  $terminalPayload = $FailedTerminal.payload
  $lastSafe = Get-AmStatusProperty -Object $payload -Name 'last_safe_failure'
  $terminalResult = Get-AmStatusProperty -Object $operationPayload -Name 'terminal_result'
  if ($null -eq $lastSafe -or $null -eq $terminalResult) { return $false }
  $terminalResultPayload = Get-AmStatusProperty -Object $terminalResult -Name 'payload'
  if ($null -eq $terminalResultPayload) { return $false }

  $unitId = [string](Get-AmStatusProperty -Object $payload -Name 'unit_id')
  $attemptId = [string](Get-AmStatusProperty -Object $payload -Name 'attempt_id')
  $operationId = [string](Get-AmStatusProperty -Object $payload -Name 'operation_id')
  $failureClass = [string](Get-AmStatusProperty -Object $payload -Name 'failure_class')
  $failureCause = [string](Get-AmStatusProperty -Object $payload -Name 'failure_cause')
  $failurePhase = [string](Get-AmStatusProperty -Object $payload -Name 'failure_phase')
  $retryEpochRaw = Get-AmStatusProperty -Object $payload -Name 'retry_epoch'
  $completedOperationSeq = Get-AmStatusProperty -Object $CompletedOperation -Name 'seq'
  $failedTerminalSeq = Get-AmStatusProperty -Object $FailedTerminal -Name 'seq'
  $authorizationSeq = Get-AmStatusProperty -Object $Event -Name 'seq'
  $supersededOperationSeq = Get-AmStatusProperty -Object $payload -Name 'superseded_operation_seq'
  $supersededTerminalSeq = Get-AmStatusProperty -Object $payload -Name 'superseded_terminal_seq'
  $expectedJournalSeq = Get-AmStatusProperty -Object $payload -Name 'expected_journal_seq'
  if (
    -not (Test-AmStatusSafeNonNegativeInteger -Value $retryEpochRaw) -or
    -not (Test-AmStatusSafeNonNegativeInteger -Value $completedOperationSeq) -or
    -not (Test-AmStatusSafeNonNegativeInteger -Value $failedTerminalSeq) -or
    -not (Test-AmStatusSafeNonNegativeInteger -Value $authorizationSeq) -or
    -not (Test-AmStatusSafeNonNegativeInteger -Value $supersededOperationSeq) -or
    -not (Test-AmStatusSafeNonNegativeInteger -Value $supersededTerminalSeq) -or
    -not (Test-AmStatusSafeNonNegativeInteger -Value $expectedJournalSeq)
  ) { return $false }

  return (
    [string](Get-AmStatusProperty -Object $payload -Name 'stage') -ceq 'summary' -and
    -not [string]::IsNullOrWhiteSpace($unitId) -and
    $operationId -ceq "$unitId`:reduce" -and
    $attemptId -ceq $StartedAttemptId -and
    [string](Get-AmStatusProperty -Object $payload -Name 'runner_input_hash') -ceq $PlannedInputHash -and
    [string](Get-AmStatusProperty -Object $payload -Name 'receipt_input_hash') -cmatch '^[0-9a-f]{64}$' -and
    [string](Get-AmStatusProperty -Object $payload -Name 'receipt_status') -ceq 'failed' -and
    @('transient_provider', 'transient_runtime') -ccontains $failureClass -and
    $failureCause -cmatch '^[a-z0-9][a-z0-9_.:-]{0,127}$' -and
    @('provider_call', 'before_final_persistence') -ccontains $failurePhase -and
    [string](Get-AmStatusProperty -Object $lastSafe -Name 'error_class') -ceq $failureClass -and
    [string](Get-AmStatusProperty -Object $lastSafe -Name 'cause') -ceq $failureCause -and
    [string](Get-AmStatusProperty -Object $lastSafe -Name 'phase') -ceq $failurePhase -and
    [string](Get-AmStatusProperty -Object $lastSafe -Name 'timestamp') -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' -and
    [string]$CompletedOperation.type -ceq 'unit_operation_completed' -and
    [long]$completedOperationSeq -eq ([long]$failedTerminalSeq - 1) -and
    [long]$supersededOperationSeq -eq [long]$completedOperationSeq -and
    [string](Get-AmStatusProperty -Object $operationPayload -Name 'unit_id') -ceq $unitId -and
    [string](Get-AmStatusProperty -Object $operationPayload -Name 'attempt_id') -ceq $attemptId -and
    [string](Get-AmStatusProperty -Object $operationPayload -Name 'operation_id') -ceq $operationId -and
    [string](Get-AmStatusProperty -Object $operationPayload -Name 'status') -ceq 'failed' -and
    [string](Get-AmStatusProperty -Object $operationPayload -Name 'error') -ceq $failureCause -and
    [string](Get-AmStatusProperty -Object $terminalResult -Name 'status') -ceq 'failed' -and
    [string](Get-AmStatusProperty -Object $terminalResultPayload -Name 'error') -ceq $failureCause -and
    [string]$FailedTerminal.type -ceq 'unit_terminal' -and
    [long]$failedTerminalSeq -eq ([long]$authorizationSeq - 1) -and
    [long]$supersededTerminalSeq -eq [long]$failedTerminalSeq -and
    [long]$expectedJournalSeq -eq [long]$failedTerminalSeq -and
    [string](Get-AmStatusProperty -Object $terminalPayload -Name 'unit_id') -ceq $unitId -and
    [string](Get-AmStatusProperty -Object $terminalPayload -Name 'attempt_id') -ceq $attemptId -and
    [string](Get-AmStatusProperty -Object $terminalPayload -Name 'status') -ceq 'failed' -and
    [string](Get-AmStatusProperty -Object $terminalPayload -Name 'error') -ceq $failureCause
  )
}

function Test-AmV2LessonsRetryAuthorization {
  param(
    [Parameter(Mandatory = $true)]$Event,
    $FailedTerminal,
    [string]$PlannedInputHash = '',
    [string]$StartedAttemptId = ''
  )
  if ($null -eq $FailedTerminal) { return $false }
  $payload = $Event.payload
  $terminalPayload = $FailedTerminal.payload
  $lastSafe = Get-AmStatusProperty -Object $payload -Name 'last_safe_failure'
  $lessonEvidence = Get-AmStatusProperty -Object $payload -Name 'lesson_run_evidence'
  if ($null -eq $lastSafe -or $null -eq $lessonEvidence) { return $false }

  $unitId = [string](Get-AmStatusProperty -Object $payload -Name 'unit_id')
  $attemptId = [string](Get-AmStatusProperty -Object $payload -Name 'attempt_id')
  $failureClass = [string](Get-AmStatusProperty -Object $payload -Name 'failure_class')
  $failureCause = [string](Get-AmStatusProperty -Object $payload -Name 'failure_cause')
  $failurePhase = [string](Get-AmStatusProperty -Object $payload -Name 'failure_phase')
  $retryEpoch = Get-AmStatusProperty -Object $payload -Name 'retry_epoch'
  $failedTerminalSeq = Get-AmStatusProperty -Object $FailedTerminal -Name 'seq'
  $authorizationSeq = Get-AmStatusProperty -Object $Event -Name 'seq'
  $supersededTerminalSeq = Get-AmStatusProperty -Object $payload -Name 'superseded_terminal_seq'
  $expectedJournalSeq = Get-AmStatusProperty -Object $payload -Name 'expected_journal_seq'
  $createdCount = Get-AmStatusProperty -Object $lessonEvidence -Name 'created_lesson_count'
  $replacedCount = Get-AmStatusProperty -Object $lessonEvidence -Name 'replaced_lesson_count'
  $chunkCount = Get-AmStatusProperty -Object $lessonEvidence -Name 'chunk_lesson_count'
  foreach ($value in @(
      $retryEpoch,
      $failedTerminalSeq,
      $authorizationSeq,
      $supersededTerminalSeq,
      $expectedJournalSeq,
      $createdCount,
      $replacedCount,
      $chunkCount
    )) {
    if (-not (Test-AmStatusSafeNonNegativeInteger -Value $value)) { return $false }
  }

  $failedAt = [string](Get-AmStatusProperty -Object $lessonEvidence -Name 'failed_at')
  return (
    [string](Get-AmStatusProperty -Object $payload -Name 'stage') -ceq 'lessons' -and
    -not [string]::IsNullOrWhiteSpace($unitId) -and
    $attemptId -ceq $StartedAttemptId -and
    [string](Get-AmStatusProperty -Object $payload -Name 'runner_input_hash') -ceq $PlannedInputHash -and
    [string](Get-AmStatusProperty -Object $payload -Name 'receipt_input_hash') -cmatch '^[0-9a-f]{64}$' -and
    [string](Get-AmStatusProperty -Object $payload -Name 'receipt_status') -ceq 'failed' -and
    [string](Get-AmStatusProperty -Object $payload -Name 'receipt_failure_class') -ceq 'transient_provider' -and
    [string](Get-AmStatusProperty -Object $payload -Name 'receipt_failure_cause') -ceq 'lesson_extraction_failed' -and
    $failureClass -ceq 'transient_provider' -and
    $failureCause -ceq 'lesson_extraction_failed' -and
    $failurePhase -ceq 'provider_call' -and
    [long]$retryEpoch -eq 0 -and
    [string](Get-AmStatusProperty -Object $lastSafe -Name 'error_class') -ceq $failureClass -and
    [string](Get-AmStatusProperty -Object $lastSafe -Name 'cause') -ceq $failureCause -and
    [string](Get-AmStatusProperty -Object $lastSafe -Name 'phase') -ceq $failurePhase -and
    [string](Get-AmStatusProperty -Object $lastSafe -Name 'timestamp') -ceq $failedAt -and
    $failedAt -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' -and
    [string](Get-AmStatusProperty -Object $lessonEvidence -Name 'status') -ceq 'retryable' -and
    [string](Get-AmStatusProperty -Object $lessonEvidence -Name 'input_hash') -cmatch '^[0-9a-f]{64}$' -and
    [string](Get-AmStatusProperty -Object $lessonEvidence -Name 'config_hash') -cmatch '^[0-9a-f]{64}$' -and
    @('rate_limited', 'timeout', 'network_error', 'server_error') -ccontains [string](
      Get-AmStatusProperty -Object $lessonEvidence -Name 'failure_cause'
    ) -and
    [string](Get-AmStatusProperty -Object $lessonEvidence -Name 'failure_phase') -ceq 'provider_call' -and
    [long]$createdCount -eq 0 -and
    [long]$replacedCount -eq 0 -and
    [long]$chunkCount -eq 0 -and
    [string]$FailedTerminal.type -ceq 'unit_terminal' -and
    [long]$failedTerminalSeq -eq ([long]$authorizationSeq - 1) -and
    [long]$supersededTerminalSeq -eq [long]$failedTerminalSeq -and
    [long]$expectedJournalSeq -eq [long]$failedTerminalSeq -and
    [string](Get-AmStatusProperty -Object $terminalPayload -Name 'unit_id') -ceq $unitId -and
    [string](Get-AmStatusProperty -Object $terminalPayload -Name 'attempt_id') -ceq $attemptId -and
    [string](Get-AmStatusProperty -Object $terminalPayload -Name 'status') -ceq 'failed' -and
    [string](Get-AmStatusProperty -Object $terminalPayload -Name 'error') -ceq $failureCause
  )
}

function Get-AmV2StageFacts {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )
  $planned = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  $started = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  $blocked = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  $terminal = [System.Collections.Generic.Dictionary[string, string]]::new(
    [System.StringComparer]::Ordinal
  )
  $plannedInputHashes = [System.Collections.Generic.Dictionary[string, string]]::new(
    [System.StringComparer]::Ordinal
  )
  $attemptIds = [System.Collections.Generic.Dictionary[string, string]]::new(
    [System.StringComparer]::Ordinal
  )
  $completed = $false
  $lastSeq = -1
  $lastAt = $null
  $previousEvent = $null
  $previousPreviousEvent = $null
  foreach ($event in (Read-AmV2Journal -Path $Path)) {
    $priorEvent = $previousEvent
    $priorPriorEvent = $previousPreviousEvent
    $previousPreviousEvent = $previousEvent
    $previousEvent = $event
    $lastSeq = [Math]::Max($lastSeq, [int]$event.seq)
    if ($null -ne $event.at -and
        ($null -eq $lastAt -or [string]$event.at -gt [string]$lastAt)) {
      $lastAt = [string]$event.at
    }
    if ([string]$event.type -eq 'stage_completed') {
      $completed = $true
      continue
    }
    $unitId = Get-AmStatusProperty -Object $event.payload -Name 'unit_id'
    if ([string]::IsNullOrWhiteSpace([string]$unitId)) { continue }
    if ([string]$event.type -eq 'unit_planned') {
      [void]$planned.Add([string]$unitId)
      $plannedInputHashes[[string]$unitId] = [string](
        Get-AmStatusProperty -Object $event.payload -Name 'input_hash'
      )
    } elseif ([string]$event.type -in @(
        'unit_started',
        'unit_prepare_started',
        'unit_committing',
        'unit_operation_started'
      )) {
      [void]$started.Add([string]$unitId)
      if ([string]$event.type -eq 'unit_started') {
        $attemptIds[[string]$unitId] = [string](
          Get-AmStatusProperty -Object $event.payload -Name 'attempt_id'
        )
      }
    } elseif ([string]$event.type -eq 'unit_blocked') {
      [void]$blocked.Add([string]$unitId)
    } elseif ([string]$event.type -eq 'unit_reconciliation_resolved') {
      [void]$blocked.Remove([string]$unitId)
      [void]$started.Remove([string]$unitId)
    } elseif ([string]$event.type -eq 'unit_summary_failed_terminal_retry_authorized') {
      $plannedInputHash = if ($plannedInputHashes.ContainsKey([string]$unitId)) {
        $plannedInputHashes[[string]$unitId]
      } else { '' }
      $attemptId = if ($attemptIds.ContainsKey([string]$unitId)) {
        $attemptIds[[string]$unitId]
      } else { '' }
      if (Test-AmV2SummaryRetryAuthorization `
          -Event $event `
          -CompletedOperation $priorPriorEvent `
          -FailedTerminal $priorEvent `
          -PlannedInputHash $plannedInputHash `
          -StartedAttemptId $attemptId) {
        [void]$terminal.Remove([string]$unitId)
        [void]$started.Remove([string]$unitId)
      }
    } elseif ([string]$event.type -eq 'unit_lessons_failed_terminal_retry_authorized') {
      $plannedInputHash = if ($plannedInputHashes.ContainsKey([string]$unitId)) {
        $plannedInputHashes[[string]$unitId]
      } else { '' }
      $attemptId = if ($attemptIds.ContainsKey([string]$unitId)) {
        $attemptIds[[string]$unitId]
      } else { '' }
      if (Test-AmV2LessonsRetryAuthorization `
          -Event $event `
          -FailedTerminal $priorEvent `
          -PlannedInputHash $plannedInputHash `
          -StartedAttemptId $attemptId) {
        [void]$terminal.Remove([string]$unitId)
        [void]$started.Remove([string]$unitId)
      }
    } elseif ([string]$event.type -eq 'unit_terminal') {
      $status = [string](Get-AmStatusProperty -Object $event.payload -Name 'status')
      $terminal[[string]$unitId] = $status
    }
  }
  $succeeded = 0
  $skipped = 0
  $failed = 0
  foreach ($status in $terminal.Values) {
    if ($status -in @('succeeded', 'completed')) {
      $succeeded++
    } elseif ($status -eq 'skipped') {
      $skipped++
    } elseif ($status -eq 'failed') {
      $failed++
    }
  }
  $running = 0
  foreach ($unitId in $started) {
    if (-not $terminal.ContainsKey($unitId) -and -not $blocked.Contains($unitId)) {
      $running++
    }
  }
  $pending = [Math]::Max(
    0,
    $planned.Count - $terminal.Count - $running - $blocked.Count
  )
  return [pscustomobject]@{
    completed = $completed
    succeeded = $succeeded
    skipped = $skipped
    failed = $failed
    pending = $pending
    running = $running
    blocked = $blocked.Count
    last_seq = $lastSeq
    last_at = $lastAt
  }
}

$runsPath = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot 'extraction-runs'))
$statePath = [System.IO.Path]::GetFullPath((Join-Path $runsPath "$RunId.json"))
if (-not $statePath.StartsWith("$runsPath\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'run state path must stay under extraction-runs'
}
$v2Root = [System.IO.Path]::GetFullPath((Join-Path $runsPath "$RunId.v2"))
if (-not $v2Root.StartsWith("$runsPath\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'v2 run state path must stay under extraction-runs'
}
if (Test-Path -LiteralPath $v2Root -PathType Container) {
  $projector = Join-Path $PSScriptRoot 'project-agentmemory-recovery-status.mjs'
  if (-not (Test-Path -LiteralPath $projector -PathType Leaf)) {
    throw 'safe recovery status projector is missing'
  }
  $arguments = @(
    $projector,
    '--runtime-root', $RuntimeRoot,
    '--run-id', $RunId
  )
  if (-not [string]::IsNullOrWhiteSpace($RequiredStages)) {
    $arguments += @('--required-stages', $RequiredStages)
  }
  $rawProjection = @(& node @arguments)
  if ($LASTEXITCODE -ne 0) {
    throw 'safe recovery status projection failed'
  }
  $projection = ($rawProjection -join [Environment]::NewLine) | ConvertFrom-Json
  $lockPath = Join-Path $v2Root 'writer.lock.json'
  $lockPresent = Test-Path -LiteralPath $lockPath -PathType Leaf
  $lockPidAlive = $false
  if ($lockPresent) {
    $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    if ([string]$lock.run_id -cne $RunId) {
      throw 'v2 writer lock run_id does not match requested run'
    }
    $lockPidAlive = $null -ne (
      Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue
    )
  }
  $journalAgeSeconds = if ($null -eq $projection.last_progress_at) { 0 } else {
    [Math]::Max(
      0,
      [Math]::Floor(
        ((Get-Date).ToUniversalTime() -
          [DateTime]::Parse([string]$projection.last_progress_at).ToUniversalTime()).TotalSeconds
      )
    )
  }
  Write-Output "run_id=$RunId"
  Write-Output 'source=v2_journal'
  Write-Output "run_status=$($projection.run_status)"
  Write-Output "recovery_contract_version=$($projection.recovery_contract_version)"
  Write-Output 'status_manifest_stale=false'
  Write-Output "status_journal_stale=$(($journalAgeSeconds -gt $StatusStaleAfterSeconds).ToString().ToLowerInvariant())"
  Write-Output "status_journal_age_seconds=$journalAgeSeconds"
  Write-Output "lock_present=$($lockPresent.ToString().ToLowerInvariant())"
  Write-Output "lock_pid_alive=$($lockPidAlive.ToString().ToLowerInvariant())"
  $currentStage = @(
    $projection.stages | Where-Object { $_.acceptance_ready -ne $true }
  ) | Select-Object -Last 1
  Write-Output "current_stage=$(if ($null -eq $currentStage) { '' } else { $currentStage.stage })"
  Write-Output 'scheduler_epoch='
  Write-Output "snapshot_at=$($projection.last_progress_at)"
  Write-Output "next_retry_at=$($projection.next_retry_at)"
  Write-Output "completion_mode=$(if ([string]::IsNullOrWhiteSpace($RequiredStages)) { 'full_run' } else { 'required_stages' })"
  Write-Output "required_stages=$RequiredStages"
  Write-Output "acceptance_ready=$(([string]$projection.acceptance_ready).ToLowerInvariant())"
  Write-Output (
    "recovery_counts=runnable:$($projection.counts.runnable)," +
    "running:$($projection.counts.running)," +
    "retry_wait:$($projection.counts.retry_wait)," +
    "reconciling:$($projection.counts.reconciling)," +
    "isolated:$($projection.counts.isolated)," +
    "dependency_blocked:$($projection.counts.dependency_blocked)," +
    "system_blocked:$($projection.counts.system_blocked)"
  )
  Write-Output "system_block_reason_codes=$($projection.system_block_reason_codes -join ',')"
  foreach ($stageFacts in $projection.stages) {
    $failed = [int]$stageFacts.counts.isolated
    $pending = [int]$stageFacts.counts.runnable + [int]$stageFacts.counts.retry_wait
    $running = [int]$stageFacts.counts.running
    $blocked = [int]$stageFacts.counts.reconciling +
      [int]$stageFacts.counts.system_blocked
    Write-Output (
      "stage.$($stageFacts.stage)=succeeded:$($stageFacts.counts.succeeded)," +
      "skipped:$($stageFacts.counts.skipped),failed:$failed," +
      "pending:$pending,running:$running," +
      "blocked:$blocked"
    )
  }
  return
}
$statusPath = $statePath -replace '\.json$', '.status.json'
$lockPath = "$statePath.lock"
$source = 'status_manifest'
$statusManifestStale = $false
$statusManifestAgeSeconds = $null

if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
  $statusFile = Get-Item -LiteralPath $statusPath
  $statusManifestAgeSeconds = [Math]::Max(
    0,
    [Math]::Floor(((Get-Date).ToUniversalTime() - $statusFile.LastWriteTimeUtc).TotalSeconds)
  )
  $statusManifestStale = $statusManifestAgeSeconds -gt $StatusStaleAfterSeconds
  $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
  if ($statusManifestStale -and (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    $snapshot = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $status = ConvertFrom-AmSnapshotStatus -Snapshot $snapshot -RunnerPid $status.runner_pid
    $source = 'snapshot_fallback_stale_manifest'
  }
} elseif (Test-Path -LiteralPath $statePath -PathType Leaf) {
  $snapshot = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $status = ConvertFrom-AmSnapshotStatus -Snapshot $snapshot
  $source = 'snapshot_fallback'
} else {
  throw "run status and snapshot are missing: $RunId"
}

if ([string]$status.run_id -cne $RunId) {
  throw 'status run_id does not match requested run'
}
$lockPresent = Test-Path -LiteralPath $lockPath -PathType Leaf
$lockPidAlive = $false
if ($lockPresent) {
  $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  if ([string]$lock.run_id -cne $RunId) {
    throw 'lock run_id does not match status run_id'
  }
  if ($source -eq 'status_manifest' -and [int]$status.runner_pid -ne [int]$lock.pid) {
    throw 'status runner_pid does not match lock pid'
  }
  $lockPidAlive = $null -ne (Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue)
}

Write-Output "run_id=$RunId"
Write-Output "source=$source"
Write-Output "status_manifest_stale=$($statusManifestStale.ToString().ToLowerInvariant())"
Write-Output "status_manifest_age_seconds=$statusManifestAgeSeconds"
Write-Output "lock_present=$($lockPresent.ToString().ToLowerInvariant())"
Write-Output "lock_pid_alive=$($lockPidAlive.ToString().ToLowerInvariant())"
Write-Output "current_stage=$(Get-AmStatusProperty -Object $status -Name 'current_stage')"
Write-Output "scheduler_epoch=$(Get-AmStatusProperty -Object $status -Name 'scheduler_epoch')"
Write-Output "journal_seq=$(Get-AmStatusProperty -Object $status -Name 'journal_seq')"
Write-Output "snapshot_at=$(Get-AmStatusProperty -Object $status -Name 'snapshot_at')"
Write-Output "next_retry_at=$(Get-AmStatusProperty -Object $status -Name 'next_retry_at')"
Write-Output "acceptance_ready=$($status.coverage.acceptance_ready)"
$inFlightGaps = Get-AmStatusProperty -Object $status -Name 'in_flight_gaps'
if ($null -ne $inFlightGaps) {
  Write-Output "in_flight_gaps=$($inFlightGaps.total)"
}
foreach ($name in @(
  'summary',
  'lessons',
  'memory_consolidate_windows',
  'semantic_windows',
  'skill_extract',
  'crystal_groups',
  'consolidation_procedural_windows',
  'reflect_insight_windows'
)) {
  $stage = Get-AmStatusProperty -Object $status.coverage -Name $name
  if ($null -eq $stage) { continue }
  Write-Output (
    "stage.$name=succeeded:$($stage.succeeded),skipped:$($stage.skipped)," +
    "failed:$($stage.failed),pending:$($stage.pending),running:$($stage.running)"
  )
}

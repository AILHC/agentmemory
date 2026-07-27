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
  foreach ($line in [System.IO.File]::ReadLines($Path)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $events.Add(($line | ConvertFrom-Json))
  }
  return $events
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
  $completed = $false
  $lastSeq = -1
  $lastAt = $null
  foreach ($event in (Read-AmV2Journal -Path $Path)) {
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
    } elseif ([string]$event.type -in @(
        'unit_started',
        'unit_prepare_started',
        'unit_committing'
      )) {
      [void]$started.Add([string]$unitId)
    } elseif ([string]$event.type -eq 'unit_blocked') {
      [void]$blocked.Add([string]$unitId)
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
  $stageNames = @(
    'summary',
    'lessons',
    'memory_consolidate',
    'semantic_rollup',
    'skill_extract',
    'crystal',
    'consolidation_procedural',
    'reflect_insight'
  )
  $coverageNames = @{
    summary = 'summary'
    lessons = 'lessons'
    memory_consolidate = 'memory_consolidate_windows'
    semantic_rollup = 'semantic_windows'
    skill_extract = 'skill_extract'
    crystal = 'crystal_groups'
    consolidation_procedural = 'consolidation_procedural_windows'
    reflect_insight = 'reflect_insight_windows'
  }
  $controlPath = Join-Path $v2Root 'control.jsonl'
  $control = @(Read-AmV2Journal -Path $controlPath)
  $runStarted = @($control | Where-Object { [string]$_.type -eq 'run_started' }) |
    Select-Object -First 1
  if ($null -eq $runStarted -or
      [string]$runStarted.payload.run_id -cne $RunId) {
    throw 'v2 control journal run_id does not match requested run'
  }
  $runCompleted = $null -ne (
    @($control | Where-Object { [string]$_.type -eq 'run_completed' }) |
      Select-Object -Last 1
  )
  $openedStages = @(
    $control |
      Where-Object { [string]$_.type -eq 'stage_opened' } |
      ForEach-Object { [string]$_.payload.stage }
  )
  $facts = @{}
  $journalSeq = -1
  $snapshotAt = [string]$runStarted.at
  foreach ($stageName in $stageNames) {
    $stageFacts = Get-AmV2StageFacts -Path (Join-Path $v2Root "$stageName.jsonl")
    $facts[$stageName] = $stageFacts
    $journalSeq = [Math]::Max($journalSeq, [int]$stageFacts.last_seq)
    if ($null -ne $stageFacts.last_at -and
        [string]$stageFacts.last_at -gt $snapshotAt) {
      $snapshotAt = [string]$stageFacts.last_at
    }
  }
  $controlSeq = ($control | Measure-Object -Property seq -Maximum).Maximum
  if ($null -eq $controlSeq) { $controlSeq = -1 }
  $currentStage = $null
  foreach ($stageName in $openedStages) {
    if (-not $facts[$stageName].completed) { $currentStage = $stageName }
  }
  $required = if ([string]::IsNullOrWhiteSpace($RequiredStages)) {
    @($stageNames)
  } else {
    @(
      $RequiredStages.Split(',') |
        ForEach-Object { $_.Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
  }
  foreach ($stageName in $required) {
    if ($stageName -notin $stageNames) {
      throw "unsupported required v2 stage: $stageName"
    }
  }
  $completionReady = $true
  foreach ($stageName in $required) {
    $stageFacts = $facts[$stageName]
    if (-not $stageFacts.completed -or
        $stageFacts.failed -ne 0 -or
        $stageFacts.pending -ne 0 -or
        $stageFacts.running -ne 0 -or
        $stageFacts.blocked -ne 0) {
      $completionReady = $false
    }
  }
  if ([string]::IsNullOrWhiteSpace($RequiredStages) -and -not $runCompleted) {
    $completionReady = $false
  }
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
  $journalAgeSeconds = [Math]::Max(
    0,
    [Math]::Floor(
      ((Get-Date).ToUniversalTime() - [DateTime]::Parse($snapshotAt).ToUniversalTime()).TotalSeconds
    )
  )
  Write-Output "run_id=$RunId"
  Write-Output 'source=v2_journal'
  Write-Output 'status_manifest_stale=false'
  Write-Output "status_journal_stale=$(($journalAgeSeconds -gt $StatusStaleAfterSeconds).ToString().ToLowerInvariant())"
  Write-Output "status_journal_age_seconds=$journalAgeSeconds"
  Write-Output "lock_present=$($lockPresent.ToString().ToLowerInvariant())"
  Write-Output "lock_pid_alive=$($lockPidAlive.ToString().ToLowerInvariant())"
  Write-Output "current_stage=$currentStage"
  Write-Output 'scheduler_epoch='
  Write-Output "journal_seq=$journalSeq"
  Write-Output "control_seq=$controlSeq"
  Write-Output "snapshot_at=$snapshotAt"
  Write-Output 'next_retry_at='
  Write-Output "completion_mode=$(if ([string]::IsNullOrWhiteSpace($RequiredStages)) { 'full_run' } else { 'required_stages' })"
  Write-Output "required_stages=$($required -join ',')"
  Write-Output "acceptance_ready=$($completionReady.ToString().ToLowerInvariant())"
  foreach ($stageName in $stageNames) {
    $stageFacts = $facts[$stageName]
    if ($stageName -notin $openedStages -and
        $stageFacts.succeeded -eq 0 -and
        $stageFacts.skipped -eq 0 -and
        $stageFacts.failed -eq 0 -and
        $stageFacts.pending -eq 0 -and
        $stageFacts.running -eq 0 -and
        $stageFacts.blocked -eq 0) {
      continue
    }
    Write-Output (
      "stage.$($coverageNames[$stageName])=succeeded:$($stageFacts.succeeded)," +
      "skipped:$($stageFacts.skipped),failed:$($stageFacts.failed)," +
      "pending:$($stageFacts.pending),running:$($stageFacts.running)," +
      "blocked:$($stageFacts.blocked)"
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

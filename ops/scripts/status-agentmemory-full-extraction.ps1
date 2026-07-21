param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$RunId,
  [string]$RuntimeRoot = '',
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

$runsPath = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot 'extraction-runs'))
$statePath = [System.IO.Path]::GetFullPath((Join-Path $runsPath "$RunId.json"))
if (-not $statePath.StartsWith("$runsPath\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'run state path must stay under extraction-runs'
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

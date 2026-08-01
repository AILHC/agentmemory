param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$RunId,
  [string]$RuntimeRoot = '',
  [ValidateRange(1, 86400)]
  [int]$TimeoutSeconds = 600,
  [ValidateRange(50, 10000)]
  [int]$PollIntervalMs = 500
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

$runsPath = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot 'extraction-runs'))
$statePath = [System.IO.Path]::GetFullPath((Join-Path $runsPath "$RunId.json"))
$v2Root = [System.IO.Path]::GetFullPath((Join-Path $runsPath "$RunId.v2"))
if (-not $statePath.StartsWith("$runsPath\", [System.StringComparison]::OrdinalIgnoreCase) -or
    -not $v2Root.StartsWith("$runsPath\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'run state path must stay under extraction-runs'
}

$v1Artifacts = @(
  $statePath,
  "$statePath.lock",
  ($statePath -replace '\.json$', '.journal.jsonl'),
  ($statePath -replace '\.json$', '.status.json')
)
$hasV1 = $null -ne ($v1Artifacts | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)
$hasV2 = Test-Path -LiteralPath $v2Root -PathType Container
if ($hasV1 -and $hasV2) {
  throw 'v1 and v2 run state collision'
}

$format = if ($hasV2) { 'v2' } else { 'v1' }
$lockPath = if ($format -eq 'v2') {
  Join-Path $v2Root 'writer.lock.json'
} else {
  "$statePath.lock"
}
$requestPath = if ($format -eq 'v2') {
  Join-Path $v2Root 'drain-request.json'
} else {
  "$statePath.drain-request.json"
}
if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
  throw "active run lock is missing: $RunId"
}
if (Test-Path -LiteralPath $requestPath) {
  throw "drain request already exists: $RunId"
}

$lockRaw = Get-Content -LiteralPath $lockPath -Raw
$lock = $lockRaw | ConvertFrom-Json
if ([string]$lock.run_id -cne $RunId -or
    [string]::IsNullOrWhiteSpace([string]$lock.owner_id) -or
    [string]::IsNullOrWhiteSpace([string]$lock.created_at)) {
  throw 'run lock identity is invalid'
}
$runnerPid = 0
if (-not [int]::TryParse([string]$lock.pid, [ref]$runnerPid) -or
    -not (Get-Process -Id $runnerPid -ErrorAction SilentlyContinue)) {
  throw 'run lock PID is not alive'
}

$requestedAt = [DateTimeOffset]::UtcNow.ToString('o')
$request = if ($format -eq 'v2') {
  [ordered]@{
    format = 'agentmemory-full-extraction-drain-request/v2'
    schema_version = 2
    run_id = $RunId
    owner_id = [string]$lock.owner_id
    requested_at = $requestedAt
  }
} else {
  [ordered]@{
    run_id = $RunId
    owner_id = [string]$lock.owner_id
    requested_at = $requestedAt
  }
}
$requestJson = $request | ConvertTo-Json -Compress
$requestTemp = "$requestPath.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
try {
  [System.IO.File]::WriteAllText(
    $requestTemp,
    "$requestJson`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  if ((Get-Content -LiteralPath $lockPath -Raw) -cne $lockRaw) {
    throw 'run lock owner changed before drain request'
  }
  Move-Item -LiteralPath $requestTemp -Destination $requestPath
} catch {
  Remove-Item -LiteralPath $requestTemp -Force -ErrorAction SilentlyContinue
  throw
}
Write-Output "drain.requested run_id=$RunId format=$format pid=$runnerPid"

$deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTimeOffset]::UtcNow -lt $deadline) {
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    $completionReason = 'in_flight_gap_zero'
    if ($format -eq 'v2') {
      $projector = Join-Path $PSScriptRoot 'project-agentmemory-recovery-status.mjs'
      if (-not (Test-Path -LiteralPath $projector -PathType Leaf)) {
        Write-Output "drain.incomplete run_id=$RunId format=$format reason=status_projector_missing"
        exit 3
      }
      $rawProjection = @(& node $projector '--runtime-root' $RuntimeRoot '--run-id' $RunId)
      if ($LASTEXITCODE -ne 0) {
        Write-Output "drain.incomplete run_id=$RunId format=$format reason=status_projection_failed"
        exit 3
      }
      $projectionJson = $rawProjection -join [Environment]::NewLine
      $supportsDateKind = (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')
      $projection = if ($supportsDateKind) {
        ConvertFrom-Json -InputObject $projectionJson -DateKind String
      } else {
        ConvertFrom-Json -InputObject $projectionJson
      }
      $pausedByRequest = (
        ([string]$projection.run_status -ceq 'paused') -and
        ([string]$projection.pause_reason_code -ceq 'operator_drain_requested')
      )
      $completed = [string]$projection.run_status -ceq 'completed'
      $countFields = @('running', 'reconciling', 'system_blocked')
      $hasBoundedCounts = $null -ne $projection.counts -and
        $null -eq ($countFields | Where-Object {
          $_ -notin $projection.counts.PSObject.Properties.Name
        } | Select-Object -First 1)
      $ownerExitedWithoutInFlight = (
        $hasBoundedCounts -and
        [int]$projection.counts.running -eq 0 -and
        [int]$projection.counts.reconciling -eq 0 -and
        [int]$projection.counts.system_blocked -eq 0 -and
        [string]$projection.run_status -cnotin @('attention_required', 'blocked')
      )
      if ([string]$projection.run_id -cne $RunId -or
          (-not $pausedByRequest -and -not $completed -and -not $ownerExitedWithoutInFlight)) {
        Write-Output "drain.incomplete run_id=$RunId format=$format reason=durable_pause_missing"
        exit 3
      }
      $completionReason = if ($pausedByRequest) {
        'operator_pause_acknowledged'
      } elseif ($completed) {
        'run_completed'
      } else {
        'owner_exited_without_in_flight'
      }
    } else {
      $statusPath = $statePath -replace '\.json$', '.status.json'
      if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
        Write-Output "drain.incomplete run_id=$RunId format=$format reason=status_manifest_missing"
        exit 3
      }
      $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
      if ([string]$status.run_id -cne $RunId -or
          $null -eq $status.in_flight_gaps -or
          [int]$status.in_flight_gaps.total -ne 0) {
        Write-Output "drain.incomplete run_id=$RunId format=$format reason=in_flight_gap"
        exit 3
      }
    }
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    Write-Output "drain.completed run_id=$RunId format=$format reason=$completionReason"
    exit 0
  }
  try {
    $currentRaw = Get-Content -LiteralPath $lockPath -Raw
  } catch [System.Management.Automation.ItemNotFoundException] {
    continue
  }
  if ($currentRaw -cne $lockRaw) {
    throw 'run lock owner changed while waiting for drain'
  }
  Start-Sleep -Milliseconds $PollIntervalMs
}

Write-Output "drain.incomplete run_id=$RunId format=$format timeout_seconds=$TimeoutSeconds"
exit 3

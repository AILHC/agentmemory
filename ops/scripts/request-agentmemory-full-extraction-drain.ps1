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
if (-not $statePath.StartsWith("$runsPath\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'run state path must stay under extraction-runs'
}
$lockPath = "$statePath.lock"
$requestPath = "$statePath.drain-request.json"
if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
  throw "active run lock is missing: $RunId"
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

$request = [ordered]@{
  run_id = $RunId
  owner_id = [string]$lock.owner_id
  requested_at = (Get-Date).ToUniversalTime().ToString('o')
}
$requestJson = $request | ConvertTo-Json -Compress
$requestTemp = "$requestPath.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
[System.IO.File]::WriteAllText(
  $requestTemp,
  "$requestJson`n",
  [System.Text.UTF8Encoding]::new($false)
)
if ((Get-Content -LiteralPath $lockPath -Raw) -cne $lockRaw) {
  Remove-Item -LiteralPath $requestTemp -Force
  throw 'run lock owner changed before drain request'
}
Move-Item -LiteralPath $requestTemp -Destination $requestPath -Force
Write-Output "drain.requested run_id=$RunId pid=$runnerPid"

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    $statusPath = $statePath -replace '\.json$', '.status.json'
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
      Write-Output "drain.incomplete run_id=$RunId reason=status_manifest_missing"
      exit 3
    }
    $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    if ([string]$status.run_id -cne $RunId -or
        $null -eq $status.in_flight_gaps -or
        [int]$status.in_flight_gaps.total -ne 0) {
      Write-Output "drain.incomplete run_id=$RunId reason=in_flight_gap"
      exit 3
    }
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    Write-Output "drain.completed run_id=$RunId"
    exit 0
  }
  $currentRaw = Get-Content -LiteralPath $lockPath -Raw
  if ($currentRaw -cne $lockRaw) {
    throw 'run lock owner changed while waiting for drain'
  }
  Start-Sleep -Milliseconds $PollIntervalMs
}

Write-Output "drain.incomplete run_id=$RunId timeout_seconds=$TimeoutSeconds"
exit 3

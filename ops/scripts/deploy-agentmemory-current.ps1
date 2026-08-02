param(
  [string]$RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')),
  [string]$RuntimeRoot = '',
  [switch]$KeepStopped,
  [switch]$ConfirmAutomationPaused
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $RuntimeRoot = if ($env:AGENTMEMORY_RUNTIME_ROOT) {
    [System.IO.Path]::GetFullPath($env:AGENTMEMORY_RUNTIME_ROOT)
  } else {
    'F:\ai-runtime\agentmemory'
  }
}

function Get-AmDeploymentFullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-AmDeploymentChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $fullPath = Get-AmDeploymentFullPath $Path
  $fullParent = Get-AmDeploymentFullPath $Parent
  if (-not $fullParent.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $fullParent += [System.IO.Path]::DirectorySeparatorChar
  }
  if (-not $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Name must stay under '$Parent'."
  }
}

function Test-AmDeploymentLockOwnerAlive {
  param([Parameter(Mandatory = $true)]$Record)
  $pidValue = 0
  if (-not [int]::TryParse([string]$Record.pid, [ref]$pidValue) -or $pidValue -le 0) {
    return $false
  }
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  try {
    $actual = $process.StartTime.ToUniversalTime()
    $expected = [datetime]::Parse(
      [string]$Record.startedAt,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
    return [math]::Abs(($actual - $expected).TotalSeconds) -le 1
  } catch {
    return $false
  }
}

function Enter-AmDeploymentLock {
  param([Parameter(Mandatory = $true)][string]$LockPath)
  $lockFullPath = Get-AmDeploymentFullPath $LockPath
  New-Item -ItemType Directory -Path (Split-Path -Parent $lockFullPath) -Force | Out-Null

  if (Test-Path -LiteralPath $lockFullPath -PathType Leaf) {
    $record = $null
    try { $record = Get-Content -LiteralPath $lockFullPath -Raw | ConvertFrom-Json } catch {}
    if ($record -and (Test-AmDeploymentLockOwnerAlive -Record $record)) {
      throw "deployment lock is active: pid=$($record.pid)"
    }
    $stalePath = "$lockFullPath.stale-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item -LiteralPath $lockFullPath -Destination $stalePath
  }

  $ownerId = [guid]::NewGuid().ToString('N')
  $process = [System.Diagnostics.Process]::GetCurrentProcess()
  $record = [ordered]@{
    schemaVersion = 1
    ownerId = $ownerId
    pid = $process.Id
    startedAt = $process.StartTime.ToUniversalTime().ToString('o')
    acquiredAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $json = $record | ConvertTo-Json -Compress
  try {
    $stream = [System.IO.File]::Open(
      $lockFullPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
    try {
      $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
      $stream.Write($bytes, 0, $bytes.Length)
    } finally {
      $stream.Dispose()
    }
  } catch [System.IO.IOException] {
    throw 'deployment lock is active'
  }

  return [pscustomobject]@{
    LockPath = $lockFullPath
    OwnerId = $ownerId
  }
}

function Exit-AmDeploymentLock {
  param([Parameter(Mandatory = $true)]$Lock)
  if (-not (Test-Path -LiteralPath $Lock.LockPath -PathType Leaf)) { return $false }
  try {
    $record = Get-Content -LiteralPath $Lock.LockPath -Raw | ConvertFrom-Json
    if ([string]$record.ownerId -cne [string]$Lock.OwnerId) { return $false }
    Remove-Item -LiteralPath $Lock.LockPath -Force
    return $true
  } catch {
    return $false
  }
}

function Assert-AmNoExtractionLocks {
  param([Parameter(Mandatory = $true)][string]$ExtractionRunsPath)
  if (-not (Test-Path -LiteralPath $ExtractionRunsPath -PathType Container)) { return }
  $locks = @(Get-ChildItem `
    -LiteralPath $ExtractionRunsPath -Recurse -Force -File -ErrorAction Stop |
      Where-Object {
        $_.Name -like '*.lock' -or $_.Name -like '*.lock.json'
      })
  if ($locks.Count -gt 0) {
    throw "full extraction lock exists: $($locks[0].FullName)"
  }
}

function Assert-AmNoExtractionControlRequests {
  param([Parameter(Mandatory = $true)][string]$ExtractionRunsPath)
  if (-not (Test-Path -LiteralPath $ExtractionRunsPath -PathType Container)) { return }
  $requests = @(Get-ChildItem `
    -LiteralPath $ExtractionRunsPath -Recurse -Force -File -ErrorAction Stop |
      Where-Object { $_.Name -like '*.drain-request.json' })
  if ($requests.Count -gt 0) {
    throw "full extraction control request exists: $($requests[0].FullName)"
  }
}

function Assert-AmDeploymentModeArguments {
  param(
    [switch]$KeepStopped,
    [switch]$ConfirmAutomationPaused
  )
  if ($KeepStopped -and -not $ConfirmAutomationPaused) {
    throw '-KeepStopped requires -ConfirmAutomationPaused.'
  }
  if (-not $KeepStopped -and $ConfirmAutomationPaused) {
    throw '-ConfirmAutomationPaused is valid only with -KeepStopped.'
  }
}

function Get-AmDeploymentService {
  return Get-Service -Name 'agentmemory' -ErrorAction Stop
}

function Assert-AmKeepStoppedServiceState {
  param([Parameter(Mandatory = $true)]$Service)
  $stateProperty = $Service.PSObject.Properties['Status']
  if (-not $stateProperty) {
    $stateProperty = $Service.PSObject.Properties['State']
  }
  $startTypeProperty = $Service.PSObject.Properties['StartType']
  if (-not $stateProperty -or -not $startTypeProperty) {
    throw 'keep-stopped service state is unavailable.'
  }
  if ([string]$stateProperty.Value -ne 'Stopped') {
    throw "keep-stopped deployment requires service Stopped, got '$($stateProperty.Value)'."
  }
  if ([string]$startTypeProperty.Value -ne 'Disabled') {
    throw "keep-stopped deployment requires service Disabled, got '$($startTypeProperty.Value)'."
  }
}

function Invoke-AmStoppedDeploymentDoctor {
  param([Parameter(Mandatory = $true)][string]$CurrentPath)
  $doctor = Join-Path $CurrentPath 'scripts\doctor-agentmemory-console.ps1'
  if (-not (Test-Path -LiteralPath $doctor -PathType Leaf)) {
    throw "stopped deployment doctor is missing: $doctor"
  }
  Invoke-AmDeploymentCommand -FilePath 'pwsh.exe' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $doctor,
    '-ExpectedState', 'Stopped'
  )
}

function Assert-AmKeepStoppedPreconditions {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentPath,
    [Parameter(Mandatory = $true)][string]$ExtractionRunsPath,
    [switch]$ConfirmAutomationPaused
  )
  if (-not $ConfirmAutomationPaused) {
    throw 'keep-stopped deployment requires a paused automation confirmation.'
  }
  Assert-AmKeepStoppedServiceState -Service (Get-AmDeploymentService)
  Assert-AmNoExtractionLocks -ExtractionRunsPath $ExtractionRunsPath
  Assert-AmNoExtractionControlRequests -ExtractionRunsPath $ExtractionRunsPath
  Invoke-AmStoppedDeploymentDoctor -CurrentPath $CurrentPath
}

function Assert-AmCurrentSourceCommit {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentPath,
    [Parameter(Mandatory = $true)][string]$SourceCommit
  )
  $manifestPath = Join-Path $CurrentPath 'DEPLOYMENT.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "deployment manifest is missing: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ([string]$manifest.sourceCommit -cne $SourceCommit) {
    throw 'deployed source commit does not match the prepared source commit.'
  }
}

function Switch-AmCurrentDirectories {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentPath,
    [Parameter(Mandatory = $true)][string]$NewPath,
    [Parameter(Mandatory = $true)][string]$PreviousPath,
    [scriptblock]$AfterCurrentMoved
  )
  if (-not (Test-Path -LiteralPath $CurrentPath -PathType Container)) {
    throw "current directory is missing: $CurrentPath"
  }
  if (-not (Test-Path -LiteralPath $NewPath -PathType Container)) {
    throw "new current directory is missing: $NewPath"
  }
  if (Test-Path -LiteralPath $PreviousPath) {
    throw "previous directory already exists: $PreviousPath"
  }

  Move-Item -LiteralPath $CurrentPath -Destination $PreviousPath
  try {
    if ($AfterCurrentMoved) { & $AfterCurrentMoved }
    Move-Item -LiteralPath $NewPath -Destination $CurrentPath
  } catch {
    if ((Test-Path -LiteralPath $PreviousPath -PathType Container) -and
        -not (Test-Path -LiteralPath $CurrentPath)) {
      Move-Item -LiteralPath $PreviousPath -Destination $CurrentPath
    }
    throw
  }
}

function Restore-AmPreviousCurrent {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentPath,
    [Parameter(Mandatory = $true)][string]$PreviousPath
  )
  if (-not (Test-Path -LiteralPath $PreviousPath -PathType Container)) {
    throw "previous directory is missing: $PreviousPath"
  }
  $failedPath = "$CurrentPath.failed-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  if (Test-Path -LiteralPath $CurrentPath -PathType Container) {
    Move-Item -LiteralPath $CurrentPath -Destination $failedPath
  }
  Move-Item -LiteralPath $PreviousPath -Destination $CurrentPath
  return $failedPath
}

function Update-AmServiceConfigForCurrent {
  param(
    [Parameter(Mandatory = $true)][string]$ServiceConfigPath,
    [Parameter(Mandatory = $true)][string]$CurrentPath
  )
  if (-not (Test-Path -LiteralPath $ServiceConfigPath -PathType Leaf)) {
    throw "service config is missing: $ServiceConfigPath"
  }
  $backupPath = "$ServiceConfigPath.pre-current-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
  Copy-Item -LiteralPath $ServiceConfigPath -Destination $backupPath
  try {
    [xml]$config = Get-Content -LiteralPath $ServiceConfigPath -Raw
    $workingDirectories = @($config.SelectNodes('/service/workingdirectory'))
    if ($workingDirectories.Count -ne 1) {
      throw 'service config must contain exactly one workingdirectory.'
    }
    $workingDirectories[0].InnerText = $CurrentPath

    $stopArguments = @($config.SelectNodes('/service/stopargument') | Where-Object {
      $_.InnerText -match 'stop-agentmemory-service-hook\.ps1$'
    })
    if ($stopArguments.Count -ne 1) {
      throw 'service config must contain exactly one AgentMemory stop hook argument.'
    }
    $stopArguments[0].InnerText = Join-Path $CurrentPath 'scripts\stop-agentmemory-service-hook.ps1'
    $config.Save($ServiceConfigPath)
    return $backupPath
  } catch {
    Copy-Item -LiteralPath $backupPath -Destination $ServiceConfigPath -Force
    throw
  }
}

function Move-AmLegacyScriptsToArchive {
  param([Parameter(Mandatory = $true)][string]$Runtime)
  $legacyPath = Join-Path $Runtime 'scripts'
  if (-not (Test-Path -LiteralPath $legacyPath -PathType Container)) { return $null }
  Assert-AmDeploymentChildPath -Path $legacyPath -Parent $Runtime -Name 'legacy scripts'
  $backupRoot = Join-Path $Runtime 'backups'
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  $archivePath = Join-Path $backupRoot "legacy-scripts-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Assert-AmDeploymentChildPath -Path $archivePath -Parent $backupRoot -Name 'legacy scripts archive'
  Move-Item -LiteralPath $legacyPath -Destination $archivePath
  return $archivePath
}

function Restore-AmLegacyScriptsArchive {
  param(
    [Parameter(Mandatory = $true)][string]$Runtime,
    [Parameter(Mandatory = $true)][string]$ArchivePath
  )
  $legacyPath = Join-Path $Runtime 'scripts'
  if ((Test-Path -LiteralPath $ArchivePath -PathType Container) -and
      -not (Test-Path -LiteralPath $legacyPath)) {
    Move-Item -LiteralPath $ArchivePath -Destination $legacyPath
  }
}

function Invoke-AmDeploymentCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [string]$WorkingDirectory
  )
  if ($WorkingDirectory) {
    Push-Location -LiteralPath $WorkingDirectory
  }
  try {
    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
  } finally {
    if ($WorkingDirectory) {
      Pop-Location
    }
  }
  if ($exitCode -ne 0) {
    throw "command failed with exit code ${exitCode}: $FilePath"
  }
}

function Resolve-AmGitCommit {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Commit
  )
  $output = @(& git -C $Repo rev-parse "$Commit`^{commit}" 2>$null)
  $exitCode = $LASTEXITCODE
  $resolved = [string]($output | Select-Object -First 1)
  $resolved = $resolved.Trim()
  if ($exitCode -ne 0 -or $resolved -notmatch '^[0-9a-f]{40}$') {
    throw "cannot resolve Git commit '$Commit' in '$Repo'."
  }
  return $resolved
}

function Assert-AmReleaseInputsCommitted {
  param([Parameter(Mandatory = $true)][string]$Repo)
  $status = @(& git -C $Repo status --porcelain --untracked-files=all -- `
    ops/deployment-package-lock.json `
    ops/scripts)
  if ($LASTEXITCODE -ne 0) { throw 'cannot inspect release input status.' }
  if ($status.Count -gt 0) {
    throw 'release input paths contain uncommitted changes.'
  }
}

function Export-AmGitTree {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Commit,
    [string[]]$Paths = @(),
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$ArchivePath
  )
  $arguments = @('-C', $Repo, 'archive', '--format=tar', "--output=$ArchivePath", $Commit)
  $arguments += $Paths
  Invoke-AmDeploymentCommand -FilePath 'git.exe' -ArgumentList $arguments
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Invoke-AmDeploymentCommand -FilePath 'tar.exe' -ArgumentList @('-xf', $ArchivePath, '-C', $Destination)
}

function Copy-AmReleaseScripts {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $required = @(
    '_agentmemory-local-common.ps1',
    'agentmemory-deployment-manifest.mjs',
    'extraction-model-contracts-v1.json',
    'validate-agentmemory-worker-supervision.mjs',
    'start-agentmemory-console.ps1',
    'stop-agentmemory-console.ps1',
    'doctor-agentmemory-console.ps1',
    'stop-agentmemory-service-hook.ps1',
    'start-agentmemory.ps1',
    'stop-agentmemory.ps1',
    'doctor-agentmemory.ps1',
    'request-agentmemory-full-extraction-drain.ps1',
    'authorize-agentmemory-lessons-failed-terminal-retry.mjs',
    'create-agentmemory-recovery-evidence-snapshot.mjs',
    'migrate-agentmemory-recovery-frontier.mjs',
    'project-agentmemory-recovery-status.mjs',
    'preview-agentmemory-adopted-baseline.mjs',
    'apply-agentmemory-adopted-baseline.mjs',
    'status-agentmemory-full-extraction.ps1',
    'run-agentmemory-cli-import-batch.mjs',
    'run-agentmemory-full-extraction.mjs'
  )
  foreach ($name in $required) {
    $sourcePath = Join-Path $Source $name
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "required release script is missing: $name"
    }
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $Destination $name)
  }

  $sourceLib = Join-Path $Source 'lib'
  $destinationLib = Join-Path $Destination 'lib'
  $requiredLib = @(
    'adaptive-provider-limiter.mjs',
    'consolidation-procedural-recovery-adapter-v1.mjs',
    'crystal-recovery-adapter-v1.mjs',
    'effect-state-recovery-stage-catalog-v1.mjs',
    'full-extraction-stage-adapters-v2.mjs',
    'iii-state-read-only-adapter-v1.mjs',
    'incremental-extraction-status-v1.mjs',
    'legacy-lesson-safe-facts-collector-v1.mjs',
    'lesson-recovery-adapter-v1.mjs',
    'offline-statekv-snapshot-v1.mjs',
    'reflect-insight-recovery-adapter-v1.mjs',
    'recoverable-stage-v2.mjs',
    'recovery-journal-reducer-v1.mjs',
    'recovery-frontier-migration-v1.mjs',
    'recovery-migration-contract-v1.mjs',
    'recovery-policy-v1.mjs',
    'recovery-status-projection-v1.mjs',
    'run-state-journal-v2.mjs',
    'run-state-store.mjs',
    'safe-stage-recovery-adapters-v1.mjs',
    'semantic-rollup-recovery-adapter-v1.mjs',
    'stage-pipeline.mjs',
    'summary-recovery-adapter-v1.mjs',
    'v2-release-gate.mjs'
  )
  New-Item -ItemType Directory -Path $destinationLib -Force | Out-Null
  foreach ($name in $requiredLib) {
    $sourcePath = Join-Path $sourceLib $name
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "required release script library is missing: lib\$name"
    }
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $destinationLib $name)
  }
}

function Copy-AmDeploymentPackageLock {
  param(
    [Parameter(Mandatory = $true)][string]$SourceExport,
    [Parameter(Mandatory = $true)][string]$AppSource
  )
  $source = Join-Path $SourceExport 'ops\deployment-package-lock.json'
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw 'versioned AgentMemory deployment package lock is missing.'
  }
  Copy-Item -LiteralPath $source -Destination (Join-Path $AppSource 'package-lock.json')
}

function Prepare-AmCurrent {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Runtime,
    [Parameter(Mandatory = $true)][string]$Commit
  )
  Assert-AmReleaseInputsCommitted -Repo $Repo
  $sourceCommit = Resolve-AmGitCommit -Repo $Repo -Commit $Commit

  $appRoot = Join-Path $Runtime 'app'
  $currentNew = Join-Path $appRoot 'current.new'
  Assert-AmDeploymentChildPath -Path $currentNew -Parent $appRoot -Name 'current.new'
  if (Test-Path -LiteralPath $currentNew) {
    Remove-Item -LiteralPath $currentNew -Recurse -Force
  }

  $buildRoot = Join-Path (Join-Path $Runtime 'tmp') "agentmemory-build-$([guid]::NewGuid().ToString('N'))"
  Assert-AmDeploymentChildPath -Path $buildRoot -Parent (Join-Path $Runtime 'tmp') -Name 'build root'
  New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
  try {
    $appSource = Join-Path $buildRoot 'agentmemory'
    Export-AmGitTree `
      -Repo $Repo -Commit $sourceCommit `
      -Destination $appSource -ArchivePath (Join-Path $buildRoot 'agentmemory.tar')

    Copy-AmDeploymentPackageLock -SourceExport $appSource -AppSource $appSource
    Invoke-AmDeploymentCommand -FilePath 'npm.cmd' -ArgumentList @('ci') -WorkingDirectory $appSource
    Invoke-AmDeploymentCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'build') -WorkingDirectory $appSource
    Invoke-AmDeploymentCommand -FilePath 'npm.cmd' -ArgumentList @('prune', '--omit=dev') -WorkingDirectory $appSource

    New-Item -ItemType Directory -Path $currentNew -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $appSource 'dist') -Destination (Join-Path $currentNew 'dist') -Recurse
    Copy-Item -LiteralPath (Join-Path $appSource 'node_modules') -Destination (Join-Path $currentNew 'node_modules') -Recurse
    Copy-Item -LiteralPath (Join-Path $appSource 'package.json') -Destination $currentNew
    Copy-Item -LiteralPath (Join-Path $appSource 'package-lock.json') -Destination $currentNew
    Copy-AmReleaseScripts `
      -Source (Join-Path $appSource 'ops\scripts') `
      -Destination (Join-Path $currentNew 'scripts')
    $configTemplate = Join-Path $currentNew 'config-template'
    New-Item -ItemType Directory -Path $configTemplate -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $appSource 'iii-config.yaml') -Destination $configTemplate
    if (Test-Path -LiteralPath (Join-Path $appSource '.env.example') -PathType Leaf) {
      Copy-Item -LiteralPath (Join-Path $appSource '.env.example') -Destination $configTemplate
    }

    $manifestScript = Join-Path $currentNew 'scripts\agentmemory-deployment-manifest.mjs'
    Invoke-AmDeploymentCommand -FilePath 'node.exe' -ArgumentList @(
      $manifestScript,
      'create',
      '--root', $currentNew,
      '--source-commit', $sourceCommit
    )
    Invoke-AmDeploymentCommand -FilePath 'node.exe' -ArgumentList @(
      $manifestScript,
      'verify',
      '--root', $currentNew
    )
    Write-Output "deployment.prepared=$currentNew"
    Write-Output "deployment.sourceCommit=$sourceCommit"
  } finally {
    if (Test-Path -LiteralPath $buildRoot) {
      Remove-Item -LiteralPath $buildRoot -Recurse -Force
    }
  }
}

function Invoke-AmCurrentManifestVerification {
  param([Parameter(Mandatory = $true)][string]$CurrentPath)
  $manifestScript = Join-Path $CurrentPath 'scripts\agentmemory-deployment-manifest.mjs'
  if (-not (Test-Path -LiteralPath $manifestScript -PathType Leaf)) {
    throw "manifest verifier is missing: $manifestScript"
  }
  Invoke-AmDeploymentCommand -FilePath 'node.exe' -ArgumentList @(
    $manifestScript,
    'verify',
    '--root', $CurrentPath
  )
}

function Test-AmPreparedCurrent {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentPath,
    [Parameter(Mandatory = $true)][string]$SourceCommit
  )
  $manifestPath = Join-Path $CurrentPath 'DEPLOYMENT.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $false }
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([string]$manifest.sourceCommit -cne $SourceCommit) { return $false }
    Invoke-AmCurrentManifestVerification -CurrentPath $CurrentPath
    return $true
  } catch {
    return $false
  }
}

function Stop-AmDeploymentRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedOwner,
    [Parameter(Mandatory = $true)][string]$CurrentPath,
    [Parameter(Mandatory = $true)][string]$RepoScripts,
    [Parameter(Mandatory = $true)][string]$Runtime
  )
  if ($SelectedOwner -eq 'Service') {
    $serviceExe = Join-Path $Runtime 'service\agentmemory.exe'
    Invoke-AmDeploymentCommand -FilePath $serviceExe -ArgumentList @('stop')
    return
  }
  $stopScript = Join-Path $CurrentPath 'scripts\stop-agentmemory-console.ps1'
  if (-not (Test-Path -LiteralPath $stopScript -PathType Leaf)) {
    $stopScript = Join-Path $RepoScripts 'stop-agentmemory-console.ps1'
  }
  Invoke-AmDeploymentCommand -FilePath 'pwsh.exe' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $stopScript
  )
}

function Start-AmDeploymentRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedOwner,
    [Parameter(Mandatory = $true)][string]$CurrentPath,
    [Parameter(Mandatory = $true)][string]$Runtime
  )
  if ($SelectedOwner -eq 'Service') {
    $serviceExe = Join-Path $Runtime 'service\agentmemory.exe'
    Invoke-AmDeploymentCommand -FilePath $serviceExe -ArgumentList @('start')
    return $null
  }
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  return Start-Process `
    -FilePath 'pwsh.exe' `
    -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      (Join-Path $CurrentPath 'scripts\start-agentmemory-console.ps1'),
      '-DeploymentAuthorized'
    ) `
    -WorkingDirectory $CurrentPath `
    -RedirectStandardOutput (Join-Path $Runtime "logs\agentmemory-console-$timestamp.out.log") `
    -RedirectStandardError (Join-Path $Runtime "logs\agentmemory-console-$timestamp.err.log") `
    -WindowStyle Hidden `
    -PassThru
}

function Invoke-AmDeploymentDoctor {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedOwner,
    [Parameter(Mandatory = $true)][string]$CurrentPath
  )
  $doctorName = if ($SelectedOwner -eq 'Service') {
    'doctor-agentmemory.ps1'
  } else {
    'doctor-agentmemory-console.ps1'
  }
  $doctor = Join-Path $CurrentPath "scripts\$doctorName"
  $deadline = (Get-Date).AddSeconds(60)
  do {
    & pwsh.exe -NoProfile -ExecutionPolicy Bypass -File $doctor -ExpectedState Running
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw 'AgentMemory doctor did not become healthy after deployment.'
}

function Resolve-AmDeploymentOwner {
  param([AllowNull()]$Service)
  if (-not $Service) {
    return 'Console'
  }
  $stateProperty = $Service.PSObject.Properties['Status']
  if (-not $stateProperty) {
    $stateProperty = $Service.PSObject.Properties['State']
  }
  if (-not $stateProperty) {
    throw 'service state is unavailable'
  }
  if ([string]$stateProperty.Value -ne 'Stopped') {
    return 'Service'
  }
  return 'Console'
}

function Invoke-AmDeployment {
  param(
    [switch]$KeepStopped,
    [switch]$ConfirmAutomationPaused
  )
  Assert-AmDeploymentModeArguments `
    -KeepStopped:$KeepStopped `
    -ConfirmAutomationPaused:$ConfirmAutomationPaused
  $appRoot = Join-Path $RuntimeRoot 'app'
  $current = Join-Path $appRoot 'current'
  $currentNew = Join-Path $appRoot 'current.new'
  $currentPrevious = Join-Path $appRoot 'current.previous'
  $lockPath = Join-Path $RuntimeRoot 'tmp\deploy-current.lock.json'
  $repoScripts = Join-Path $RepositoryRoot 'ops\scripts'
  $extractionRuns = Join-Path $RuntimeRoot 'extraction-runs'
  foreach ($item in @(
    @{ Path = $current; Name = 'current' },
    @{ Path = $currentNew; Name = 'current.new' },
    @{ Path = $currentPrevious; Name = 'current.previous' }
  )) {
    Assert-AmDeploymentChildPath -Path $item.Path -Parent $appRoot -Name $item.Name
  }

  $deploymentLock = Enter-AmDeploymentLock -LockPath $lockPath
  $switched = $false
  $restored = $false
  $serviceConfigBackup = $null
  $legacyScriptsArchive = $null
  try {
    $sourceCommit = Resolve-AmGitCommit -Repo $RepositoryRoot -Commit 'HEAD'
    $owner = Resolve-AmDeploymentOwner -Service (
      Get-AmDeploymentService
    )
    Write-Output "deployment.sourceCommit=$sourceCommit"
    Write-Output "deployment.owner=$owner"
    Write-Output "deployment.keepStopped=$(([bool]$KeepStopped).ToString().ToLowerInvariant())"
    if ($KeepStopped) {
      Assert-AmKeepStoppedPreconditions `
        -CurrentPath $current -ExtractionRunsPath $extractionRuns `
        -ConfirmAutomationPaused:$ConfirmAutomationPaused
    } else {
      Assert-AmNoExtractionLocks -ExtractionRunsPath $extractionRuns
    }
    if (Test-AmPreparedCurrent -CurrentPath $currentNew -SourceCommit $sourceCommit) {
      Write-Output "deployment.prepared=reused"
    } else {
      Prepare-AmCurrent -Repo $RepositoryRoot -Runtime $RuntimeRoot -Commit $sourceCommit
      Invoke-AmCurrentManifestVerification -CurrentPath $currentNew
    }
    if ($KeepStopped) {
      Assert-AmKeepStoppedPreconditions `
        -CurrentPath $current -ExtractionRunsPath $extractionRuns `
        -ConfirmAutomationPaused:$ConfirmAutomationPaused
    } else {
      Stop-AmDeploymentRuntime `
        -SelectedOwner $owner -CurrentPath $current -RepoScripts $repoScripts -Runtime $RuntimeRoot
      Assert-AmNoExtractionLocks -ExtractionRunsPath $extractionRuns
    }
    if (Test-Path -LiteralPath $currentPrevious) {
      throw "previous deployment directory already exists: $currentPrevious"
    }
    Switch-AmCurrentDirectories `
      -CurrentPath $current -NewPath $currentNew -PreviousPath $currentPrevious
    $switched = $true
    $serviceConfigBackup = Update-AmServiceConfigForCurrent `
      -ServiceConfigPath (Join-Path $RuntimeRoot 'service\agentmemory.xml') `
      -CurrentPath $current
    if ($KeepStopped) {
      Assert-AmKeepStoppedPreconditions `
        -CurrentPath $current -ExtractionRunsPath $extractionRuns `
        -ConfirmAutomationPaused:$ConfirmAutomationPaused
    } else {
      [void](Start-AmDeploymentRuntime -SelectedOwner $owner -CurrentPath $current -Runtime $RuntimeRoot)
      Invoke-AmDeploymentDoctor -SelectedOwner $owner -CurrentPath $current
    }
    Invoke-AmCurrentManifestVerification -CurrentPath $current
    Assert-AmCurrentSourceCommit -CurrentPath $current -SourceCommit $sourceCommit
    $legacyScriptsArchive = Move-AmLegacyScriptsToArchive -Runtime $RuntimeRoot
    Remove-Item -LiteralPath $currentPrevious -Recurse -Force
    $switched = $false
    Write-Output 'deployment.result=success'
  } catch {
    $deploymentError = $_
    if ($legacyScriptsArchive) {
      Restore-AmLegacyScriptsArchive -Runtime $RuntimeRoot -ArchivePath $legacyScriptsArchive
    }
    if ($serviceConfigBackup -and (Test-Path -LiteralPath $serviceConfigBackup -PathType Leaf)) {
      Copy-Item `
        -LiteralPath $serviceConfigBackup `
        -Destination (Join-Path $RuntimeRoot 'service\agentmemory.xml') `
        -Force
    }
    if ($switched -and (Test-Path -LiteralPath $currentPrevious -PathType Container)) {
      if (-not $KeepStopped) {
        try {
          Stop-AmDeploymentRuntime `
            -SelectedOwner $owner -CurrentPath $current -RepoScripts $repoScripts -Runtime $RuntimeRoot
        } catch {}
      }
      [void](Restore-AmPreviousCurrent -CurrentPath $current -PreviousPath $currentPrevious)
      $restored = $true
      if (-not $KeepStopped) {
        try {
          [void](Start-AmDeploymentRuntime -SelectedOwner $owner -CurrentPath $current -Runtime $RuntimeRoot)
        } catch {}
      }
    }
    if ($KeepStopped -and $restored) {
      try {
        Assert-AmKeepStoppedPreconditions `
          -CurrentPath $current -ExtractionRunsPath $extractionRuns `
          -ConfirmAutomationPaused:$ConfirmAutomationPaused
      } catch {
        throw "deployment failed: $($deploymentError.Exception.Message); keep-stopped rollback invariant failed: $($_.Exception.Message)"
      }
    }
    throw
  } finally {
    [void](Exit-AmDeploymentLock -Lock $deploymentLock)
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-AmDeployment `
    -KeepStopped:$KeepStopped `
    -ConfirmAutomationPaused:$ConfirmAutomationPaused
}

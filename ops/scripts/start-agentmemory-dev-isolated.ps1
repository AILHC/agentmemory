$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. "$PSScriptRoot\_agentmemory-local-common.ps1"

$DevRestPort = 3211
$DevStreamPort = 3212
$DevViewerPort = 3213
$DevEnginePort = 49234

Assert-AmRequiredDirectory -Path $script:AmFormalRoot -Name 'formal runtime root'
Assert-AmRequiredDirectory -Path $script:AmFormalInstall -Name 'formal AGENTMEMORY_INSTALL_HOME'
Assert-AmRequiredDirectory -Path $script:AmDevApp -Name 'repository AgentMemory app'
Assert-AmRequiredFile -Path $script:AmIiiExe -Name 'formal iii.exe'
Assert-AmRequiredFile -Path (Join-Path $script:AmDevApp 'dist\index.mjs') -Name 'repository AgentMemory worker'
Assert-AmRequiredFile -Path (Join-Path $script:AmDevApp 'dist\worker-supervisor.mjs') -Name 'repository AgentMemory worker supervisor'

if (Test-AmSamePath -Left $script:AmDevHome -Right $script:AmFormalHome) {
  throw 'Refusing dev isolated start: DevHome equals formal AGENTMEMORY_HOME.'
}
if (Test-AmSamePath -Left $script:AmDevConfig -Right $script:AmFormalConfig) {
  throw 'Refusing dev isolated start: DevConfig equals formal AGENTMEMORY_III_CONFIG.'
}
Assert-AmPathInside -Path $script:AmDevHome -Root $script:AmDevRoot -Name 'DevHome'
Assert-AmPathInside -Path $script:AmDevLogs -Root $script:AmDevRoot -Name 'DevLogs'
Assert-AmPathInside -Path $script:AmDevRun -Root $script:AmDevRoot -Name 'DevRun'
Assert-AmPathInside -Path $script:AmDevTmp -Root $script:AmDevRoot -Name 'DevTmp'
Assert-AmPathInside -Path $script:AmDevConfig -Root $script:AmDevRoot -Name 'DevConfig'

if (Test-Path -LiteralPath $script:AmDevConfig -PathType Leaf) {
  if (Test-AmConfigContainsText -ConfigPath $script:AmDevConfig -Text ((Join-Path $script:AmFormalHome 'data').Replace('\', '/'))) {
    throw 'Refusing dev isolated start: existing dev iii-config.yaml points at formal state path.'
  }
}

$listeners = @(Get-AmListeners -Ports $script:AmDevPorts)
if ($listeners.Count -gt 0) {
  $details = ($listeners | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid=$($_.OwningProcess)" }) -join '; '
  throw "Refusing dev isolated start: dev AgentMemory ports are already occupied: $details"
}

New-Item -ItemType Directory -Path $script:AmDevHome -Force | Out-Null
New-Item -ItemType Directory -Path $script:AmDevLogs -Force | Out-Null
New-Item -ItemType Directory -Path $script:AmDevRun -Force | Out-Null
New-Item -ItemType Directory -Path $script:AmDevTmp -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $script:AmDevHome 'data') -Force | Out-Null

Assert-AmInstanceStartReady -InstanceHome $script:AmDevHome -InstanceId 'dev-isolated' -AppDirectory $script:AmDevApp

$devSupervisorEntry = (Join-Path $script:AmDevApp 'dist\worker-supervisor.mjs').Replace('\', '/')
$devWorkerEntry = (Join-Path $script:AmDevApp 'dist\index.mjs').Replace('\', '/')

$devConfigText = @"
workers:
  - name: iii-worker-manager
    config:
      host: 0.0.0.0
      port: $DevEnginePort
  - name: iii-http
    config:
      port: $DevRestPort
      host: 127.0.0.1
      default_timeout: 180000
      cors:
        allowed_origins: ["http://localhost:$DevRestPort", "http://localhost:$DevViewerPort", "http://127.0.0.1:$DevRestPort", "http://127.0.0.1:$DevViewerPort"]
        allowed_methods: [GET, POST, PUT, DELETE, OPTIONS]
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: $script:AmDevStatePath
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
      port: $DevStreamPort
      host: 127.0.0.1
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: $script:AmDevStreamPath
  - name: iii-observability
    config:
      enabled: true
      service_name: agentmemory-dev
      exporter: memory
      sampling_ratio: 0.1
      metrics_enabled: true
      logs_enabled: true
      logs_console_output: false
  - name: iii-exec
    config:
      exec:
        - node $devSupervisorEntry --instance-id dev-isolated --worker-entry $devWorkerEntry
"@

Set-Content -LiteralPath $script:AmDevConfig -Value $devConfigText -Encoding UTF8

$workerPort = Get-AmWorkerPortFromConfig -ConfigPath $script:AmDevConfig -WorkerName 'iii-worker-manager'
if ($workerPort -ne $DevEnginePort) {
  throw "Refusing dev isolated start: iii-worker-manager port must be $DevEnginePort, got '$workerPort'."
}
if (Test-AmConfigContainsText -ConfigPath $script:AmDevConfig -Text ((Join-Path $script:AmFormalHome 'data').Replace('\', '/'))) {
  throw 'Refusing dev isolated start: generated dev config points at formal state path.'
}
Invoke-AmWorkerSupervisionValidation `
  -ConfigPath $script:AmDevConfig `
  -AppDirectory $script:AmDevApp `
  -InstanceId 'dev-isolated' `
  -ExpectedStatePath $script:AmDevStatePath `
  -ExpectedStreamPath $script:AmDevStreamPath

$env:AGENTMEMORY_HOME = $script:AmDevHome
$env:AGENTMEMORY_INSTALL_HOME = $script:AmFormalInstall
$env:AGENTMEMORY_III_CONFIG = $script:AmDevConfig
$env:III_REST_PORT = [string]$DevRestPort
$env:III_STREAM_PORT = [string]$DevStreamPort
$env:III_VIEWER_PORT = [string]$DevViewerPort
$env:III_ENGINE_URL = "ws://localhost:$DevEnginePort"
$env:AGENTMEMORY_URL = "http://localhost:$DevRestPort"
$env:AGENTMEMORY_OUTPUT_LANGUAGE = 'zh-CN'
$env:TEMP = $script:AmDevTmp
$env:TMP = $script:AmDevTmp
$env:npm_config_cache = Join-Path $script:AmFormalRoot 'cache\npm'
$env:CI = '1'

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutLog = Join-Path $script:AmDevLogs "agentmemory-dev-$timestamp.out.log"
$stderrLog = Join-Path $script:AmDevLogs "agentmemory-dev-$timestamp.err.log"
$pidFile = Join-Path $script:AmDevRun 'agentmemory-dev-iii.pid'

$process = Start-Process -FilePath $script:AmIiiExe -ArgumentList @('--config', $script:AmDevConfig) -WorkingDirectory $script:AmDevApp -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value ([string]$process.Id) -Encoding ASCII

Write-Output 'Started AgentMemory dev isolated mode.'
Write-Output "dev.iiiPid=$($process.Id)"
Write-Output "dev.home=$script:AmDevHome"
Write-Output "dev.config=$script:AmDevConfig"
Write-Output "dev.engine=$script:AmIiiExe"
Write-Output "dev.outputLanguage=$env:AGENTMEMORY_OUTPUT_LANGUAGE"
Write-Output "dev.logs.stdout=$stdoutLog"
Write-Output "dev.logs.stderr=$stderrLog"
Write-Output 'dev.ports=3211,3212,3213,49234'
Write-Output 'Run doctor-agentmemory-dev-isolated.ps1 to verify readiness.'

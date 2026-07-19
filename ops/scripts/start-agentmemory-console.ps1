param([switch]$DeploymentAuthorized)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. "$PSScriptRoot\_agentmemory-local-common.ps1"

if (-not $DeploymentAuthorized) {
  Assert-AmNoDeploymentInProgress
}

$svc = Get-AmService
if ($svc -and $svc.State -ne 'Stopped') {
  throw "Refusing formal console start: Windows Service '$script:AmServiceName' is $($svc.State). Stop the service once, then use formal console mode for iterative development."
}

Assert-AmRequiredDirectory -Path $script:AmFormalRoot -Name 'formal runtime root'
Assert-AmRequiredDirectory -Path $script:AmFormalHome -Name 'formal AGENTMEMORY_HOME'
Assert-AmRequiredDirectory -Path $script:AmFormalInstall -Name 'formal AGENTMEMORY_INSTALL_HOME'
Assert-AmRequiredDirectory -Path $script:AmAppCurrent -Name 'formal app current'
Assert-AmRequiredFile -Path $script:AmFormalConfig -Name 'formal AGENTMEMORY_III_CONFIG'
Assert-AmRequiredFile -Path $script:AmIiiExe -Name 'formal iii.exe'
Assert-AmRequiredFile -Path (Join-Path $script:AmAppCurrent 'dist\index.mjs') -Name 'formal AgentMemory worker'
Write-AmDeploymentManifestSummary -AppDirectory $script:AmAppCurrent
if (-not $script:AmLastDeploymentManifestOk) {
  throw 'Refusing formal console start: deployment manifest verification failed.'
}

$supervisionConfigured = Test-AmConfigContainsText -ConfigPath $script:AmFormalConfig -Text 'worker-supervisor.mjs'
$legacyWorkerConfigured = Test-AmConfigContainsText -ConfigPath $script:AmFormalConfig -Text 'dist/index.mjs'
if (-not $supervisionConfigured -and -not $legacyWorkerConfigured) {
  throw 'Refusing formal console start: iii-exec is neither the supported supervisor nor the legacy direct worker.'
}

Assert-AmPathEquals -Actual $script:AmFormalHome -Expected (Join-Path $script:AmFormalRoot 'home') -Name 'AGENTMEMORY_HOME'
Assert-AmPathEquals -Actual $script:AmFormalConfig -Expected (Join-Path $script:AmFormalRoot 'home\iii-config.yaml') -Name 'AGENTMEMORY_III_CONFIG'

if ($supervisionConfigured) {
  Assert-AmRequiredFile -Path (Join-Path $script:AmAppCurrent 'dist\worker-supervisor.mjs') -Name 'formal AgentMemory worker supervisor'
  Assert-AmInstanceStartReady -InstanceHome $script:AmFormalHome -InstanceId 'formal' -AppDirectory $script:AmAppCurrent
  Invoke-AmWorkerSupervisionValidation `
    -ConfigPath $script:AmFormalConfig `
    -AppDirectory $script:AmAppCurrent `
    -InstanceId 'formal' `
    -ExpectedStatePath $script:AmFormalStatePath `
    -ExpectedStreamPath $script:AmFormalStreamPath
} else {
  Write-Output 'formal.workerMode=legacy-direct-transition'
}

$listeners = @(Get-AmListeners -Ports $script:AmFormalPorts | Where-Object { $null -ne $_ -and $_.PSObject.Properties['OwningProcess'] })
if ($listeners.Count -gt 0) {
  $details = ($listeners | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid=$($_.OwningProcess)" }) -join '; '
  throw "Refusing formal console start: formal AgentMemory ports are already occupied: $details"
}

$env:AGENTMEMORY_HOME = $script:AmFormalHome
$env:AGENTMEMORY_INSTALL_HOME = $script:AmFormalInstall
$env:AGENTMEMORY_III_CONFIG = $script:AmFormalConfig
$env:III_REST_PORT = '3111'
$env:III_STREAM_PORT = '3112'
$env:III_VIEWER_PORT = '3113'
$env:III_ENGINE_URL = 'ws://localhost:49134'
$env:AGENTMEMORY_URL = 'http://localhost:3111'
$env:AGENTMEMORY_OUTPUT_LANGUAGE = 'zh-CN'
$env:TEMP = Join-Path $script:AmFormalRoot 'tmp'
$env:TMP = Join-Path $script:AmFormalRoot 'tmp'
$env:npm_config_cache = Join-Path $script:AmFormalRoot 'cache\npm'
$env:CI = '1'

Set-Location $script:AmAppCurrent
Write-Output 'Starting AgentMemory formal console mode.'
Write-Output "formal.home=$env:AGENTMEMORY_HOME"
Write-Output "formal.config=$env:AGENTMEMORY_III_CONFIG"
Write-Output 'formal.ports=3111,3112,3113,49134'
Write-Output "formal.outputLanguage=$env:AGENTMEMORY_OUTPUT_LANGUAGE"
Write-Output "formal.engine=$script:AmIiiExe"
Write-Output 'This process uses formal data and formal ports. It is not a Windows Service.'
& $script:AmIiiExe --config $script:AmFormalConfig
exit $LASTEXITCODE

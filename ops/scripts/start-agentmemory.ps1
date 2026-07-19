$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. "$PSScriptRoot\_agentmemory-local-common.ps1"

Assert-AmNoDeploymentInProgress

$serviceExe = Join-Path $script:AmFormalRoot 'service\agentmemory.exe'
$doctor = Join-Path $script:AmAppCurrent 'scripts\doctor-agentmemory.ps1'

function Test-AmAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

Assert-AmRequiredFile -Path $serviceExe -Name 'WinSW service executable'
Assert-AmRequiredFile -Path $doctor -Name 'service doctor'

$service = Get-AmService
if ($service -and $service.State -eq 'Running') {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $doctor -ExpectedState Running
  exit $LASTEXITCODE
}

if (Test-AmAdministrator) {
  & $serviceExe start
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $doctor -ExpectedState Running
  exit $LASTEXITCODE
}

$adminScript = Join-Path $script:AmFormalRoot 'tmp\start-agentmemory-service-elevated.ps1'
@"
`$ErrorActionPreference = 'Stop'
& '$serviceExe' start
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$doctor' -ExpectedState Running
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $adminScript -Encoding UTF8
Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $adminScript
)

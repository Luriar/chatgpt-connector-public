param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$taskName = "ChatGPT-Connector"
$root = Split-Path -Parent $PSScriptRoot
$supervisorScript = Join-Path $PSScriptRoot "supervise-chatgpt-connector.ps1"
$recoveryInstaller = Join-Path $PSScriptRoot "install-windows-recovery.ps1"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "ChatGPT-Connector-Recovery" -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled tasks: $taskName, ChatGPT-Connector-Recovery"
  exit 0
}

if (-not (Test-Path $supervisorScript)) {
  throw "Missing supervisor script: $supervisorScript"
}
if (-not (Test-Path $recoveryInstaller)) {
  throw "Missing recovery installer: $recoveryInstaller"
}

$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisorScript`""
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument $arg `
  -WorkingDirectory $root

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Continuously supervise ChatGPT Connector MCP, Work runtime, UI watchdog, and Tailscale Funnel." |
  Out-Null

& $recoveryInstaller
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 4

$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host "Registered scheduled task: $taskName"
Write-Host "LastTaskResult: $($info.LastTaskResult)"
Write-Host "Check connector status with: npm run status"

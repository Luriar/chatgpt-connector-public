param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$taskName = "ChatGPT-Connector-Work-Runtime"
$root = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot "start-work-runtime.ps1"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task: $taskName"
  exit 0
}

if (-not (Test-Path $startScript)) { throw "Missing start script: $startScript" }

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Start ChatGPT Connector Work coordinator and browser worker at logon." | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 4
$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
  task = $taskName
  state = (Get-ScheduledTask -TaskName $taskName).State.ToString()
  lastTaskResult = $info.LastTaskResult
} | ConvertTo-Json -Compress

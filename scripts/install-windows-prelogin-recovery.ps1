param(
  [switch]$Uninstall,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$taskName = "ChatGPT-Connector-Prelogin-Recovery"
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot "windows-prelogin-recovery.ps1"
$stateDir = Join-Path $root ".webjjonku\prelogin-recovery"
$installed = Join-Path $stateDir "windows-prelogin-recovery.ps1"

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Administrator privileges are required to install the pre-login SYSTEM recovery task."
  }
}

function Assert-PsSyntax([string]$Path) {
  $tokens = $null; $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors) | Out-Null
  if (@($errors).Count -gt 0) { throw "PowerShell syntax check failed: $Path :: $($errors[0].Message)" }
}

Assert-Admin
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task: $taskName"
  exit 0
}
if (-not (Test-Path $source)) { throw "Missing pre-login recovery source: $source" }
Assert-PsSyntax $source
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Copy-Item -LiteralPath $source -Destination $installed -Force
Assert-PsSyntax $installed

# Keep the recovery copy independent of the live source tree and explicitly grant SYSTEM access.
& icacls.exe $stateDir /grant '*S-1-5-18:(OI)(CI)(F)' /T /C *> $null
if ($LASTEXITCODE -ne 0) { throw "Failed to grant SYSTEM access to pre-login recovery state." }

$arg = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$installed`" -Root `"$root`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Credential-free pre-login recovery guard. Repairs runtime source and hands off to user-context Connector tasks after logon." | Out-Null
if (-not $NoStart) { Start-ScheduledTask -TaskName $taskName }
Start-Sleep -Milliseconds 500
$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
  task = $taskName
  state = $task.State.ToString()
  lastTaskResult = $info.LastTaskResult
  trigger = "AtStartup"
  principal = "SYSTEM"
  fullConnectorStillUserContext = $true
} | ConvertTo-Json -Compress

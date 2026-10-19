param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$taskName = "ChatGPT-Connector-Recovery"
$preLoginTaskName = "ChatGPT-Connector-PreLogin-Recovery"
$root = Split-Path -Parent $PSScriptRoot
$sourceWatchdog = Join-Path $PSScriptRoot "windows-recovery-watchdog.ps1"
$stateDir = Join-Path $root ".webjjonku\recovery"
$watchdogCopy = Join-Path $stateDir "windows-recovery-watchdog.ps1"
$snapshotRoot = Join-Path $stateDir "snapshot"
$snapshotNext = Join-Path $stateDir "snapshot.next"
$snapshotPrev = Join-Path $stateDir "snapshot.prev"
function Assert-RecoveryPath([string]$Path) {
  $resolved = [IO.Path]::GetFullPath($Path)
  $allowed = [IO.Path]::GetFullPath($stateDir).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)) { throw "Recovery path outside state directory: $resolved" }
  return $resolved
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $preLoginTaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled tasks: $taskName, $preLoginTaskName"
  exit 0
}
if (-not (Test-Path $sourceWatchdog)) { throw "Missing recovery watchdog: $sourceWatchdog" }
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Assert-JsSyntax([string]$Path) {
  & node --check $Path *> $null
  if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $Path" }
}
function Assert-PsSyntax([string]$Path) {
  $tokens = $null; $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors) | Out-Null
  if (@($errors).Count -gt 0) { throw "PowerShell syntax check failed: $Path :: $($errors[0].Message)" }
}

Assert-PsSyntax $sourceWatchdog
$files = @()
$srcDir = Join-Path $root "src"
if (Test-Path $srcDir) { $files += Get-ChildItem $srcDir -Recurse -File | Where-Object { $_.Extension.ToLowerInvariant() -in @(".js",".mjs") } }
foreach ($rel in @("scripts\daemon.js","scripts\nas-client-launcher.js","scripts\windows-tool-worker.js","scripts\windows-recovery-probe.js","scripts\start-chatgpt-connector.ps1","scripts\supervise-chatgpt-connector.ps1")) {
  $p = Join-Path $root $rel
  if (Test-Path $p) { $files += Get-Item $p }
}
$files = @($files | Sort-Object FullName -Unique)
if (-not $files.Count) { throw "No recovery source files found." }
foreach ($f in $files) {
  $ext = $f.Extension.ToLowerInvariant()
  if ($ext -in @(".js",".mjs")) { Assert-JsSyntax $f.FullName }
  elseif ($ext -eq ".ps1") { Assert-PsSyntax $f.FullName }
}

$snapshotNext = Assert-RecoveryPath $snapshotNext
Remove-Item -LiteralPath $snapshotNext -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $snapshotNext | Out-Null
$rootFull = [IO.Path]::GetFullPath($root).TrimEnd("\")
$records = @()
foreach ($f in $files) {
  $rel = $f.FullName.Substring($rootFull.Length).TrimStart("\")
  $dst = Join-Path $snapshotNext $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item -LiteralPath $f.FullName -Destination $dst -Force
  $records += [pscustomobject]@{ path=$rel; sha256=(Get-FileHash $dst -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$head = $null
try { $head = (git -C $root rev-parse HEAD 2>$null).Trim() } catch {}
[pscustomobject]@{ version=1; createdAt=(Get-Date).ToUniversalTime().ToString("o"); gitHead=$head; files=$records } |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $snapshotNext "manifest.json") -Encoding UTF8

$snapshotPrev = Assert-RecoveryPath $snapshotPrev
$snapshotRoot = Assert-RecoveryPath $snapshotRoot
Remove-Item -LiteralPath $snapshotPrev -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $snapshotRoot) { Move-Item -LiteralPath $snapshotRoot -Destination $snapshotPrev -Force }
Move-Item -LiteralPath $snapshotNext -Destination $snapshotRoot -Force
Copy-Item -LiteralPath $sourceWatchdog -Destination $watchdogCopy -Force
Assert-PsSyntax $watchdogCopy

$manualPath = Join-Path $root ".webjjonku\restart-main.ps1"
$manual = @'
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $PSScriptRoot "recovery\windows-recovery-watchdog.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdog -Root $root -Once
exit $LASTEXITCODE
'@
Set-Content -LiteralPath $manualPath -Value $manual -Encoding UTF8
Assert-PsSyntax $manualPath

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogCopy`" -Root `"$root`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -eq 'powershell.exe' -and
    $_.CommandLine -and
    $_.CommandLine.Replace('/','\').IndexOf($root.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine -match 'windows-recovery-watchdog\.ps1' -and
    $_.CommandLine -notmatch '\s-Once(?:\s|$)' -and
    $_.CommandLine -notmatch '\s-PreLogin(?:\s|$)'
  } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
$existingMainTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existingMainTask) {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Independent fallback watchdog for Windows Connector 8748 health and coordinator-to-worker end-to-end recovery." | Out-Null
} elseif ([string]$existingMainTask.Actions[0].Arguments -ne $arg) {
  Set-ScheduledTask -TaskName $taskName -Action $action -ErrorAction Stop | Out-Null
}

$preArg = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogCopy`" -Root `"$root`" -PreLogin"
$preAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $preArg -WorkingDirectory $root
$preTrigger = New-ScheduledTaskTrigger -AtStartup
$preSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$prePrincipal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Limited
$preLoginInstalled = $false
$preLoginRequiresElevation = $false
$preLoginError = $null
try {
  $existingPreTask = Get-ScheduledTask -TaskName $preLoginTaskName -ErrorAction SilentlyContinue
  if ($existingPreTask) {
    Stop-ScheduledTask -TaskName $preLoginTaskName -ErrorAction SilentlyContinue
    if ([string]$existingPreTask.Actions[0].Arguments -ne $preArg) { Set-ScheduledTask -TaskName $preLoginTaskName -Action $preAction -ErrorAction Stop | Out-Null }
  } else {
    Register-ScheduledTask -TaskName $preLoginTaskName -Action $preAction -Trigger $preTrigger -Settings $preSettings -Principal $prePrincipal -Description "Minimal pre-login source and stale-state repair only. Does not start browser, UI, Codex, or the full Connector." -ErrorAction Stop | Out-Null
  }
  Start-ScheduledTask -TaskName $preLoginTaskName -ErrorAction Stop
  $preLoginInstalled = $true
} catch {
  $preLoginError = $_.Exception.Message
  if ($_.Exception.HResult -eq -2147024891 -or $_.FullyQualifiedErrorId -match '0x80070005' -or $_.CategoryInfo.Category -eq 'PermissionDenied') {
    $preLoginRequiresElevation = $true
  }
}

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 1
$info = Get-ScheduledTaskInfo -TaskName $taskName
$preTask = Get-ScheduledTask -TaskName $preLoginTaskName -ErrorAction SilentlyContinue
$preInfo = if ($preTask) { Get-ScheduledTaskInfo -TaskName $preLoginTaskName -ErrorAction SilentlyContinue } else { $null }
[pscustomobject]@{
  task=$taskName
  state=(Get-ScheduledTask -TaskName $taskName).State.ToString()
  lastTaskResult=$info.LastTaskResult
  preLoginTask=$preLoginTaskName
  preLoginInstalled=$preLoginInstalled
  preLoginRequiresElevation=$preLoginRequiresElevation
  preLoginState=if($preTask){$preTask.State.ToString()}else{"missing"}
  preLoginLastTaskResult=if($preInfo){$preInfo.LastTaskResult}else{$null}
  preLoginError=$preLoginError
  snapshotFiles=$records.Count
  snapshotHead=$head
} | ConvertTo-Json -Compress

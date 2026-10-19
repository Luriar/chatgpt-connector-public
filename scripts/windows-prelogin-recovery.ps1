param(
  [Parameter(Mandatory=$true)][string]$Root,
  [int]$PollSeconds = 15,
  [int]$TaskStartCooldownSeconds = 60,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$Root = [IO.Path]::GetFullPath($Root).TrimEnd("\")
$stateDir = Join-Path $Root ".webjjonku\prelogin-recovery"
$logPath = Join-Path $stateDir "prelogin-recovery.log"
$statusPath = Join-Path $stateDir "status.json"
$snapshotRoot = Join-Path $Root ".webjjonku\recovery\snapshot"
$manifestPath = Join-Path $snapshotRoot "manifest.json"
$healthUrl = "http://127.0.0.1:8748/health"
$mainTask = "ChatGPT-Connector"
$recoveryTask = "ChatGPT-Connector-Recovery"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Log([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  try {
    $fi = Get-Item $logPath -ErrorAction Stop
    if ($fi.Length -gt 1048576) {
      $tail = Get-Content $logPath -Tail 1000
      Set-Content -LiteralPath $logPath -Value $tail -Encoding UTF8
    }
  } catch {}
}

function Write-Status([string]$Phase,[bool]$Health,[string]$InteractiveUser,[string]$LastError="") {
  [pscustomobject]@{
    version = 1
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    pid = $PID
    phase = $Phase
    health = $Health
    interactiveUser = $InteractiveUser
    lastError = $LastError
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

function Test-Health {
  try {
    $r = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    return [bool]$r.ok
  } catch { return $false }
}

function Get-InteractiveUser {
  try {
    return [string](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName
  } catch { return "" }
}

function Test-JsSyntax([string]$Path) {
  if (-not (Test-Path $Path)) { return $false }
  try { & node --check $Path *> $null; return $LASTEXITCODE -eq 0 } catch { return $false }
}

function Test-PsSyntax([string]$Path) {
  if (-not (Test-Path $Path)) { return $false }
  try {
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors) | Out-Null
    return @($errors).Count -eq 0
  } catch { return $false }
}

function Restore-BrokenRuntimeFiles {
  if (-not (Test-Path $manifestPath)) {
    Log "snapshot manifest missing; source repair unavailable"
    return 0
  }
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $restored = 0
  foreach ($item in @($manifest.files)) {
    $rel = [string]$item.path
    if (-not $rel) { continue }
    $live = Join-Path $Root $rel
    $snap = Join-Path $snapshotRoot $rel
    $ext = [IO.Path]::GetExtension($rel).ToLowerInvariant()
    $healthy = if ($ext -in @(".js",".mjs")) { Test-JsSyntax $live } elseif ($ext -eq ".ps1") { Test-PsSyntax $live } else { Test-Path $live }
    if ($healthy) { continue }
    if (-not (Test-Path $snap)) { Log "snapshot missing for broken runtime file: $rel"; continue }
    $want = ([string]$item.sha256).ToLowerInvariant()
    $got = (Get-FileHash $snap -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $want -or $got -ne $want) { Log "snapshot hash mismatch; refusing restore: $rel"; continue }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $live) | Out-Null
    Copy-Item -LiteralPath $snap -Destination $live -Force
    $restored++
    Log "restored syntax-broken runtime file from snapshot: $rel"
  }
  return $restored
}

function Start-UserConnectorTasks {
  $user = Get-InteractiveUser
  if (-not $user) {
    Log "8748 unavailable before interactive logon; waiting for user-context handoff"
    return $false
  }
  foreach ($name in @($recoveryTask,$mainTask)) {
    try {
      $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
      if ($task.State -ne "Running") {
        Start-ScheduledTask -TaskName $name
        Log "started user-context scheduled task: $name user=$user"
      }
    } catch {
      Log ("could not start user-context scheduled task " + $name + ": " + $_.Exception.Message)
    }
  }
  return $true
}

function Run-Iteration {
  if (Test-Health) {
    $u = Get-InteractiveUser
    Write-Status "healthy" $true $u
    return $true
  }
  $restored = Restore-BrokenRuntimeFiles
  $u = Get-InteractiveUser
  if ($u) {
    [void](Start-UserConnectorTasks)
    Write-Status "handoff-to-user-context" $false $u ("restored="+$restored)
  } else {
    Write-Status "prelogin-wait" $false "" ("restored="+$restored)
  }
  return $false
}

Log "prelogin recovery started pid=$PID root=$Root once=$([bool]$Once)"
if ($Once) {
  try { [void](Run-Iteration); exit 0 }
  catch { Log ("one-shot error: " + $_.Exception.Message); Write-Status "error" $false (Get-InteractiveUser) $_.Exception.Message; exit 1 }
}

$lastTaskStart = [DateTime]::MinValue
while ($true) {
  try {
    $healthy = Test-Health
    if ($healthy) {
      Write-Status "healthy" $true (Get-InteractiveUser)
    } else {
      $restored = Restore-BrokenRuntimeFiles
      $u = Get-InteractiveUser
      if ($u -and ((Get-Date)-$lastTaskStart).TotalSeconds -ge [Math]::Max(15,$TaskStartCooldownSeconds)) {
        [void](Start-UserConnectorTasks)
        $lastTaskStart = Get-Date
        Write-Status "handoff-to-user-context" $false $u ("restored="+$restored)
      } elseif ($u) {
        Write-Status "waiting-for-user-task-recovery" $false $u ("restored="+$restored)
      } else {
        Write-Status "prelogin-wait" $false "" ("restored="+$restored)
      }
    }
  } catch {
    Log ("iteration error: " + $_.Exception.Message)
    Write-Status "error" $false (Get-InteractiveUser) $_.Exception.Message
  }
  Start-Sleep -Seconds ([Math]::Max(5,$PollSeconds))
}

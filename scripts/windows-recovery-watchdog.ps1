param(
  [Parameter(Mandatory=$true)][string]$Root,
  [int]$PollSeconds = 10,
  [int]$FailureThreshold = 3,
  [int]$InitialGraceSeconds = 25,
  [int]$RecoveryTimeoutSeconds = 30,
  [int]$CooldownSeconds = 60,
  [int]$ProbeEverySeconds = 20,
  [int]$ProbeFailureThreshold = 2,
  [int]$ProbeTimeoutSeconds = 8,
  [int]$ProbeBusyGraceSeconds = 180,
  [switch]$SelfTest,
  [switch]$Once,
  [switch]$PreLogin
)

$ErrorActionPreference = "Stop"
$Root = [IO.Path]::GetFullPath($Root).TrimEnd("\")
$stateDir = Join-Path $Root ".webjjonku\recovery"
$snapshotRoot = Join-Path $stateDir "snapshot"
$manifestPath = Join-Path $snapshotRoot "manifest.json"
$logPath = Join-Path $stateDir "windows-recovery.log"
$startScript = Join-Path $Root "scripts\start-chatgpt-connector.ps1"
$probeScript = Join-Path $Root "scripts\windows-recovery-probe.js"
$daemonState = Join-Path $Root ".webjjonku\runtimes\windows\daemon.json"
$healthUrl = "http://127.0.0.1:8748/health"
$script:lastProbeResult = $null

function Log([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  try {
    $fi = Get-Item $logPath -ErrorAction Stop
    if ($fi.Length -gt 2097152) {
      $tail = Get-Content $logPath -Tail 1500
      Set-Content -LiteralPath $logPath -Value $tail -Encoding UTF8
    }
  } catch {}
}

function Test-LocalHealth {
  try {
    $r = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    return [bool]$r.ok
  } catch { return $false }
}

function Test-EndToEnd {
  $script:lastProbeResult = [pscustomobject]@{ status="configuration_unavailable"; repairEligible=$false; verified=$false }
  if (-not (Test-Path $probeScript)) { Log "E2E probe script missing: $probeScript"; return $false }
  try {
    $out = & node $probeScript --timeout-ms ([Math]::Max(2000,$ProbeTimeoutSeconds*1000)) --busy-grace-ms ([Math]::Max(30000,$ProbeBusyGraceSeconds*1000)) 2>&1 | Out-String
    $script:lastProbeResult = $out.Trim() | ConvertFrom-Json
    $ok = $script:lastProbeResult.ok -eq $true -and $script:lastProbeResult.verified -eq $true
    if (-not $ok) { Log ("E2E probe status: " + (($out.Trim() -replace "\r?\n"," | ").Substring(0,[Math]::Min(1200,$out.Trim().Length)))) }
    return $ok
  } catch {
    Log ("E2E probe exception: " + $_.Exception.Message)
    return $false
  }
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
  if (-not (Test-Path $manifestPath)) { Log "recovery snapshot manifest missing; skipping source restore"; return }
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  foreach ($item in @($manifest.files)) {
    $rel = [string]$item.path
    if (-not $rel) { continue }
    $live = [IO.Path]::GetFullPath((Join-Path $Root $rel))
    $snap = [IO.Path]::GetFullPath((Join-Path $snapshotRoot $rel))
    if (-not $live.StartsWith($Root + "\",[StringComparison]::OrdinalIgnoreCase) -or -not $snap.StartsWith($snapshotRoot + "\",[StringComparison]::OrdinalIgnoreCase)) { Log "invalid snapshot path; refusing restore"; continue }
    $ext = [IO.Path]::GetExtension($rel).ToLowerInvariant()
    $healthy = if ($ext -in @(".js",".mjs")) { Test-JsSyntax $live } elseif ($ext -eq ".ps1") { Test-PsSyntax $live } else { Test-Path $live }
    if ($healthy) { continue }
    if (-not (Test-Path $snap)) { Log "snapshot missing for broken runtime file: $rel"; continue }
    $want = ([string]$item.sha256).ToLowerInvariant()
    $got = (Get-FileHash $snap -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $want -or $got -ne $want) { Log "snapshot hash mismatch; refusing restore: $rel"; continue }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $live) | Out-Null
    if (Test-Path -LiteralPath $live) { Copy-Item -LiteralPath $live -Destination ($live + ".recovery-backup-" + (Get-Date -Format "yyyyMMddHHmmssfff")) }
    Copy-Item -LiteralPath $snap -Destination $live -Force
    Log "restored syntax-broken runtime file from recovery snapshot: $rel"
  }
}

function Test-RootProcess($Process) {
  return [bool]($Process -and $Process.ProcessId -ne $PID -and $Process.Name -in @('node.exe','powershell.exe') -and $Process.CommandLine -and $Process.CommandLine.Replace('/','\').IndexOf($Root + '\',[StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Stop-MatchingProcess([string]$Pattern) {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { (Test-RootProcess $_) -and $_.CommandLine -match $Pattern } |
    ForEach-Object {
      try {
        $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ProcessId)" -ErrorAction Stop
        if ((Test-RootProcess $actual) -and $actual.CreationDate -eq $_.CreationDate -and $actual.CommandLine -match $Pattern) { Stop-Process -Id $actual.ProcessId -Force -ErrorAction Stop; Log "stopped pid=$($actual.ProcessId) pattern=$Pattern" }
      } catch {}
    }
}

function Remove-StaleDaemonState {
  if (-not (Test-Path $daemonState)) { return $false }
  $valid = $false
  try {
    $state = Get-Content $daemonState -Raw | ConvertFrom-Json
    $pidValue = [int]$state.pid
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
    $valid = [bool]((Test-RootProcess $proc) -and $proc.CommandLine -match 'scripts[\\/]+daemon\.js')
  } catch {}
  if ($valid) { return $false }
  Remove-Item -LiteralPath $daemonState -Force -ErrorAction SilentlyContinue
  Log "removed stale Windows daemon state"
  return $true
}

function Restart-LocalConnectorRuntime {
  Stop-MatchingProcess 'src[\\/]+index\.js.*--http'
  Stop-MatchingProcess 'scripts[\\/]+daemon\.js'
  Stop-MatchingProcess 'nas-client-launcher\.js.*--mode\s+daemon'
  [void](Remove-StaleDaemonState)
  try {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -Profile windows 2>&1 | Out-String
    if ($out.Trim()) { Log ("bootstrap output: " + ($out.Trim() -replace "\r?\n"," | ")) }
  } catch { Log ("bootstrap error: " + $_.Exception.Message) }
}

function Invoke-Recovery([string]$Reason) {
  Log "recovery start reason=$Reason"
  Restore-BrokenRuntimeFiles
  if ($Reason -eq "e2e-probe") {
    # Recheck immediately before repair: normal work may have started since the failed sample.
    if (Test-EndToEnd) { Log "recovery skipped; E2E path already recovered"; return $true }
    if (-not $script:lastProbeResult.repairEligible) { Log "recovery deferred; no worker fault evidence status=$($script:lastProbeResult.status)"; return $false }
    $workers = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { (Test-RootProcess $_) -and $_.CommandLine -match 'windows-tool-worker\.js' })
    if ($workers.Count -gt 0) { Stop-MatchingProcess 'windows-tool-worker\.js' }
    else { Stop-MatchingProcess 'nas-client-launcher\.js.*--mode\s+tools' }
    $launchers = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { (Test-RootProcess $_) -and $_.CommandLine -match 'nas-client-launcher\.js.*--mode\s+tools' })
    if ($launchers.Count -eq 0) {
      $launcher = Join-Path $Root 'scripts\nas-client-launcher.js'
      $runtimeConfig = Join-Path $Root '.webjjonku\nas-runtime.json'
      Start-Process -FilePath (Get-Command node).Source -ArgumentList @("`"$launcher`"",'--mode','tools','--config',"`"$runtimeConfig`"") -WorkingDirectory $Root -WindowStyle Hidden
    }
  } else {
    Restart-LocalConnectorRuntime
  }

  $deadline = (Get-Date).AddSeconds([Math]::Max(15,$RecoveryTimeoutSeconds))
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalHealth) {
      Start-Sleep -Milliseconds 500
      if (Test-EndToEnd) { Log "recovery succeeded; local health and E2E probe are OK"; return $true }
    }
    Start-Sleep -Seconds 1
  }
  if ($Reason -eq "e2e-probe") {
    if (Test-EndToEnd) { Log "worker-only recovery eventually succeeded"; return $true }
    if (-not $script:lastProbeResult.repairEligible) {
      Log "worker-only recovery failed but runtime escalation deferred; no worker fault evidence status=$($script:lastProbeResult.status)"
      return $false
    }
    Log "worker-only recovery failed; escalating to local runtime repair"
    Restart-LocalConnectorRuntime
    $deadline = (Get-Date).AddSeconds([Math]::Max(15,$RecoveryTimeoutSeconds))
    while ((Get-Date) -lt $deadline) {
      if (Test-LocalHealth) {
        Start-Sleep -Milliseconds 500
        if (Test-EndToEnd) { Log "escalated local runtime recovery succeeded"; return $true }
        if (-not $script:lastProbeResult.repairEligible) {
          Log "escalated recovery deferred after recheck status=$($script:lastProbeResult.status)"
          return $false
        }
      }
      Start-Sleep -Seconds 1
    }
  }
  Log "recovery failed; local health or E2E probe is still down"
  return $false
}

if ($SelfTest) {
  $owned = [pscustomobject]@{ ProcessId=123; Name='node.exe'; CommandLine="node `"$Root\scripts\windows-tool-worker.js`"" }
  $foreign = [pscustomobject]@{ ProcessId=123; Name='node.exe'; CommandLine='node C:\other\scripts\windows-tool-worker.js' }
  if (-not (Test-RootProcess $owned) -or (Test-RootProcess $foreign)) { throw 'root process ownership regression' }
  [pscustomobject]@{ ok=$true; rootScopedProcessSelection=$true; noLiveChanges=$true } | ConvertTo-Json -Compress
  exit 0
}
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Log "windows recovery watchdog started pid=$PID root=$Root once=$([bool]$Once) preLogin=$([bool]$PreLogin)"
if ($PreLogin) {
  Restore-BrokenRuntimeFiles
  [void](Remove-StaleDaemonState)
  $marker = Join-Path $stateDir "prelogin-ready.json"
  [pscustomobject]@{
    ok=$true
    timestamp=(Get-Date).ToUniversalTime().ToString("o")
    user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    mode="prelogin-minimal"
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $marker -Encoding UTF8
  Log "pre-login minimal recovery completed"
  exit 0
}
if ($Once) {
  $localOk = Test-LocalHealth
  $e2eOk = $localOk -and (Test-EndToEnd)
  if ($localOk -and $e2eOk) { Log "one-shot recovery skipped; local health and E2E probe are already OK"; exit 0 }
  if ($localOk -and -not $script:lastProbeResult.repairEligible) { Log "one-shot recovery deferred status=$($script:lastProbeResult.status)"; exit 2 }
  $reason = if ($localOk) { "e2e-probe" } else { "local-health" }
  if (Invoke-Recovery $reason) { exit 0 }
  exit 1
}

Start-Sleep -Seconds ([Math]::Max(0,$InitialGraceSeconds))
$localFailCount = 0
$probeFailCount = 0
$lastProbe = [DateTime]::MinValue
$lastRecovery = [DateTime]::MinValue
while ($true) {
  $localOk = Test-LocalHealth
  if ($localOk) {
    $localFailCount = 0
    if (((Get-Date) - $lastProbe).TotalSeconds -ge [Math]::Max(10,$ProbeEverySeconds)) {
      $lastProbe = Get-Date
      if (Test-EndToEnd) {
        if ($probeFailCount -gt 0) { Log "E2E probe recovered" }
        $probeFailCount = 0
      } elseif ($script:lastProbeResult.repairEligible) {
        $probeFailCount++
        Log "E2E probe failure count=$probeFailCount"
        $cooldownOk = ((Get-Date) - $lastRecovery).TotalSeconds -ge [Math]::Max(10,$CooldownSeconds)
        if ($probeFailCount -ge [Math]::Max(1,$ProbeFailureThreshold) -and $cooldownOk) {
          $lastRecovery = Get-Date
          [void](Invoke-Recovery "e2e-probe")
          $probeFailCount = 0
          $localFailCount = 0
        }
      } else {
        # Busy/upstream/config samples are inconclusive and break consecutive failure counts.
        $probeFailCount = 0
      }
    }
  } else {
    $probeFailCount = 0
    $localFailCount++
    if ($localFailCount -eq 1) { Log "8748 local health failure detected" }
    $cooldownOk = ((Get-Date) - $lastRecovery).TotalSeconds -ge [Math]::Max(10,$CooldownSeconds)
    if ($localFailCount -ge [Math]::Max(1,$FailureThreshold) -and $cooldownOk) {
      $lastRecovery = Get-Date
      [void](Invoke-Recovery "local-health")
      $localFailCount = 0
      $probeFailCount = 0
    }
  }
  Start-Sleep -Seconds ([Math]::Max(5,$PollSeconds))
}

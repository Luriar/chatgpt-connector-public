param(
  [int]$PollSeconds = 15,
  [int]$FunnelCheckEvery = 4,
  [int]$RecoveryTimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".webjjonku"
$pidPath = Join-Path $stateDir "connector-supervisor.pid"
$logPath = Join-Path $stateDir "connector-supervisor.log"
$startScript = Join-Path $PSScriptRoot "start-chatgpt-connector.ps1"
$watchdogConfig = Join-Path $stateDir "ui-watchdog.json"
$watchdogPidPath = Join-Path $stateDir "ui-watchdog.pid"
$tailscale = "C:\Program Files\Tailscale\tailscale.exe"
$nasConfigPath = Join-Path $stateDir "nas-runtime.json"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Get-NasRuntime {
  if (-not (Test-Path $nasConfigPath)) { return $null }
  try {
    $r = Get-Content $nasConfigPath -Raw | ConvertFrom-Json
    if ([bool]$r.enabled) { return $r }
  } catch {}
  return $null
}

function Log([string]$message) {
  $line = "$(Get-Date -Format o) $message"
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  try {
    $fi = Get-Item $logPath -ErrorAction Stop
    if ($fi.Length -gt 2097152) {
      $tail = Get-Content $logPath -Tail 1500
      Set-Content -LiteralPath $logPath -Value $tail -Encoding UTF8
    }
  } catch {}
}

function Test-HttpOk([string]$url) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    return $r.StatusCode -ge 200 -and $r.StatusCode -lt 300
  } catch { return $false }
}

function Test-TcpUrl([string]$url) {
  try {
    $u=[Uri]$url
    $port=if($u.IsDefaultPort){if($u.Scheme -eq "https"){443}else{80}}else{$u.Port}
    $c=New-Object System.Net.Sockets.TcpClient
    try {$a=$c.ConnectAsync($u.Host,$port);if(-not $a.Wait(3000)){return $false};return $c.Connected} finally {$c.Dispose()}
  } catch { return $false }
}

function Get-WorkerCount {
  try {
    $nas=Get-NasRuntime
    if($nas){
      return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine -match 'nas-client-launcher\.js.*--mode\s+browser'}).Count
    }
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -eq 'node.exe' -and
        $_.CommandLine -and
        $_.CommandLine -match 'browser-worker\.js' -and
        $_.CommandLine -match '127\.0\.0\.1:8780' -and
        $_.CommandLine -match 'cloud-browser-local'
      }).Count
  } catch { return 0 }
}

function Get-ToolWorkerCount {
  try {
    $nas=Get-NasRuntime
    if(-not $nas){ return 0 }
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine -match 'nas-client-launcher\.js.*--mode\s+tools'}).Count
  } catch { return 0 }
}

function Test-WatchdogHealthy {
  $enabled = $false
  if (Test-Path $watchdogConfig) {
    try { $enabled = [bool]((Get-Content $watchdogConfig -Raw | ConvertFrom-Json).enabled) } catch {}
  }
  if (-not $enabled) { return $true }
  if (-not (Test-Path $watchdogPidPath)) { return $false }
  try {
    $watchdogPid = [int](Get-Content $watchdogPidPath -Raw)
    return [bool](Get-Process -Id $watchdogPid -ErrorAction SilentlyContinue)
  } catch { return $false }
}

function Test-FunnelHealthy {
  if (-not (Test-Path $tailscale)) { return $false }
  try {
    & $tailscale status *> $null
    if ($LASTEXITCODE -ne 0) { return $false }
    $funnel = (& $tailscale funnel status 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0) { return $false }
    return ($funnel -match 'proxy\s+http://127\.0\.0\.1:8747') -and ($funnel -notmatch '/coordinator')
  } catch { return $false }
}

function Invoke-Recovery([bool]$includeFunnel,[string]$reason) {
  Log "recovery start reason=$reason includeFunnel=$includeFunnel"
  try {
    $nas = Get-NasRuntime
    if ($nas) {
      $recoveryArgs = @("-NoProfile","-ExecutionPolicy","Bypass","-File",$startScript,"-Profile","windows")
    } else {
      $recoveryArgs = @("-NoProfile","-ExecutionPolicy","Bypass","-File",$startScript,"-HealthTimeoutSeconds","6","-TailscaleTimeoutSeconds","6")
      if (-not $includeFunnel) { $recoveryArgs += "-SkipFunnel" }
    }
    $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $recoveryArgs -WindowStyle Hidden -PassThru
    $timeoutMs = [Math]::Max(5,$RecoveryTimeoutSeconds) * 1000
    if (-not $proc.WaitForExit($timeoutMs)) {
      try { & taskkill.exe /PID $proc.Id /T /F *> $null } catch { try { $proc.Kill() } catch {} }
      Log "recovery timed_out reason=$reason timeoutSeconds=$RecoveryTimeoutSeconds"
      return $false
    }
    if ($proc.ExitCode -ne 0) {
      Log "recovery failed reason=$reason exitCode=$($proc.ExitCode)"
      return $false
    }
    Log "recovery completed reason=$reason"
    return $true
  } catch {
    Log ("recovery failed reason=" + $reason + " error=" + $_.Exception.Message)
    return $false
  }
}

if (Test-Path $pidPath) {
  try {
    $oldPid = [int](Get-Content $pidPath -Raw)
    $old = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid" -ErrorAction SilentlyContinue
    if ($old -and $old.CommandLine -match 'supervise-chatgpt-connector\.ps1') {
      Write-Host "ChatGPT Connector supervisor already running (pid=$oldPid)."
      exit 0
    }
  } catch {}
}
$PID | Set-Content -LiteralPath $pidPath -Encoding ASCII

try {
  Log "supervisor started pid=$PID"
  $startupNas = Get-NasRuntime
  $startupHealthUrl = if ($startupNas) { "http://127.0.0.1:8748/health" } else { "http://127.0.0.1:8747/health" }
  $startupMainOk = Test-HttpOk $startupHealthUrl
  $startupCoordOk = if ($startupNas) { Test-TcpUrl ([string]$startupNas.coordinatorUrl) } else { Test-HttpOk "http://127.0.0.1:8780/health" }
  $startupWorkerCount = Get-WorkerCount
  $startupToolWorkerCount = Get-ToolWorkerCount
  $startupWatchdogOk = Test-WatchdogHealthy
  $startupFunnelOk = Test-FunnelHealthy
  if (-not $startupMainOk) {
    [void](Invoke-Recovery (-not $startupFunnelOk) "startup-mcp-down")
  } elseif ($startupNas -and -not $startupCoordOk) {
    Log "startup degraded; NAS coordinator unavailable, keeping MCP/Funnel online without restart"
  } elseif (($startupWorkerCount -ne 1) -or ($startupNas -and $startupToolWorkerCount -ne 1) -or (-not $startupWatchdogOk) -or (-not $startupFunnelOk)) {
    [void](Invoke-Recovery (-not $startupFunnelOk) "startup")
  } else {
    Log "startup healthy; recovery skipped"
  }

  $lastNasCoordOk = $startupCoordOk
  $cycle = 0
  while ($true) {
    $cycle++
    $nas = Get-NasRuntime
    $healthUrl = if ($nas) { "http://127.0.0.1:8748/health" } else { "http://127.0.0.1:8747/health" }
    $mainOk = Test-HttpOk $healthUrl
    $coordOk = if ($nas) { Test-TcpUrl ([string]$nas.coordinatorUrl) } else { Test-HttpOk "http://127.0.0.1:8780/health" }
    $workerCount = Get-WorkerCount
    $toolWorkerCount = Get-ToolWorkerCount
    $watchdogOk = Test-WatchdogHealthy

    if (-not $mainOk) {
      [void](Invoke-Recovery $false "mcp-health-down")
    } elseif ($nas -and -not $coordOk) {
      if ($lastNasCoordOk) { Log "NAS coordinator became unavailable; keeping MCP/Funnel online and waiting for NAS recovery" }
    } elseif ($workerCount -ne 1) {
      [void](Invoke-Recovery $false ("browser-worker-count-" + $workerCount))
    } elseif ($nas -and $toolWorkerCount -ne 1) {
      [void](Invoke-Recovery $false ("windows-tool-worker-count-" + $toolWorkerCount))
    } elseif (-not $watchdogOk) {
      [void](Invoke-Recovery $false "ui-watchdog-down")
    }

    if ($nas -and $coordOk -and -not $lastNasCoordOk) {
      Log "NAS coordinator recovered"
    }
    $lastNasCoordOk = $coordOk

    if ($cycle -ge [Math]::Max(1,$FunnelCheckEvery)) {
      $cycle = 0
      if (-not (Test-FunnelHealthy)) {
        [void](Invoke-Recovery $true "tailscale-funnel-drift")
      }
    }

    Start-Sleep -Seconds ([Math]::Max(5,$PollSeconds))
  }
} finally {
  Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
  Log "supervisor stopped pid=$PID"
}

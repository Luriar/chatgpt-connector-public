param(
  [ValidateSet("legacy", "nas", "windows")]
  [string]$Profile = "legacy",
  [switch]$SkipFunnel,
  [int]$HealthTimeoutSeconds = 30,
  [int]$TailscaleTimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"
if ($Profile -ne "legacy") {
  & node (Join-Path $PSScriptRoot "runtime.js") start --profile $Profile
  if ($LASTEXITCODE -ne 0) { throw "Runtime start failed: $Profile" }
  return
}
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$healthUrl = "http://127.0.0.1:8747/health"
$coordUrl = "http://127.0.0.1:8780/health"
$runtimeDir = Join-Path $root ".webjjonku\work-runtime"
$watchdogScript = Join-Path $PSScriptRoot "chatgpt-ui-watchdog.ps1"
$nasConfigPath = Join-Path $root ".webjjonku\nas-runtime.json"
$nasRuntime = $null
if (Test-Path $nasConfigPath) {
  try {
    $candidate = Get-Content $nasConfigPath -Raw | ConvertFrom-Json
    if ([bool]$candidate.enabled) { $nasRuntime = $candidate }
  } catch {}
}
$nasMode = $null -ne $nasRuntime
if ($nasMode) { $coordUrl = ([string]$nasRuntime.coordinatorUrl).TrimEnd("/"); $healthUrl = "http://127.0.0.1:8748/health" }
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

function Test-HttpOk([string]$url) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    return $r.StatusCode -ge 200 -and $r.StatusCode -lt 300
  } catch { return $false }
}

function Wait-HttpOk([string]$url,[int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  do {
    if (Test-HttpOk $url) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Test-TcpUrl([string]$url) {
  try {
    $u = [Uri]$url
    $port = if ($u.IsDefaultPort) { if ($u.Scheme -eq "https") { 443 } else { 80 } } else { $u.Port }
    $c = New-Object System.Net.Sockets.TcpClient
    try {
      $a = $c.ConnectAsync($u.Host,$port)
      if (-not $a.Wait(3000)) { return $false }
      return $c.Connected
    } finally { $c.Dispose() }
  } catch { return $false }
}

function Get-CommandLineProcess([string]$pattern) {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine -match $pattern
  })
}

# 1) Main MCP daemon. NAS mode injects scoped coordinator credentials through the broker launcher.
$nasDaemon = @(Get-CommandLineProcess 'nas-client-launcher\.js.*--mode\s+daemon')
$needDaemonRestart = (-not (Test-HttpOk $healthUrl)) -or ($nasMode -and $nasDaemon.Count -eq 0)
if ($needDaemonRestart) {
  Get-CommandLineProcess 'scripts\\daemon\.js' | ForEach-Object {
    try { & taskkill.exe /PID $_.ProcessId /T /F *> $null } catch { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
  }
  Get-CommandLineProcess 'src\\index\.js.*--http' | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
  Get-CommandLineProcess 'nas-client-launcher\.js.*--mode\s+daemon' | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
  Start-Sleep -Milliseconds 700
  if ($nasMode) {
    Start-Process -FilePath $node -ArgumentList @("scripts\nas-client-launcher.js","--mode","daemon","--config",$nasConfigPath) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir "daemon-nas.out.log") -RedirectStandardError (Join-Path $runtimeDir "daemon-nas.err.log")
  } else {
    Start-Process -FilePath $node -ArgumentList @("scripts\daemon.js") -WorkingDirectory $root -WindowStyle Hidden
  }
  if (-not (Wait-HttpOk $healthUrl $HealthTimeoutSeconds)) {
    throw "ChatGPT Connector HTTP health check failed after daemon start."
  }
}

# 2) Coordinator. NAS mode never creates a forked local coordinator.
if ($nasMode) {
  Get-CommandLineProcess 'coordinator-server\.js.*--port\s+8780' | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
  if (-not (Test-TcpUrl $coordUrl)) { throw "NAS Work coordinator is unreachable: $coordUrl" }
} elseif (-not (Test-HttpOk $coordUrl)) {
  Get-CommandLineProcess 'coordinator-server\.js.*--port\s+8780' | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
  Start-Process -FilePath $node -ArgumentList @("scripts\coordinator-server.js","--host","127.0.0.1","--port","8780","--data",(Join-Path $runtimeDir "state.json"),"--blob-dir",(Join-Path $runtimeDir "blobs")) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir "coordinator.out.log") -RedirectStandardError (Join-Path $runtimeDir "coordinator.err.log")
  if (-not (Wait-HttpOk $coordUrl $HealthTimeoutSeconds)) {
    throw "Work coordinator health check failed after start."
  }
}

# 3) Browser worker. NAS mode attaches a Windows-specific worker to the NAS coordinator.
if ($nasMode) {
  Get-CommandLineProcess 'browser-worker\.js.*--coordinator\s+http://127\.0\.0\.1:8780.*--worker-id\s+cloud-browser-local' | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
  $browserWorkers = @(Get-CommandLineProcess 'nas-client-launcher\.js.*--mode\s+browser')
  if ($browserWorkers.Count -eq 0) {
    Start-Process -FilePath $node -ArgumentList @("scripts\nas-client-launcher.js","--mode","browser","--config",$nasConfigPath) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir "browser-windows.out.log") -RedirectStandardError (Join-Path $runtimeDir "browser-windows.err.log")
    Start-Sleep -Seconds 2
  } elseif ($browserWorkers.Count -gt 1) {
    $browserWorkers | Select-Object -Skip 1 | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
  }
} else {
  $browserWorkers = @(Get-CommandLineProcess 'browser-worker\.js.*--coordinator\s+http://127\.0\.0\.1:8780.*--worker-id\s+cloud-browser-local')
  if ($browserWorkers.Count -eq 0) {
    Start-Process -FilePath $node -ArgumentList @("scripts\browser-worker.js","--coordinator","http://127.0.0.1:8780","--worker-id","cloud-browser-local","--poll-ms","3000") -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir "browser-worker.out.log") -RedirectStandardError (Join-Path $runtimeDir "browser-worker.err.log")
    Start-Sleep -Seconds 2
  } elseif ($browserWorkers.Count -gt 1) {
    $browserWorkers | Select-Object -Skip 1 | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
  }
}

# 4) Windows tool RPC worker. In NAS mode this keeps desktop/UIA/Office/local Windows files available through the NAS coordinator.
if ($nasMode) {
  $toolWorkers = @(Get-CommandLineProcess 'nas-client-launcher\.js.*--mode\s+tools')
  if ($toolWorkers.Count -eq 0) {
    Start-Process -FilePath $node -ArgumentList @("scripts\nas-client-launcher.js","--mode","tools","--config",$nasConfigPath) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir "windows-tools.out.log") -RedirectStandardError (Join-Path $runtimeDir "windows-tools.err.log")
    Start-Sleep -Seconds 2
  } elseif ($toolWorkers.Count -gt 1) {
    $toolWorkers | Select-Object -Skip 1 | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
  }
}

# 5) ChatGPT stream-timeout UI watchdog, only when previously enabled.
if (Test-Path $watchdogScript) {
  $watchdogConfig = Join-Path $root ".webjjonku\ui-watchdog.json"
  $watchdogEnabled = $false
  if (Test-Path $watchdogConfig) {
    try { $watchdogEnabled = [bool]((Get-Content $watchdogConfig -Raw | ConvertFrom-Json).enabled) } catch {}
  }
  if ($watchdogEnabled) {
    $status = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdogScript -Action status | Out-String
    if ($status -notmatch '"pid"\s*:\s*\d+') {
      Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File",$watchdogScript,"-Action","run") -WorkingDirectory $root -WindowStyle Hidden
    }
  }
}

# 6) Public MCP Funnel. Reset removes stale extra path routes such as an old coordinator mapping.
if (-not $SkipFunnel) {
  $tailscale = "C:\Program Files\Tailscale\tailscale.exe"
  if (-not (Test-Path $tailscale)) { throw "Tailscale CLI not found: $tailscale" }
  try {
    $svc = Get-Service -Name "Tailscale" -ErrorAction Stop
    if ($svc.Status -ne "Running") { try { Start-Service -Name "Tailscale" -ErrorAction Stop } catch {} }
  } catch {}

  $deadline = (Get-Date).AddSeconds($TailscaleTimeoutSeconds)
  $online = $false
  do {
    & $tailscale status *> $null
    if ($LASTEXITCODE -eq 0) { $online = $true; break }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  if (-not $online) { throw "Tailscale did not become ready in time." }

  & $tailscale funnel reset *> $null
  & $tailscale funnel --bg --yes http://127.0.0.1:8747 *> $null
  if ($LASTEXITCODE -ne 0) { throw "Failed to enable Tailscale Funnel." }
  $funnel = (& $tailscale funnel status 2>$null | Out-String)
  if ($funnel -notmatch "proxy\s+http://127\.0\.0\.1:8747") { throw "Tailscale Funnel is not proxying to 127.0.0.1:8747." }
  if ($funnel -match "/coordinator") { throw "Unsafe stale coordinator Funnel route still exists." }
}

$coordOk = if ($nasMode) { Test-TcpUrl $coordUrl } else { Test-HttpOk $coordUrl }
$workerCount = if ($nasMode) { @(Get-CommandLineProcess 'nas-client-launcher\.js.*--mode\s+browser').Count } else { @(Get-CommandLineProcess 'browser-worker\.js.*--coordinator\s+http://127\.0\.0\.1:8780.*--worker-id\s+cloud-browser-local').Count }
$toolWorkerCount = if ($nasMode) { @(Get-CommandLineProcess 'nas-client-launcher\.js.*--mode\s+tools').Count } else { 0 }
Write-Host "ChatGPT Connector ready. nasMode=$nasMode coordinator=$coordOk browserWorker=$workerCount windowsToolWorker=$toolWorkerCount"

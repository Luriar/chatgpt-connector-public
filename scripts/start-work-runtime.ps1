param(
  [int]$CoordinatorPort = 8780,
  [string]$WorkerId = "cloud-browser-local"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".webjjonku\work-runtime"
$coordOut = Join-Path $stateDir "coordinator.out.log"
$coordErr = Join-Path $stateDir "coordinator.err.log"
$workerOut = Join-Path $stateDir "browser-worker.out.log"
$workerErr = Join-Path $stateDir "browser-worker.err.log"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Test-Coordinator {
  try {
    $r = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $CoordinatorPort + "/health") -TimeoutSec 3
    return [bool]$r.ok
  } catch { return $false }
}

if (-not (Test-Coordinator)) {
  $listener = Get-NetTCPConnection -LocalPort $CoordinatorPort -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    foreach ($pidValue in ($listener.OwningProcess | Select-Object -Unique)) {
      try { Stop-Process -Id $pidValue -Force -ErrorAction Stop } catch {}
    }
    Start-Sleep -Milliseconds 700
  }

  Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList @(
      "scripts\coordinator-server.js",
      "--host","127.0.0.1",
      "--port",[string]$CoordinatorPort,
      "--data",(Join-Path $stateDir "state.json"),
      "--blob-dir",(Join-Path $stateDir "blobs")
    ) `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $coordOut `
    -RedirectStandardError $coordErr

  $ready = $false
  for ($i=0; $i -lt 40; $i++) {
    if (Test-Coordinator) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw "Coordinator failed health check. See $coordErr" }
}

$workerPattern = "browser-worker\.js.*--worker-id\s+" + [regex]::Escape($WorkerId)
$worker = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $workerPattern } |
  Select-Object -First 1

if (-not $worker) {
  Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList @(
      "scripts\browser-worker.js",
      "--coordinator",("http://127.0.0.1:" + $CoordinatorPort),
      "--worker-id",$WorkerId,
      "--poll-ms","3000"
    ) `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $workerOut `
    -RedirectStandardError $workerErr
}

Start-Sleep -Seconds 2
$workerCount = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $workerPattern }).Count

[pscustomobject]@{
  coordinatorReady = (Test-Coordinator)
  coordinatorPort = $CoordinatorPort
  workerId = $WorkerId
  workerProcesses = $workerCount
} | ConvertTo-Json -Compress

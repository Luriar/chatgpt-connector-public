param(
  [int]$PollSeconds = 15,
  [int]$RecoveryTimeoutSeconds = 12
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".webjjonku"
$pidPath = Join-Path $stateDir "windows-aux-supervisor.pid"
$logPath = Join-Path $stateDir "windows-aux-supervisor.log"
$startScript = Join-Path $PSScriptRoot "start-chatgpt-connector.ps1"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Log([string]$message) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $message" -Encoding UTF8
}

if (Test-Path $pidPath) {
  try {
    $oldPid = [int](Get-Content $pidPath -Raw)
    $old = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid" -ErrorAction SilentlyContinue
    if ($old -and $old.CommandLine -match 'supervise-windows-auxiliary\.ps1') { exit 0 }
  } catch {}
}
$PID | Set-Content -LiteralPath $pidPath -Encoding ASCII

try {
  Log "aux supervisor started pid=$PID"
  while ($true) {
    try {
      $args = @("-NoProfile","-ExecutionPolicy","Bypass","-File",$startScript,"-Profile","windows")
      $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $args -WindowStyle Hidden -PassThru
      if (-not $proc.WaitForExit([Math]::Max(5,$RecoveryTimeoutSeconds) * 1000)) {
        try { & taskkill.exe /PID $proc.Id /T /F *> $null } catch { try { $proc.Kill() } catch {} }
        Log "aux ensure timed_out timeoutSeconds=$RecoveryTimeoutSeconds"
      } elseif ($proc.ExitCode -ne 0) {
        Log "aux ensure failed exitCode=$($proc.ExitCode)"
      }
    } catch {
      Log ("aux ensure failed error=" + $_.Exception.Message)
    }
    Start-Sleep -Seconds ([Math]::Max(5,$PollSeconds))
  }
} finally {
  Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
  Log "aux supervisor stopped pid=$PID"
}

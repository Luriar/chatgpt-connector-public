# Requires Administrator. Does NOT reboot automatically.
# Enables the Windows features needed for the dedicated webjjonku WSL2 guest.
$ErrorActionPreference = "Stop"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Error "Administrator PowerShell is required. Re-open PowerShell as Administrator and run this script."
  exit 1
}
$features = @("Microsoft-Windows-Subsystem-Linux","VirtualMachinePlatform")
$changed = $false
foreach ($f in $features) {
  $state = (Get-WindowsOptionalFeature -Online -FeatureName $f).State
  Write-Host "$f : $state"
  if ($state -ne "Enabled") {
    Enable-WindowsOptionalFeature -Online -FeatureName $f -All -NoRestart | Out-Null
    $changed = $true
    Write-Host "Enabled: $f"
  }
}
try { wsl --update } catch { Write-Warning "wsl --update failed: $($_.Exception.Message)" }
Write-Host ""
if ($changed) {
  Write-Host "A Windows restart is required before vm_prepare can create the dedicated guest."
} else {
  Write-Host "Required Windows features are already enabled."
}
Write-Host "This script intentionally does not restart the PC."

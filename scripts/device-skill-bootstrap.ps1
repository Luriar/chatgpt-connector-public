param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [string]$CanonicalRoot='\\TS-253D\NAS_Drive\ChatGPT-Connector\skills-canonical',
  [ValidateSet('Check','Apply')][string]$Mode='Check',
  [string]$ExpectedHostname=''
)
$ErrorActionPreference='Stop'
if($ExpectedHostname -and $env:COMPUTERNAME -ine $ExpectedHostname){
  throw "WRONG_DEVICE: expected=$ExpectedHostname actual=$env:COMPUTERNAME"
}
$manifest=Join-Path $CanonicalRoot 'manifest.json'
$script=Join-Path $ProjectRoot 'scripts\sync-shared-skills.mjs'
if(-not (Test-Path -LiteralPath $manifest)){throw 'NAS catalog not accessible'}
if(-not (Test-Path -LiteralPath $script)){throw 'Connector checkout not accessible'}
$node=(Get-Command node -ErrorAction Stop).Source
$dest=Join-Path $ProjectRoot 'skills'
Write-Output ('HOST='+$env:COMPUTERNAME+' MODE='+$Mode)
& $node $script ('--source='+$CanonicalRoot) ('--dest='+$dest) ('--'+$Mode.ToLowerInvariant())
if($LASTEXITCODE -ne 0){throw ('Skill sync failed code='+$LASTEXITCODE)}
Write-Output 'DEVICE_SKILL_SYNC_PASS'

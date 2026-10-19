$ErrorActionPreference='Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)
Remove-Item '.\parity.log','.\parity.exit' -Force -ErrorAction SilentlyContinue
& node '.\scripts\parity-test.js' *> '.\parity.log'
$LASTEXITCODE | Set-Content '.\parity.exit'

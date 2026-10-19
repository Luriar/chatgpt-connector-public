Set-Location (Split-Path $PSScriptRoot -Parent)
Remove-Item parity-final.log,parity-final.exit -Force -ErrorAction SilentlyContinue
npm run test:parity *> parity-final.log
$LASTEXITCODE | Set-Content parity-final.exit

Set-Location (Split-Path $PSScriptRoot -Parent)
Remove-Item work-final.log,work-final.exit -Force -ErrorAction SilentlyContinue
npm run test:work *> work-final.log
$LASTEXITCODE | Set-Content work-final.exit

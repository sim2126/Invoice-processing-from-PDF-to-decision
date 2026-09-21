$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.env'))) {
    throw 'Create .env from .env.example and configure the extraction credentials first.'
}
Push-Location $projectRoot
try {
    docker compose up --build -d
    if ($LASTEXITCODE -ne 0) { throw 'Docker startup failed. Inspect the error above.' }
    Write-Host 'AP Review Desk: http://localhost:3000'
} finally { Pop-Location }

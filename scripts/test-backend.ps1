$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    $testDatabase = docker compose exec -T db psql -U ap -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='apdesk_test'"
    if ($testDatabase -notmatch '1') {
        docker compose exec -T db psql -U ap -d postgres -c 'CREATE DATABASE apdesk_test'
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated test database.' }
    }
    docker compose exec -e DATABASE_URL=postgresql+psycopg://ap:ap_local_only@db:5432/apdesk_test api uv run --no-sync alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw 'Test migration failed.' }
    docker compose exec -e DATABASE_URL=postgresql+psycopg://ap:ap_local_only@db:5432/apdesk_test -e AP_INTEGRATION=1 api uv run --no-sync pytest -q
    if ($LASTEXITCODE -ne 0) { throw 'Backend checks failed.' }
} finally { Pop-Location }

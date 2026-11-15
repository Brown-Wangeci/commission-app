# Stops everything scripts/demo-start.ps1 started; PostgreSQL is shut down
# cleanly first. See docs/RUNBOOK.md.
$app = Join-Path $PSScriptRoot "..\app"
Push-Location $app
try {
  & node "node_modules/tsx/dist/cli.mjs" "scripts/demo.ts" "stop"
  exit $LASTEXITCODE
} finally {
  Pop-Location
}

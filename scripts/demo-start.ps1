# Starts the local demo in the background and returns once it answers:
# PostgreSQL, migrations, the scoring service and the app, optionally the seed
# and the scheduler. Stop it with scripts/demo-stop.ps1. See docs/RUNBOOK.md.
#
#   scripts/demo-start.ps1 [-Seed] [-Scheduler] [-Dev]
param([switch]$Seed, [switch]$Scheduler, [switch]$Dev)
$app = Join-Path $PSScriptRoot "..\app"
$flags = @()
if ($Seed) { $flags += "--seed" }
if ($Scheduler) { $flags += "--scheduler" }
if ($Dev) { $flags += "--dev" }
Push-Location $app
try {
  & node "node_modules/tsx/dist/cli.mjs" "scripts/demo.ts" "start" @flags
  exit $LASTEXITCODE
} finally {
  Pop-Location
}

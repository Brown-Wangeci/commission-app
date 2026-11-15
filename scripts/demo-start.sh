#!/bin/sh
# Starts the local demo in the background and returns once it answers:
# PostgreSQL, migrations, the scoring service and the app, optionally the seed
# and the scheduler. Stop it with scripts/demo-stop.sh. See docs/RUNBOOK.md.
#
#   scripts/demo-start.sh [--seed] [--scheduler] [--dev]
set -e
cd "$(dirname "$0")/../app"
exec node node_modules/tsx/dist/cli.mjs scripts/demo.ts start "$@"

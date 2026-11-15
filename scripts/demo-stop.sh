#!/bin/sh
# Stops everything scripts/demo-start.sh started; PostgreSQL is shut down
# cleanly first. See docs/RUNBOOK.md.
set -e
cd "$(dirname "$0")/../app"
exec node node_modules/tsx/dist/cli.mjs scripts/demo.ts stop

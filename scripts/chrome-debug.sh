#!/usr/bin/env bash
# ============================================================
# chrome-debug.sh — POSIX compatibility delegate (v3)
#
# The real lifecycle lives in the shared Node engine
# (scripts/lib/chrome-debug-lifecycle.cjs), reached through the
# extensionless helper scripts/chrome-debug. This file keeps the
# historical `.sh` invocation working without owning any process,
# profile, or lifecycle logic of its own.
#
# Canonical invocations:
#   POSIX:   bash scripts/chrome-debug [options] [URL]
#   Windows: scripts\run-helper.cmd chrome-debug [options] [URL]
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec bash "${SCRIPT_DIR}/run-helper.cmd" chrome-debug "$@"

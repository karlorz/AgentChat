#!/bin/bash
# ============================================================
# start-chrome-debug.sh — legacy compatibility delegate
#
# Historical entry point for the old Playwright daemon
# (start-chrome-debug.py, removed). The daemon is gone: this script
# only preserves the legacy default profile and forwards to the
# shared lifecycle engine through the run-helper.cmd bridge.
#
# The engine itself loads .env safely (no `source`), honors
# HEADLESS=1/true/yes, and resolves CHROME_PROFILE →
# CHROME_DEBUG_PROFILE → platform default, so no other legacy
# behavior needs re-implementing here.
#
# Usage:
#   bash start-chrome-debug.sh                    # visible window (default)
#   HEADLESS=1 bash start-chrome-debug.sh         # headless mode
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Legacy default profile (old daemon's ~/.chrome-debug-profile). Set only
# when the caller configured nothing; the engine loads .env afterwards and
# will not override an already-set variable.
if [[ -z "${CHROME_PROFILE:-}" && -z "${CHROME_DEBUG_PROFILE:-}" ]]; then
    export CHROME_PROFILE="$HOME/.chrome-debug-profile"
fi

exec bash "$SCRIPT_DIR/run-helper.cmd" chrome-debug "$@"

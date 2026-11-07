#!/usr/bin/env bash

# Runs one ad hoc Playwright spec for the qa-check phase with a hard time cap,
# then deletes the spec. Playwright runs in its own process group so a hang
# (browser, npx, node workers) is killed as a whole instead of leaving the
# agent waiting on orphaned children.
#
# Usage: ./pw.sh <spec under $DASH/tools/playwright/tmp/> [timeout_s=240]
# Env:   BASE_URL (default http://qa.localhost:5100), WEB_REPO_ROOT (default: main checkout)

set -uo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <spec> [timeout_s]" >&2
  exit 1
fi

PW_DIR="$(cd -P "$SCRIPT_DIR/../../.." && pwd)/tools/playwright"
SPEC="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
TIMEOUT_S="${2:-240}"
case "$SPEC" in
  "$PW_DIR"/tmp/*) : ;;
  *) echo "pw.sh: spec must live in $PW_DIR/tmp/" >&2; exit 1 ;;
esac
[ -f "$SPEC" ] || { echo "pw.sh: no such spec: $SPEC" >&2; exit 1; }

export BASE_URL="${BASE_URL:-http://qa.localhost:5100}"
export WEB_REPO_ROOT="${WEB_REPO_ROOT:-$(resolve_repo_root)}"

set -m
(cd "$PW_DIR" && exec npx playwright test "${SPEC#"$PW_DIR"/}" --global-timeout="$((TIMEOUT_S * 1000))" --reporter=line --workers=1) &
PW_PID=$!
set +m

kill_group() { kill -0 -- "-$PW_PID" 2>/dev/null || return 0; kill -TERM -- "-$PW_PID" 2>/dev/null; sleep 5; kill -KILL -- "-$PW_PID" 2>/dev/null; }
cleanup() { kill "$WATCHDOG" 2>/dev/null; kill_group; rm -f "$SPEC"; }
(sleep "$((TIMEOUT_S + 60))"; echo "pw.sh: killed after $((TIMEOUT_S + 60))s" >&2; kill_group) &
WATCHDOG=$!
trap cleanup EXIT
trap 'exit 130' INT TERM

wait "$PW_PID"

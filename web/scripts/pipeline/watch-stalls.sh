#!/usr/bin/env bash

# Stall watchdog for a supervised run, meant to be the command of a Claude Code
# Monitor. Every agent appends a line to its ticket's heartbeat file
# (<worktree>/.ai-workspace/jira-plans/<TICKET-ID>/progress.log); this prints
# one `STALE <TICKET-ID> <minutes>m | <last line>` event when a ticket's file
# has not changed for <minutes>, and again only after it changes and goes quiet
# once more. Tickets whose last line starts with FINISHED are ignored. Exits
# when every ticket is FINISHED.
#
# Usage: ./watch-stalls.sh <minutes> <TICKET-ID> [<TICKET-ID> ...]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <minutes> <TICKET-ID> [<TICKET-ID> ...]" >&2
  exit 1
fi

LIMIT_MIN="$1"
shift
REPO_ROOT="$(resolve_repo_root)"
STATE_DIR="$(mktemp -d)"
trap 'rm -rf "$STATE_DIR"' EXIT

while :; do
  open=0
  now="$(date +%s)"
  for t in "$@"; do
    hb="$REPO_ROOT/.ai-workspace/worktrees/$t/.ai-workspace/jira-plans/$t/progress.log"
    if [ ! -f "$hb" ]; then
      open=$((open + 1))
      continue
    fi
    last="$(tail -n 1 "$hb")"
    case "$last" in
      FINISHED*) continue ;;
    esac
    open=$((open + 1))
    mtime="$(stat -f %m "$hb" 2>/dev/null || stat -c %Y "$hb")"
    age_min=$(( (now - mtime) / 60 ))
    if [ "$age_min" -ge "$LIMIT_MIN" ] && [ "$(cat "$STATE_DIR/$t" 2>/dev/null)" != "$mtime" ]; then
      echo "STALE $t ${age_min}m | $last"
      echo "$mtime" >"$STATE_DIR/$t"
    fi
  done
  [ "$open" -eq 0 ] && exit 0
  sleep 60
done

#!/usr/bin/env bash

# Atomically claim one pipeline slot for a ticket (MAX_SLOTS in lib.sh). Does
# NOT retry: if all are busy it reports who's holding them and exits non-zero.
# Used by run-ticket-pipeline.sh for the initial claim, and by reclaim-slot.sh
# (which does retry) after a Slack escalation wait.
#
# Usage: ./claim-slot.sh <repo-root> <ticket-id>
#
# On success: creates .claude/pipeline-slots/<N>/{ticket,started_at}, writes
# .claude/pipeline-slots/.owner-<TICKET-ID> with the claimed slot number, and
# prints the slot number on stdout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

if [ $# -ne 2 ]; then
  echo "Usage: $0 <repo-root> <ticket-id>" >&2
  exit 1
fi

REPO_ROOT="$1"
TICKET_ID="$2"
SLOTS_DIR="$REPO_ROOT/.claude/pipeline-slots"

mkdir -p "$SLOTS_DIR"

if try_claim_slot "$SLOTS_DIR" "$TICKET_ID"; then
  exit 0
fi

echo "No pipeline slot available (max $MAX_SLOTS concurrent tickets). Currently occupied:" >&2
for i in $(seq 1 "$MAX_SLOTS"); do
  d="$SLOTS_DIR/$i"
  if [ -d "$d" ]; then
    t=$(cat "$d/ticket" 2>/dev/null || echo "?")
    started=$(cat "$d/started_at" 2>/dev/null || echo "?")
    echo "  slot $i: $t (started $started)" >&2
  fi
done
exit 1

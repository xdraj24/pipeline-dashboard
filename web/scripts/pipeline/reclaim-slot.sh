#!/usr/bin/env bash

# Re-claim a pipeline slot for a ticket after a Slack escalation wait (see
# .claude/skills/_shared/slack-escalation.md), once a reply has arrived or the
# wait has timed out and real work is about to resume. Unlike claim-slot.sh,
# this retries indefinitely instead of failing fast — the ticket already made
# it through the pipeline once and shouldn't be dropped because every slot is
# momentarily busy.
#
# Usage: ./reclaim-slot.sh <repo-root> <ticket-id>
#
# Prints the reclaimed slot number (which may differ from the one held before
# release) and updates .claude/pipeline-slots/.owner-<TICKET-ID>.

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

until try_claim_slot "$SLOTS_DIR" "$TICKET_ID"; do
  sleep 5
done

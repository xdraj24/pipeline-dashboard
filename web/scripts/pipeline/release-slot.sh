#!/usr/bin/env bash

# Release the pipeline slot currently owned by a ticket, e.g. while a skill is
# idly polling Slack for a reply during unattended escalation (see
# .claude/skills/_shared/slack-escalation.md) and isn't doing Docker/DB work.
# Pair with reclaim-slot.sh once real work is about to resume.
#
# Usage: ./release-slot.sh <repo-root> <ticket-id>
#
# Reads .ai-workspace/pipeline-slots/.owner-<TICKET-ID> to find which slot number is
# currently held, removes that slot directory, then removes the owner file.
# The owner file (not a variable held in memory) is the single source of
# truth for "which slot does this ticket currently hold" — it's what lets the
# coordinator script's EXIT trap clean up correctly even though the slot
# number can change out from under it via this script, running in a
# completely separate headless agent process.

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <repo-root> <ticket-id>" >&2
  exit 1
fi

REPO_ROOT="$1"
TICKET_ID="$2"
OWNER_FILE="$REPO_ROOT/.ai-workspace/pipeline-slots/.owner-$TICKET_ID"

if [ ! -f "$OWNER_FILE" ]; then
  echo "No owner file for $TICKET_ID — nothing to release" >&2
  exit 0
fi

SLOT=$(cat "$OWNER_FILE")
rm -rf "$REPO_ROOT/.ai-workspace/pipeline-slots/$SLOT"
rm -f "$OWNER_FILE"
echo "Released slot $SLOT for $TICKET_ID"

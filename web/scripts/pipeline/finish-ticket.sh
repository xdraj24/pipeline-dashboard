#!/usr/bin/env bash

# End of a supervised ticket run: copy the ticket's artifacts from its worktree
# back to the main checkout (so /w-3-land-branch can read them) and release its
# pipeline slot. Safe to run after a failure too; the worktree stays in place.
#
# Usage: ./finish-ticket.sh <TICKET-ID>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

if [ $# -ne 1 ]; then
  echo "Usage: $0 <TICKET-ID>" >&2
  exit 1
fi

TICKET_ID="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
REPO_ROOT="$(resolve_repo_root)"
WORKTREE="$REPO_ROOT/.ai-workspace/worktrees/$TICKET_ID"

mkdir -p "$REPO_ROOT/.ai-workspace/jira-plans"
if [ -d "$WORKTREE/.ai-workspace/jira-plans/$TICKET_ID" ]; then
  cp -Rp "$WORKTREE/.ai-workspace/jira-plans/$TICKET_ID" "$REPO_ROOT/.ai-workspace/jira-plans/"
  echo "Copied artifacts back to .ai-workspace/jira-plans/$TICKET_ID"
fi

"$SCRIPT_DIR/release-slot.sh" "$REPO_ROOT" "$TICKET_ID"

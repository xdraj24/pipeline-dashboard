#!/usr/bin/env bash

# Prepare one ticket's pipeline worktree: claim a slot (or keep the one the
# ticket already holds), create or reuse .ai-workspace/worktrees/<TICKET-ID> at
# fresh origin/main, copy in the plan, skills and host config, link
# node_modules, prepare the slot's test database, and write
# <worktree>/.ai-workspace/pipeline.env for every later stage to source.
#
# Used by run-ticket-pipeline.sh (unattended) and by the supervised coordinator
# (.claude/skills/_shared/supervised-run.md). Progress goes to stderr; stdout is
# only the shell-quoted SLOT=, WORKTREE= and CONTAINER_WORKDIR= assignments, so
# a caller can `eval` it.
#
# Usage: ./prepare-worktree.sh <TICKET-ID> <unattended|supervised> [<wait-for-reply-minutes>]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "Usage: $0 <TICKET-ID> <unattended|supervised> [<wait-for-reply-minutes>]" >&2
  exit 1
fi

TICKET_ID="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
MODE="$2"
WAIT_FOR_REPLY="${3:-}"

if ! [[ "$TICKET_ID" =~ ^XWWP-[0-9]+$ ]]; then
  echo "Ticket id must look like XWWP-1234, got: $TICKET_ID" >&2
  exit 1
fi
case "$MODE" in
  unattended|supervised) : ;;
  *)
    echo "Mode must be unattended or supervised, got: $MODE" >&2
    exit 1
    ;;
esac

REPO_ROOT="$(resolve_repo_root)"

# Copy the supervisor checkout's container-aware hooks into a worktree cut from
# origin/main. skip-worktree so `git add -A` does not commit them with the ticket.
# The helper stays in the main checkout; the hooks source it from there until
# this change is on origin/main.
overlay_dev_hooks() {
  local repo_root="$1" worktree="$2" f
  for f in hooks/rubocop.sh hooks/biome-check.sh hooks/graphql-codegen.sh; do
    [ -f "$repo_root/$f" ] || continue
    mkdir -p "$worktree/$(dirname "$f")"
    cp "$repo_root/$f" "$worktree/$f"
    if git -C "$worktree" ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      if ! git -C "$worktree" diff --quiet -- "$f"; then
        git -C "$worktree" update-index --skip-worktree "$f"
      fi
    fi
  done
}
SLOTS_DIR="$REPO_ROOT/.ai-workspace/pipeline-slots"
OWNER_FILE="$SLOTS_DIR/.owner-$TICKET_ID"
mkdir -p "$SLOTS_DIR"

SLOT=""
if [ -f "$OWNER_FILE" ]; then
  held="$(cat "$OWNER_FILE")"
  if [ -n "$held" ] && [ "$(cat "$SLOTS_DIR/$held/ticket" 2>/dev/null)" = "$TICKET_ID" ]; then
    SLOT="$held"
    echo "Keeping slot $SLOT already held by $TICKET_ID." >&2
  fi
fi
if [ -z "$SLOT" ]; then
  SLOT="$("$SCRIPT_DIR/claim-slot.sh" "$REPO_ROOT" "$TICKET_ID")"
  echo "Claimed slot: $SLOT" >&2
fi

# Worktrees don't share untracked files with the main checkout, and
# .ai-workspace/jira-plans/ is untracked, so plan.md etc. are copied in.
WORKTREE="$REPO_ROOT/.ai-workspace/worktrees/$TICKET_ID"

git -C "$REPO_ROOT" fetch origin main >&2

if [ -d "$WORKTREE" ]; then
  echo "Worktree already exists at $WORKTREE — reusing it." >&2
else
  git -C "$REPO_ROOT" worktree add -d "$WORKTREE" origin/main >&2
fi

mkdir -p "$WORKTREE/.ai-workspace/jira-plans"
if [ -f "$REPO_ROOT/.ai-workspace/jira-plans/$TICKET_ID/plan.md" ]; then
  echo "Existing plan found in main checkout — copying into worktree." >&2
  cp -r "$REPO_ROOT/.ai-workspace/jira-plans/$TICKET_ID" "$WORKTREE/.ai-workspace/jira-plans/"
fi

# .claude/skills/ is untracked, so a worktree from origin/main has no skills.
# Copy them in, plus the per-host MCP config for JIRA/Slack and the
# Codex/Cursor discovery files (symlinks stay relative).
if [ -d "$REPO_ROOT/.claude/skills" ]; then
  mkdir -p "$WORKTREE/.claude"
  rm -rf "$WORKTREE/.claude/skills"
  cp -R "$REPO_ROOT/.claude/skills" "$WORKTREE/.claude/"
else
  echo "No .claude/skills/ in $REPO_ROOT — the /w-* stage commands will not resolve." >&2
  exit 1
fi

for f in .mcp.json .claude/settings.json .claude/settings.local.json flags.json \
    .codex/config.toml .codex/agents .cursor/mcp.json .agents AGENTS.md; do
  if { [ -e "$REPO_ROOT/$f" ] || [ -L "$REPO_ROOT/$f" ]; } \
      && ! { [ -e "$WORKTREE/$f" ] || [ -L "$WORKTREE/$f" ]; }; then
    mkdir -p "$WORKTREE/$(dirname "$f")"
    cp -RP "$REPO_ROOT/$f" "$WORKTREE/$f"
  fi
done

# origin/main's hooks `docker run` an image whose gems lag Gemfile.lock.
# Overlay this checkout's hooks and keep that diff out of the ticket commit.
overlay_dev_hooks "$REPO_ROOT" "$WORKTREE"

# The dev containers mount the main checkout at /app, so the worktree is
# visible inside them at this path (see .claude/skills/_shared/run-checks.md).
CONTAINER_WORKDIR="/app/.ai-workspace/worktrees/$TICKET_ID"

if docker exec web-spa-1 ln -sf /app/frontend/node_modules "$CONTAINER_WORKDIR/frontend/node_modules" 2>/dev/null; then
  echo "Symlinked frontend/node_modules into the worktree." >&2
else
  echo "Warning: could not symlink frontend/node_modules into the worktree (best-effort, non-fatal)." >&2
fi

TEST_ENV_NUMBER=$((SLOT + 1))
{
  echo "export PIPELINE_MODE=$MODE"
  echo "export PIPELINE_REPO_ROOT=$(printf %q "$REPO_ROOT")"
  echo "export PIPELINE_CONTAINER_WORKDIR=$(printf %q "$CONTAINER_WORKDIR")"
  echo "export TEST_ENV_NUMBER=$TEST_ENV_NUMBER"
  if [ -n "$WAIT_FOR_REPLY" ]; then
    echo "export WAIT_FOR_REPLY_MINUTES=$WAIT_FOR_REPLY"
  fi
} >"$WORKTREE/.ai-workspace/pipeline.env"

# One test database per slot (welligence_test<TEST_ENV_NUMBER>, see
# backend/config/database.yml), so concurrent tickets never share one.
if docker exec -e TEST_ENV_NUMBER="$TEST_ENV_NUMBER" -e RAILS_ENV=test -w "$CONTAINER_WORKDIR/backend" web-web-1 \
    bundle exec rails db:prepare >/dev/null 2>&1; then
  echo "Test database welligence_test$TEST_ENV_NUMBER is ready." >&2
else
  echo "Warning: could not prepare welligence_test$TEST_ENV_NUMBER — backend specs in this run may fail." >&2
fi

printf 'SLOT=%q\nWORKTREE=%q\nCONTAINER_WORKDIR=%q\n' "$SLOT" "$WORKTREE" "$CONTAINER_WORKDIR"

#!/usr/bin/env bash

# Lists every ticket the pipeline has state for — .ai-workspace/jira-plans/<T>/ and/or
# .ai-workspace/worktrees/<T> — with its local-branch.md status, whether the
# worktree still exists, and whether its PR is merged (via gh). With --apply,
# removes the worktree, the plan directory and the pipeline-logs entries of
# every ticket whose PR is merged. Dry-run by default.
#
# Usage: ./scripts/pipeline/prune.sh [--apply]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *)
      echo "Usage: $0 [--apply]" >&2
      exit 1
      ;;
  esac
done

REPO_ROOT="$(resolve_repo_root)"
PLANS_DIR="$REPO_ROOT/.ai-workspace/jira-plans"
WORKTREES_DIR="$REPO_ROOT/.ai-workspace/worktrees"
LOGS_DIR="$REPO_ROOT/.ai-workspace/pipeline-logs"

tickets="$( (ls "$PLANS_DIR" 2>/dev/null; ls "$WORKTREES_DIR" 2>/dev/null) \
  | grep -E '^XWWP-[0-9]+$' | sort -u)"
others="$(ls "$WORKTREES_DIR" 2>/dev/null | grep -vE '^XWWP-[0-9]+$' || true)"

if [ -z "$tickets" ] && [ -z "$others" ]; then
  echo "Nothing to prune."
  exit 0
fi

pr_state() {
  local branch="$1"
  [ -z "$branch" ] && { echo "-"; return; }
  gh pr list --head "$branch" --state all --json state -q '.[0].state' 2>/dev/null \
    | tr '[:upper:]' '[:lower:]' | sed 's/^$/none/'
}

printf "%-12s %-20s %-9s %-8s %s\n" TICKET STATUS WORKTREE PR BRANCH
MERGED=""
for t in $tickets; do
  lb="$PLANS_DIR/$t/local-branch.md"
  status="no-plan"
  branch=""
  if [ -d "$PLANS_DIR/$t" ]; then
    status="planned"
    if [ -f "$lb" ]; then
      status="$(grep -m1 '^status:' "$lb" | sed 's/^status: *//')"
      branch="$(grep -m1 '^branch:' "$lb" | sed 's/^branch: *//')"
    fi
  fi
  if [ -z "$branch" ] && [ -d "$WORKTREES_DIR/$t" ]; then
    branch="$(git -C "$WORKTREES_DIR/$t" branch --show-current 2>/dev/null || true)"
  fi
  wt="no"
  [ -d "$WORKTREES_DIR/$t" ] && wt="yes"
  pr="$(pr_state "$branch")"
  printf "%-12s %-20s %-9s %-8s %s\n" "$t" "$status" "$wt" "$pr" "${branch:--}"
  [ "$pr" = "merged" ] && MERGED="$MERGED $t"
done

for o in $others; do
  printf "%-12s %-20s %-9s %-8s %s\n" "$o" "not-pipeline" "yes" "-" \
    "$(git -C "$WORKTREES_DIR/$o" branch --show-current 2>/dev/null || echo '-')"
done

echo ""
if [ -z "$MERGED" ]; then
  echo "No merged tickets to prune."
  exit 0
fi

echo "Merged:$MERGED"
if [ "$APPLY" -eq 0 ]; then
  echo "Dry run. Re-run with --apply to remove their worktrees, plan dirs and log entries."
  exit 0
fi

for t in $MERGED; do
  if [ -d "$WORKTREES_DIR/$t" ]; then
    # Same exclusions as run-ticket-pipeline.sh: the scaffolding it copies in
    # is untracked there and would make every worktree look dirty.
    if [ -n "$(git -C "$WORKTREES_DIR/$t" status --porcelain -- . \
        ':!.ai-workspace' ':!.claude' ':!.mcp.json' ':!flags.json' \
        ':!.codex' ':!.cursor' ':!.agents' ':!AGENTS.md' 2>/dev/null)" ]; then
      echo "Skipping $t: worktree has uncommitted changes." >&2
      continue
    fi
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREES_DIR/$t"
  fi
  rm -rf "$PLANS_DIR/$t"
  rm -f "$LOGS_DIR"/*/"$t".log "$LOGS_DIR"/*/"$t".status
  echo "Pruned $t"
done
git -C "$REPO_ROOT" worktree prune
# A run directory whose tickets are all pruned still holds the shared progress.log.
for d in "$LOGS_DIR"/*/; do
  [ -d "$d" ] || continue
  if [ -z "$(ls -A "$d" | grep -v '^progress\.log$')" ]; then
    rm -rf "$d"
  fi
done

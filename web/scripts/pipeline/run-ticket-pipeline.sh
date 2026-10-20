#!/usr/bin/env bash

# Run one XWWP ticket unattended, end to end, in its own git worktree:
# plan -> implement -> code-review -> commit -> qa-check [-> code-review ->
# commit, when QA changed code] [-> draft PR]. Plain, deterministic
# bash — no LLM calls happen in this script itself; each stage is a separate
# headless process of the host CLI (--agent / PIPELINE_AGENT: claude, codex or
# cursor, see lib.sh) running one phase of /w-1-coding (see
# .claude/skills/w-1-coding/), and the optional draft PR runs /w-4-publish.
#
# Usage:
#   ./scripts/pipeline/run-ticket-pipeline.sh <TICKET-ID> [--stages=<list>] [--draft-pr] [--waitForReply=<minutes>] [--agent=<host>]
#
# --stages takes a comma-separated subset of
# `plan,implement,code-review,commit,qa-check` and defaults to all five.
# /w-1-coding passes the stages that match the phase it was asked for (it
# always plans in the main checkout first, so `plan` only runs here when no
# plan exists yet). A qa-check stage whose qa-check.md says `code_changed: yes`
# re-runs code-review and commit whatever --stages said, so the worktree is
# never left with uncommitted QA fixes (the commit phase amends the ticket's
# single commit).
#
# --draft-pr runs `/w-4-publish <TICKET-ID> draft` after the commit stage:
# rebase onto fresh origin/main, push, open a draft PR. It requires the commit
# stage to be in --stages.
#
# Up to MAX_SLOTS (lib.sh) tickets can run concurrently, coordinated via
# atomic-mkdir slot files under .claude/pipeline-slots/. Run this from any
# checkout of the repo, including from inside a worktree it previously
# created — the repo root is resolved via `git rev-parse --git-common-dir`
# so slot/`.jira-plans/` bookkeeping always lands in the right place.
#
# A Claude Code stage is capped by PIPELINE_MAX_TURNS (default 300) and, when
# PIPELINE_MAX_BUDGET_USD is set, by that spend; codex and cursor have no
# equivalent and ignore both. A stage that exits
# non-zero is re-run up to PIPELINE_STAGE_RETRIES times (default 1): every
# phase is re-entrant, so a retry resumes where the failed attempt stopped.
# All three are plain environment variables.
#
# Once all stages succeed, the ticket's `.jira-plans/<TICKET-ID>/local-branch.md`
# has `status: ready-for-review` (or `draft-pr-open` with --draft-pr) — run
# `/w-3-land-branch <TICKET-ID>` next to land it back into your main checkout
# for a human pass.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

ALL_STAGES="plan,implement,code-review,commit,qa-check"
PIPELINE_MAX_TURNS="${PIPELINE_MAX_TURNS:-300}"
PIPELINE_STAGE_RETRIES="${PIPELINE_STAGE_RETRIES:-1}"
if ! [[ "$PIPELINE_STAGE_RETRIES" =~ ^[0-9]+$ ]]; then
  echo "PIPELINE_STAGE_RETRIES must be a non-negative integer, got: $PIPELINE_STAGE_RETRIES" >&2
  exit 1
fi

usage() {
  echo "Usage: $0 <TICKET-ID> [--stages=<list>] [--draft-pr] [--waitForReply=<minutes>] [--agent=<host>]" >&2
  echo "       --stages: comma-separated subset of $ALL_STAGES (default: all)" >&2
  echo "       --draft-pr: open a draft PR after the commit stage" >&2
  echo "       --agent: claude (default), codex or cursor" >&2
  exit 1
}

if [ $# -lt 1 ]; then
  usage
fi

TICKET_ID="$1"
shift
WAIT_FOR_REPLY=""
STAGES="$ALL_STAGES"
DRAFT_PR=0

for arg in "$@"; do
  case "$arg" in
    --waitForReply=*)
      WAIT_FOR_REPLY="${arg#--waitForReply=}"
      ;;
    --stages=*)
      STAGES="${arg#--stages=}"
      ;;
    --draft-pr)
      DRAFT_PR=1
      ;;
    --agent=*)
      PIPELINE_AGENT="${arg#--agent=}"
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage
      ;;
  esac
done

validate_pipeline_agent || exit 1
export PIPELINE_AGENT
if ! command -v "$(agent_binary)" >/dev/null 2>&1; then
  echo "$(agent_binary) (the $PIPELINE_AGENT CLI) is not on PATH." >&2
  exit 1
fi

TICKET_ID="$(echo "$TICKET_ID" | tr '[:lower:]' '[:upper:]')"
if ! [[ "$TICKET_ID" =~ ^XWWP-[0-9]+$ ]]; then
  echo "Ticket id must look like XWWP-1234, got: $TICKET_ID" >&2
  exit 1
fi

if [ -n "$WAIT_FOR_REPLY" ] && ! [[ "$WAIT_FOR_REPLY" =~ ^[0-9]+$ ]]; then
  echo "--waitForReply must be a number of minutes, got: $WAIT_FOR_REPLY" >&2
  exit 1
fi

# `,a,b,` framing so a substring match can't cross a stage boundary.
stage_enabled() {
  case ",$STAGES," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -z "$STAGES" ]; then
  echo "--stages must name at least one of: $ALL_STAGES" >&2
  exit 1
fi
for stage in $(echo "$STAGES" | tr ',' ' '); do
  case ",$ALL_STAGES," in
    *",$stage,"*) : ;;
    *)
      echo "Unknown stage '$stage' — valid stages are: $ALL_STAGES" >&2
      exit 1
      ;;
  esac
done

if [ "$DRAFT_PR" -eq 1 ] && ! stage_enabled commit; then
  echo "--draft-pr needs the commit stage in --stages (got: $STAGES)." >&2
  exit 1
fi

REPO_ROOT="$(resolve_repo_root)"

echo "Repo root: $REPO_ROOT"
echo "Ticket:    $TICKET_ID"
echo "Stages:    $STAGES"
echo "Agent:     $PIPELINE_AGENT"
if [ "$DRAFT_PR" -eq 1 ]; then
  echo "Draft PR:  yes"
fi

# Without the plan stage there is nothing to generate a plan, so one must
# already exist in the main checkout. Check before claiming a slot so a missing
# plan fails instantly instead of holding a slot hostage.
if ! stage_enabled plan && [ ! -f "$REPO_ROOT/.jira-plans/$TICKET_ID/plan.md" ]; then
  echo "No plan at .jira-plans/$TICKET_ID/plan.md and the 'plan' stage is disabled." >&2
  echo "Run /w-1-coding $TICKET_ID just-plan first, or add 'plan' to --stages." >&2
  exit 1
fi

# 2. Claim a slot via atomic mkdir. The owner file
# (.claude/pipeline-slots/.owner-<TICKET_ID>) is the single source of truth
# for "which slot number does this ticket currently hold" — the Slack
# escalation helpers (release-slot.sh / reclaim-slot.sh) update it from a
# completely separate headless agent process while this script is blocked
# waiting for that process to exit, so the slot number this script started
# with can go stale. The EXIT trap below always re-reads the owner file
# rather than closing over a fixed slot number, so cleanup targets whichever
# slot is actually current no matter which process last changed it.
SLOTS_DIR="$REPO_ROOT/.claude/pipeline-slots"
OWNER_FILE="$SLOTS_DIR/.owner-$TICKET_ID"

cleanup() {
  if [ -f "$OWNER_FILE" ]; then
    local cur_slot
    cur_slot="$(cat "$OWNER_FILE" 2>/dev/null || true)"
    if [ -n "$cur_slot" ]; then
      rm -rf "$SLOTS_DIR/$cur_slot"
    fi
    rm -f "$OWNER_FILE"
  fi
}
trap cleanup EXIT

SLOT="$("$SCRIPT_DIR/claim-slot.sh" "$REPO_ROOT" "$TICKET_ID")"
echo "Claimed slot: $SLOT"

# 3. Worktree setup. Worktrees don't share untracked files/dirs with the main
# checkout (only the git object database/refs are shared), and .jira-plans/
# is untracked — so plan.md etc. must be copied in explicitly.
WORKTREE="$REPO_ROOT/.claude/worktrees/$TICKET_ID"

git -C "$REPO_ROOT" fetch origin main

if [ -d "$WORKTREE" ]; then
  echo "Worktree already exists at $WORKTREE — reusing it."
else
  git -C "$REPO_ROOT" worktree add -d "$WORKTREE" origin/main
fi

mkdir -p "$WORKTREE/.jira-plans"
if [ -f "$REPO_ROOT/.jira-plans/$TICKET_ID/plan.md" ]; then
  echo "Existing plan found in main checkout — copying into worktree (plan stage will be skipped)."
  cp -r "$REPO_ROOT/.jira-plans/$TICKET_ID" "$WORKTREE/.jira-plans/"
fi

# The `/w-*` stage commands below live in .claude/skills/, which is untracked —
# so a worktree checked out from origin/main has no skills at all and every
# stage would die with "Unknown command". Copy them in, plus the per-host MCP
# config for the JIRA/Slack servers the skills rely on (Slack is how unattended
# runs escalate) and the Codex/Cursor discovery files (symlinks stay relative,
# so .agents/skills resolves to the worktree's own copy).
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

# The dev containers mount the main checkout at /app, so the worktree is
# visible inside them at this path. Every check the skills run uses it as the
# container working directory (see .claude/skills/_shared/run-checks.md).
CONTAINER_WORKDIR="/app/.claude/worktrees/$TICKET_ID"

if docker exec web-spa-1 ln -sf /app/frontend/node_modules "$CONTAINER_WORKDIR/frontend/node_modules" 2>/dev/null; then
  echo "Symlinked frontend/node_modules into the worktree."
else
  echo "Warning: could not symlink frontend/node_modules into the worktree (best-effort, non-fatal)." >&2
fi

# 4. Export env for the child processes.
export PIPELINE_MODE=unattended
export TEST_ENV_NUMBER=$((SLOT + 1))
export PIPELINE_REPO_ROOT="$REPO_ROOT"
export PIPELINE_CONTAINER_WORKDIR="$CONTAINER_WORKDIR"
if [ -n "$WAIT_FOR_REPLY" ]; then
  export WAIT_FOR_REPLY_MINUTES="$WAIT_FOR_REPLY"
fi

# Each slot has its own test database (welligence_test<TEST_ENV_NUMBER>, see
# backend/config/database.yml). Create or migrate it up front so backend specs
# in this run don't fail on a missing database or collide with another slot.
if docker exec -e TEST_ENV_NUMBER -e RAILS_ENV=test -w "$CONTAINER_WORKDIR/backend" web-web-1 \
    bundle exec rails db:prepare >/dev/null 2>&1; then
  echo "Test database welligence_test$TEST_ENV_NUMBER is ready."
else
  echo "Warning: could not prepare welligence_test$TEST_ENV_NUMBER — backend specs in this run may fail." >&2
fi

cd "$WORKTREE"

STAGE_FAILED=""

# Single-line, machine-watchable status per ticket per stage. Always goes to
# this process's own stdout (so it lands in the per-ticket log the batch
# runner tees it into); when PROGRESS_LOG is set (the batch runner sets it to
# one shared file across all concurrent tickets) it's also appended there, so
# a single `tail -f` on that file shows every ticket's stage transitions as
# they happen.
progress() {
  local line="[$TICKET_ID] $*"
  echo "$line"
  if [ -n "${PROGRESS_LOG:-}" ]; then
    echo "$line" >>"$PROGRESS_LOG"
  fi
}

# `claude -p` exits 0 even when the slash command doesn't resolve (it just
# prints "Unknown command: ..."), so a bare exit-code check reports success for
# a stage that did nothing. run_stage tees the output, then fails on that
# marker as well as on a non-zero exit. The per-host command, including the
# MCP allow-list Claude Code needs for JIRA and Slack, is run_agent_headless
# in lib.sh.
export PIPELINE_MAX_TURNS

run_stage() {
  local stage="$1" command="$2"
  local attempt=0 rc

  while :; do
    rc=0
    run_stage_once "$stage" "$command" || rc=$?
    if [ "$rc" -eq 0 ]; then
      return 0
    fi
    # 2 = the slash command didn't resolve; another attempt can't fix that.
    if [ "$rc" -eq 2 ] || [ "$attempt" -ge "$PIPELINE_STAGE_RETRIES" ]; then
      return 1
    fi
    attempt=$((attempt + 1))
    progress "$stage: retrying ($attempt/$PIPELINE_STAGE_RETRIES)"
  done
}

run_stage_once() {
  local stage="$1" command="$2"
  local out_file
  out_file="$(mktemp)"

  echo "=== Stage: $stage ==="
  progress "$stage: in progress"

  # Read the CLI's own status out of PIPESTATUS (tee is last in the pipe).
  # Must be the very next statement after the pipeline: any intervening
  # command — including a `|| rc=$?` assignment — overwrites PIPESTATUS.
  local rc=0
  set +e
  run_agent_headless "$WORKTREE" "$command" 2>&1 | tee "$out_file"
  rc="${PIPESTATUS[0]}"
  set -e

  if [ "$rc" -ne 0 ]; then
    echo "Stage $stage: $PIPELINE_AGENT exited $rc." >&2
    progress "$stage: FAILED (exit $rc)"
    rm -f "$out_file"
    return 1
  fi

  if headless_unknown_command "$out_file"; then
    echo "Stage $stage: '$command' did not resolve to a known command — the" >&2
    echo "  skill is missing from the worktree, so no work was done." >&2
    progress "$stage: FAILED (unknown command)"
    rm -f "$out_file"
    return 2
  fi

  rm -f "$out_file"
  progress "$stage: done"
  return 0
}

# Fails a stage that was supposed to change the tree but left it untouched.
assert_worktree_dirty() {
  local stage="$1"
  # Exclude the scaffolding this script copies in (plans, skills, mcp/flag
  # config) — otherwise the worktree always looks dirty and a stage that wrote
  # no actual code would pass this check.
  if [ -z "$(git -C "$WORKTREE" status --porcelain -- . \
      ':!.jira-plans' ':!.claude' ':!.mcp.json' ':!flags.json' \
      ':!.codex' ':!.cursor' ':!.agents' ':!AGENTS.md')" ]; then
    echo "Stage $stage: reported success but the worktree has no changes." >&2
    return 1
  fi
  return 0
}

LOCAL_BRANCH_MD=".jira-plans/$TICKET_ID/local-branch.md"

if ! stage_enabled plan; then
  echo "=== Stage: plan (skipped, not in --stages) ==="
  progress "plan: skipped (not in --stages)"
elif [ ! -f ".jira-plans/$TICKET_ID/plan.md" ]; then
  if ! run_stage plan "$(skill_invocation w-1-coding "$TICKET_ID" just-plan here)"; then
    STAGE_FAILED="plan"
  elif [ ! -f ".jira-plans/$TICKET_ID/plan.md" ]; then
    echo "Stage plan: no plan.md was written." >&2
    progress "plan: FAILED (no plan.md written)"
    STAGE_FAILED="plan"
  fi
else
  echo "=== Stage: plan (skipped, plan.md already present) ==="
  progress "plan: skipped (plan.md already present)"
fi

if [ -z "$STAGE_FAILED" ] && stage_enabled implement; then
  if ! run_stage implement "$(skill_invocation w-1-coding "$TICKET_ID" just-implement here)"; then
    STAGE_FAILED="implement"
  elif ! assert_worktree_dirty implement; then
    STAGE_FAILED="implement"
  elif ! grep -q '^- \[x\]' ".jira-plans/$TICKET_ID/plan.md"; then
    echo "Stage implement: no to-do item in plan.md was ticked." >&2
    progress "implement: FAILED (no to-do ticked)"
    STAGE_FAILED="implement"
  fi
fi

stage_code_review() {
  if ! run_stage code-review "$(skill_invocation w-1-coding "$TICKET_ID" just-code-review here)"; then
    STAGE_FAILED="code-review"
  elif [ ! -f ".jira-plans/$TICKET_ID/code-review.md" ]; then
    echo "Stage code-review: no code-review.md was written." >&2
    progress "code-review: FAILED (no code-review.md written)"
    STAGE_FAILED="code-review"
  fi
}

stage_commit() {
  if ! run_stage commit "$(skill_invocation w-1-coding "$TICKET_ID" just-commit here)"; then
    STAGE_FAILED="commit"
  elif [ ! -f "$LOCAL_BRANCH_MD" ]; then
    echo "Stage commit: no local-branch.md was written." >&2
    progress "commit: FAILED (no local-branch.md written)"
    STAGE_FAILED="commit"
  fi
}

if [ -z "$STAGE_FAILED" ] && stage_enabled code-review; then
  stage_code_review
fi

if [ -z "$STAGE_FAILED" ] && stage_enabled commit; then
  stage_commit
fi

QA_CHECK_MD=".jira-plans/$TICKET_ID/qa-check.md"

if [ -z "$STAGE_FAILED" ] && stage_enabled qa-check; then
  if ! run_stage qa-check "$(skill_invocation w-1-coding "$TICKET_ID" just-qa-check here)"; then
    STAGE_FAILED="qa-check"
  elif [ ! -f "$QA_CHECK_MD" ]; then
    echo "Stage qa-check: no qa-check.md was written." >&2
    progress "qa-check: FAILED (no qa-check.md written)"
    STAGE_FAILED="qa-check"
  elif grep -q '^code_changed: *yes' "$QA_CHECK_MD"; then
    progress "qa-check: changed code, re-running code-review and commit"
    stage_code_review
    if [ -z "$STAGE_FAILED" ]; then
      stage_commit
    fi
  fi
fi

if [ -z "$STAGE_FAILED" ] && [ "$DRAFT_PR" -eq 1 ]; then
  if ! run_stage draft-pr "$(skill_invocation w-4-publish "$TICKET_ID" draft)"; then
    STAGE_FAILED="draft-pr"
  elif ! grep -q '^pr_url:' "$LOCAL_BRANCH_MD" 2>/dev/null; then
    echo "Stage draft-pr: no pr_url recorded in local-branch.md — the PR was not opened." >&2
    progress "draft-pr: FAILED (no pr_url)"
    STAGE_FAILED="draft-pr"
  fi
fi

# 5. Copy artifacts back so they're readable from the main checkout
# afterward (needed by /w-3-land-branch). Best-effort, even on
# failure, so a failed run can still be inspected.
mkdir -p "$REPO_ROOT/.jira-plans"
cp -Rp "$WORKTREE/.jira-plans/$TICKET_ID" "$REPO_ROOT/.jira-plans/" 2>/dev/null || true

BRANCH="(unknown — local-branch.md not found)"
PR_URL=""
if [ -f "$LOCAL_BRANCH_MD" ]; then
  BRANCH="$(grep -m1 '^branch:' "$LOCAL_BRANCH_MD" | sed 's/^branch: *//')"
  PR_URL="$(grep -m1 '^pr_url:' "$LOCAL_BRANCH_MD" | sed 's/^pr_url: *//' || true)"
fi

echo ""
echo "==================== Pipeline summary ===================="
echo "Ticket:    $TICKET_ID"
echo "Slot used: $SLOT"
if stage_enabled commit || stage_enabled qa-check; then
  echo "Branch:    $BRANCH"
fi
if [ -n "$PR_URL" ]; then
  echo "Draft PR:  $PR_URL"
fi
echo "Worktree:  $WORKTREE"

if [ -n "$STAGE_FAILED" ]; then
  echo "Result:    FAILED at $STAGE_FAILED — worktree left in place for inspection."
  echo "============================================================"
  progress "FAILED at $STAGE_FAILED"
  exit 1
fi

echo "Result:    All requested stages completed."
progress "all requested stages complete"
if stage_enabled commit || stage_enabled qa-check; then
  echo "Next:      /w-3-land-branch $TICKET_ID"
else
  echo "Next:      changes are uncommitted in the worktree above — review them,"
  echo "           then continue with the remaining stages for this ticket."
fi
echo "============================================================"

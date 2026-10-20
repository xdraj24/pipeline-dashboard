#!/usr/bin/env bash

# Fan out the implement, code-review, commit and qa-check phases of /w-1-coding
# across many XWWP tickets at once — each ticket in its own git worktree, each driven
# by run-ticket-pipeline.sh. This produces a locally-committed branch per
# ticket (status: ready-for-review), or a draft PR per ticket with --draft-pr,
# but never a non-draft PR. Plain, deterministic bash: no LLM calls happen
# here, and this script never blocks on a human.
#
# Usage:
#   ./scripts/pipeline/run-batch-implement.sh <TICKET-ID> [<TICKET-ID> ...] \
#       [--stages=<list>] [--draft-pr] [--jobs=<n>] [--waitForReply=<minutes>] [--agent=<host>]
#
# --agent picks the host CLI that runs every stage: claude (default), codex or
# cursor (PIPELINE_AGENT in lib.sh; .claude/skills/_shared/host-runtime.md).
#
# --stages defaults to implement,code-review,commit,qa-check; any subset of
# run-ticket-pipeline.sh's stages is accepted and passed through.
#
# Every ticket must already have a plan at `.jira-plans/<TICKET-ID>/plan.md` in
# the main checkout (/w-1-coding plans before launching this) — this script
# refuses to start otherwise, since implementation without a plan is exactly
# what the implement phase rejects.
#
# Concurrency defaults to MAX_SLOTS (lib.sh); more than that just fails to
# claim a slot. Per-ticket output is tee'd to
# `.claude/pipeline-logs/<run-id>/<TICKET-ID>.log`.
#
# This is what /w-1-coding's background and draft-pr modes launch.
#
# On macOS the batch re-execs itself under `caffeinate -i` so idle sleep can't
# kill the in-flight headless stages (a closed lid still suspends them).

set -euo pipefail

if [ -z "${PIPELINE_CAFFEINATED:-}" ] && command -v caffeinate >/dev/null 2>&1; then
  export PIPELINE_CAFFEINATED=1
  exec caffeinate -i "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
ALL_STAGES="plan,implement,code-review,commit,qa-check"

usage() {
  echo "Usage: $0 <TICKET-ID> [<TICKET-ID> ...] [--stages=<list>] [--draft-pr] [--jobs=<n>] [--waitForReply=<minutes>] [--agent=<host>]" >&2
  exit 1
}

JOBS="$MAX_SLOTS"
WAIT_FOR_REPLY=""
STAGES="implement,code-review,commit,qa-check"
DRAFT_PR=0
TICKETS=""

for arg in "$@"; do
  case "$arg" in
    --jobs=*)
      JOBS="${arg#--jobs=}"
      ;;
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
    -*)
      echo "Unknown argument: $arg" >&2
      usage
      ;;
    *)
      ticket="$(echo "$arg" | tr '[:lower:]' '[:upper:]')"
      if ! [[ "$ticket" =~ ^XWWP-[0-9]+$ ]]; then
        echo "Ticket id must look like XWWP-1234, got: $arg" >&2
        exit 1
      fi
      case " $TICKETS " in
        *" $ticket "*) echo "Ignoring duplicate ticket: $ticket" >&2 ;;
        *) TICKETS="$TICKETS $ticket" ;;
      esac
      ;;
  esac
done

TICKETS="$(echo "$TICKETS" | sed 's/^ *//')"
if [ -z "$TICKETS" ]; then
  echo "No ticket ids given." >&2
  usage
fi

validate_pipeline_agent || exit 1
export PIPELINE_AGENT
if ! command -v "$(agent_binary)" >/dev/null 2>&1; then
  echo "$(agent_binary) (the $PIPELINE_AGENT CLI) is not on PATH." >&2
  exit 1
fi

if ! [[ "$JOBS" =~ ^[0-9]+$ ]] || [ "$JOBS" -lt 1 ]; then
  echo "--jobs must be a positive integer, got: $JOBS" >&2
  exit 1
fi
if [ "$JOBS" -gt "$MAX_SLOTS" ]; then
  echo "--jobs capped at $MAX_SLOTS (only $MAX_SLOTS pipeline slots exist)." >&2
  JOBS="$MAX_SLOTS"
fi

if [ -n "$WAIT_FOR_REPLY" ] && ! [[ "$WAIT_FOR_REPLY" =~ ^[0-9]+$ ]]; then
  echo "--waitForReply must be a number of minutes, got: $WAIT_FOR_REPLY" >&2
  exit 1
fi

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
if [ "$DRAFT_PR" -eq 1 ]; then
  case ",$STAGES," in
    *",commit,"*) : ;;
    *)
      echo "--draft-pr needs the commit stage in --stages (got: $STAGES)." >&2
      exit 1
      ;;
  esac
fi

REPO_ROOT="$(resolve_repo_root)"

# Fail the whole batch before launching anything if any plan is missing —
# a half-launched batch is much harder to reason about than a refused one.
MISSING=""
for ticket in $TICKETS; do
  if [ ! -f "$REPO_ROOT/.jira-plans/$ticket/plan.md" ]; then
    MISSING="$MISSING $ticket"
  fi
done
if [ -n "$MISSING" ]; then
  echo "No plan.md found for:$MISSING" >&2
  echo "Run /w-1-coding$MISSING just-plan first." >&2
  exit 1
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="$REPO_ROOT/.claude/pipeline-logs/$RUN_ID"
mkdir -p "$LOG_DIR"

# Shared across every concurrent ticket subshell below: each one appends its
# own "[TICKET] stage: state" lines (run-ticket-pipeline.sh's `progress`
# helper), so `tail -f` on this single file is a live feed of every ticket's
# stage transitions.
PROGRESS_LOG="$LOG_DIR/progress.log"
: >"$PROGRESS_LOG"
export PROGRESS_LOG

PIPELINE_ARGS="--stages=$STAGES --agent=$PIPELINE_AGENT"
if [ "$DRAFT_PR" -eq 1 ]; then
  PIPELINE_ARGS="$PIPELINE_ARGS --draft-pr"
fi
if [ -n "$WAIT_FOR_REPLY" ]; then
  PIPELINE_ARGS="$PIPELINE_ARGS --waitForReply=$WAIT_FOR_REPLY"
fi

TICKET_COUNT="$(echo "$TICKETS" | wc -w | tr -d ' ')"
echo "Repo root:   $REPO_ROOT"
echo "Tickets:     $TICKET_COUNT ($TICKETS)"
echo "Stages:      $STAGES"
echo "Agent:       $PIPELINE_AGENT"
if [ "$DRAFT_PR" -eq 1 ]; then
  echo "Draft PR:    yes"
fi
echo "Concurrency: $JOBS"
echo "Logs:        $LOG_DIR"
echo "Progress:    $PROGRESS_LOG (tail -f this for live per-ticket stage status)"
echo ""

PIDS=""

# bash 3.2 (macOS system bash) has no `wait -n`, so poll liveness instead.
running_count() {
  local n=0
  local pid
  for pid in $PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      n=$((n + 1))
    fi
  done
  echo "$n"
}

throttle() {
  while [ "$(running_count)" -ge "$JOBS" ]; do
    sleep 5
  done
}

for ticket in $TICKETS; do
  throttle
  log_file="$LOG_DIR/$ticket.log"
  echo "Launching $ticket -> $log_file"
  (
    rc=0
    # shellcheck disable=SC2086
    "$SCRIPT_DIR/run-ticket-pipeline.sh" "$ticket" $PIPELINE_ARGS >"$log_file" 2>&1 || rc=$?
    # Each run records its own exit code, so the summary below never has to
    # correlate pids with tickets by position.
    echo "$rc" >"$LOG_DIR/$ticket.status"
  ) &
  PIDS="$PIDS $!"
  # Stagger slot claims so two runs don't race `git fetch` in the same instant.
  sleep 2
done

wait

FAILED=""
for ticket in $TICKETS; do
  rc="$(cat "$LOG_DIR/$ticket.status" 2>/dev/null || echo 1)"
  if [ "$rc" != "0" ]; then
    FAILED="$FAILED $ticket"
  fi
done

echo ""
echo "==================== Batch summary ===================="
for ticket in $TICKETS; do
  case " $FAILED " in
    *" $ticket "*) status="FAILED " ;;
    *) status="ok     " ;;
  esac
  echo "  $status $ticket  ($LOG_DIR/$ticket.log)"
done
echo ""
echo "Worktrees:  $REPO_ROOT/.claude/worktrees/<TICKET-ID>"
echo "Progress:   $PROGRESS_LOG"
if [ "$DRAFT_PR" -eq 1 ]; then
  echo "Each successful ticket is committed locally on its branch and pushed as a"
  echo "draft PR (status: draft-pr-open). Run /w-3-land-branch <TICKET-ID> next."
else
  echo "Each successful ticket is committed locally on its branch (status:"
  echo "ready-for-review) and not pushed. Run /w-3-land-branch <TICKET-ID> next."
fi

if [ -n "$FAILED" ]; then
  echo "Result:     some tickets failed:$FAILED"
  echo "======================================================="
  exit 1
fi

echo "Result:     all $TICKET_COUNT tickets completed ($STAGES)."
echo "======================================================="

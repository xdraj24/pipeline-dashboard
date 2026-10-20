#!/usr/bin/env bash

# Shared by every script in this directory: `source "$SCRIPT_DIR/lib.sh"`.

# Concurrent pipeline runs are bounded by this many slots (claim-slot.sh).
# Each slot maps to its own test database via TEST_ENV_NUMBER=$((slot + 1)).
MAX_SLOTS=6

# Which host CLI runs each unattended stage: claude (default), codex or cursor.
# See .claude/skills/_shared/host-runtime.md.
PIPELINE_AGENT="${PIPELINE_AGENT:-claude}"

validate_pipeline_agent() {
  case "$PIPELINE_AGENT" in
    claude|codex|cursor) return 0 ;;
    *)
      echo "PIPELINE_AGENT must be claude, codex or cursor, got: $PIPELINE_AGENT" >&2
      return 1
      ;;
  esac
}

agent_binary() {
  case "$PIPELINE_AGENT" in
    cursor) echo agent ;;
    *) echo "$PIPELINE_AGENT" ;;
  esac
}

# Prints a skill invocation in the host's syntax: /w-x on claude and cursor, $w-x on codex.
skill_invocation() {
  local skill="$1"
  shift
  case "$PIPELINE_AGENT" in
    codex) echo "\$$skill $*" ;;
    *) echo "/$skill $*" ;;
  esac
}

# Runs one headless stage in $workdir and returns the CLI's exit code. Every
# host runs with approvals off and no sandbox: stages docker exec into the dev
# containers and, with --draft-pr, git push, which a sandbox blocks.
run_agent_headless() {
  local workdir="$1" prompt="$2"
  case "$PIPELINE_AGENT" in
    claude)
      local args=(--permission-mode dontAsk --allowedTools "mcp__atlassian__*,mcp__slack__*")
      if [ -n "${PIPELINE_MAX_TURNS:-}" ]; then
        args+=(--max-turns "$PIPELINE_MAX_TURNS")
      fi
      if [ -n "${PIPELINE_MAX_BUDGET_USD:-}" ]; then
        args+=(--max-budget-usd "$PIPELINE_MAX_BUDGET_USD")
      fi
      (cd "$workdir" && claude "${args[@]}" -p "$prompt")
      ;;
    codex)
      codex exec --dangerously-bypass-approvals-and-sandbox -C "$workdir" "$prompt"
      ;;
    cursor)
      agent -p --force --trust --sandbox disabled --approve-mcps --workspace "$workdir" --output-format text "$prompt"
      ;;
  esac
}

# Only Claude Code prints a marker when a slash command doesn't resolve; other
# hosts leave stage success to the artifact checks in run-ticket-pipeline.sh.
headless_unknown_command() {
  [ "$PIPELINE_AGENT" = claude ] && grep -qi "^Unknown command:" "$1"
}

# Prints the main checkout's root, whichever worktree the caller is in.
resolve_repo_root() {
  local common_dir
  common_dir="$(git rev-parse --git-common-dir)"
  case "$common_dir" in
    /*) : ;;
    *) common_dir="$(pwd)/$common_dir" ;;
  esac
  (cd "$(dirname "$common_dir")" && pwd)
}

# Claims the first free slot for a ticket, printing its number; returns 1 when
# all are busy. Atomic via mkdir.
try_claim_slot() {
  local slots_dir="$1" ticket_id="$2" i
  for i in $(seq 1 "$MAX_SLOTS"); do
    if mkdir "$slots_dir/$i" 2>/dev/null; then
      echo "$ticket_id" >"$slots_dir/$i/ticket"
      date -u +%FT%TZ >"$slots_dir/$i/started_at"
      echo "$i" >"$slots_dir/.owner-$ticket_id"
      echo "$i"
      return 0
    fi
  done
  return 1
}

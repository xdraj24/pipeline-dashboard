#!/usr/bin/env bash

# One-shot doctor for running the w-* skills (and the unattended pipeline)
# under a given host CLI. Prints one line per problem and exits non-zero if
# any were found. See .claude/skills/_shared/host-runtime.md.
#
# Usage: ./scripts/pipeline/check-host.sh <claude|codex|cursor>

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

if [ $# -ne 1 ]; then
  echo "Usage: $0 <claude|codex|cursor>" >&2
  exit 1
fi

PIPELINE_AGENT="$1"
validate_pipeline_agent || exit 1
REPO_ROOT="$(resolve_repo_root)"
PROBLEMS=0

problem() {
  echo "PROBLEM: $*"
  PROBLEMS=$((PROBLEMS + 1))
  return 1
}

require_link() {
  local link="$1" target="$2"
  if [ ! -L "$REPO_ROOT/$link" ]; then
    problem "$link is not a symlink (expected -> $target)"
  elif [ "$(readlink "$REPO_ROOT/$link")" != "$target" ]; then
    problem "$link points at $(readlink "$REPO_ROOT/$link"), expected $target"
  elif [ ! -e "$REPO_ROOT/$link" ]; then
    problem "$link -> $target is dangling"
  fi
}

require_file() {
  [ -f "$REPO_ROOT/$1" ] || problem "$1 is missing"
}

mcp_names_present() {
  local file="$1"
  grep -q '"atlassian"' "$REPO_ROOT/$file" || problem "$file has no atlassian server"
  grep -q '"slack"' "$REPO_ROOT/$file" || problem "$file has no slack server"
}

if ! command -v "$(agent_binary)" >/dev/null 2>&1; then
  problem "$(agent_binary) (the $PIPELINE_AGENT CLI) is not on PATH"
fi

[ -d "$REPO_ROOT/.claude/skills" ] || problem ".claude/skills/ is missing"

for skill_md in "$REPO_ROOT"/.claude/skills/*/SKILL.md; do
  dir="$(basename "$(dirname "$skill_md")")"
  name="$(sed -n 's/^name: *//p' "$skill_md" | head -1)"
  if ! [[ "$dir" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    problem "skill directory '$dir' is not a valid Agent Skills name (a-z, 0-9, single hyphens)"
  fi
  if [ "$name" != "$dir" ]; then
    problem "$dir/SKILL.md has name '$name', which must equal the directory name"
  fi
done

[ -n "${SLACK_BOT_TOKEN:-}" ] || problem "SLACK_BOT_TOKEN is not exported (Slack escalation will be treated as not set up)"

case "$PIPELINE_AGENT" in
  claude)
    require_file .mcp.json && mcp_names_present .mcp.json
    if [ -f "$REPO_ROOT/.claude/settings.local.json" ]; then
      grep -q '"slack"' "$REPO_ROOT/.claude/settings.local.json" \
        || problem ".claude/settings.local.json does not enable the slack server (enabledMcpjsonServers)"
    else
      problem ".claude/settings.local.json is missing (enabledMcpjsonServers for atlassian and slack)"
    fi
    ;;
  codex)
    require_link .agents/skills ../.claude/skills
    require_file AGENTS.md
    if require_file .codex/config.toml; then
      grep -q '^\[mcp_servers\.atlassian\]' "$REPO_ROOT/.codex/config.toml" || problem ".codex/config.toml has no [mcp_servers.atlassian]"
      grep -q '^\[mcp_servers\.slack\]' "$REPO_ROOT/.codex/config.toml" || problem ".codex/config.toml has no [mcp_servers.slack]"
    fi
    for role in planner reviewer fixer verifier; do
      require_file ".codex/agents/w-$role.toml"
    done
    ;;
  cursor)
    require_link .cursor/mcp.json ../.mcp.json
    [ -e "$REPO_ROOT/.cursor/mcp.json" ] && mcp_names_present .cursor/mcp.json
    ;;
esac

if [ "$PROBLEMS" -gt 0 ]; then
  echo "$PROBLEMS problem(s) for host $PIPELINE_AGENT."
  exit 1
fi
echo "Host $PIPELINE_AGENT: ready."

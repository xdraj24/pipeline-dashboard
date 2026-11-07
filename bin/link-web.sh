#!/usr/bin/env bash
# Link the w-* skills, pipeline scripts and agent configs from this repo into a web checkout,
# and exclude them plus the skills' local state from that checkout's git via .git/info/exclude.
# .claude/skills stays a real folder with one link per skill, so skills committed to the web repo
# by other developers sit next to them.
# Usage: link-web.sh [web-dir]   (default: ../web next to this repo)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$(cd "${1:-$HERE/../web}" && pwd)"
OVERLAY="$HERE/web"

LINKS=(.codex .mcp.json scripts/pipeline docs/second-dev-stack.md)
LOCAL_STATE=(AGENTS.md .ai-workspace/ .claude/scheduled_tasks.lock .claude/settings.local.json)
EXCLUDES=()

git -C "$WEB" rev-parse --git-dir >/dev/null

# Older checkouts kept the skills' state in dot folders at the root and under .claude/.
migrate_state() {
  local ws="$WEB/.ai-workspace" old new wt
  if [ -n "$(ls -A "$WEB/.claude/pipeline-slots" 2>/dev/null | grep -v '^\.owner-' || true)" ]; then
    echo "skip    state migration (a pipeline run holds a slot; re-run when it finishes)" >&2
    return 0
  fi
  for pair in .jira-plans:jira-plans .pr-reviews:pr-reviews .claude/pipeline-logs:pipeline-logs .claude/pipeline-slots:pipeline-slots; do
    old="$WEB/${pair%%:*}" new="$ws/${pair#*:}"
    [ -d "$old" ] && [ ! -L "$old" ] || continue
    mkdir -p "$new"
    cp -Rp "$old/." "$new/"
    rm -rf "$old"
    echo "moved   ${pair%%:*} -> .ai-workspace/${pair#*:}"
  done
  for wt in "$WEB"/.claude/worktrees/*; do
    case "$(basename "$wt")" in [Xx][Ww][Ww][Pp]-[0-9]*) ;; *) continue ;; esac
    [ -e "$ws/worktrees/$(basename "$wt")" ] && continue
    mkdir -p "$ws/worktrees"
    git -C "$WEB" worktree move "$wt" "$ws/worktrees/$(basename "$wt")"
    echo "moved   ${wt#"$WEB"/} -> .ai-workspace/worktrees/$(basename "$wt")"
  done
}

tracked() { git -C "$WEB" ls-files --error-unmatch -- "$1" >/dev/null 2>&1; }

backup() {
  local path="$1" b
  b="$path.bak.$(date +%Y%m%d%H%M%S)"
  mv "$path" "$b"
  echo "backup  ${path#"$WEB"/} -> $(basename "$b")"
}

# link <path relative to web> <absolute target>
link() {
  local rel="$1" target="$2" path="$WEB/$1"
  if [ -L "$path" ]; then
    if [ "$(readlink "$path")" = "$target" ]; then echo "ok      $rel"; EXCLUDES+=("/$rel"); return 0; fi
    rm "$path"
  elif [ -e "$path" ]; then
    if tracked "$rel"; then echo "skip    $rel (tracked in web; the web repo's version wins)" >&2; return 0; fi
    backup "$path"
  fi
  mkdir -p "$(dirname "$path")"
  # Absolute target: the pipeline copies these links into worktrees at a different depth.
  ln -s "$target" "$path"
  echo "linked  $rel"
  EXCLUDES+=("/$rel")
}

# Earlier versions linked whole folders and AGENTS.md; turn those back into real ones.
for rel in .claude/skills .agents; do
  if [ -L "$WEB/$rel" ] && [[ "$(readlink "$WEB/$rel")" == "$OVERLAY"/* ]]; then
    rm "$WEB/$rel"; mkdir -p "$WEB/$rel"; echo "unlink  $rel (now a folder)"
  fi
done
if [ -L "$WEB/AGENTS.md" ] && [[ "$(readlink "$WEB/AGENTS.md")" == "$OVERLAY"/* ]]; then
  cp "$WEB/AGENTS.md" "$WEB/AGENTS.md.tmp" 2>/dev/null && mv "$WEB/AGENTS.md.tmp" "$WEB/AGENTS.md" || rm "$WEB/AGENTS.md"
  echo "unlink  AGENTS.md (now a local file)"
fi

for rel in "${LINKS[@]}"; do
  [ -e "$OVERLAY/$rel" ] || { echo "missing in overlay: $rel" >&2; exit 1; }
  link "$rel" "$OVERLAY/$rel"
done

mkdir -p "$WEB/.claude/skills"
for src in "$OVERLAY"/.claude/skills/*/; do
  link ".claude/skills/$(basename "$src")" "${src%/}"
done
for path in "$WEB"/.claude/skills/*; do
  if [ -L "$path" ] && [[ "$(readlink "$path")" == "$OVERLAY"/* ]] && [ ! -e "$path" ]; then
    rm "$path"; echo "removed .claude/skills/$(basename "$path") (gone from pipeline-dashboard)"
  fi
done

# Codex reads .agents/skills; point it at the same folder, team skills included.
if ! tracked .agents/skills; then
  mkdir -p "$WEB/.agents"
  if [ ! -L "$WEB/.agents/skills" ]; then
    [ -e "$WEB/.agents/skills" ] && backup "$WEB/.agents/skills"
    ln -s ../.claude/skills "$WEB/.agents/skills"
    echo "linked  .agents/skills"
  fi
  EXCLUDES+=("/.agents/skills")
fi

migrate_state

EXCLUDE="$(git -C "$WEB" rev-parse --git-common-dir)/info/exclude"
case "$EXCLUDE" in /*) ;; *) EXCLUDE="$WEB/$EXCLUDE" ;; esac
mkdir -p "$(dirname "$EXCLUDE")"
touch "$EXCLUDE"
MARK="# pipeline-dashboard (bin/link-web.sh)"
# Rewrite the whole block so it follows the current set of skills.
MARK="$MARK" perl -0pi -e 's/\n*\Q$ENV{MARK}\E\n(?:[^#\n][^\n]*\n?)*//' "$EXCLUDE"
{
  printf '\n%s\n' "$MARK"
  printf '%s\n' ${EXCLUDES[@]+"${EXCLUDES[@]}"} "${LOCAL_STATE[@]/#//}" '*.bak.[0-9]*'
} >>"$EXCLUDE"
echo "exclude $EXCLUDE"

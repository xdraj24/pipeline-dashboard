#!/usr/bin/env bash
# Link the w-* skills, pipeline scripts and agent configs from this repo into a web checkout,
# and exclude them plus the skills' local state from that checkout's git via .git/info/exclude.
# Usage: link-web.sh [web-dir]   (default: ../web next to this repo)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$(cd "${1:-$HERE/../web}" && pwd)"
OVERLAY="$HERE/web"

LINKS=(.claude/skills .agents .codex .mcp.json scripts/pipeline docs/second-dev-stack.md)
LOCAL_STATE=(AGENTS.md .jira-plans/ .pr-reviews/ .claude/pipeline-logs/ .claude/pipeline-slots/ .claude/worktrees/
  .claude/scheduled_tasks.lock .claude/settings.local.json)

git -C "$WEB" rev-parse --git-dir >/dev/null

# AGENTS.md used to be linked from here; /w-setup now merges it into a local file instead.
if [ -L "$WEB/AGENTS.md" ] && [ "$(readlink "$WEB/AGENTS.md")" = "$OVERLAY/AGENTS.md" ]; then
  cp "$OVERLAY/AGENTS.md" "$WEB/AGENTS.md.tmp" 2>/dev/null && mv "$WEB/AGENTS.md.tmp" "$WEB/AGENTS.md" \
    || rm "$WEB/AGENTS.md"
  echo "unlink  AGENTS.md (now a local file)"
fi

for rel in "${LINKS[@]}"; do
  target="$OVERLAY/$rel"
  link="$WEB/$rel"
  [ -e "$target" ] || { echo "missing in overlay: $rel" >&2; exit 1; }
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$target" ] && { echo "ok      $rel"; continue; }
    rm "$link"
  elif [ -e "$link" ]; then
    if git -C "$WEB" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
      echo "refusing: $rel is tracked in $WEB" >&2; exit 1
    fi
    backup="$link.bak.$(date +%Y%m%d%H%M%S)"
    mv "$link" "$backup"
    echo "backup  $rel -> $(basename "$backup")"
  fi
  mkdir -p "$(dirname "$link")"
  # Absolute target: the pipeline copies these links into worktrees at a different depth.
  ln -s "$target" "$link"
  echo "linked  $rel"
done

EXCLUDE="$(git -C "$WEB" rev-parse --git-common-dir)/info/exclude"
case "$EXCLUDE" in /*) ;; *) EXCLUDE="$WEB/$EXCLUDE" ;; esac
mkdir -p "$(dirname "$EXCLUDE")"
touch "$EXCLUDE"
MARK="# pipeline-dashboard (bin/link-web.sh)"
grep -qxF "$MARK" "$EXCLUDE" || printf '\n%s\n' "$MARK" >>"$EXCLUDE"
for pat in "${LINKS[@]/#//}" "${LOCAL_STATE[@]/#//}" '*.bak.[0-9]*'; do
  grep -qxF "$pat" "$EXCLUDE" || echo "$pat" >>"$EXCLUDE"
done
echo "exclude $EXCLUDE"

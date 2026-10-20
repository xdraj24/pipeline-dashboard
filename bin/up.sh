#!/usr/bin/env bash
# Start the skills dashboard if it is not running, then open it in the browser.
# Usage: up.sh [board|history|reviews|stop|status] [--no-open]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4848}"
URL="http://localhost:$PORT"
LOG="$HERE/data/server.log"
PAGE="board"
OPEN=1

for arg in "$@"; do
  case "$arg" in
    board|history|reviews|stop|status) PAGE="$arg" ;;
    --no-open) OPEN=0 ;;
    *) echo "Unknown argument: $arg" >&2; echo "Usage: $0 [board|history|reviews|stop|status] [--no-open]" >&2; exit 1 ;;
  esac
done

alive() { curl -sf -m 2 -o /dev/null "$URL/api/questions"; }
running_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

if [ "$PAGE" = stop ]; then
  pid="$(running_pid || true)"
  if [ -z "$pid" ]; then echo "dashboard: not running"; exit 0; fi
  kill "$pid" && echo "dashboard: stopped (pid $pid)"
  exit 0
fi

if [ "$PAGE" = status ]; then
  if alive; then echo "dashboard: running at $URL (pid $(running_pid))"; else echo "dashboard: not running"; fi
  exit 0
fi

if ! alive; then
  if ! command -v node >/dev/null 2>&1; then echo "node is not on PATH" >&2; exit 1; fi
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 22 ]; then echo "node 22+ is required for type stripping, found $(node -v)" >&2; exit 1; fi
  mkdir -p "$HERE/data"
  (cd "$HERE" && nohup node server.ts >>"$LOG" 2>&1 &)
  for _ in $(seq 1 40); do
    alive && break
    sleep 0.25
  done
  if ! alive; then
    echo "dashboard failed to start; last log lines:" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
  echo "dashboard: started (pid $(running_pid), log $LOG)"
else
  echo "dashboard: already running (pid $(running_pid))"
fi

target="$URL"
[ "$PAGE" = history ] && target="$URL/history"
[ "$PAGE" = reviews ] && target="$URL/reviews"
echo "dashboard: $target"
if [ "$OPEN" -eq 1 ]; then
  if command -v open >/dev/null 2>&1; then open "$target"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$target"
  else echo "open $target in your browser"
  fi
fi

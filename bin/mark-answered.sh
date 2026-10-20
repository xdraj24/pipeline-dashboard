#!/usr/bin/env bash
# Record an answer that arrived elsewhere (e.g. the Slack thread) so the dashboard stops showing the question as open.
#   mark-answered.sh <id> "<answer>" [via]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILE="$HERE/../data/questions/$1.json"
[ -f "$FILE" ] || { echo "no such question: $1" >&2; exit 2; }
python3 - "$FILE" "$2" "${3:-slack}" <<'PY'
import json, sys, datetime, os
path, answer, via = sys.argv[1:4]
q = json.load(open(path))
q.update(status="answered", answer=answer, answeredVia=via, answeredAt=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
tmp = path + ".tmp"
json.dump(q, open(tmp, "w"), indent=2)
os.replace(tmp, path)
PY

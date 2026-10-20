#!/usr/bin/env bash
# Print the answer recorded for a dashboard question id; exit 1 while it is still open.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILE="$HERE/../data/questions/$1.json"
[ -f "$FILE" ] || { echo "no such question: $1" >&2; exit 2; }
python3 - "$FILE" <<'PY'
import json, sys
q = json.load(open(sys.argv[1]))
if q.get("status") != "answered" or q.get("answer") is None:
    sys.exit(1)
print(q["answer"])
PY

#!/usr/bin/env bash

# Uploads, lists and downloads JIRA issue attachments over the REST API; the
# Atlassian MCP server has no attachment tools.
#
# Usage: ./jira-attachments.sh upload   <TICKET-ID> <file>...
#        ./jira-attachments.sh list     <TICKET-ID>
#        ./jira-attachments.sh download <TICKET-ID> <dir>
# Env:   JIRA_EMAIL, JIRA_API_TOKEN, JIRA_SITE (default welligence.atlassian.net);
#        read from $DASH/.env when not already exported.

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="$(cd -P "$SCRIPT_DIR/../../.." && pwd)"

die() { echo "jira-attachments.sh: $*" >&2; exit 1; }

if [ -z "${JIRA_API_TOKEN:-}" ] && [ -f "$DASH/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$DASH/.env"
  set +a
fi
[ -n "${JIRA_EMAIL:-}" ] && [ -n "${JIRA_API_TOKEN:-}" ] \
  || die "set JIRA_EMAIL and JIRA_API_TOKEN in $DASH/.env (token: https://id.atlassian.com/manage-profile/security/api-tokens)"

SITE="${JIRA_SITE:-welligence.atlassian.net}"
SITE="${SITE#http*://}"
API="https://${SITE%/}/rest/api/3"

jira() { curl -sSf -u "$JIRA_EMAIL:$JIRA_API_TOKEN" "$@"; }

attachments_json() {
  jira -H 'Accept: application/json' "$API/issue/$1?fields=attachment" \
    || die "cannot read $1 (wrong ticket id, or no access)"
}

[ $# -ge 2 ] || die "usage: $0 upload|list|download <TICKET-ID> [...]"
CMD="$1"
TICKET="$(echo "$2" | tr '[:lower:]' '[:upper:]')"
shift 2

case "$CMD" in
  upload)
    [ $# -ge 1 ] || die "upload needs at least one file"
    args=()
    for f in "$@"; do
      [ -f "$f" ] || die "no such file: $f"
      args+=(-F "file=@$f")
    done
    # The no-check header is mandatory; without it JIRA rejects the upload as XSRF.
    jira -X POST -H 'X-Atlassian-Token: no-check' "${args[@]}" "$API/issue/$TICKET/attachments" \
      | python3 -c 'import json,sys
for a in json.load(sys.stdin): print("\t".join(str(a[k]) for k in ("id", "size", "filename")))'
    ;;
  list)
    attachments_json "$TICKET" | python3 -c 'import json,sys
for a in json.load(sys.stdin)["fields"].get("attachment") or []:
    print("\t".join(str(a[k]) for k in ("id", "mimeType", "size", "filename")))'
    ;;
  download)
    [ $# -eq 1 ] || die "download needs a target directory"
    mkdir -p "$1"
    attachments_json "$TICKET" | python3 -c 'import json,sys
for a in json.load(sys.stdin)["fields"].get("attachment") or []:
    print("\t".join(str(a[k]) for k in ("id", "filename")))' \
      | while IFS=$'\t' read -r id name; do
          out="$1/${id}-${name//\//_}"
          jira -L -o "$out" "$API/attachment/content/$id"
          echo "$out"
        done
    ;;
  *) die "unknown command: $CMD (upload, list or download)" ;;
esac

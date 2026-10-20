#!/usr/bin/env bash
# Post a question for the developer into the skills dashboard and (by default) wait for the answer.
# Works with the dashboard server down: questions are plain JSON files the dashboard reads.
#
#   ask.sh --ticket XWWP-1234 --phase plan --question "Skip the LNG branch too?" \
#          [--option "yes" --option "no"] [--label "<subject when no ticket>"] [--slack-ts <ts>] \
#          [--timeout-minutes N] [--poll-seconds N] [--no-wait]
#
# Prints the answer on stdout and exits 0. Exit 124 on timeout, 2 on bad usage.
# With --no-wait prints the question id only; `answer.sh <id>` reads it later.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$HERE/../data/questions"
TICKET="" PHASE="" QUESTION="" LABEL="" SLACK_TS="" TIMEOUT="" POLL=20 WAIT=1
OPTIONS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ticket) TICKET="$(echo "$2" | tr '[:lower:]' '[:upper:]')"; shift 2 ;;
    --phase) PHASE="$2"; shift 2 ;;
    --question) QUESTION="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --option) OPTIONS+=("$2"); shift 2 ;;
    --slack-ts) SLACK_TS="$2"; shift 2 ;;
    --timeout-minutes) TIMEOUT="$2"; shift 2 ;;
    --poll-seconds) POLL="$2"; shift 2 ;;
    --no-wait) WAIT=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$QUESTION" ] || { echo "--question is required" >&2; exit 2; }

mkdir -p "$DIR"
ID="$(date -u +%Y%m%d%H%M%S)-$(python3 -c 'import secrets; print(secrets.token_hex(3))')"
json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }
OPTS_JSON="[]"
if [ "${#OPTIONS[@]}" -gt 0 ]; then
  OPTS_JSON="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "${OPTIONS[@]}")"
fi
null_or() { if [ -n "$1" ]; then json_str "$1"; else echo null; fi; }
TMP="$DIR/$ID.json.tmp"
cat >"$TMP" <<JSON
{
  "id": "$ID",
  "ticket": $(null_or "$TICKET"),
  "label": $(null_or "$LABEL"),
  "phase": $(null_or "$PHASE"),
  "question": $(json_str "$QUESTION"),
  "options": $OPTS_JSON,
  "createdAt": "$(date -u +%FT%TZ)",
  "source": $(json_str "${PIPELINE_AGENT:-claude}${PIPELINE_MODE:+/$PIPELINE_MODE}"),
  "status": "open",
  "answer": null,
  "answeredAt": null,
  "answeredVia": null,
  "slackTs": $(null_or "$SLACK_TS"),
  "cwd": $(json_str "$PWD")
}
JSON
mv "$TMP" "$DIR/$ID.json"

if [ "$WAIT" -eq 0 ]; then
  echo "$ID"
  exit 0
fi

START="$(date -u +%s)"
while :; do
  if ANSWER="$("$HERE/answer.sh" "$ID" 2>/dev/null)"; then
    echo "$ANSWER"
    exit 0
  fi
  if [ -n "$TIMEOUT" ] && [ $(( $(date -u +%s) - START )) -ge $(( TIMEOUT * 60 )) ]; then
    exit 124
  fi
  sleep "$POLL"
done

#!/usr/bin/env bash

# Extra full web stacks next to the main checkout, each a separate clone with its own compose
# project, database and host ports (docs/second-dev-stack.md):
#   2 = review stack (/w-24-land-branch-for-review), ../web-2nd, http://127.0.0.1:4000
#   3 = QA stack (w-1-coding qa-check phase),        ../web-3rd, http://qa.localhost:5100
#
# Usage:
#   stack.sh setup    <2|3>                    clone if missing, write the untracked config
#   stack.sh restore  <2|3>                    restore the STG dump into the stack's DB (long)
#   stack.sh up       <2|3>                    start detached, wait until SPA and API answer
#   stack.sh down     <2|3>
#   stack.sh seed     <2|3>                    create/refresh the E2E login users (db/seeds/playwright_config.rb)
#   stack.sh branch   <2|3> <branch>           check out origin/<branch> (detached), then refresh
#   stack.sh pr       <2|3> <number>           check out the PR's head (forks too), then refresh
#   stack.sh sync     <2|3> <checkout-dir>     mirror a local checkout or worktree, uncommitted
#                                              and untracked files included, then refresh
#   stack.sh lock     <2|3> <owner> [minutes]  wait up to [minutes] (default 30) for the lock
#   stack.sh unlock   <2|3> <owner>
#   stack.sh info     <2|3>                    dir, url, compose project, what is deployed
#
# Directories default to ../web-2nd and ../web-3rd next to the main checkout; override with
# WEB_STACK2_DIR / WEB_STACK3_DIR.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MAIN_ROOT="${PIPELINE_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && resolve_repo_root)}"
[ -f "$MAIN_ROOT/docker-compose.yml" ] || { echo "stack: $MAIN_ROOT is not a web checkout; run <web>/scripts/pipeline/stack.sh" >&2; exit 1; }
REPO_URL="${WEB_REPO_URL:-git@github.com:welligence/web.git}"

die() { echo "stack: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: $0 <setup|restore|up|down|seed|branch|pr|sync|lock|unlock|info> <2|3> [args]"
CMD="$1"; N="$2"; shift 2

case "$N" in
  2) DIR="${WEB_STACK2_DIR:-$(dirname "$MAIN_ROOT")/web-2nd}"; PROJECT=web2; HOST=127.0.0.1; P=40 ;;
  # Not 50xx: macOS ControlCenter (AirPlay Receiver) listens on 5000.
  3) DIR="${WEB_STACK3_DIR:-$(dirname "$MAIN_ROOT")/web-3rd}"; PROJECT=web3; HOST=qa.localhost; P=51 ;;
  *) die "stack must be 2 or 3, got '$N'" ;;
esac
SPA_PORT="${P}00"; API_PORT="${P}31"; PACK_PORT="${P}35"; DB_PORT="543$((N + 1))"; REDIS_PORT="638$((N - 2))"
URL="http://$HOST:$SPA_PORT"
STATE="$DIR/.git/stack-deployed"
LOCK="$DIR/.git/stack-lock"

in_dir() { (cd "$DIR" && "$@"); }

assert_project() {
  local name
  name="$(in_dir docker compose config 2>/dev/null | sed -n 's/^name: *//p' | head -1)"
  [ "$name" = "$PROJECT" ] || die "$DIR resolves to compose project '$name', expected '$PROJECT'; run: $0 setup $N"
}

cmd_setup() {
  if [ ! -d "$DIR/.git" ]; then
    git clone "$REPO_URL" "$DIR"
  fi
  [ -f "$DIR/.env" ] || { [ -f "$MAIN_ROOT/.env" ] && cp "$MAIN_ROOT/.env" "$DIR/.env"; } \
    || die "no .env in $MAIN_ROOT to copy; create the main checkout's .env first"

  local mark="# --- stack $N ($PROJECT) via scripts/pipeline/stack.sh ---"
  # Rewrite our own block on every run so port changes reach existing clones.
  if grep -qxF "$mark" "$DIR/.env"; then
    MARK="$mark" perl -0pi -e 's/\n*\Q$ENV{MARK}\E\n(?:[A-Z_]+=.*\n?)*//' "$DIR/.env"
  fi
  if ! grep -q "^COMPOSE_PROJECT_NAME=$PROJECT\$" "$DIR/.env"; then
    perl -pi -e "s/^DB_PORT_LOCAL=.*/DB_PORT_LOCAL=$DB_PORT/" "$DIR/.env"
    grep -q '^DB_PORT_LOCAL=' "$DIR/.env" || echo "DB_PORT_LOCAL=$DB_PORT" >>"$DIR/.env"
    cat >>"$DIR/.env" <<ENV

$mark
COMPOSE_PROJECT_NAME=$PROJECT
WEB_HOST_PORT=$API_PORT
SPA_HOST_PORT=$SPA_PORT
SHAKAPACK_HOST_PORT=$PACK_PORT
DB_HOST_PORT=$DB_PORT
REDIS_HOST_PORT=$REDIS_PORT
CORS_ALLOWED_ORIGINS=$URL,http://localhost:$SPA_PORT
ENV
  fi

  cat >"$DIR/docker-compose.override.yml" <<YML
services:
  web:
    ports: !override
      - $API_PORT:3031
    environment:
      CORS_ALLOWED_ORIGINS: $URL,http://localhost:$SPA_PORT
      # backend/lib/cors_config.rb gives origins other than localhost/127.0.0.1 Secure cookies,
      # which an http page drops; FORCE_SSL=false keeps them Lax. Only production reads it otherwise.
      FORCE_SSL: "false"
  spa:
    ports: !override
      - $SPA_PORT:3000
  shakapack:
    ports: !override
      - $PACK_PORT:3035
  db:
    ports: !override
      - $DB_PORT:5432
  redis:
    ports: !override
      - $REDIS_PORT:6379
YML
  grep -qxF docker-compose.override.yml "$DIR/.git/info/exclude" 2>/dev/null \
    || echo docker-compose.override.yml >>"$DIR/.git/info/exclude"

  if [ -f "$DIR/frontend/.env.development.example" ] && [ ! -f "$DIR/frontend/.env.development" ]; then
    cp "$DIR/frontend/.env.development.example" "$DIR/frontend/.env.development"
  fi
  if [ -f "$DIR/frontend/.env.development" ]; then
    perl -pi -e "s#^VITE_API_BASE_URL=.*#VITE_API_BASE_URL=http://$HOST:$API_PORT#" "$DIR/frontend/.env.development"
  fi

  if [ ! -f "$DIR/stg-welligence.dump" ] && [ -f "$MAIN_ROOT/stg-welligence.dump" ]; then
    cp -c "$MAIN_ROOT/stg-welligence.dump" "$DIR/" 2>/dev/null || cp "$MAIN_ROOT/stg-welligence.dump" "$DIR/"
  fi

  assert_project
  in_dir docker compose config | grep -E 'published:' | sort -u
  echo "stack $N: configured at $DIR ($PROJECT), open $URL"
}

# Roles are cluster-wide, so the STG dump does not carry them, and the migrations that create
# them already ran on STG; without them later migrations fail ("role ... does not exist").
ensure_roles() {
  local f
  in_dir docker compose up -d --wait db >/dev/null
  for f in "$DIR"/backend/db/users/*.sql; do
    [ -f "$f" ] || continue
    in_dir docker compose exec -T -e PGOPTIONS="-c client_min_messages=warning" db psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 <"$f" >/dev/null
  done
}

cmd_restore() {
  assert_project
  [ -f "$DIR/stg-welligence.dump" ] || die "no stg-welligence.dump in $DIR or $MAIN_ROOT; run 'make syncdb' in the main checkout first"
  in_dir docker compose up -d --wait db
  # restore_db.sh exits 1 with "errors ignored on restore: 5" on a healthy restore (RDS-only
  # extensions plus one FK the STG data violates); any other pg_restore error is real.
  in_dir ./backend/db/scripts/restore_db.sh stg || true
  ensure_roles
}

wait_http() {
  local url="$1" i code
  for i in $(seq 1 90); do
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$url" || true)"
    [ "$code" = 200 ] && return 0
    sleep 10
  done
  return 1
}

cmd_up() {
  assert_project
  ensure_roles
  in_dir docker compose up -d
  wait_http "http://127.0.0.1:$API_PORT/up" || die "API on :$API_PORT did not answer 200 within 15 min (docker compose -p $PROJECT logs web)"
  wait_http "http://127.0.0.1:$SPA_PORT/" || die "SPA on :$SPA_PORT did not answer 200 within 15 min (docker compose -p $PROJECT logs spa)"
  echo "stack $N: up at $URL"
}

# E2E users (admin_end_to_end@welligence.com etc.) with the repo's default E2E password.
cmd_seed() {
  assert_project
  in_dir docker compose exec -T -w /app/backend web bundle exec rails runner db/seeds/playwright_config.rb
}

cmd_down() { assert_project; in_dir docker compose down; }

running() { [ -n "$(in_dir docker compose ps -q --status running 2>/dev/null)" ]; }

# After the code changed underneath a running stack: install what the lockfiles now ask for,
# migrate, and restart what does not hot-reload.
refresh() {
  local before="$1" after
  after="$(git -C "$DIR" rev-parse HEAD)"
  running || { echo "stack $N: not running; '$0 up $N' starts it on the new code"; return 0; }
  local changed=""
  [ -n "$before" ] && changed="$(git -C "$DIR" diff --name-only "$before" "$after" 2>/dev/null || echo all)"
  if [ -z "$before" ] || grep -q 'Gemfile.lock' <<<"$changed"; then
    in_dir docker compose exec -T web bundle install --quiet
    in_dir docker compose restart web sidekiq
  fi
  if [ -z "$before" ] || grep -q 'pnpm-lock.yaml' <<<"$changed"; then
    in_dir docker compose exec -T spa pnpm install --frozen-lockfile
    in_dir docker compose restart spa
  fi
  ensure_roles
  if [ -z "$(in_dir docker compose ps -q --status running web)" ]; then
    in_dir docker compose up -d web
  fi
  wait_http "http://127.0.0.1:$API_PORT/up" || die "API did not come back after the refresh"
  in_dir docker compose exec -T web bundle exec rails db:migrate
  wait_http "http://127.0.0.1:$SPA_PORT/" || die "SPA did not come back after the refresh"
}

clean_tree() {
  git -C "$DIR" reset -q --hard
  git -C "$DIR" clean -fdq
}

cmd_branch() {
  local branch="${1:?branch name}" before
  assert_project
  before="$(git -C "$DIR" rev-parse HEAD)"
  git -C "$DIR" fetch -q origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  clean_tree
  git -C "$DIR" checkout -q --detach "origin/$branch"
  printf 'source: origin/%s\nsha: %s\nat: %s\n' "$branch" "$(git -C "$DIR" rev-parse HEAD)" "$(date -u +%FT%TZ)" >"$STATE"
  refresh "$before"
  echo "stack $N: origin/$branch at $(git -C "$DIR" rev-parse --short HEAD), $URL"
}

cmd_pr() {
  local number="${1:?PR number}" before
  assert_project
  before="$(git -C "$DIR" rev-parse HEAD)"
  git -C "$DIR" fetch -q origin "+refs/pull/$number/head:refs/remotes/origin/pr/$number"
  clean_tree
  git -C "$DIR" checkout -q --detach "origin/pr/$number"
  printf 'source: PR #%s\nsha: %s\nat: %s\n' "$number" "$(git -C "$DIR" rev-parse HEAD)" "$(date -u +%FT%TZ)" >"$STATE"
  refresh "$before"
  echo "stack $N: PR #$number at $(git -C "$DIR" rev-parse --short HEAD), $URL"
}

cmd_sync() {
  local src before head
  src="$(cd "${1:?checkout dir}" && pwd)"
  assert_project
  before="$(git -C "$DIR" rev-parse HEAD)"
  head="$(git -C "$src" rev-parse HEAD)"
  git -C "$DIR" fetch -q "$src" HEAD
  [ "$(git -C "$DIR" rev-parse FETCH_HEAD)" = "$head" ] || die "fetched $(git -C "$DIR" rev-parse FETCH_HEAD), expected $head"
  clean_tree
  git -C "$DIR" checkout -q --detach "$head"
  git -C "$src" diff --binary HEAD | git -C "$DIR" apply --whitespace=nowarn --allow-empty
  git -C "$src" ls-files -z --others --exclude-standard -- . \
    ':!.jira-plans' ':!.claude' ':!.mcp.json' ':!flags.json' ':!.codex' ':!.cursor' ':!.agents' ':!AGENTS.md' \
    | rsync -a --from0 --files-from=- "$src/" "$DIR/"
  printf 'source: %s\nbranch: %s\nsha: %s\ndirty: %s\nat: %s\n' "$src" \
    "$(git -C "$src" branch --show-current)" "$head" \
    "$([ -n "$(git -C "$src" status --porcelain -- . ':!.jira-plans' ':!.claude')" ] && echo yes || echo no)" \
    "$(date -u +%FT%TZ)" >"$STATE"
  refresh "$before"
  echo "stack $N: synced $src ($(git -C "$src" branch --show-current) $(git -C "$src" rev-parse --short HEAD)), $URL"
}

cmd_lock() {
  local owner="${1:?owner}" minutes="${2:-30}" deadline
  deadline=$(( $(date +%s) + minutes * 60 ))
  while ! mkdir "$LOCK" 2>/dev/null; do
    if [ "$(cat "$LOCK/owner" 2>/dev/null)" = "$owner" ]; then echo "stack $N: lock already held by $owner"; return 0; fi
    # A holder that crashed never unlocks; four hours is longer than any QA phase.
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +240 2>/dev/null)" ]; then rm -rf "$LOCK"; continue; fi
    [ "$(date +%s)" -lt "$deadline" ] || die "lock held by $(cat "$LOCK/owner" 2>/dev/null || echo unknown) for over $minutes min"
    sleep 20
  done
  echo "$owner" >"$LOCK/owner"
  echo "stack $N: locked by $owner"
}

cmd_unlock() {
  local owner="${1:?owner}"
  [ -d "$LOCK" ] || { echo "stack $N: not locked"; return 0; }
  [ "$(cat "$LOCK/owner" 2>/dev/null)" = "$owner" ] || die "lock is held by $(cat "$LOCK/owner" 2>/dev/null), not $owner"
  rm -rf "$LOCK"
  echo "stack $N: unlocked"
}

cmd_info() {
  echo "dir: $DIR"
  echo "url: $URL"
  echo "project: $PROJECT"
  echo "ports: spa $SPA_PORT, api $API_PORT, db $DB_PORT, redis $REDIS_PORT"
  if [ -d "$DIR/.git" ]; then
    echo "running: $(running && echo yes || echo no)"
    if [ -f "$STATE" ]; then cat "$STATE"; fi
    if [ -d "$LOCK" ]; then echo "locked by: $(cat "$LOCK/owner" 2>/dev/null)"; fi
  else
    echo "status: not set up ($0 setup $N)"
  fi
}

case "$CMD" in
  setup|restore|up|down|seed|branch|pr|sync|lock|unlock|info) "cmd_$CMD" "$@" ;;
  *) die "unknown command '$CMD'" ;;
esac

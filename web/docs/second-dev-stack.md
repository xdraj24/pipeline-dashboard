# Running the app, and a second stack for code review

This covers the main dev stack, and a second fully isolated stack (own DB, Rails, SPA, Sidekiq, Redis) running from a separate clone. Use the second stack to run another branch, e.g. a co-developer's PR, without touching your main stack or its database.

The "For AI agents" section at the end is written for Claude Code, Codex, Cursor and other coding agents. Humans can skip it.

## Main stack

First time only, from the repo root (needs `.env`, see README pre-requisites):

```
make init          # macOS Apple Silicon; use make init_amd64 on Linux/WSL2/Intel
```

This builds the images, restores the STG dump into the local DB and starts everything. Afterwards:

```
make start         # foreground; Ctrl+C stops it
# or
docker compose up -d   # background; follow logs with docker compose logs -f
```

| Service | URL |
|---|---|
| SPA | http://localhost:3000 |
| Rails API | http://localhost:3031 |
| Postgres | localhost:5432 |

Refresh the DB from the latest STG dump with `make syncdb`.

## Second stack

The second stack is a second clone with its own compose project (`web2`), its own volumes (so its own DB) and shifted host ports:

| Service | Main | Second |
|---|---|---|
| SPA | localhost:3000 | **127.0.0.1:4000** |
| Rails API | localhost:3031 | 127.0.0.1:4031 |
| Shakapacker | 3035 | 4035 |
| Postgres | 5432 | 5433 |
| Redis | 6379 | 6380 |

### Open it at 127.0.0.1, not localhost

Use http://127.0.0.1:4000. On `localhost:4000` login fails with `ActionController::InvalidAuthenticityToken` ("Can't verify CSRF token authenticity").

The second SPA calls its API at `http://127.0.0.1:4031`. A page on `localhost` calling `127.0.0.1` is cross-site, and the session cookie is `SameSite=Lax`, so the browser never sends it and the CSRF token can't be verified. Cookies are also scoped by host, not port: two stacks both on `localhost` would overwrite each other's session. `127.0.0.1` keeps both logins working side by side.

### Docker memory

Give Docker Desktop at least 16 GB (Settings > Resources). The first SPA start in a new stack takes about 3.2 GiB while Vite builds its dependency cache. With a 7.75 GiB VM, starting the second stack OOM-killed the main stack's SPA (`docker inspect web-spa-1` showed `OOMKilled=true`).

### Setup, when the branch has `make start_second`

```
git clone git@github.com:welligence/web.git ../web-2nd
cd ../web-2nd
cp ../web/.env .
git checkout <branch>
make start_second
```

On first run `start_second`:

1. appends a marked block to this clone's `.env` (`COMPOSE_PROJECT_NAME=web2` and the port settings);
2. points `frontend/.env.development` at `http://127.0.0.1:4031`;
3. starts the `web2` DB and, if the database doesn't exist yet, restores the STG dump into it. It uses `./stg-welligence.dump`, else copies `../web/stg-welligence.dump`, else runs `make syncdb`;
4. runs `docker compose up` in the foreground.

Later runs skip the restore and just start the stack. `make console`, `make test`, `make db_migrate` etc. in this clone target the second stack.

### Setup, when the branch doesn't have it

Branches cut before `start_second` existed have hardcoded ports in `docker-compose.yml`. Set the clone up with untracked files only, so it works on any branch:

```
git clone git@github.com:welligence/web.git ../web-2nd
cd ../web-2nd
cp ../web/.env .
perl -pi -e 's/^DB_PORT_LOCAL=.*/DB_PORT_LOCAL=5433/' .env
cat >> .env <<'ENV'

# --- second dev stack (make start_second) ---
COMPOSE_PROJECT_NAME=web2
WEB_HOST_PORT=4031
SPA_HOST_PORT=4000
SHAKAPACK_HOST_PORT=4035
DB_HOST_PORT=5433
REDIS_HOST_PORT=6380
CORS_ALLOWED_ORIGINS=http://127.0.0.1:4000,http://localhost:4000
ENV

cat > docker-compose.override.yml <<'YML'
services:
  web:
    ports: !override
      - 4031:3031
    environment:
      CORS_ALLOWED_ORIGINS: http://127.0.0.1:4000,http://localhost:4000
  spa:
    ports: !override
      - 4000:3000
  shakapack:
    ports: !override
      - 4035:3035
  db:
    ports: !override
      - 5433:5432
  redis:
    ports: !override
      - 6380:6379
YML
echo docker-compose.override.yml >> .git/info/exclude

cp frontend/.env.development.example frontend/.env.development
perl -pi -e 's#^VITE_API_BASE_URL=.*#VITE_API_BASE_URL=http://127.0.0.1:4031#' frontend/.env.development

cp -c ../web/stg-welligence.dump .     # APFS clone: instant, no extra disk
```

`!override` replaces the port lists instead of appending to them (Docker Compose 2.24+). The marker line in `.env` means a later `make start_second` won't append the block twice.

Check before starting anything:

```
docker compose config | grep -E '^name:|published:'   # name: web2, only 4031/4000/4035/5433/6380
```

Restore the DB, then start the rest:

```
docker compose up -d --wait db
./backend/db/scripts/restore_db.sh stg
docker compose up -d
```

`restore_db.sh` exits 1 with `errors ignored on restore: 5`. That's expected: `aws_commons` and `aws_s3` are RDS-only extensions, and the STG data violates `fk_rails_05cf230adf` (`etl_errors.etl_run_id`), which the main DB is missing too. Any other `pg_restore: error` line is a real problem.

On these branches, `make console`, `make test`, `make shell` and `make db_migrate` still call `docker exec web-web-1`, which is the **main** stack. Use `docker compose exec web ...` from the clone instead, e.g.:

```
docker compose exec web bundle exec rails c
docker compose exec web bundle exec rails db:migrate
docker compose exec -T web bundle exec rspec spec/...
```

### Stopping and cleaning up

```
docker compose down       # from ../web-2nd; keeps the web2 DB volume
docker compose down -v    # also deletes the web2 DB; the next start restores again
```

## Scripted setup and the third (QA) stack

`scripts/pipeline/stack.sh` (from the pipeline-dashboard repo, linked into the main checkout)
does the "doesn't have it" setup above without editing tracked files, and runs a third, identical
stack for automated QA:

| Stack | Clone | Compose project | SPA | API | Shakapacker | Postgres | Redis | Used by |
|---|---|---|---|---|---|---|---|---|
| 2 | `../web-2nd` | `web2` | **127.0.0.1:4000** | 4031 | 4035 | 5433 | 6380 | `/w-24-land-branch-for-review` |
| 3 | `../web-3rd` | `web3` | **qa.localhost:5100** | 5131 | 5135 | 5434 | 6381 | `/w-1-coding` qa-check phase |

```
scripts/pipeline/stack.sh setup 3      # clone + untracked config
scripts/pipeline/stack.sh restore 3    # STG dump into the web3 DB (long)
scripts/pipeline/stack.sh up 3         # detached, waits for SPA and API
scripts/pipeline/stack.sh pr 2 5464    # run a PR on the review stack
scripts/pipeline/stack.sh sync 3 <checkout-or-worktree>   # mirror a local branch, uncommitted files included
scripts/pipeline/stack.sh info 3
```

`branch`, `pr` and `sync` reset the clone (`git reset --hard`, `git clean -fd`) before checking
out, then migrate and reinstall changed lockfiles when the stack is running. Migrations applied
for one branch stay in that stack's DB. `lock` / `unlock` serialise QA runs on stack 3.

Each stack has its own host (`localhost`, `127.0.0.1`, `qa.localhost`), so one browser keeps a
separate login on each; cookies are per host, not per port. `backend/lib/cors_config.rb` treats
only `localhost` and `127.0.0.1` as plain-HTTP local and gives other origins `Secure` cookies,
which an `http://` page drops, so the QA stack's override sets `FORCE_SSL=false` on `web` (outside
production nothing else reads it). Chrome and Node resolve `*.localhost` without a hosts entry.
Port 5000 is taken by macOS AirPlay Receiver, hence 5100.

## For AI agents (Claude Code, Codex, Cursor, ...)

Rules that keep you from damaging the wrong stack:

- **Run every `docker compose` and `make` command from the root of the clone you mean to act on.** The compose project (`web` vs `web2`) is chosen by the `.env` in the current directory.
- **Before any destructive DB action** (`restore_db.sh`, `make syncdb`, `make restoredb`, `db:drop`, `docker compose down -v`), run `docker compose config | grep '^name:'` and `grep ^DB_PORT_LOCAL .env`, and confirm both point at the stack you intend. `restore_db.sh` drops and recreates the database.
- **Never use `docker exec web-web-1`, `web-spa-1` etc. when working on the second stack.** Those names are the main stack. Use `docker compose exec <service>` from the second clone, which resolves to `web2-*`.
- **Check which setup the branch supports:** `grep -q '^start_second:' Makefile`. If present, use `make start_second`. If not, follow "Setup, when the branch doesn't have it" exactly and use `docker compose exec` instead of the Make targets that hardcode `web-web-1`.
- **Never edit tracked files in the second clone to make it run.** It exists to run someone else's branch as-is. The setup uses `.env`, `frontend/.env.development`, `docker-compose.override.yml` (excluded via `.git/info/exclude`) and the dump file, none of which are committed. `git status` in the clone should stay clean.
- **The restore takes a long time** (the STG DB is about 49 GB). Run it in the background, and don't start `web` until it finishes: the Rails entrypoint runs `db:create db:migrate` and would race the restore.
- **Starting the foreground stack** (`make start`, `make start_second`) blocks. As an agent, use `docker compose up -d`, then poll `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4031/up` and `http://127.0.0.1:4000/` until both return 200. The first SPA start installs node modules into a fresh volume, so poll instead of assuming a fixed wait.
- **If a container exits with code 137,** check `docker inspect <name> --format '{{.State.OOMKilled}}'`. If it's true, tell the user to raise Docker Desktop memory instead of restarting containers in a loop.
- **Tell the user to open `http://127.0.0.1:4000`**, never `localhost:4000` (see "Open it at 127.0.0.1"). The third stack is `http://qa.localhost:5100`.
- Agents running inside the wlaude container follow the `docker exec web-web-1` instructions in `CLAUDE.md`. Those apply to the main stack only.

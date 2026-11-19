# Shared: Lint and Test What You Touched

Every `w-*` skill that changes code runs its checks through this doc. The caller says which files
are in scope and what to do with files the linters modify; this doc says how to run the checks.

## Container working directory

The dev containers (`web-spa-1`, `web-web-1`) mount the main checkout at `/app`. A pipeline
worktree is a different directory on the same mount (`/app/.ai-workspace/worktrees/<TICKET-ID>`), and
`scripts/pipeline/prepare-worktree.sh` writes it to the worktree's `.ai-workspace/pipeline.env`
as `PIPELINE_CONTAINER_WORKDIR`. Every
`-w` below uses `${PIPELINE_CONTAINER_WORKDIR:-/app}` — a bare `/app/frontend` from inside a
worktree lints and tests `main`, not the branch.

Resolve it once at the start of the phase:

```bash
W="${PIPELINE_CONTAINER_WORKDIR:-/app}"
```

## Is a pipeline worktree clean?

`prepare-worktree.sh` copies `.ai-workspace/jira-plans/`, `.claude/skills/`, `.mcp.json`, `flags.json`
and the other hosts' config (`.codex/`, `.cursor/`, `.agents`, `AGENTS.md`) into every worktree,
and none of them are tracked, so a bare `git status --porcelain` there is never empty. Any skill
that asks whether a worktree is clean uses the same pathspec the pipeline scripts use:

```bash
git -C .ai-workspace/worktrees/<TICKET-ID> status --porcelain -- . ':!.ai-workspace' ':!.claude' ':!.mcp.json' ':!flags.json' ':!.codex' ':!.cursor' ':!.agents' ':!AGENTS.md'
```

Empty output means clean.

## Frontend (any `frontend/` file in the diff)

```bash
docker exec -w "$W/frontend" web-spa-1 pnpm exec biome check --write <files relative to frontend/>
docker exec -w "$W/frontend" web-spa-1 pnpm exec jest --findRelatedTests <files relative to frontend/>
docker exec -w "$W/frontend" web-spa-1 pnpm exec jest <changed or added test files>
```

Never run `pnpm install` in a worktree: its `frontend/node_modules` is a symlink to the main
checkout's, so an install there mutates the main environment.

## Backend (any `backend/` file in the diff)

Spec files to run: every changed spec, plus the matching spec for each changed app file
(`backend/app/services/foo.rb` → `backend/spec/services/foo_spec.rb`; a SQL function →
`backend/spec/db/functions/`).

```bash
docker exec -e TEST_ENV_NUMBER -w "$W/backend" web-web-1 bundle exec rubocop -A <files relative to backend/>
docker exec -e TEST_ENV_NUMBER -w "$W/backend" web-web-1 bundle exec rspec <spec files relative to backend/>
```

`-e TEST_ENV_NUMBER` forwards the value the pipeline sets so concurrent runs use separate test
databases; when it isn't set, nothing is forwarded.

## Rules

- Run every check in the foreground and wait for it. Never background a check: under
  `PIPELINE_MODE=unattended` the headless process exits after a fixed ceiling, the stage is
  recorded as done, and the work is lost.
- Fix failures until green. No skipped or disabled tests, no `--no-verify`. If a failure isn't
  resolvable within a few attempts, stop and report it as the calling skill says.
- If Biome or RuboCop modified files, stage them; the calling skill says whether that means a
  new commit or an amend.
- Skip a side entirely if the diff has no files for it.

## Pre-commit hook fails for an environment reason

The code passed the checks above, but `git commit` fails inside a hook. Never bypass it (`SKIP=`,
`--no-verify`): find which case it is, then fix the environment or stop and ask.

| Hook output | Cause | Fix |
|---|---|---|
| `Bundler::GemNotFound` / `Could not find <gem>` from `hooks/rubocop.sh` | The hook ran `docker run welligence/web:dev`, whose baked-in gems lag `backend/Gemfile.lock` | Rebuild the image (`make build`), then retry the commit |
| `Your Ruby version is X, but your Gemfile specified Y` during `make build` | The `FROM ruby:` line in `Dockerfile.wlaude` moved without `backend/.ruby-version` and the Gemfile | Build from a copy pinned to `.ruby-version`, changing no repo file (command below) |
| RuboCop or Biome reports files the diff doesn't touch, or misses the worktree's files | The hook linted `/app/...`, the main checkout, instead of the committing worktree | Lint the worktree with `run-checks.md` paths; ask the developer before committing |

```bash
sed "s/^FROM ruby:[0-9.]*-/FROM ruby:$(cat backend/.ruby-version)-/" Dockerfile.wlaude \
  | docker buildx build -f - --platform linux/arm64 -t welligence/web:dev .
```

Under `PIPELINE_MODE` set, stop with `NEEDS-INPUT` naming the row and the fix; the developer
decides whether to rebuild. `./scripts/pipeline/check-host.sh claude` and `prepare-worktree.sh`
both catch the first two rows before a run starts.

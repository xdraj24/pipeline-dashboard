# Shared: Code Review Panel

Specialist reviewers that read a diff in parallel, each from one angle. Used by `w-1-coding`'s
code-review phase (the ticket's own branch) and by `w-21-review-prs` (another developer's PR).
The calling skill is the **conductor**: it picks the seats, spawns them, triages what they
report, and says what happens to accepted findings (a fixer, or review comments). The conductor
never reviews the diff itself.

Roles and models: `.claude/skills/_shared/host-runtime.md` § Delegation roles. A host without
delegation runs each selected seat's prompt itself, one after another, and says in its report
that the panel was a single model.

## 1. Pick the seats

Read the diff's file list and skim the diff, then decide per seat. Record every seat as `run` or
`skipped (<one-line reason>)`; the caller writes that line into its artifact. When unsure
whether a seat applies, run it.

| Seat | Role | Run when |
|---|---|---|
| linter | checker | any code or test file changed. Skip for docs, Markdown or comments only. |
| staff | reviewer | production logic changed, or test logic changed beyond renames, fixtures or snapshot updates. |
| architect | reviewer | new files, classes, components or modules; a change spanning layers (frontend and backend, GraphQL schema, DB schema or migrations, workers, SQL functions); a new dependency; responsibility moved between layers. Skip for a change local to existing functions. |
| security | reviewer | the diff touches authentication or authorization, resolvers, mutations, controllers or routes, input parsing, raw SQL, file upload, download or export, rendered HTML, secrets, config or env, logging of user data, admin or permission checks, or dependencies and lockfiles. Skip otherwise. |
| ui-ux | reviewer | non-test `frontend/` files that render UI changed: components, pages, styles, copy. Skip for hooks, stores or utils whose rendered output doesn't change. |
| repo | reviewer | any code or test file changed. |

Examples: a PR that changes one Jest test runs linter and repo (plus staff if the test's logic
changed). A new GraphQL mutation runs all seats except ui-ux unless the frontend uses it.

## 2. Spawn

Spawn every seat marked `run` in one message and wait for all of them. Each prompt is the
**common preamble** with the caller's **environment block** filled in, followed by that seat's
**focus**. Never paste a diff or whole files into a prompt; seats read them as the environment
block says.

### Common preamble

> You are the `<seat>` reviewer on a code-review panel for `<TICKET-ID or PR #number>` in this
> Rails + React + Go monorepo. Other reviewers cover the other angles; stay in your lane and
> report nothing outside it. You are read-only: change no file, run no formatter in write mode,
> commit nothing.
>
> Environment:
> `<the caller's environment block: where the diff comes from, where the code is, the frontend
> and backend container command prefixes, and the intent documents to read>`
>
> Read whatever surrounding code you need to judge the change. Judge against this repo's actual
> conventions (root, `frontend/` and `backend/app/` `CLAUDE.md`), not generic opinions.
>
> Report findings as a numbered list, ids `<SEAT>-1`, `<SEAT>-2`, …, each with:
> - `file:line`
> - severity: blocker / major / minor
> - origin: `diff` (introduced or made reachable by this change) or `pre-existing` (the same
>   defect is on `origin/main` independent of this change; say how you know, e.g. the code is
>   identical in `git show origin/main:<file>` and reads nothing the diff changed)
> - the concrete failure scenario in one or two sentences
> - the fix you'd expect, in one sentence
>
> If a finding from a previous round (below) is still unresolved, reuse its id and say so instead
> of re-describing it. If you have nothing, say `No findings.`
>
> Previous rounds' findings and their triage: `<…, or "none - first round">`

### Seat focus

**linter** (checker role)

> Run the checks below for every area the diff touches, in the foreground, with the container
> command prefixes from the environment block, in check mode: no `--write`, no `-A`. A failing
> check is a **blocker**. An error in a file the diff does not touch is `pre-existing`, never a
> blocker for this change.
>
> - Frontend: `pnpm exec biome check <changed files>`; `pnpm exec tsc --noEmit -p .` and report
>   only errors in changed files or caused by them; `pnpm exec jest --coverage
>   --findRelatedTests <changed files>` and report changed lines no test executes.
> - GraphQL: a change to types, fields or arguments under `backend/app/graphql/` needs the
>   matching change in `frontend/schema.graphql`, and a change there needs the regenerated
>   `frontend/types/GraphqlSchema.ts` in the diff. Either missing is a blocker, and so is a
>   removed or narrowed field unless the ticket says it's a decommission.
> - Backend: `bundle exec rubocop <changed files>`; `bundle exec rspec` on every changed spec
>   plus the matching spec of each changed app file (`backend/app/services/foo.rb` →
>   `backend/spec/services/foo_spec.rb`; a SQL function → `backend/spec/db/functions/`), and,
>   from the SimpleCov result, report changed lines in `backend/app/` no spec executes. A new app
>   file with no spec is **major**. Migrations get no specs in this repo; don't flag that.
> - `backend/config/smart_report_export_components.json` changed: run the frontend suite that
>   covers the Smart Report component registry too, as CI does.
> - Data loader: `go vet ./...` and `go test ./... -cover` in `data-loader/` when it changed,
>   on the host if `go` is installed; otherwise report "not run (no go toolchain)".
>
> List every command you ran with its exit code before the findings.

**staff** (reviewer role)

> Correctness: logic errors, unhandled states, edge cases (empty, null, boundary, large input,
> concurrency, retries), error handling, N+1 queries and unbounded loads, wrong or missing
> tests, tests that pass without exercising the change, dead code. Don't nitpick style that
> Biome or RuboCop enforce.

**architect** (reviewer role)

> Design: does the change sit in the right layer, follow the data flow the repo already uses,
> and avoid new coupling across `frontend/`, GraphQL, services, queries, workers and SQL? Flag
> new abstractions that duplicate an existing one, logic in the wrong place (query logic in a
> GraphQL resolver instead of an `ApplicationQuery` under `backend/app/queries/`), GraphQL
> schema changes that aren't backward compatible, and choices that will be expensive to undo.
> Name the existing example the code should follow.

**security** (reviewer role)

> OWASP top 10 on the changed paths: authorization on every new or changed resolver, mutation,
> controller and worker (who can reach it, and can they reach another customer's data?), SQL
> built from input (raw SQL under `backend/app/sql/`, `find_by_sql`, string interpolation),
> XSS (`dangerouslySetInnerHTML`, unescaped HTML in exports), secrets or tokens in code or logs,
> sensitive data in logs, error messages or GraphQL errors, unsafe file handling, and new
> dependencies with known advisories.

**ui-ux** (reviewer role)

> The changed UI, judged from code and from the ticket's attachments when the environment block
> names them: reuse of the existing components and design tokens instead of one-off styling,
> loading, empty and error states, keyboard and screen-reader access (labels, focus, roles), copy
> and units consistent with the rest of the app, layout at narrow widths, and whether the result
> matches the ticket's expected UI. You can't run the app; QA does that, so report only what the
> code shows.

**repo** (reviewer role)

> This repo's customs, from its `CLAUDE.md` files and from how neighbouring code is written:
> file placement, naming, idioms, error-handling patterns, generated files edited by hand, a
> new query or mutation not taking a single `input` argument, a new `.js` file, and the rules
> below. Reviewers here reject these every time, so both are **major**:
> 1. **Comment volume.** Any comment that narrates what the code does, restates a name, explains
>    the diff, or runs longer than two lines is a finding; say whether to delete it or shorten
>    it to its one load-bearing sentence. Comments in test files are always a finding. Only a
>    non-obvious trap, quirk, or magic-value origin earns one, roughly one per file.
> 2. **Ignoring an existing seam.** New code that reimplements a structure the repo already has.
>    Name the existing example it should follow.

## 3. Triage

Merge the reports, drop duplicates between seats (keep the clearest one, note the other id), and
put every finding in exactly one bucket. Check the code yourself before deciding; a reviewer can
be wrong about what a line does.

- **fix** — a real defect or convention breach in this diff that is worth the change: every
  blocker, every major, and a minor when the fix is small and local. The caller says what
  happens to it.
- **won't fix** — a false positive, a preference the repo's conventions don't back, something
  the ticket or plan deliberately decided otherwise, or a pre-existing problem too small to
  track. Give a one-line reason.
- **follow-up bug** — real and worth fixing, but `pre-existing` and outside this change's scope.
  It goes to the backlog via `.claude/skills/_shared/raise-follow-up-bug.md`.

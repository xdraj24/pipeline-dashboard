# Phase: QA Check

Input from `SKILL.md`: a single ticket id.

A staff-level QA pass over the ticket's committed branch. The **qa** role (a strong model,
`.claude/skills/_shared/host-runtime.md` § Delegation roles) is not the author: it writes a
test plan from the ticket's acceptance criteria, runs the automated suites for every touched
area, probes the edge cases the plan left untested, and tests the change in the running app.
Blocker/major findings go to the **fixer** role; the qa role re-verifies what was fixed. Up to
**2 rounds**. The phase ends with `.jira-plans/<TICKET-ID>/qa-check.md`, whose
`code_changed:` line tells `SKILL.md` (and the pipeline) whether code-review and commit have to
run again.

A host without delegation does the QA pass itself in the same session, as a single
non-adversarial pass, and says so in the report. Always report which model ran each role.

## 1. Gather context

- `git status` and `git diff origin/main` (committed and uncommitted, untracked new files read
  too) — the branch's full diff. Empty → stop: nothing to QA; point at the implement phase.
- Read `.jira-plans/<TICKET-ID>/plan.md` (requirements, Implementation Log),
  `change-notes.md` and the `## Testing Instructions` section of `local-branch.md`, each if it
  exists. Fetch the JIRA ticket (`mcp__atlassian__getJiraIssue`, cloud id via
  `mcp__atlassian__getAccessibleAtlassianResources` if needed) for its acceptance criteria; if
  the fetch fails, continue on `plan.md` alone and say so in the report.
- `W="${PIPELINE_CONTAINER_WORKDIR:-/app}"` as `.claude/skills/_shared/run-checks.md` says.

## 2. Put the branch on the QA stack

The browser pass runs against the **QA stack**: the third full web instance (`../web-3rd`,
compose project `web3`, http://qa.localhost:5100), driven by `scripts/pipeline/stack.sh` and set
up by `/w-setup`. It serves whatever this phase syncs into it, so it tests the branch from the
main checkout and from a pipeline worktree alike, and never disturbs the developer's own stack.

```bash
S="$(git rev-parse --show-toplevel)/scripts/pipeline/stack.sh"
"$S" info 3
```

**QA stack set up** (`info` prints `running:`):

1. `"$S" lock 3 <TICKET-ID> 30` — one ticket at a time; parallel pipeline tickets wait their
   turn. Still locked after 30 minutes → `browser: blocked (QA stack busy)`.
2. `running: no` → `"$S" up 3` (foreground, up to 15 minutes).
3. `"$S" sync 3 "$(git rev-parse --show-toplevel)"` — mirrors this checkout's `HEAD` plus its
   uncommitted and untracked files into the stack, runs migrations and reinstalls when a lockfile
   changed. It resets `../web-3rd` to that state; nothing there is ever kept.
4. App URL: `http://qa.localhost:5100`. Exit non-zero from any step → `browser: blocked (<last
   line of its output>)`.
5. Release the lock when the phase ends, whatever the outcome (escalation and errors included):
   `"$S" unlock 3 <TICKET-ID>`. Leave the stack running.

**QA stack not set up** (`info` prints `status: not set up`): fall back to the developer's main
stack, which only serves the main checkout.

- Pipeline worktree (`PIPELINE_CONTAINER_WORKDIR` is `/app/.claude/worktrees/...`): the main
  stack would test the wrong code. `browser: skipped (worktree, no QA stack; run /w-setup)`.
- Main checkout: app URL `http://localhost:3000`. If
  `docker ps --filter name=web-web-1 --filter name=web-spa-1 --format '{{.Names}}'` lacks either
  name, start it: `make start` needs `.env` at the repo root (missing → `browser: blocked (no .env
  at repo root)`), runs in the foreground, so `nohup make start > <scratch directory>/make-start.log
  2>&1 &`, then poll `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/login` every
  15 s for up to 15 minutes. If `docker image inspect welligence/web:dev` fails, `make build`
  (`make build_amd64` on `x86_64`) first and say it takes tens of minutes.

**Driver**, when the pass runs:

- Claude Code without `PIPELINE_MODE`: the `claude-in-chrome` tools — load them with
  `ToolSearch` (`select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__find,mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__read_network_requests,mcp__claude-in-chrome__tabs_create_mcp`),
   call `tabs_context_mcp` first and open a new tab for the app URL. On the QA stack Chrome may
  land on the login page (its cookies are per host): ask the developer to log in there once, via
  `.claude/skills/_shared/slack-escalation.md`. `browser: chrome`.
- Every other case (`PIPELINE_MODE=unattended`, Codex, Cursor): Playwright runs from the pipeline-dashboard repo's `tools/playwright/` (installed by
  `/w-setup`; `DASH` as in `.claude/skills/_shared/slack-escalation.md`), not from the web repo:
  write the ad hoc spec to `$DASH/tools/playwright/tmp/<TICKET-ID>-<slug>.spec.ts` (never under
  the web repo's `tests/`), start each test with `await login(page)` imported from `../login.ts`,
  and run `cd "$DASH/tools/playwright" && WEB_REPO_ROOT=<main checkout> BASE_URL=<app URL> npx
  playwright test tmp/<file>`. `login.ts` takes `BASE_USER` / `BASE_PASSWORD`, else the main
  checkout's `playwright.env.local.json` (the seeded `admin_end_to_end@welligence.com`). Neither
  → `browser: blocked (no test credentials)`; interactively, ask the developer via
  `.claude/skills/_shared/slack-escalation.md` before settling for that. Delete the spec
  afterwards. `browser: playwright`.

## 3. Run the loop (round = 1)

### a. QA (qa role)

Delegate to the **qa** role and wait for the result. Prompt:

> You are a staff-level QA engineer testing ticket `<TICKET-ID>` on its branch in this
> Rails + React + Go monorepo (conventions: root, `frontend/` and `backend/app/` `CLAUDE.md`).
> You did not write this code. Your job is to find what breaks, not to confirm that it works.
>
> Ticket, description and acceptance criteria: `<JIRA fields, or "JIRA unavailable">`
> Plan and implementation log: `<plan.md>`
> Change notes: `<change-notes.md, or "none">`
> Testing instructions from the commit phase: `<section from local-branch.md, or "none">`
> Diff:
> ```
> <the diff/new files>
> ```
> Environment: `<main checkout | pipeline worktree>`; container working directory `<W>`;
> browser pass: `<chrome tools | playwright | not available: <reason>>`; app at `<app URL>`
> (the QA stack serves this branch; tests and probes still run in the main dev containers as
> below).
>
> 1. **Test plan.** From the acceptance criteria and the diff, list the cases a release-blocking
>    QA would check: every criterion, the edge cases the code's branches imply (empty, null,
>    boundary, large, concurrent, unauthorized, wrong role, other units or locales), and the
>    adjacent features the touched code can regress. Only cases that matter.
> 2. **Automated.** Run the whole spec files and Jest suites of every touched area — not only
>    `--findRelatedTests` — with the container commands and the working-directory rule in
>    `.claude/skills/_shared/run-checks.md`, in the foreground.
> 3. **Probes.** Where the plan leaves a case untested, write throwaway checks in the scratch
>    directory (never inside the repo): an RSpec or Jest file run against the branch, or
>    `docker exec -w "<W>/backend" web-web-1 bundle exec rails runner '<ruby>'` against the
>    development database, read-only — never write, migrate or seed it. Add nothing to the repo
>    and delete nothing from it. A probe that ought to be a real test is a finding.
> 4. **Browser.** With the driver named above, walk the testing instructions and every UI case
>    of the test plan on `<app URL>`. Watch the console and failed network requests
>    (`read_console_messages` / `read_network_requests` in Chrome; `page.on('console')` /
>    `page.on('requestfailed')` in Playwright). Screenshot each case to `<shots dir>` as
>    `<TICKET-ID>-qa-<slug>.png`, framed on the changed UI so a PR reviewer sees the feature
>    working. Never trigger a native `alert`, `confirm` or `prompt`. If the browser pass is not
>    available, mark those cases "not run" — never pretend.
> 5. **Report.** A numbered list of findings, each with: severity (blocker/major/minor), where
>    (file:line, or URL plus steps), what you did, what happened, what should have happened. Then
>    the test plan with pass / fail / not run per case, the commands you ran, and a
>    `Screenshots` list: one line per file, `<path> — <one-line caption of what it shows>`. A finding from a previous round (below) that is still open: say so instead of
>    describing it afresh. In round 2, re-verify the fixed findings first, then re-run the cases
>    they touch.
>
> Previous rounds' findings and the fixer's report (if any): `<..., or "none - first round">`
>
> End your response with **exactly one** of these as the final line, nothing after it:
> `QA: PASS` (no blocker/major finding open) or `QA: FINDINGS`.

- `QA: PASS` → step 4.
- `QA: FINDINGS` → step b.

### b. Fix (fixer role)

Delegate to the **fixer** role and wait for the result. Prompt:

> A staff QA engineer tested your implementation for ticket `<TICKET-ID>` and found the issues
> below. Fix each blocker and major directly in the working tree — minimal, targeted changes,
> following this repo's conventions (root, `frontend/`, `backend/app/` `CLAUDE.md`). Add or
> update the test each finding implies. Re-run lint and tests for everything you touch exactly
> as `.claude/skills/_shared/run-checks.md` describes (foreground only, container paths from
> that doc) and make sure they pass. Never skip or disable a failing test. Leave minor findings
> alone unless the fix is a one-liner next to something you are already changing.
>
> Findings to address:
> ```
> <the numbered findings from step a>
> ```
>
> Report back what you changed and the result of every lint/test run.

- Increment round. Round > 2 → step 5 (escalate).
- Otherwise re-run `"$S" sync 3 "$(git rev-parse --show-toplevel)"` when on the QA stack, so it
  serves the fixed code, then back to step a, passing this round's findings and the fixer's
  report as "previous rounds".

## 4. Write the artifact

`<shots dir>` is `<scratch directory>/qa-<TICKET-ID>/round-<n>/`, one per round, created before
step a.

On `QA: PASS` with a browser pass, keep the final round's screenshots for `/w-4-publish`, which
attaches them to the PR: replace `.jira-plans/<TICKET-ID>/screenshots/` with the files from the
last round that show the change working (leave out failure shots), plus an `index.md` holding
the `Screenshots` lines from the report with bare file names. Without a pass or without a browser
pass, delete `.jira-plans/<TICKET-ID>/screenshots/` so stale shots never reach a PR. The folder is
local only (`.jira-plans/` is excluded from git) and goes away with the ticket's plan folder.

Write `.jira-plans/<TICKET-ID>/qa-check.md` (overwrite — this is a refresh):

```
---
ticket: <TICKET-ID>
status: pass | needs-manual-qa
code_changed: yes | no
browser: chrome | playwright | skipped (<reason>) | blocked (<reason>)
app_url: <the URL the browser pass used>
screenshots: <count kept in screenshots/, 0 when none>
rounds: <n>
---

## Test plan
- pass | fail | not run — <case>

## Findings fixed
- <finding, one line> — <what the fixer changed>   ("None" if the fixer never ran)

## Open findings
- <severity> <finding, one line>   (minor findings left alone; "None")

## Models
- qa: <model>
- fixer: <model, or "not used">

QA: PASS | QA: FINDINGS
```

- `code_changed: yes` whenever the fixer ran and changed any file, `no` otherwise. This is the
  line `SKILL.md` and `scripts/pipeline/run-ticket-pipeline.sh` read to decide whether
  code-review and commit run again (the commit phase folds QA fixes into the ticket's existing
  commit).
- `status: pass` here; `needs-manual-qa` only from step 5.
- Open minor findings are carried into `change-notes.md` by the commit phase.

Report: rounds run, the models per role, the browser driver (or why there was none), fixed and
open findings, and the screenshot paths. The next step when this phase ran on its own:
`code_changed: yes` → `/w-1-coding <TICKET-ID> just-code-review`, then `just-commit`;
`code_changed: no` → publish (`here` mode) or land (pipeline), as `SKILL.md` § Report says.

When `browser:` is `skipped` or `blocked`, the UI cases were never exercised, so end the report
with the browser re-run as the first thing to do, before publishing:

> No browser pass (`<reason>`). Fix the cause (`scripts/pipeline/stack.sh info 3`; `/w-setup`
> sets the QA stack up), then run: `/w-1-coding <TICKET-ID> just-qa-check here`

For `blocked (no .env ...)` or `blocked (no test credentials)`
name what is missing: the re-run is pointless until it exists.

## 5. Escalation

Triggered when round > 2 with blocker/major findings still open.

**Interactive (no `PIPELINE_MODE` set):** stop. Show the rounds run and the open findings
verbatim, write `qa-check.md` as in step 4 with `status: needs-manual-qa` and the open findings,
then ask how to proceed via `.claude/skills/_shared/slack-escalation.md` (fix by hand, or accept
and continue). Don't keep fixing on your own past this point.

**Unattended (`PIPELINE_MODE=unattended`):** a code-quality judgment call, not a business
question, so don't ask anyone: run one more fixer pass (step 3b) against the open findings as
its best remaining attempt, don't re-QA it, write `qa-check.md` with `status: needs-manual-qa`,
`code_changed:` reflecting every fixer pass, and an `## Unresolved at pipeline completion`
section listing what is still open verbatim. Report success so the pipeline continues; a human
reviews it via `/w-3-land-branch` before anything reaches a non-draft PR.

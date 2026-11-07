# Phase: QA Check

Input from `SKILL.md`: a single ticket id.

A staff-level QA pass over the ticket's committed branch by the testers in
`.claude/skills/_shared/qa-testers.md`: **functional** against the JIRA ticket, **regression**
against everything the change could have broken. This session is the **conductor**: it picks the
testers and whether a browser pass makes sense, sets up the stack only when it does, triages
every finding, and sends only the accepted ones to the **fixer** role. Up to **2 rounds**. The
phase ends with `.ai-workspace/jira-plans/<TICKET-ID>/qa-check.md`, whose `code_changed:` line
tells `SKILL.md` (and the pipeline) whether code-review and commit have to run again. Always
report which model ran each role.

## 1. Gather context

- `git status` and `git diff origin/main` (committed and uncommitted, untracked new files read
  too) — the branch's full diff. Empty → stop: nothing to QA; point at the implement phase.
- Read `.ai-workspace/jira-plans/<TICKET-ID>/plan.md` (requirements, Implementation Log),
  `change-notes.md` and the `## Testing Instructions` section of `local-branch.md`, each if it
  exists. Fetch the JIRA ticket (`mcp__atlassian__getJiraIssue`, cloud id via
  `mcp__atlassian__getAccessibleAtlassianResources` if needed) for its acceptance criteria; if
  the fetch fails, continue on `plan.md` alone and say so in the report. Open the screenshots and
  PDFs in `.ai-workspace/jira-plans/<TICKET-ID>/attachments/` (download them per
  `.claude/skills/_shared/host-runtime.md` § JIRA attachments if the folder is missing). When
  they show the expected UI, the browser pass compares against them.
- `W="${PIPELINE_CONTAINER_WORKDIR:-/app}"` as `.claude/skills/_shared/run-checks.md` says.

## 2. Pick the testers

`qa-testers.md` § 1, on the full diff. Browser mode here is `driver`.

- No tester selected → write `qa-check.md` as step 5 says with `browser: not needed (<reason>)`,
  `rounds: 0`, `code_changed: no`, the test plan `- not run — <reason no tester applies>`, and
  `QA: PASS`; delete `screenshots/`. Skip everything else and report.
- Browser not selected → `browser: not needed (<reason>)`; skip step 3 entirely, the testers
  run without a browser.

## 3. Put the branch on the QA stack

Only when the browser was selected. The browser pass runs against the **QA stack**: the third full web instance (`../web-3rd`,
compose project `web3`, http://qa.localhost:5100), driven by `scripts/pipeline/stack.sh` and set
up by `/w-setup`. It serves whatever this phase syncs into it, so it tests the branch from the
main checkout and from a pipeline worktree alike, and never disturbs the developer's own stack.

```bash
# scripts/pipeline lives only in the main checkout, not in pipeline worktrees.
MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
S="$MAIN/scripts/pipeline/stack.sh"
"$S" info 3
```

**QA stack set up** (`info` prints `running:`):

1. `"$S" lock 3 <TICKET-ID> 30` — one ticket at a time; parallel pipeline tickets wait their
   turn. Still locked after 30 minutes → `browser: blocked (QA stack busy)`.
2. `running: no` → `"$S" up 3` (foreground, up to 15 minutes).
3. `"$S" sync 3 "$(git rev-parse --show-toplevel)"` — mirrors this checkout's `HEAD` plus its
   uncommitted and untracked files into the stack, reinstalls when a lockfile changed, runs
   migrations and restarts web and sidekiq so the synced Ruby code is served. It resets `../web-3rd` to that state; nothing there is ever kept.
4. App URL: `http://qa.localhost:5100`. Exit non-zero from any step → `browser: blocked (<last
   line of its output>)`.
5. The QA stack has no S3 bucket, so exports and downloads cannot produce a file there. Check
   an export through its query or headers with a read-only `rails runner` probe instead; a
   failed download on the QA stack is not a finding.
6. Release the lock when the phase ends, whatever the outcome (escalation and errors included):
   `"$S" unlock 3 <TICKET-ID>`. Leave the stack running.

**QA stack not set up** (`info` prints `status: not set up`): fall back to the developer's main
stack, which only serves the main checkout.

- Pipeline worktree (`PIPELINE_CONTAINER_WORKDIR` is `/app/.ai-workspace/worktrees/...`): the main
  stack would test the wrong code. `browser: skipped (worktree, no QA stack; run /w-setup)`.
- Main checkout: app URL `http://localhost:3000`. If
  `docker ps --filter name=web-web-1 --filter name=web-spa-1 --format '{{.Names}}'` lacks either
  name, start it: `make start` needs `.env` at the repo root (missing → `browser: blocked (no .env
  at repo root)`), runs in the foreground, so `nohup make start > <scratch directory>/make-start.log
  2>&1 &`, then poll `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/login` every
  15 s for up to 15 minutes. If `docker image inspect <dev_docker_image>` fails (`host-runtime.md`), `make build`
  (`make build_amd64` on `x86_64`) first and say it takes tens of minutes.

**Driver**, when the pass runs. Only the functional tester drives Chrome; the regression tester
always uses Playwright, so the two never fight over one browser:

- Claude Code without `PIPELINE_MODE`: the `claude-in-chrome` tools — load them with
  `ToolSearch` (`select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__find,mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__read_network_requests,mcp__claude-in-chrome__tabs_create_mcp`),
   call `tabs_context_mcp` first and open a new tab for the app URL. On the QA stack Chrome may
  land on the login page (its cookies are per host): ask the developer to log in there once, via
  `.claude/skills/_shared/slack-escalation.md`. `browser: chrome`.
- Every other case (`PIPELINE_MODE` set, Codex, Cursor): Playwright runs from the pipeline-dashboard repo's `tools/playwright/` (installed by
  `/w-setup`; `DASH` as in `.claude/skills/_shared/slack-escalation.md`), not from the web repo:
  write the ad hoc spec to `$DASH/tools/playwright/tmp/<TICKET-ID>-<slug>.spec.ts` (never under
  the web repo's `tests/`), start each test with `await login(page)` imported from `../login.ts`,
  and run it only through `"$MAIN/scripts/pipeline/pw.sh" <spec> [timeout_s]` with
  `BASE_URL=<app URL>`. It caps the run (default 240 s), kills Playwright's whole process group
  on a hang and deletes the spec, so write a fresh spec per run. Keep each spec to one or two
  tests with `test.setTimeout` of 150 s or less, and append a heartbeat before every run. `login.ts` takes `BASE_USER` / `BASE_PASSWORD`, else the main
  checkout's `playwright.env.local.json` (the seeded `admin_end_to_end@welligence.com`). Neither
  → `browser: blocked (no test credentials)`; interactively, ask the developer via
  `.claude/skills/_shared/slack-escalation.md` before settling for that. `browser: playwright`.

## 4. Run the loop (round = 1)

`<shots dir>` is `<scratch directory>/qa-<TICKET-ID>/round-<n>/`, one per round, created before
step a.

### a. Test

Spawn the testers picked in step 2 as `qa-testers.md` § 2 says, with this environment block:

> - Diff: get it yourself, `git diff origin/main` plus untracked files. The code is the current
>   checkout (`<main checkout | pipeline worktree>`).
> - Intent: `.ai-workspace/jira-plans/<TICKET-ID>/plan.md`, `change-notes.md` and the
>   `## Testing Instructions` section of `local-branch.md`, each if present; ticket attachments
>   in `.ai-workspace/jira-plans/<TICKET-ID>/attachments/`.
> - Frontend commands: `docker exec -w "<W>/frontend" web-spa-1 <command>`. Backend commands:
>   `docker exec -e TEST_ENV_NUMBER -w "<W>/backend" web-web-1 <command>`
>   (`.claude/skills/_shared/run-checks.md`). Read-only rails runner:
>   `docker exec -w "<W>/backend" web-web-1 bundle exec rails runner '<ruby>'`.
> - App: `<app URL>`; it serves this branch; tests and probes still run in the main dev
>   containers above.
> - Browser mode: `driver`, `<chrome tools | playwright>` for functional, Playwright for
>   regression, screenshots to `<shots dir>` named with `<TICKET-ID>` as the id; or `none:
>   <reason>`.

### b. Triage

`qa-testers.md` § 3. A stack artefact includes step 3's item 5 (no S3 on the QA stack). No finding
triaged **fix** left at blocker or major → step 5. Otherwise step c.

### c. Fix (fixer role)

Delegate to the **fixer** role and wait for the result. Prompt:

> QA testers checked your implementation for ticket `<TICKET-ID>` and the findings below were
> accepted. Fix each one directly in the working tree with minimal, targeted changes, following
> this repo's conventions (root, `frontend/`, `backend/app/` `CLAUDE.md`). Add or update the
> test each finding implies. Re-run lint and tests for everything you touch exactly as
> `.claude/skills/_shared/run-checks.md` describes (foreground only, container paths from that
> doc) and make sure they pass. Never skip or disable a failing test. Fix nothing that isn't on
> this list.
>
> Findings to fix:
> ```
> <the findings triaged "fix", with ids>
> ```
>
> Report back what you changed per finding id and the result of every lint/test run.

- Increment round. Round > 2 → step 6 (escalate).
- Otherwise re-run `"$S" sync 3 "$(git rev-parse --show-toplevel)"` when on the QA stack, so it
  serves the fixed code, then back to step a with the same testers, passing every finding so far with
  its triage and the fixer's report as "previous rounds".

## 5. Write the artifact

Raise the follow-up bugs collected across all rounds, per
`.claude/skills/_shared/raise-follow-up-bug.md`.

When the final round has no open blocker/major **fix** finding and a browser pass ran, keep the
functional tester's final-round screenshots for `/w-4-publish`, which attaches them to the PR:
replace `.ai-workspace/jira-plans/<TICKET-ID>/screenshots/` with the files that show the change
working (leave out failure shots and every `-reg-` shot), plus an `index.md` holding their
`Screenshots` lines with bare file names. Otherwise delete
`.ai-workspace/jira-plans/<TICKET-ID>/screenshots/` so stale shots never reach a PR. The folder is
local only (`.ai-workspace/jira-plans/` is excluded from git) and goes away with the ticket's
plan folder.

Write `.ai-workspace/jira-plans/<TICKET-ID>/qa-check.md` (overwrite — this is a refresh):

```
---
ticket: <TICKET-ID>
status: pass | needs-manual-qa
code_changed: yes | no
browser: chrome | playwright | not needed (<reason>) | skipped (<reason>) | blocked (<reason>)
app_url: <the URL the browser pass used>
screenshots: <count kept in screenshots/, 0 when none>
rounds: <n>
---

## Testers
- functional: run | skipped (<reason>)
- regression: run | skipped (<reason>)

## Test plan
- pass | fail | not run — functional: <case>
- pass | fail | not run — regression: <case>

## Findings fixed
- <id> <finding, one line> — <what the fixer changed>   ("None" if the fixer never ran)

## Won't fix
- <id> <severity> <finding, one line> — <reason>   ("None")

## Follow-up bugs
- <id> — <JIRA-KEY> (new | existing) — <summary>   ("None"; `not raised (<reason>)` on failure)

## Open findings
- <id> <severity> <finding, one line>   (still open after the last round; "None")

## Models
- qa: <model> (functional and regression)
- fixer: <model, or "not used">

QA: PASS | QA: FINDINGS
```

- `browser:` is the functional tester's driver; the regression tester's Playwright result shows
  in the test plan.
- `code_changed: yes` whenever the fixer ran and changed any file, `no` otherwise. This is the
  line `SKILL.md` and `scripts/pipeline/run-ticket-pipeline.sh` read to decide whether
  code-review and commit run again (the commit phase folds QA fixes into the ticket's existing
  commit).
- `status: pass` here; `needs-manual-qa` only from step 6.
- Won't-fix minors and open findings are carried into `change-notes.md` by the commit phase.

Report: rounds run, the testers run and skipped, the models per role, the browser driver (or why
there was none), fixed,
won't-fix and open findings, follow-up bug keys with their URLs (`<jira_browse>/<KEY>`), and the
screenshot paths. The next step when this phase ran on its own:
`code_changed: yes` → `/w-1-coding <TICKET-ID> just-code-review`, then `just-commit`;
`code_changed: no` → publish (`here` mode) or land (pipeline), as `SKILL.md` § Report says.

When `browser:` is `skipped` or `blocked` (not `not needed`), the UI cases were never exercised, so end the report
with the browser re-run as the first thing to do, before publishing:

> No browser pass (`<reason>`). Fix the cause (`scripts/pipeline/stack.sh info 3`; `/w-setup`
> sets the QA stack up), then run: `/w-1-coding <TICKET-ID> just-qa-check here`

For `blocked (no .env ...)` or `blocked (no test credentials)`
name what is missing: the re-run is pointless until it exists.

## 6. Escalation

Triggered when round > 2 with blocker/major **fix** findings still open. Raise the follow-up bugs
collected so far either way.

**Interactive (no `PIPELINE_MODE` set):** stop. Show the rounds run and the open findings
verbatim, write `qa-check.md` as in step 5 with `status: needs-manual-qa` and the open findings,
then ask how to proceed via `.claude/skills/_shared/slack-escalation.md` (fix by hand, or accept
and continue). Don't keep fixing on your own past this point.

**Unattended or supervised (`PIPELINE_MODE` set):** a code-quality judgment call, not a business
question, so don't ask anyone: run one more fixer pass (step 4c) against the open **fix**
findings as its best remaining attempt, don't re-test it, write `qa-check.md` with `status:
needs-manual-qa`, `code_changed:` reflecting every fixer pass, and an
`## Unresolved at pipeline completion` section listing what is still open verbatim. Report
success so the pipeline continues; a human reviews it via `/w-3-land-branch` before anything
reaches a non-draft PR.

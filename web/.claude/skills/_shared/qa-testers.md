# Shared: QA Testers

Two testers, both the **qa** role (`.claude/skills/_shared/host-runtime.md` § Delegation roles),
neither the author:

- **functional** tests the change against its JIRA ticket: a test plan from the acceptance
  criteria, the edge cases the code implies, and the changed UI.
- **regression** tests what the change could have broken: the features around it, the callers
  and consumers of the changed code, and the full suites of every touched area.

Used by `w-1-coding`'s qa-check phase and by `w-21-review-prs`. The calling skill is the
**conductor**: it picks the testers and the browser mode, spawns them, triages what they report
and says what happens to accepted findings. A host without delegation runs each selected
tester's prompt itself, one after the other, and says the pass was a single model.

## 1. Pick the testers and the browser mode

Read the diff's file list and skim the diff. Record each tester and the browser as `run` or
`skipped (<one-line reason>)`; the caller writes that into its artifact. When unsure, run it.

| | Run when |
|---|---|
| functional | the change has behaviour a user or API client can observe. Skip for tests, docs, comments, or a refactor with no intended behaviour change. |
| regression | production code changed that other code consumes or that runs on existing data: shared components, hooks, services, models, queries, GraphQL types, SQL, migrations, workers, config, dependencies. Skip for tests or docs only, or code nothing else reaches yet. |
| browser | the change reaches the UI: `frontend/` rendering, or a backend change a page shows (GraphQL fields a page queries, exports, permissions that hide or show UI). Skip for backend-only services, workers, SQL or APIs no page uses; probes cover those. |

Examples: a PR that changes one Jest test runs no tester and no browser. A backend worker fix runs
functional and regression without a browser. A refactor of a shared table component runs
regression with a browser and no functional tester.

No tester selected → there is nothing to QA; the caller records that and moves on.

The browser mode is the caller's: either a tester drives a browser (`driver`), or the testers
write browser cases for the developer to walk (`handover`).

## 2. Spawn

Spawn the selected testers in one message and wait for both. Each prompt is the **common
preamble** with the caller's **environment block** filled in, followed by that tester's
**focus**.

### Common preamble

> You are the `<functional | regression>` QA tester for `<TICKET-ID or PR #number>` in this
> Rails + React + Go monorepo (conventions: root, `frontend/` and `backend/app/` `CLAUDE.md`).
> You did not write this code. Your job is to find what breaks, not to confirm that it works. A
> second tester may cover the other angle; stay in your lane.
>
> Ticket, description and acceptance criteria: `<JIRA fields, or the PR description when there is
> no ticket, or "JIRA unavailable">`
>
> Environment:
> `<the caller's environment block: where the diff comes from, where the code is, the intent
> documents to read, the frontend and backend container command prefixes, the read-only
> rails runner command, the app URL, and the browser mode: driver <chrome tools | playwright>
> with a screenshots dir, or handover, or none>`
>
> Rules for every step:
> - Automated tests run with the container command prefixes above, in the foreground.
> - Throwaway checks go in the scratch directory, never inside the repo: an RSpec or Jest file
>   run against the change, or the rails runner command above against the development
>   database, read-only. Never write, migrate or seed it. Add nothing to the repo and delete
>   nothing from it. A probe that ought to be a real test is a finding.
> - Browser mode `driver`: watch the console and failed network requests
>   (`read_console_messages` / `read_network_requests` in Chrome; `page.on('console')` /
>   `page.on('requestfailed')` in Playwright). Never trigger a native `alert`, `confirm` or
>   `prompt`. Mode `handover`: don't open a browser; write each browser case as path on the app
>   URL, steps, and expected result, for the developer. Mode `none` or a driver that fails: mark
>   the browser cases "not run"; never pretend.
>
> Report a numbered list of findings, ids `<F | R>-1`, `<F | R>-2`, …, each with: severity
> (blocker/major/minor); where (file:line, or URL plus steps); what you did, what happened, what
> should have happened; and origin: `diff` (caused by this change) or `pre-existing` (the same
> behaviour exists on `origin/main` independent of this change; say how you know, e.g. the
> failing code is identical in `git show origin/main:<file>` and reads nothing the diff changed).
> Then the test plan with pass / fail / not run per case, the commands you ran, a `Screenshots`
> list in `driver` mode (one line per file, `<path> — <one-line caption>`), and a
> `Browser cases` list in `handover` mode.
>
> Previous rounds' findings, their triage and the fixer's report: `<…, or "none - first
> round">`. In round 2, re-verify the findings that were fixed first, reusing their ids, then
> re-run the cases they touch.
>
> End your response with **exactly one** of these as the final line, nothing after it:
> `QA: PASS` (no blocker/major finding open) or `QA: FINDINGS`.

### functional focus

> 1. **Test plan.** From the acceptance criteria, the diff and the plan's `## Manual checks` (if
>    there is a plan), list the cases a release-blocking QA would check: every criterion, every
>    manual check, and the edge cases the code's branches imply (empty, null, boundary, large,
>    concurrent, unauthorized, wrong role, other units or locales). Only cases that matter.
> 2. **Automated.** Run the specs and Jest suites that test the changed code.
> 3. **Probes.** Where the plan leaves a case untested, write throwaway checks.
> 4. **Browser.** Cover the testing instructions and every UI case of the test plan. When the
>    ticket's attachments show the expected UI, compare against them. In `driver` mode,
>    screenshot each case as `<id>-qa-<slug>.png`, framed on the changed UI so a PR reviewer
>    sees the feature working.

### regression focus

> 1. **Blast radius.** From the diff, list what else uses the changed code: callers of changed
>    methods and functions, components that render changed components, GraphQL operations that
>    query changed types or fields, workers, exports and SQL functions reading changed tables
>    or columns, shared styles and hooks. Each is a regression case. Only cases that matter.
> 2. **Automated.** Run the whole spec files and Jest suites of every touched area and of every
>    consumer from step 1, not only `--findRelatedTests`. `pnpm exec jest
>    --changedSince=origin/main` in the frontend container catches dependants the list missed.
> 3. **Probes.** Check the consumers no suite covers with throwaway checks.
> 4. **Browser.** Cover the adjacent flows from step 1 that a user reaches through the UI, plus
>    the main page each changed area lives on, and confirm they still behave as on
>    `origin/main`. In `driver` mode your driver is always Playwright (none available → "not
>    run"), and you screenshot failures only, as `<id>-reg-<slug>.png`.

## 3. Triage

Merge both reports, drop duplicates (keep the clearer one, note the other id), and put every
finding in exactly one bucket. Check the evidence yourself before deciding; a tester can misread
a symptom.

- **fix** — a defect the change caused or a gap against the ticket, worth the change: every
  blocker, every major, and a minor when the fix is small and local. The caller says what
  happens to it.
- **won't fix** — not reproducible, the ticket asks for this behaviour, an artefact of the stack
  the test ran on, or a pre-existing problem too small to track. Give a one-line reason.
- **follow-up bug** — real and worth fixing, but `pre-existing` and outside this change's scope.
  It goes to the backlog via `.claude/skills/_shared/raise-follow-up-bug.md`.

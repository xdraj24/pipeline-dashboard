---
name: w-1-coding
description: Take XWWP tickets from JIRA to a locally committed, QA-checked branch (plan, implement, two-model review, commit, staff-level QA in the running app) or run one phase (just-plan/just-implement/just-code-review/just-commit/just-qa-check), in parallel worktrees (background, draft-pr) or in place (here). Use to plan, implement, review, commit or QA a ticket.
argument-hint: "XWWP-XXXX [XWWP-YYYY ...] [just-plan|just-implement|just-code-review|just-commit|just-qa-check] [background|here|draft-pr] [--jobs=N] [--waitForReply=N]"
model: sonnet
effort: xhigh
---

# Coding: Plan → Implement → Code Review → Commit → QA Check

One skill, five phases. Each phase is a file under `phases/` in this skill's folder; when a phase
is up, read its file and follow it as your own instructions for that phase.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

| Phase | File | Writes |
|-------|------|--------|
| plan | `phases/plan.md` | `.jira-plans/<TICKET-ID>/plan.md` |
| implement | `phases/implement.md` | code + tests on a ticket branch, ticks `plan.md` to-dos |
| code-review | `phases/code-review.md` | `.jira-plans/<TICKET-ID>/code-review.md` |
| commit | `phases/commit.md` | `.jira-plans/<TICKET-ID>/change-notes.md`, `local-branch.md`, one local commit |
| qa-check | `phases/qa-check.md` | `.jira-plans/<TICKET-ID>/qa-check.md`; may change code (then code-review and commit run again) |

qa-check is the last phase: a strong model plays staff-level QA against the committed branch,
in the running app when the checkout under test is the one the dev containers serve. When it
changes code, the run goes back through code-review and commit once more (the commit phase
folds the fixes into the ticket's single commit); qa-check itself does not run a second time.

Every question for the developer, in every phase and every mode, goes through
`.claude/skills/_shared/slack-escalation.md` (Slack when it's set up, a direct question
otherwise).

## 1. Parse `$ARGUMENTS`

Split on whitespace/commas. Classify each token:

- `XWWP-\d+` (case-insensitive, uppercase it) → a ticket id. De-duplicate. At least one is
  required — if none, ask the developer for one before doing anything else.
- `just-plan` / `just-implement` / `just-code-review` / `just-commit` / `just-qa-check` → the
  **phase**. At most one. None → run all five in order.
- `background` / `here` / `draft-pr` → the **mode**. At most one. None → `background`.
- `--jobs=N` → pipeline concurrency for background modes (default and hard max: `MAX_SLOTS` in
  `scripts/pipeline/lib.sh`).
- `--waitForReply=N` → minutes an escalation waits for a reply before falling back to the phase's
  best-guess default. Omit it and an escalation waits indefinitely. In `here` mode treat it as
  `WAIT_FOR_REPLY_MINUTES` for this session's escalations.
- Anything else → ask the developer to clarify; don't guess.

Then apply these rules:

- **`PIPELINE_MODE=unattended` is set** (you are already one stage of
  `scripts/pipeline/run-ticket-pipeline.sh`) → force mode `here`. Never launch the pipeline from
  inside the pipeline.
- **Mode `here`** takes exactly one ticket, except `just-plan`, which takes any number (planning
  doesn't touch the working tree). More than one ticket with another phase → ask which one.
- **`draft-pr`** is `background` plus a draft PR at the end, so it needs the commit phase in the
  run: with `just-plan`, `just-implement`, `just-code-review` or `just-qa-check` it makes no
  sense — tell the developer and stop.
- **The plan phase always runs in this session**, whatever the mode: it needs JIRA, repo
  exploration and possibly a Slack answer before anything is fanned out, and that is cheap here
  and awkward in a worktree. `just-plan background` therefore behaves exactly like
  `just-plan here`.

## 2. Load state (this skill is re-entrant)

For every ticket, before running anything:

- `.jira-plans/<TICKET-ID>/plan.md` — exists? Read its `## To-do` list: `<ticked>/<total>`.
- `.jira-plans/<TICKET-ID>/local-branch.md` — exists? Read `status:`.
- `.jira-plans/<TICKET-ID>/qa-check.md` — exists? Read `status:` and `code_changed:`.
- `.claude/worktrees/<TICKET-ID>` — exists?

That combination is the state. Ask "what's still open?", never "what step are you in?". Don't
re-ask anything already recorded in `plan.md`.

When **no phase was given** (full run), decide per ticket what still needs doing:

- No `plan.md` → plan, then the rest.
- `plan.md` and no `local-branch.md` at `ready-for-push` / `ready-for-review` /
  `draft-pr-open` → implement, code-review, commit, qa-check (skip plan unless the developer
  asked for a refresh). Re-running is safe: implement resumes from the first unchecked box,
  code-review re-reads the current diff, commit only commits once tests pass, qa-check
  overwrites its own artifact.
- `local-branch.md` at `ready-for-push` / `ready-for-review` / `draft-pr-open` and no
  `qa-check.md` → qa-check only (a run from before the phase existed, or one that stopped after
  commit), plus the code-review + commit re-cycle if it changes code.
- `qa-check.md` with `code_changed: yes` and the ticket's files still uncommitted → the
  re-cycle never finished: code-review, then commit.
- `local-branch.md` at `ready-for-review` or `draft-pr-open` with `qa-check.md` → already
  done; the ticket's next step is `/w-3-land-branch <TICKET-ID>`. Skip it and say so.
- `local-branch.md` at `pushed` or anything else → landed or never run through here; leave it
  alone and say so.

When **a phase was given**, run exactly that phase on exactly the tickets given — the developer
asked for it; the only check is the phase's own precondition (e.g. implement refuses without a
plan). `just-qa-check` that changes code does not run code-review or commit itself; its report
names them as the next steps.

## 3. Mode `here`

Run the requested phase(s) in order, in this session, in the current working directory. For each
phase, read its file and follow it. Stop at the first phase that fails or stops to wait on the
developer; don't start the next one.

- `just-plan` with several tickets: the plan phase already fans out one `Plan` agent per ticket
  in parallel.
- In a full run, after qa-check read `qa-check.md`: `code_changed: yes` → run code-review and
  then commit once more; `no` → done. Never a second qa-check.
- A full run ends with `local-branch.md` at `status: ready-for-push` (you were in the loop the
  whole time, so no landing pass is needed). Next step: `/w-4-publish <TICKET-ID>`.

## 4. Modes `background` and `draft-pr`

### a. Plan here first

If the plan phase is part of the run (full run with a ticket that has no `plan.md`, or
`just-plan`), run `phases/plan.md` now, in this session, for all such tickets in one go. When it
returns, verify `plan.md` exists for each. Drop any ticket whose plan is missing from the launch
below and report it — the pipeline refuses to start a ticket without a plan.

If the run is `just-plan`, you're done: report as in step 5.

### b. Launch the pipeline

Map the phase to the script's `--stages` value:

| Phase | `--stages` |
|-------|-----------|
| (none) | `implement,code-review,commit,qa-check` |
| `just-implement` | `implement` |
| `just-code-review` | `code-review` |
| `just-commit` | `commit` |
| `just-qa-check` | `qa-check` |

Build the exact command, from the repo root, detached from this session so it survives clearing
the session and quitting the host:

```bash
nohup ./scripts/pipeline/run-batch-implement.sh <TICKET-A> [<TICKET-B> ...] --stages=<stages> [--draft-pr] [--jobs=N] [--waitForReply=N] [--agent=<host>] >/dev/null 2>&1 &
```

`--draft-pr` only for mode `draft-pr`. `--agent` names the host you are running in (`claude`,
`codex` or `cursor`; omit it in Claude Code) so every stage runs under the same CLI; run
`./scripts/pipeline/check-host.sh <host>` first on a non-default host and stop if it fails. Any
other host has no pipeline: tell the developer and offer `here` mode instead. Run the command as
a plain foreground shell call — the trailing `&` returns immediately and the batch keeps running
on its own (on macOS the script holds the machine awake with `caffeinate` for the duration; a
closed lid still suspends it). Tell the developer the batch is launched, that they can move on
immediately (clearing the session and quitting are safe), and where to watch it: per-ticket logs in `.claude/pipeline-logs/<run-id>/<TICKET-ID>.log`
and the live feed at `.claude/pipeline-logs/<run-id>/progress.log` (the run id is printed by the
script; `ls -t .claude/pipeline-logs | head -1` finds the newest).

### c. What the pipeline does (for reporting back)

For each ticket, `run-batch-implement.sh` runs `run-ticket-pipeline.sh <TICKET> --stages=…`
which:

1. Claims a pipeline slot (`scripts/pipeline/claim-slot.sh`).
2. Creates `.claude/worktrees/<TICKET-ID>` detached at fresh `origin/main` (or reuses it), and
   copies the ticket's `.jira-plans/<TICKET-ID>/`, this `.claude/skills/` folder and the host
   config files (`.mcp.json`, `.codex/`, `.cursor/mcp.json`, `.agents`, `AGENTS.md`) into it.
3. Symlinks `frontend/node_modules` into the worktree and prepares the slot's test database
   (both best-effort).
4. Runs each stage as its own headless process of the host CLI invoking
   `/w-1-coding <TICKET-ID> just-<stage> here`, with `PIPELINE_MODE=unattended` and
   `PIPELINE_CONTAINER_WORKDIR` set, in order, and
   checks each stage left its artifact behind (ticked to-dos, `code-review.md`,
   `local-branch.md`, `qa-check.md`). A failure in any stage stops that ticket there; the
   worktree is left in place for inspection.
5. After the qa-check stage, when `qa-check.md` says `code_changed: yes`, runs the code-review
   and commit stages once more so the QA fixes are reviewed and folded into the ticket's commit
   — whatever `--stages` said, so a worktree is never left with uncommitted QA fixes. The
   browser pass runs on the QA stack (`../web-3rd`, one ticket at a time), which the qa-check
   phase syncs from the worktree; without a QA stack it is skipped and `qa-check.md` records
   `browser: skipped (...)`.
6. With `--draft-pr`: runs `/w-4-publish <TICKET-ID> draft` in the worktree after the last
   commit — rebases onto fresh `origin/main`, pushes, opens a **draft** PR whose last section is
   the ticket's `change-notes.md`, and sets `status: draft-pr-open`.
7. Copies `.jira-plans/<TICKET-ID>/` back to the main checkout and releases the slot.

Under `PIPELINE_MODE=unattended` the commit phase writes `status: ready-for-review` (never
`ready-for-push`): nothing from the pipeline reaches a non-draft PR until a human has looked at
it via `/w-3-land-branch`.

## 5. Report back

- Per ticket: the phases run (or launched), `plan.md` path and to-do count `<ticked>/<total>`,
  the branch name once one exists, and the log path for a background run.
- Any ticket skipped (already at `ready-for-review` / `draft-pr-open` with a QA check, or
  landed) and why; any ticket dropped because planning failed.
- Each phase's own report (the phase file says what to include) when it ran here.
- The next step per ticket:
  - run ended after plan → `/w-1-coding <TICKET-ID> just-implement [here]`
  - after implement → `/w-1-coding <TICKET-ID> just-code-review [here]`
  - after code-review → `/w-1-coding <TICKET-ID> just-commit [here]`
  - after commit → `/w-1-coding <TICKET-ID> just-qa-check [here]`
  - after qa-check with `code_changed: yes` (phase run on its own) →
    `/w-1-coding <TICKET-ID> just-code-review [here]`, then `just-commit`
  - after qa-check, or the re-cycle it triggered, in `here` mode → `/w-4-publish <TICKET-ID>`
  - after qa-check in `background` / `draft-pr` mode → `/w-3-land-branch <TICKET-ID>`
  - whenever `qa-check.md` says `browser: skipped (...)` or `browser: blocked (...)`, put the
    browser re-run first, as `phases/qa-check.md` § 4 words it.

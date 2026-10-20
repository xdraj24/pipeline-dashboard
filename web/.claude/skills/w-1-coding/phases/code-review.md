# Phase: Two-Model Code Review Loop

Input from `SKILL.md`: a single ticket id.

This runs a review/fix loop between two independent models so the fixer isn't grading its own
work: the **reviewer** role plays the staff-level reviewer, the **fixer** role acts on the
findings (`.claude/skills/_shared/host-runtime.md` § Delegation roles says how each host runs
them and which models they map to). Repeat up to **3 rounds**. If it's not clean after 3 rounds,
or the loop is clearly spiraling, stop and ask the developer — never loop forever and never
silently give up.

A host without delegation does both the review and the fix itself in the same session — it
loses the independence of a second model checking the first one's work, so it treats the loop as
a single self-review pass and says so when reporting back. Always report which model ran each
role.

## 1. Gather context

- `git status` and `git diff origin/main` (working tree included; read untracked new files too)
  to get the full diff for this ticket's branch. On the first pass nothing is committed yet; on
  a re-review after the qa-check phase changed code, the diff covers the commit plus the
  uncommitted QA fixes — review all of it, with `.jira-plans/<TICKET-ID>/qa-check.md` as extra
  context for what changed and why.
- If the diff is empty, stop and tell the developer there's nothing to review yet.
- Read `.jira-plans/<TICKET-ID>/plan.md` if it exists (ticket requirements + Implementation Log
  from the implement phase) for context. Not fatal if missing — proceed with the diff alone.

## 2. Run the loop (round = 1)

### a. Review (reviewer role)

Delegate to the **reviewer** role and wait for the result (you need it before continuing).
Prompt:

> You are a staff/principal-level engineer doing a thorough code review of the diff below for
> ticket `<TICKET-ID>` in this Rails + React + Go monorepo. Judge against this repo's actual
> conventions (root, `frontend/`, and `backend/app/` `CLAUDE.md` files) — not generic style
> opinions.
>
> Look for: correctness bugs, edge cases, security issues (OWASP top 10), missing or wrong
> tests, dead code, and violations of repo conventions. Do not nitpick pure style already
> enforced by Biome/RuboCop.
>
> Two things reviewers in this repo reject on every time, so flag them as **major**:
> 1. **Comment volume.** Code here is expected to be self-explanatory. Any comment that narrates
>    what the code does, restates a name, explains the diff, or runs longer than two lines is a
>    finding — say whether it should be deleted or shortened to its one load-bearing sentence.
>    Comments in test files are always a finding. Only a non-obvious trap, quirk, or magic-value
>    origin earns one, at roughly one per file.
> 2. **Ignoring an existing seam.** New code that reimplements a structure the repo already has
>    — e.g. a GraphQL resolver holding query logic instead of delegating to an `ApplicationQuery`
>    object under `backend/app/queries/`. Name the existing example it should follow.
>
> Ticket context: `<plan.md contents, or "no plan available">`
>
> Diff:
> ```
> <the diff/new files>
> ```
>
> Report findings as a numbered list, each with: file:line, severity (blocker/major/minor), and
> a one-sentence description of the concrete failure scenario. If a finding from a previous
> round (given below, if any) is still unresolved, say so explicitly instead of re-describing it
> fresh.
>
> Previous rounds' findings (if any): `<prior findings, or "none - first round">`
>
> End your response with **exactly one** of these as the final line, nothing after it:
> `STATUS: GREEN` (no blocker/major findings remain) or `STATUS: FINDINGS` (blocker/major
> findings remain).

- If `STATUS: GREEN` → go to step 3 (done).
- If `STATUS: FINDINGS` → continue to step b.

### b. Spiral check

Before spawning the fixer, compare this round's findings to findings from **two rounds ago**
(not the immediately previous round). If the same finding (same file/line/issue) is showing up
again after already having been "fixed" in between, that's a spiral — stop the loop now and go
straight to step 4 (escalate), don't spend another round on it.

### c. Fix (fixer role)

Delegate to the **fixer** role and wait for the result. Prompt:

> A staff engineer reviewed your implementation for ticket `<TICKET-ID>` and found the issues
> below. Fix each one directly in the working tree — minimal, targeted changes, following this
> repo's conventions (root, `frontend/`, `backend/app/` `CLAUDE.md`). Re-run the lint/tests for
> anything you touch exactly as `.claude/skills/_shared/run-checks.md` describes (foreground
> only, container paths from that doc) and make sure they pass. Do not skip or disable a failing
> test to make it pass.
>
> Findings to address:
> ```
> <the numbered findings from step a>
> ```
>
> Report back what you changed and the result of any lint/test run.

- Increment round. If round > 3, go to step 4 (escalate) regardless of outcome.
- Otherwise go back to step a for the next review round, passing this round's findings as
  "previous rounds' findings".

## 3. Success

All clean. Append a short entry to `.jira-plans/<TICKET-ID>/code-review.md` (create if needed):
round count, final `STATUS: GREEN`, the models that ran the reviewer and fixer roles, and any
minor findings left unfixed (the commit phase carries them into `change-notes.md`). Report that the review passed; the next phase is commit
(`/w-1-coding <TICKET-ID> just-commit` when run on its own).

## 4. Escalation

Triggered when the round cap is reached (round > 3) or step 2b detected a spiral.

**Interactive (no `PIPELINE_MODE` set):**

Stop. Do not attempt another round. Show the developer:

- How many rounds ran, and why it stopped (round cap reached vs. spiral detected).
- The current outstanding findings verbatim.

Ask how they want to proceed, via `.claude/skills/_shared/slack-escalation.md` — do not guess or
keep fixing on your own past this point. Append the same information to
`.jira-plans/<TICKET-ID>/code-review.md` before stopping.

**Unattended (`PIPELINE_MODE=unattended`):**

Don't ask anyone, not even in Slack — unlike a missing requirement, this isn't a business
question for a human to answer, it's a code-quality judgment call, so it's best-guess-and-log
only:

- Run one more fixer pass (step 2c) against the current outstanding findings — this is the
  fixer's **best remaining attempt**, not another full review round, so don't re-review it
  afterward.
- Ensure `.jira-plans/<TICKET-ID>/code-review.md` has a frontmatter block, adding one if it
  doesn't exist yet:
  ```
  ---
  ticket: <TICKET-ID>
  status: needs-manual-review
  ---
  ```
  (If the file already has frontmatter from a previous run, update `status:` to
  `needs-manual-review` in place rather than duplicating the block.)
- Append a `## Unresolved at pipeline completion` section: how many rounds ran and why it stopped
  (cap vs. spiral), then whatever findings remain after the extra fix attempt, verbatim
  (file:line, severity, description).
- Do **not** stop — report success so the pipeline continues to the commit stage. A human
  reviews this via `/w-3-land-branch` before anything reaches a non-draft PR.

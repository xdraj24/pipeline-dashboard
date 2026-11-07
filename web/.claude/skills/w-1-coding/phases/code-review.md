# Phase: Code Review Panel

Input from `SKILL.md`: a single ticket id.

The specialist panel in `.claude/skills/_shared/review-panel.md` reviews the ticket's diff. This
session is the **conductor**: it picks the seats the diff needs, triages every finding, and sends
the accepted ones to the **fixer** role, so neither the reviewers nor the conductor grade their
own fixes. Up to **5 rounds**. If it's not clean after 5 rounds, or the loop is clearly
spiraling, escalate (step 5) — never loop forever and never silently give up. Always report which
model ran each role.

## 1. Gather context

- `git status` and `git diff origin/main --stat` (working tree included, untracked new files
  too). On the first pass nothing is committed yet; on a re-review after the qa-check phase
  changed code, the diff covers the commit plus the uncommitted QA fixes, and
  `.ai-workspace/jira-plans/<TICKET-ID>/qa-check.md` says what changed and why.
- If the diff is empty, stop and tell the developer there's nothing to review yet.
- Read `.ai-workspace/jira-plans/<TICKET-ID>/plan.md` if it exists (ticket requirements +
  Implementation Log). Not fatal if missing.
- `W="${PIPELINE_CONTAINER_WORKDIR:-/app}"` as `.claude/skills/_shared/run-checks.md` says.

## 2. Pick the seats

`review-panel.md` § 1, on the full diff. The seats picked here run in round 1.

Environment block for every seat:

> - Diff: get it yourself, `git diff origin/main` plus every untracked file `git status
>   --porcelain` shows (in a pipeline worktree, the pathspec in
>   `.claude/skills/_shared/run-checks.md`). The code is the current checkout.
> - Intent: `.ai-workspace/jira-plans/<TICKET-ID>/plan.md` and, if present, `qa-check.md`;
>   ticket attachments in `.ai-workspace/jira-plans/<TICKET-ID>/attachments/`.
> - Frontend commands: `docker exec -w "<W>/frontend" web-spa-1 <command>`. Backend commands:
>   `docker exec -e TEST_ENV_NUMBER -w "<W>/backend" web-web-1 <command>`
>   (`.claude/skills/_shared/run-checks.md`).

## 3. Run the loop (round = 1)

### a. Review

Spawn the seats for this round as `review-panel.md` § 2 says. Round 2 and later run the linter,
staff, and every seat that had a finding triaged **fix** in the previous round, but never a seat
§ 2 skipped.

### b. Triage

`review-panel.md` § 3. No finding triaged **fix** left at blocker or major → `STATUS: GREEN`, go
to step 4. Otherwise `STATUS: FINDINGS`, continue.

### c. Spiral check

Compare this round's **fix** findings with those from **two rounds ago**. If the same finding
(same file/line/issue) is back after having been fixed in between, that's a spiral: stop and go
to step 5.

### d. Fix (fixer role)

Delegate to the **fixer** role and wait for the result. Prompt:

> Code reviewers checked your implementation for ticket `<TICKET-ID>` and the findings below
> were accepted. Fix each one directly in the working tree with minimal, targeted changes,
> following this repo's conventions (root, `frontend/`, `backend/app/` `CLAUDE.md`). Re-run the
> lint/tests for anything you touch exactly as `.claude/skills/_shared/run-checks.md` describes
> (foreground only, container paths from that doc) and make sure they pass. Do not skip or
> disable a failing test to make it pass. Fix nothing that isn't on this list.
>
> Findings to fix:
> ```
> <the findings triaged "fix", with ids>
> ```
>
> Report back what you changed per finding id and the result of every lint/test run.

Increment round. Round > 5 → step 5. Otherwise back to step a, passing every finding so far with
its triage and the fixer's report as "previous rounds".

## 4. Success

Raise the follow-up bugs collected across all rounds, per
`.claude/skills/_shared/raise-follow-up-bug.md`.

Append to `.ai-workspace/jira-plans/<TICKET-ID>/code-review.md` (create if needed):

```
## Review <UTC date and time>

- Rounds: <n>
- Seats: <each seat: run in rounds <list>, or skipped (<reason>)>
- Models: checker: <model>; reviewer: <model>; fixer: <model, or "not used">

### Fixed
- <id> <severity> <file:line> — <finding, one line> — <what the fixer changed>   ("None")

### Won't fix
- <id> <severity> <file:line> — <finding, one line> — <reason>   ("None")

### Follow-up bugs
- <id> — <JIRA-KEY> (new | existing) — <summary>   ("None"; `not raised (<reason>)` on failure)

STATUS: GREEN
```

Report the round count, the seats run and skipped, the models per role, the counts per bucket
and any follow-up bug keys with their URLs (`<jira_browse>/<KEY>`). The next phase is commit
(`/w-1-coding <TICKET-ID> just-commit` when run on its own).

## 5. Escalation

Triggered when the round cap is reached (round > 5) or step 3c detected a spiral. Raise the
follow-up bugs collected so far either way; they don't depend on the outcome.

**Interactive (no `PIPELINE_MODE` set):**

Stop. Do not attempt another round. Show the developer how many rounds ran, why it stopped
(cap vs. spiral), and the open **fix** findings verbatim. Ask how they want to proceed via
`.claude/skills/_shared/slack-escalation.md`; don't keep fixing on your own past this point.
Append the same information to `code-review.md`, in step 4's format with `STATUS: FINDINGS`,
before stopping.

**Unattended or supervised (`PIPELINE_MODE` is `unattended` or `supervised`):**

Don't ask anyone, not even in Slack; this is a code-quality judgment call, not a business
question, so it's best-guess-and-log only:

- Run one more fixer pass (step 3d) against the open **fix** findings. This is the fixer's
  best remaining attempt, not another round, so don't re-review it.
- Ensure `code-review.md` starts with a frontmatter block, updating `status:` in place if one
  exists:
  ```
  ---
  ticket: <TICKET-ID>
  status: needs-manual-review
  ---
  ```
- Append step 4's entry with `STATUS: FINDINGS`, followed by a
  `## Unresolved at pipeline completion` section: how many rounds ran and why it stopped, then
  the findings still open after the extra fixer pass, verbatim (id, file:line, severity,
  description).
- Do **not** stop: report success so the pipeline continues to the commit stage. A human
  reviews this via `/w-3-land-branch` before anything reaches a non-draft PR.

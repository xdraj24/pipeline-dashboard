---
name: w-21-review-prs
description: Review a batch of other developers' open PRs (from /w-20-list-prs-for-review or given numbers) on the review stack - a specialist review panel and functional/regression QA testers, picked per PR, triaged into review comments or backlog bugs; hands UI changes to you right away for browser verification (/w-24-land-branch-for-review) - then has a different model (verifier role, Sonnet) tighten the comments, one local review file per PR. `just-verify` re-runs only the verification. Use to prepare a review before publishing it.
argument-hint: "[just-verify] [PR-number PR-number ...]"
model: sonnet
effort: high
---

# Review and Verify a Batch of PRs

Argument: `$ARGUMENTS` — an optional leading `just-verify`, then optional whitespace/comma-separated
PR numbers (e.g. `123 456`).

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

- **Without `just-verify`**: run steps 1–6 (review, then verify).
  - **PR numbers given**: review exactly those, resolving each directly via `gh pr view` even if
    it isn't in `.ai-workspace/pr-reviews/candidates.md`.
  - **None given**: read `.ai-workspace/pr-reviews/candidates.md` (from `/w-20-list-prs-for-review`)
    and review every row in it. If that file doesn't exist, tell the user to run
    `/w-20-list-prs-for-review` first, or to pass PR numbers directly, and stop.
- **With `just-verify`**: skip to step 5 for the given PRs' `review.md` files, or, with no numbers,
  every `.ai-workspace/pr-reviews/PR-*/review.md` at `status: draft`. If none exist, tell the user
  to run `/w-21-review-prs` without `just-verify` first and stop.

Output goes to `.ai-workspace/pr-reviews/PR-<number>/review.md` per PR (excluded from git, same folder
`/w-20-list-prs-for-review` uses).

The review runs the specialist panel in `.claude/skills/_shared/review-panel.md` and the testers
in `.claude/skills/_shared/qa-testers.md`. This session is the **conductor** for both: it picks
what each PR needs, triages what comes back, and turns accepted findings into review comments.
The **verifier** role (a different model, `.claude/skills/_shared/host-runtime.md` § Delegation
roles) then checks the comments themselves; never let the model that drafted a comment grade it.

## 1. Resolve repo + PR metadata

- `gh repo view --json nameWithOwner -q .nameWithOwner` → `<owner>/<repo>`.
- For each PR number: if it's a row in `candidates.md`, reuse that row's title/author/branch/JIRA
  fields. Otherwise fetch fresh: `gh pr view <number> --repo <owner>/<repo> --json
  number,title,author,url,headRefName`, and best-effort the JIRA ticket from title/branch
  (`ticket_pattern`, `host-runtime.md`) same as `/w-20-list-prs-for-review` step 5 — leave blank if no match.
- For each PR, also `gh pr view <number> --json body,headRefOid` and, with a JIRA ticket,
  `mcp__atlassian__getJiraIssue` for its description and acceptance criteria (cloud id via
  `mcp__atlassian__getAccessibleAtlassianResources`). A failed fetch → the testers work from the
  PR body; say so in the report.

## 2. Check the review stack

```bash
S="$(git rev-parse --show-toplevel)/scripts/pipeline/stack.sh"
"$S" info 2
```

The review stack (`../web-2nd`, http://127.0.0.1:4000; `docs/second-dev-stack.md` § For AI
agents) holds one PR at a time, so step 3 runs **one PR after another**. Note its `dir:` as
`<DIR2>`.

`status: not set up` → tell the developer the linter, the testers and the browser hand-over need
it (`/w-setup`, second-stack step), and review with the reviewer seats only: each reads the code
at the PR head with `git fetch origin pull/<number>/head` and `git show FETCH_HEAD:<path>`.

## 3. Review each PR

For each PR, in order:

### a. Put it on the review stack

As `/w-24-land-branch-for-review` step 3: `"$S" pr 2 <number>`, then `"$S" up 2` if the stack
isn't running; same OOM and migration notes. A failure here → review that PR with the reviewer
seats only, as step 2's fallback says.

### b. Pick

- Seats: `review-panel.md` § 1 on `gh pr diff <number> --name-only` and the diff.
- Testers and browser: `qa-testers.md` § 1. Browser mode here is `handover`: testers never open a
  browser; they write browser cases, and step e hands them to the developer.

### c. Spawn

Spawn the picked seats and testers together, in one message, and wait for all of them
(`review-panel.md` § 2, `qa-testers.md` § 2). Single review, no fixer, so there are no rounds:
"previous rounds" is always `none - first round`. Environment block:

> - Diff: `gh pr diff <number> --repo <owner>/<repo>`. The code is the PR head, checked out in
>   `<DIR2>`; read files there and never edit, stage or check out anything in it.
> - Intent: the PR description and the JIRA ticket below; no plan file exists.
> - Frontend commands: `cd <DIR2> && docker compose exec -T -w /app/frontend spa <command>`.
>   Backend commands: `cd <DIR2> && docker compose exec -T -w /app/backend web <command>`.
>   Never `docker exec web-web-1` or `web-spa-1`: those are the developer's own stack.
>   Read-only rails runner: `cd <DIR2> && docker compose exec -T -w /app/backend web bundle exec
>   rails runner '<ruby>'`.
> - App: http://127.0.0.1:4000, serving this PR.
> - Browser mode: `handover`, or `none: <reason>`.

### d. Triage into comments

`review-panel.md` § 3 and `qa-testers.md` § 3, over both reports together (a tester and a seat
can report the same defect). Then:

- **fix** → one row of the draft review table: the finding's `file:line`, and one to two
  sentences stating the problem, the fix, and why it matters. Start it with `[🔴 Required]: `
  for a blocker or major, `[🔸 Nice to have]: ` for a minor. Be ruthless about count: the author
  is a human reading every row.
- **won't fix** → no comment.
- **follow-up bug** → `.claude/skills/_shared/raise-follow-up-bug.md`, found during review of
  PR #`<number>`, linked to the PR's JIRA ticket when it has one.

Write every finding with its bucket and reason, the seats and testers run or skipped, and the
follow-up bug lines (under `## Follow-up bugs`) to `.ai-workspace/pr-reviews/PR-<number>/triage.md` (overwrite). Then save the
draft as step 4 says.

### e. Browser verification (when the browser was picked)

Right away, while the PR is on the review stack: invoke `/w-24-land-branch-for-review <number>`
and give it the testers' `Browser cases` as the checklist for its step 4. It points the developer
at http://127.0.0.1:4000 and waits for their answer.

- **Works** → w-24 posts its "🦈 visually tested" comment.
- **Found problems** → add each problem the developer describes as a row in `review.md`, worded
  as step d says (`[🔴 Required]: ` unless the developer calls it minor).
- **Stop** → nothing to add.

Record the outcome in `review.md`'s frontmatter as `browser_check: works | problems | stopped`,
or `browser_check: not needed (<reason>)` when step b skipped the browser.

Then the next PR.

## 4. Save each draft

For every PR, write (overwrite) `.ai-workspace/pr-reviews/PR-<number>/review.md` before verifying,
so a failed verifier still leaves the draft for `just-verify`:

```
---
pr_number: <number>
pr_url: <PR url>
branch: <headRefName>
author: <author login>
jira_ticket: <TICKET or blank>
jira_url: <jira_browse>/<TICKET> or blank
review_model: <model that ran the reviewer role, or unknown>
qa_model: <model that ran the qa role, "not used", or unknown>
browser_check: <set in step 3e>
status: draft
reviewed_at: <ISO 8601 timestamp>
---

# PR #<number> Review — <title>

| File:Line | Comment |
|-----------|---------|
<one row per finding triaged "fix", or the single line "No issues found.">
```

If every seat failed for a PR, write no file for it and leave it out of step 5.

## 5. Verify each draft (verifier role, in parallel)

For every draft whose body isn't `No issues found.`, delegate one **verifier**, all in parallel,
and wait for every result. A host without delegation does this pass itself, applying the same
criteria, and notes in the report that it wasn't a genuinely separate model. Prompt:

> Below is a draft code review for PR #`<number>` in a Rails + React + Go monorepo, written by
> another reviewer. You are not re-reviewing the diff — you're checking the *comments themselves*
> for quality, one at a time:
>
> 1. **Says how to fix it, and why.** It names the concrete change (what to call, move, rename,
>    delete or add), not just the problem. "Consider…" or "might want to look at…" with no change
>    named fails, and so does a fix with no reason it matters.
> 2. **Minimal and non-redundant.** Drop anything vague, purely stylistic (Biome/RuboCop already
>    enforce style), a duplicate of another row, or not actually actionable.
> 3. **Reads like a colleague wrote it.** One or two sentences, direct second person, everyday
>    words. No restating what the code visibly does, no preamble or closing summary, no bold,
>    headers, lists, emoji, em dashes, praise openers ("Great work, but…"), hedging ("It's
>    important to note…") or other AI filler.
>
> For each row: keep it as-is if it already passes all three, rewrite it if the substance is right
> but the wording fails #1 or #3, or drop it entirely if it fails #2 or the fix can't be worked out
> from the comment itself. Never guess a fix or add a new comment about the code — you have not
> reviewed the diff, only these comments.
>
> Every comment starts with a severity tag, `[🔴 Required]: ` or `[🔸 Nice to have]: `. It is
> exempt from the emoji rule: keep it verbatim at the start of every row you keep or rewrite. If a
> row has none, add the one its text supports (`Required` for a bug, security issue, missing test
> or convention violation; `Nice to have` otherwise).
>
> Example rewrite. Before: "**N+1 query:** It's important to note that calling `well.operator`
> inside this loop triggers a query per well, which could lead to performance issues. Consider
> looking into eager loading." After: "[🔴 Required]: `well.operator` here runs one query per
> well. Add `includes(:operator)` to the scope above the loop."
>
> Draft comments:
> ```
> <the review.md table, or "No issues found." verbatim>
> ```
>
> Output **only** the corrected Markdown table in the same `| File:Line | Comment |` format,
> nothing else. If every row was dropped, or the input was already "No issues found.", output
> exactly: `No issues found.`

## 6. Update each review.md

Overwrite the table (or `No issues found.` line) with the verifier's output. If the old table
carried a third `Publish` column (dashboard ticks), drop it: the rows changed, so the developer
ticks again. Update the frontmatter: `status: verified`, add `verified_model: <model that ran the
verifier role, or unknown>` and `verified_at: <ISO 8601 timestamp>`. Leave every other field as-is.

A draft that was `No issues found.` skips the verifier: bump its frontmatter to `verified`
directly. A draft whose verifier call failed stays at `status: draft`; say so in the report and
point at `/w-21-review-prs just-verify <number>`.

## 7. Report back

For every PR, give the seats and testers run and skipped, the comment count and how many the
verifier dropped, tightened or kept (or "no issues found"), the browser check outcome, and any
follow-up bug keys with their URLs (`<jira_browse>/<KEY>`). Name any PR whose diff, seat, tester or verifier call failed, or that was reviewed without the review stack. Then show
one final table so the developer can check each PR in context:

| PR | Branch | JIRA | PR Link | Review file |
|----|--------|------|---------|-------------|
| #<number> | `<branch>` | [<TICKET>](<jira_url>) or — | <pr_url> | `.ai-workspace/pr-reviews/PR-<number>/review.md` |

Tell the user to check out each branch locally to review the comments against the actual code,
and that once satisfied, `/w-23-publish-review <branch|TICKET-ID|PR-link-or-number>` posts a
given PR's verified comments to GitHub.

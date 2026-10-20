---
name: w-22-verify-review-comments
description: Have a different model (verifier role) check the review comments drafted by /w-21-review-prs are minimal, actionable and readable, tightening or dropping the rest. Use after /w-21-review-prs, before publishing to GitHub.
argument-hint: "[PR-number PR-number ...]"
model: sonnet
effort: medium
---

# Verify Drafted PR Review Comments

Argument: `$ARGUMENTS` — optional, whitespace/comma-separated PR numbers.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

- **If given**: verify only those PRs' `.pr-reviews/PR-<number>/review.md` files.
- **If omitted**: verify every `.pr-reviews/PR-*/review.md` currently at `status: draft`.

If none of the targeted files exist, tell the user to run `/w-21-review-prs` first and stop.

The review step (`/w-21-review-prs`) ran the **reviewer** role. This step runs the **verifier**
role — a different model checking the first one's work, never the same model grading itself
(`.claude/skills/_shared/host-runtime.md` § Delegation roles).

## 1. Verify each review (verifier role, in parallel)

A different model judging the drafted comments is the point of this step. A host without
delegation does the verification pass itself, applying the same criteria below as the
independent checker, and notes in the report that it wasn't a genuinely separate model.

For every targeted `review.md` whose body isn't already `No issues found.`, delegate one
**verifier**, all in parallel, and wait for every result. Prompt:

> Below is a draft code review for PR #`<number>` in a Rails + React + Go monorepo, written by
> another reviewer. You are not re-reviewing the diff — you're checking the *comments themselves*
> for quality, one at a time:
>
> 1. **States a fix and a brief why.** A comment that only names a problem without saying what to
>    change, or that gives a fix with no reason it matters, fails this.
> 2. **Minimal and non-redundant.** Drop anything vague, purely stylistic (Biome/RuboCop already
>    enforce style), a duplicate of another row, or not actually actionable.
> 3. **Easy to read.** One to two sentences, plain language, no restating what the code visibly
>    does.
>
> For each row: keep it as-is if it already passes all three, rewrite it tighter if the substance
> is right but the wording fails #3, or drop it entirely if it fails #1 or #2. Do not add any new
> comment about the code — you have not reviewed the diff, only these comments.
>
> Draft comments:
> ```
> <the review.md table, or "No issues found." verbatim>
> ```
>
> Output **only** the corrected Markdown table in the same `| File:Line | Comment |` format,
> nothing else. If every row was dropped, or the input was already "No issues found.", output
> exactly: `No issues found.`

## 2. Update each review.md

Overwrite the table (or `No issues found.` line) in `.pr-reviews/PR-<number>/review.md` with the
agent's output. If the old table carried a third `Publish` column (dashboard ticks), drop it: the
rows changed, so the developer ticks again. Update its frontmatter: `status: verified`, add `verified_model: <model that ran the verifier role, or unknown>` and
`verified_at: <ISO 8601 timestamp>`. Leave every other field as-is.

If a `review.md` was already `No issues found.` going in, skip the verifier for it — just
bump its frontmatter to `verified` directly, since there's nothing to check.

## 3. Report back

For every PR processed, note how many comments were dropped or tightened versus kept as-is. Then
show one final table so the developer can go check each PR in context:

| PR | Branch | JIRA | PR Link | Review file |
|----|--------|------|---------|-------------|
| #<number> | `<branch>` | [<TICKET>](<jira_url>) or — | <pr_url> | `.pr-reviews/PR-<number>/review.md` |

Tell the user to check out each branch locally to review the comments against the actual code,
and that once satisfied, `/w-23-publish-review <branch|XWWP-ticket|PR-link-or-number>` posts a
given PR's verified comments to GitHub.

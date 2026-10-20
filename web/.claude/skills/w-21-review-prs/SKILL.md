---
name: w-21-review-prs
description: Draft a staff-level review (independent reviewer role) for a batch of other developers' open PRs (from /w-20-list-prs-for-review or given numbers), one local review file per PR. Use to draft a first-pass review before verifying and publishing it.
argument-hint: "[PR-number PR-number ...]"
model: sonnet
effort: high
---

# Draft Reviews for a Batch of PRs

Argument: `$ARGUMENTS` — optional, whitespace/comma-separated PR numbers (e.g. `123 456`).

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

- **If given**: review exactly those PR numbers, resolving each directly via `gh pr view` even if
  it isn't in `.pr-reviews/candidates.md`.
- **If omitted**: read `.pr-reviews/candidates.md` (from `/w-20-list-prs-for-review`) and review
  every row in it. If that file doesn't exist, tell the user to run `/w-20-list-prs-for-review`
  first, or to pass PR numbers directly, and stop.

Output goes to `.pr-reviews/PR-<number>/review.md` per PR (gitignored, same folder
`/w-20-list-prs-for-review` uses).

## 1. Resolve repo + PR metadata

- `gh repo view --json nameWithOwner -q .nameWithOwner` → `<owner>/<repo>`.
- For each PR number: if it's a row in `candidates.md`, reuse that row's title/author/branch/JIRA
  fields. Otherwise fetch fresh: `gh pr view <number> --repo <owner>/<repo> --json
  number,title,author,url,headRefName`, and best-effort the JIRA ticket from title/branch
  (`XWWP-\d+`) same as `/w-20-list-prs-for-review` step 5 — leave blank if no match.

## 2. Fetch each PR's diff

```
gh pr diff <number> --repo <owner>/<repo>
```

## 3. Review each PR (reviewer role, in parallel)

Delegate one **reviewer** per PR, all in parallel, and wait for every result
(`.claude/skills/_shared/host-runtime.md` § Delegation roles). Delegation is used here for
parallelism, not independence (unlike the adversarial loop in `w-1-coding`'s code-review phase);
a host without delegation reviews each PR in turn using the prompt below as its own
instructions. Prompt:

> You are reviewing PR #`<number>` ("`<title>`") in this Rails + React + Go monorepo, authored by
> `<author>`. Judge against this repo's actual conventions (root, `frontend/`, and `backend/app/`
> `CLAUDE.md` files) — not generic style opinions. Do not nitpick anything Biome/RuboCop already
> enforces.
>
> Look for real problems: correctness bugs, edge cases, security issues (OWASP top 10), missing
> tests for new logic, dead code, and violations of repo conventions (e.g. a GraphQL resolver
> holding query logic instead of delegating to an `ApplicationQuery` object, a new query/mutation
> not taking a single `input` argument, a new `.js` file, manual edits to
> `frontend/types/GraphqlSchema.ts`).
>
> **Be ruthless about comment count.** This review gets read by a human developer, so only write a
> comment when it's genuinely worth their time — skip anything trivial, subjective, or already
> caught by lint. Each comment must be one to two sentences: state the concrete problem, the fix,
> and briefly why it matters. No restating what the code does, no multi-paragraph essays, no
> comment that doesn't end in an actionable fix.
>
> Diff:
> ```
> <the diff>
> ```
>
> Output **only** a Markdown table, nothing else — no preamble, no summary paragraph:
>
> | File:Line | Comment |
> |-----------|---------|
> | `path:line` | One to two sentences: the problem, the fix, and why. |
>
> If there is genuinely nothing worth flagging, output exactly: `No issues found.`

## 4. Save each review

For every PR, write (overwrite) `.pr-reviews/PR-<number>/review.md`:

```
---
pr_number: <number>
pr_url: <PR url>
branch: <headRefName>
author: <author login>
jira_ticket: <TICKET or blank>
jira_url: <https://welligence.atlassian.net/browse/TICKET or blank>
review_model: <model that ran the reviewer role, or unknown>
status: draft
reviewed_at: <ISO 8601 timestamp>
---

# PR #<number> Review — <title>

<the agent's table verbatim, or "No issues found." verbatim>
```

## 5. Report back

List each PR processed with its comment count (or "no issues found") and the saved file path. If
any PR's diff or agent call failed, say so explicitly rather than writing a partial file for it.

Suggest the follow-up: `/w-22-verify-review-comments` to have a different model check these
comments are minimal, actionable, and clearly worded before anything is posted to GitHub.

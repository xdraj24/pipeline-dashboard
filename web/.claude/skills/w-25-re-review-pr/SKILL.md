---
name: w-25-re-review-pr
description: Re-review a PR after its author addressed your comments (by XWWP ticket, PR link or number) - check each of your review threads against the new commits, and approve when every one is properly addressed and you left a "🦈 visually tested" comment. Use when another developer asks for a re-review.
argument-hint: "<XWWP-XXXX|PR-link-or-number>"
model: opus
effort: high
---

# Re-review a PR

Decide whether your earlier review of another developer's PR has been addressed, and approve it
when it has and you have tested it visually.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`. Every question for the developer goes through
`.claude/skills/_shared/slack-escalation.md`.

Argument: `$ARGUMENTS` — required: an XWWP ticket id, a GitHub PR URL or a bare PR number. If
missing, ask for one before doing anything else.

## 1. Resolve the PR and gather its state

As `.claude/skills/_shared/resolve-pr.md` describes (other developers' PRs: for a ticket id the
`gh pr list` search applies), with fields `number,url,state,isDraft,author,headRefOid`.

- Draft → stop: nothing to approve yet.
- `ME="$(gh api user -q .login)"`. The PR author is `$ME` → stop: you cannot approve your own PR.

One GraphQL call for the rest:

```
gh api graphql -f query='
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        headRefOid reviewDecision
        reviews(last: 50) { nodes { author { login } state body submittedAt commit { oid } } }
        comments(last: 100) { nodes { author { login } body createdAt url } }
        reviewThreads(first: 100) {
          nodes {
            id isResolved isOutdated path line originalLine
            comments(first: 50) { nodes { author { login } body createdAt originalCommit { oid } } }
          }
        }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }' -f owner=<owner> -f repo=<repo> -F pr=<number>
```

- **Your threads**: review threads whose first comment's author is `$ME`.
- **Your review summaries**: your `reviews` with a non-empty `body` (a `CHANGES_REQUESTED` or
  `COMMENTED` summary can carry requests outside any thread).
- **Last reviewed commit**: `commit.oid` of your most recent review.
- **Visually tested**: an issue comment by `$ME` whose body, trimmed, is `🦈 visually tested`.

No threads and no review summaries of yours → this is a first review, not a re-review: say so,
point at `/w-21-review-prs <number>`, and stop.

## 2. Judge each request

`git fetch origin pull/<number>/head`, then for each of your threads and each request in your
review summaries:

- Read your comment, every reply after it, and the current code at `path` around the line
  (`git show FETCH_HEAD:<path>`), plus what changed in that file since your last review
  (`git diff <last reviewed commit> FETCH_HEAD -- <path>`; when that commit is gone after a
  force-push, compare against the code your comment quoted).
- Classify it:
  - **addressed** — the code now does what you asked, or what the author did instead solves the
    same problem at least as well.
  - **answered** — no code change, but the reply gives a reason that holds (the concern does not
    apply, or it is already covered elsewhere — check that claim in the code).
  - **open** — not changed, changed without fixing the problem, or a reply whose reason does not
    hold.
  - **your call** — the reply pushes back on a judgment call where both positions are
    defensible. Never decide these yourself.

  A resolved thread is not addressed by being resolved; judge the code. Be strict: "properly
  addressed" means you would sign off on it, not that something changed.
- Skim the rest of the diff since your last review (`git diff <last reviewed commit> FETCH_HEAD`)
  for anything the fixes broke. Real problems only; each one counts as **open**.

## 3. Decide

Approve only when all of these hold:

1. every item is **addressed** or **answered** (after the developer settled every **your call**
   item, see below);
2. **Visually tested** is true;
3. the PR is still open and not a draft.

- **your call** items exist → ask the developer, one question per item with your comment and the
  author's reply quoted, options "accept the reply" / "keep it open". Accepted → **answered**.
- Checks (`statusCheckRollup.state`) are `FAILURE` or `ERROR` → say which and ask whether to
  approve anyway; `PENDING` → mention it, it does not block.
- **Visually tested** false while everything else holds → do not approve. Say so and point at
  `/w-24-land-branch-for-review <number>`, then run `/w-25-re-review-pr <number>` again.

## 4. Approve

When step 3 says approve:

```bash
gh pr review <number> --approve --body "Re-reviewed: all comments addressed."
```

The developer invoking this skill is the go-ahead; do not ask again. Do not resolve threads or
post replies; the item list in the report is for the developer.

## 5. Report back

- The verdict: approved (with the review URL), or not approved and the reason.
- One line per item: `addressed | answered | open | your call → <decision>`, `path:line`, and
  what you checked. Open items first.
- Whether "🦈 visually tested" was found, and the checks state.
- When not approved because of open items, offer to post them as replies on their threads; post
  nothing unless the developer says so.

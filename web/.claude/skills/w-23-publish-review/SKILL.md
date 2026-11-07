---
name: w-23-publish-review
description: Post one PR's verified review comments (from /w-21-review-prs) as a GitHub review, resolved by branch, Jira ticket or PR link/number. Use when a drafted review has been checked and should go to GitHub.
argument-hint: "<branch|TICKET-ID|PR-link-or-number>"
model: sonnet
effort: medium
---

# Publish a PR Review to GitHub

Argument: `$ARGUMENTS` — required, one of:
- A branch name (e.g. `feature/<TICKET-ID>-thing`).
- A ticket id matching `ticket_pattern` (`host-runtime.md`).
- A GitHub PR URL (e.g. `https://github.com/<org>/<repo>/pull/123`).
- A bare PR number (e.g. `123`).

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

If missing, ask the user for one before doing anything else.

Every question for the developer in this skill goes through
`.claude/skills/_shared/slack-escalation.md`, including the confirmation in step 3.

## 1. Resolve the PR

- **Ticket id** (matches `ticket_pattern`): search saved reviews first —
  `grep -l "jira_ticket: <TICKET-ID>" .ai-workspace/pr-reviews/PR-*/review.md` — and take the PR number from
  the matching file's path. No match → the ticket-id rule in
  `.claude/skills/_shared/resolve-pr.md` (these are other developers' PRs, so
  `local-branch.md` won't exist; the `gh pr list` search applies).
- **Branch name**: `gh pr list --head <branch> --state open --json number,url`. Zero or ambiguous
  results → tell the user and ask for the PR link or number.
- **PR URL** or **bare number**: as `resolve-pr.md` describes.

Confirm it's open per `resolve-pr.md`, with fields `state,url,headRefOid`.

## 2. Load the verified comments

Read `.ai-workspace/pr-reviews/PR-<number>/review.md`. If it doesn't exist, tell the user to run
`/w-20-list-prs-for-review` → `/w-21-review-prs` for this PR
first, and stop.

- If its body is `No issues found.` → tell the user there's nothing to publish and stop.
- If `status:` is not `verified` → warn the user this review hasn't been through
  verification yet, and ask whether to publish the unverified draft anyway or
  stop to run `/w-21-review-prs just-verify <number>` first. Default recommendation: verify first.

Parse the Markdown table's rows into `{path, line, body}` triples (`File:Line` splits on the last
`:`).

The table may carry a third `Publish` column (`[x]` / `[ ]`), ticked by the developer on the
skills dashboard's Reviews page. When it is present, post **only** the `[x]` rows; keep the `[ ]`
rows in a "left out by the reviewer" list for steps 3 and 6. If the column exists and no row is
ticked, tell the user nothing is ticked and stop. Without the column, every row is a candidate.

Every posted body must start with `[🔴 Required]: ` or `[🔸 Nice to have]: ` so the author sees
its weight at a glance. If a selected row has no tag (a review drafted before the tag existed),
propose one from its text and mark it as proposed in step 3.

## 3. Confirm before posting

This posts visibly to another developer's PR and notifies them — always show the user the exact
comments about to be posted (the rows selected in step 2, tags included) plus the rows left out,
and get explicit confirmation before step 4, even if they already approved the general idea of running this skill.

## 4. Post the review

Get the PR's GraphQL node id and head commit:

```
gh api graphql -f query='
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) { id headRefOid }
    }
  }' -f owner=<owner> -f repo=<repo> -F pr=<number>
```

Build the threads array as `{"path": "<path>", "line": <line>, "side": "RIGHT", "body": "<body>"}`
per row. Use `threads`, not `comments`: `comments` takes diff `position` and rejects `line`/`side`.
Write the whole request body to a temp JSON file under the scratch directory (avoids shell-quoting
issues with comment bodies):

```json
{
  "query": "mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id url } } }",
  "variables": {
    "input": {"pullRequestId": "<node id>", "commitOID": "<headRefOid>", "event": "COMMENT", "threads": [...]}
  }
}
```

then post it with `gh api graphql --input <tmp-file>.json`. Do not pass it as
`-F input=@<file>`: gh sends the file contents as a string, and GraphQL rejects the variable.
Always use `event: COMMENT` — never `APPROVE` or `REQUEST_CHANGES`; that verdict is the human
reviewer's call, not this skill's.

If a comment's `line` doesn't exist in the current diff (the PR moved on since verification —
GraphQL will error for that specific comment), drop it from the batch, retry once without it, and
collect it into a "skipped" list to report rather than letting one bad line fail the whole review.

## 5. Update local state

In `.ai-workspace/pr-reviews/PR-<number>/review.md`: set `status: published`, add `published_at: <ISO 8601
timestamp>` and `review_url: <pullRequestReview.url from the mutation response>`.

## 6. Report back

Give the user the posted review's URL, how many comments were posted, how many the reviewer left
unticked, and any that were skipped by GitHub (with the reason) so they can add those manually if
still relevant.

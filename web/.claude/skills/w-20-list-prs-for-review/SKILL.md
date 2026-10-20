---
name: w-20-list-prs-for-review
description: List open, non-draft PRs by other developers with no human review activity yet (bot/CI comments don't count), optionally filtered to frontend- or backend-heavy, saved to .pr-reviews/candidates.md. Use to find PRs waiting on a first review.
argument-hint: "[fe|be]"
model: sonnet
effort: medium
---

# List PRs Awaiting Review

Argument: `$ARGUMENTS` — optional, one of `fe`, `be`, or empty:
- `fe` — keep only PRs whose changes are frontend-heavy with minimal/no backend changes.
- `be` — keep only PRs whose changes are backend-heavy with minimal/no frontend changes.
- (none) — keep all qualifying PRs regardless of area, area shown per row.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

Anything else in `$ARGUMENTS` → ask the developer to clarify (only `fe`, `be`, or empty are
valid), via `.claude/skills/_shared/slack-escalation.md` like every other question in these
skills.

Output goes to `.pr-reviews/candidates.md` (gitignored like `.jira-plans/`; create the folder if
it doesn't exist).

## 1. Resolve repo + identity

- `gh repo view --json nameWithOwner -q .nameWithOwner` → `<owner>/<repo>`.
- `gh api user -q .login` → current GitHub login. PRs authored by this login are never
  candidates — this skill is for finding *other* developers' PRs.

## 2. List open PRs from other authors

```
gh pr list --repo <owner>/<repo> --state open --json number,title,author,url,headRefName,baseRefName,isDraft --limit 200
```

Drop any PR whose `author.login` equals the current user's login, and drop any PR where
`isDraft` is `true` — drafts aren't ready for review yet.

## 3. Filter to PRs with no *human* review activity yet

For each remaining PR, fetch its reviews, issue comments, and inline review-thread comments in
one call, including each author's `__typename` so bot accounts can be told apart from people:

```
gh api graphql -f query='
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        author { login }
        reviews(first: 50) { nodes { author { login __typename } state } }
        comments(first: 50) { nodes { author { login __typename } } }
        reviewThreads(first: 50) { nodes { comments(first: 10) { nodes { author { login __typename } } } } }
      }
    }
  }' -f owner=<owner> -f repo=<repo> -F pr=<number>
```

Before checking logins, discard every entry that is automated — this is what makes the check
"human-only":
- `author.__typename == "Bot"` (GitHub's own bot type, covers `github-actions`,
  `welligence-gh-actions-bot-v1`, etc.)
- `author.login` ending in `[bot]`, or equal to `dependabot`, `github-actions`, or any other
  login you recognize as a bot/CI/AI account (e.g. an org's automated review or coverage-bot
  account) — match case-insensitively and check for a `-bot`/`bot` suffix too.

A PR qualifies only if, after discarding automated entries, every remaining login across
`reviews`, `comments`, and every `reviewThreads[].comments` node is either `null` (deleted
account) or equal to the PR's own `author.login` — i.e. no *human* other than the author has
touched it yet. Drop any PR where a different human login shows up anywhere in those three lists.
An empty or all-bot/CI/AI set of reviews+comments+threads still qualifies.

## 4. Classify area (frontend vs. backend)

For each PR that survived step 3, get its changed files with line counts:

```
gh api repos/<owner>/<repo>/pulls/<number>/files --paginate -q '.[] | "\(.filename)\t\(.additions)\t\(.deletions)"'
```

Sum `additions + deletions` per path prefix: `frontend/` → `fe_lines`, `backend/` → `be_lines`,
everything else (root config, `data-loader/`, `.github/`, `docker_scripts/`, `tests/`, etc.) →
`other_lines`.

Classify:
- **frontend**: `fe_lines > 0` and `be_lines` is small — `be_lines == 0` or
  `be_lines / (fe_lines + be_lines) <= 0.1`.
- **backend**: symmetric (`be_lines > 0`, `fe_lines` small by the same rule).
- **mixed**: neither condition holds.

Apply the argument's filter now: `fe` → keep only `frontend`-classified PRs; `be` → keep only
`backend`-classified PRs; empty → keep all three classes.

## 5. Best-effort JIRA ticket

Look for an `XWWP-\d+` pattern in the PR title first, then in the branch name (`headRefName`). If
neither matches, leave the field blank — don't guess a ticket id.

## 6. Write the candidate list

Write (overwrite) `.pr-reviews/candidates.md`:

```
---
generated_at: <ISO 8601 timestamp>
filter: <fe|be|none>
repo: <owner>/<repo>
---

# PR Review Candidates

| PR | Title | Author | Branch | Area | JIRA | Link |
|----|-------|--------|--------|------|------|------|
| #<number> | <title> | <author login> | `<headRefName>` | <frontend/backend/mixed> | [<TICKET>](https://welligence.atlassian.net/browse/<TICKET>) or — | <PR url> |
```

Sort by PR number ascending.

## 7. Report back

Tell the user how many open PRs were scanned, how many had zero review activity, and how many
remain after the area filter. Show the table inline as well as the file path. If the list is
empty, say so plainly — don't invent a placeholder table.

If non-empty, suggest the follow-up: `/w-21-review-prs` to review every listed PR, or
`/w-21-review-prs <PR-number> [<PR-number> ...]` to review only specific ones from the list.

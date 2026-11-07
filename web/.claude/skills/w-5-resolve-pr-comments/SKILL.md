---
name: w-5-resolve-pr-comments
description: Fetch a PR's unresolved review threads (by Jira ticket or PR link/number), fix each in code, push, then reply and resolve the threads on GitHub. Use to address reviewer feedback on an open PR.
argument-hint: "<TICKET-ID|PR-link-or-number>"
model: opus
effort: high
---

# Resolve PR Review Comments

Address outstanding reviewer feedback on an already-open pull request: fetch every unresolved
review thread, fix each one in the working tree, push, then reply to and resolve each thread on
GitHub.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

Argument: `$ARGUMENTS` — required, one of:
- A ticket id matching `ticket_pattern` (`host-runtime.md`) — the PR is looked up from local state / GitHub.
- A GitHub PR URL (e.g. `https://github.com/<org>/<repo>/pull/123`).
- A bare PR number (e.g. `123`) — resolved against this repo's `origin`.

If missing, ask the user for one before doing anything else.

Every question for the developer in this skill goes through
`.claude/skills/_shared/slack-escalation.md`.

## 1. Resolve the PR

As `.claude/skills/_shared/resolve-pr.md` describes; the `gh pr view` fields needed here are
`state,headRefName,url`.

## 2. Sync the local branch

- `git status` on the **current** branch — if there are uncommitted changes that don't belong to
  this PR's branch, warn the user and confirm before switching.
- `git fetch origin <headRefName>`.
- Check out the PR's branch locally: `git checkout <headRefName>` if it exists locally, else
  `git checkout -b <headRefName> origin/<headRefName>`.
- Fast-forward to match `origin/<headRefName>` exactly (`git merge --ff-only
  origin/<headRefName>`) so fixes land on top of the actual PR state, not a stale local copy. If
  the fast-forward fails (local branch has diverged), stop and ask the user how to reconcile
  rather than guessing which side should win.

## 3. Fetch unresolved review threads

Use the GraphQL API (the REST API can't tell resolved from unresolved):

```
gh api graphql -f query='
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            comments(first: 50) {
              nodes { databaseId body author { login } }
            }
          }
        }
      }
    }
  }' -f owner=<owner> -f repo=<repo> -F pr=<number>
```

- Filter to `isResolved: false`. Keep `isOutdated` around for context, but don't skip an outdated
  thread solely for that reason — the code may still need the fix even if the diff line moved.
- If there are zero unresolved threads, tell the user the PR has nothing to resolve and stop.

## 4. Triage each thread

For every unresolved thread, read the file at `path` around `line` for context, and read the full
comment chain (a thread can have a reviewer comment plus back-and-forth replies — read all of it,
not just the first comment).

Split threads into two buckets:

- **Actionable and unambiguous** — a concrete, mechanical request (typo, rename, add a null
  check, add a test, follow a convention already established elsewhere in the repo). Fix these
  directly.
- **Ambiguous or opinion-based** — anything where the "right" fix isn't clear from the comment
  alone (a suggested redesign, a debatable style preference, a comment that could be addressed
  multiple valid ways, or one that seems to conflict with the ticket's requirements). Do **not**
  guess. Collect these and ask the developer about all of them together in one message, one
  question per thread with the comment text as context, options along the lines of "apply this
  fix" / "reply explaining why not" / "skip", before touching that code.

## 5. Apply the fixes

- Make each fix directly in the working tree, following this repo's conventions (root,
  `frontend/`, `backend/app/` `CLAUDE.md`).
- Re-run lint/tests for whatever each fix touches as `.claude/skills/_shared/run-checks.md`
  describes. If a test fails and you can't confidently fix it, stop and ask the user rather than
  pushing broken code.
- Commit: `git add -A && git commit -m "Address PR review feedback"` (pre-commit hooks will run;
  if hooks modify files, stage and amend).

## 6. Push

- `git push` (plain push — this is the existing PR branch, not a rebase, so no
  `--force-with-lease` is needed since step 2 already guaranteed a fast-forward base).

## 7. Reply to and resolve each addressed thread

For every thread fixed in step 5 (skip ones the user chose to leave alone in step 4):

- Reply on the thread with what changed, referencing the new commit:

  ```
  gh api repos/<owner>/<repo>/pulls/<number>/comments/<databaseId>/replies -f body="<short note on the fix>, see <sha>."
  ```

- Mark the thread resolved:

  ```
  gh api graphql -f query='mutation($id:ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' -f id=<thread-node-id>
  ```

For threads where the user chose "reply explaining why not" in step 4, post the explanation via
the same reply command but do **not** resolve the thread — leave that decision to the reviewer.

## 8. Report back

Show the user: how many threads were unresolved at the start, how many were fixed and resolved,
how many were skipped/replied-only per their choice, and the commit(s)/push result.

---
name: w-24-land-branch-for-review
description: Check out another developer's PR (by Jira ticket, PR link or number) on the second web stack, start it, hand it to you for visual testing, and on your confirmation comment "🦈 visually tested" on the PR. Use to test a PR in the running app before approving it.
argument-hint: "<TICKET-ID|PR-link-or-number>"
model: sonnet
effort: medium
---

# Land a PR on the Review Stack for Visual Testing

Run someone else's PR in the **review stack** (the second full web instance, `../web-2nd`,
http://127.0.0.1:4000) without touching your own checkout or database, let the developer test
it, and record the result on the PR.

Host-specific mechanics (arguments, invoking other skills, asking the developer):
`.claude/skills/_shared/host-runtime.md`. Every question for the developer goes through
`.claude/skills/_shared/slack-escalation.md`. Stack rules: `docs/second-dev-stack.md` § For AI
agents.

Argument: `$ARGUMENTS` — required: a ticket id matching `ticket_pattern` (`host-runtime.md`), a GitHub PR URL or a bare PR number. If
missing, ask for one before doing anything else.

## 1. Resolve the PR

As `.claude/skills/_shared/resolve-pr.md` describes, with fields
`number,title,url,state,isDraft,headRefName,headRefOid,author,body`. These are other developers'
PRs, so for a ticket id the `gh pr list` search applies.

## 2. Check the review stack

```bash
S="$(git rev-parse --show-toplevel)/scripts/pipeline/stack.sh"
"$S" info 2
```

`status: not set up` → say the review stack is missing, point at `/w-setup` (its second-stack
step), and stop. Otherwise note what `source:` it currently serves; step 3 replaces it.

## 3. Check out and start

- `"$S" pr 2 <number>` — checks out the PR head (forks included) detached, resets anything left
  in `../web-2nd`, and when the stack runs, migrates and reinstalls changed lockfiles. Never edit
  tracked files there.
- `running: no` in step 2 → `"$S" up 2` (up to 15 minutes; on failure it prints the log command
  to read).
- A container that exits with 137: `docker inspect <name> --format '{{.State.OOMKilled}}'`; if
  true, tell the developer to raise Docker Desktop memory instead of restarting in a loop.
- The PR adds migrations → say so: they now live in the review stack's database, and switching
  it to another PR does not roll them back.

## 4. Hand it over for testing

Show, in one message:

- the PR title, author, number and link, and the sha now running (`"$S" info 2`);
- **http://127.0.0.1:4000** (never `localhost:4000`: login breaks there, see the stack doc);
- the PR body's Testing Instructions section verbatim, or "none in the PR";
- the changed UI files (`gh pr diff <number> --name-only`, `frontend/` minus tests and stories) so
  the developer knows where to look;
- when `/w-21-review-prs` invoked this, its browser cases as a numbered checklist: path on
  http://127.0.0.1:4000, steps, expected result.

Then ask, via `slack-escalation.md`, with these options:

1. Works — post "🦈 visually tested"
2. Found problems
3. Stop, post nothing

No timeout default: this waits for the developer, and nothing is posted without an answer.

## 5. Record the result

- **Works** → skip if the current user already left that comment
  (`gh api user -q .login`, then look for a comment by that login whose body is exactly
  `🦈 visually tested` in `gh pr view <number> --json comments`). Otherwise:

  ```bash
  gh pr comment <number> --body "🦈 visually tested"
  ```

- **Found problems** → post nothing. Ask the developer to describe them. Invoked from
  `/w-21-review-prs` → return the description to it, which turns it into review comments.
  Otherwise offer `/w-21-review-prs <number>` to do that.
- **Stop** → post nothing.

Leave the review stack running on the PR either way.

## 6. Report back

Invoked from `/w-21-review-prs`: return the answer and any problem description to it, and skip
this report. Otherwise one short block: PR link, the sha tested, the stack URL, and whether the "🦈 visually tested"
comment was posted (with its URL), skipped as a duplicate, or not posted and why. When posted,
the next step once the author addresses review comments is `/w-25-re-review-pr <number>`.

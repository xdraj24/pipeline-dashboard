---
name: w-4-1-fast-track-push-to-release
description: Hotfix path instead of /w-4-publish. Cherry-pick a locally-prepared fix onto a chosen release branch, push, and open a RELEASE-titled PR into it. Use when a prepared fix must reach an already-cut release branch.
argument-hint: "[branch-name-or-TICKET-ID]"
model: sonnet
effort: medium
---

# Fast-Track Push to Release

Publish a branch that was already prepared locally (typically by `/w-1-coding`'s commit phase) —
but instead of rebasing it onto `main` and opening a PR there (what `/w-4-publish` does), cherry-pick
its fix onto a new branch based on an already-cut **release branch**, and open the PR against that
release branch. Use this when production needs the fix immediately, ahead of (or instead of) the
normal `main` merge.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

This does **not** land the fix in `main`. Once the release PR merges, run
`/w-4-2-cherrypick-to-main` with the resulting commit hash so `main` doesn't miss the fix.

Argument: `$ARGUMENTS` — optional. A branch name, a partial branch name, or a ticket id
(a ticket id matching `ticket_pattern`, `host-runtime.md`). Same lookup rules as `/w-4-publish`.

Every question for the developer in this skill goes through
`.claude/skills/_shared/slack-escalation.md`.

## 1. Find the source branch (the fix to fast-track)

Resolve it as `.claude/skills/_shared/find-branch.md` describes. Without an argument, the
qualifying statuses are `ready-for-push` and `fast-tracked-to-release` (a re-run for a follow-up
fix). Apply its "Before switching branches" guard.

- Note the source branch's commit range for step 4: `git merge-base origin/main <source-branch>`
  gives the base; everything from there to the branch tip is "the fix" to cherry-pick. In the
  common case (one commit per ticket from `/w-1-coding`'s commit phase) this is a single commit —
  confirm with `git log --oneline <base>..<source-branch>`.

## 2. Choose the release branch

- `git fetch origin --quiet` to make sure remote branch refs are current.
- List candidates: `git for-each-ref --sort=-committerdate --format='%(refname:short) | %(committerdate:short) | %(subject)' refs/remotes/origin | grep -E "^origin/<release_branch_pattern> "` (`release_branch_pattern` from `host-runtime.md`).
- Take the 8 most recent and present them as a numbered single-select list, each option showing
  the last-commit date and subject so the user can tell them apart. Always leave a way for the
  developer to name a release branch older than the top 8.
- Resolve the choice to a bare branch name (strip the `origin/` prefix).

## 3. Create the fix branch off the release branch

- `git fetch origin <release-branch>` to get it fresh.
- Branch name:

  ```
  <prefix>/<TICKET-ID>-<release-branch-without-its-first-segment>-<short-fix-description>
  ```

  - `<prefix>`: `bugfix/` or `feature/`, same rule as `/w-1-coding`'s commit phase (from the
    ticket's JIRA issue type; reuse it from `.ai-workspace/jira-plans/<TICKET-ID>/plan.md` if present, else
    look it up via `mcp__atlassian__getJiraIssue`).
  - Keep it ≤ 60 chars — drop words from `<short-fix-description>` first if it's too long, since
    the release-branch segment isn't optional (it's what makes the fix branch identifiable).
  - The release-branch segment is the branch with its first path segment removed (`release/r378` → `r378` when the pattern is `release/r[0-9]+`).
  - Example: `bugfix/<TICKET-ID>-r378-text-overflow`.
- `git checkout -b <fix-branch> origin/<release-branch>`.

## 4. Apply the fix

- Cherry-pick the source branch's commit(s) from step 1 onto the new branch, in order:
  `git cherry-pick <base>..<source-branch>` (or list individual SHAs if that range includes
  unrelated commits — verify with `git log --oneline` first).
- **If it cherry-picks cleanly**, continue to step 5.
- **If there are conflicts**: resolve them as `/w-6-rebase-with-main` step 4 describes (the two
  sides here are the fix and whatever the release branch carries that `main` doesn't, or vice
  versa), with `git cherry-pick --continue` / `--abort` in place of the rebase commands.

## 5. Re-run checks

A cherry-pick onto a different base can change behavior even without conflicts. Re-run the checks
for whatever the fix touches as `.claude/skills/_shared/run-checks.md` describes. If
Biome/RuboCop modified files, stage them and amend: `git commit --amend --no-edit`. If a test
fails, **stop**: report it and do not push. Fix only if the user asks.

## 6. Push

- This is a brand-new branch, so: `git push -u origin <fix-branch>`.

## 7. Open the release PR

- Title **must contain the literal word `RELEASE`**, e.g.:

  ```
  RELEASE: <TICKET-ID> <short description>
  ```

- Body from the template at `.github/pull_request_template.md`:
  - **Overview**: what the fix does, and that it's a fast-tracked hotfix targeting
    `<release-branch>` ahead of/instead of the normal `main` merge.
  - **JIRA Ticket**: `[<TICKET-ID>](<jira_browse>/<TICKET-ID>)`.
  - **Dependencies**: note that this fix still needs to reach `main` — once this PR merges, run
    `/w-4-2-cherrypick-to-main <TICKET-ID> <resulting-commit-hash>` to land it there too (unless
    the ticket is already covered by a separate PR into `main`).
  - **Testing Instructions**: carry over from `.ai-workspace/jira-plans/<TICKET-ID>/local-branch.md` if
    present, else derive from the diff/ticket.

  ```
  gh pr create --base <release-branch> --title "<title>" --body "<filled template>"
  ```

## 8. Update local-branch state

Update `.ai-workspace/jira-plans/<TICKET-ID>/local-branch.md` (if it exists): set `status:
fast-tracked-to-release`, and add `release_branch: <release-branch>` and `release_pr_url:
<pr-url>` fields. Leave the file in place rather than deleting it — `main` still needs this fix
via `/w-4-2-cherrypick-to-main`.

## 9. Report back

Show the user: the release branch chosen, the new fix branch name, the PR URL, any conflicts
resolved during the cherry-pick, and the reminder to run `/w-4-2-cherrypick-to-main` once the PR
merges.

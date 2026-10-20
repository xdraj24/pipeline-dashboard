---
name: w-4-2-cherrypick-to-main
description: Cherry-pick a commit that exists only on a release branch (e.g. a /w-4-1 hotfix) into main via a new branch and a "Release cherrypick" PR. Use when a release-branch fix also needs to reach main.
argument-hint: "XWWP-XXXX [commit-sha]"
model: sonnet
effort: medium
---

# Cherry-Pick Release Fix to Main

Take a commit that only exists on a release branch (most often a hotfix fast-tracked there via
`/w-4-1-fast-track-push-to-release`, but this also works for any fix applied directly to a
release branch) and land the same change on `main`. The source is always a `release/rXXX` branch
— this skill never cherry-picks from `main`, feature branches, or anywhere else.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

Arguments: `$ARGUMENTS` — whitespace-separated:
1. An XWWP ticket id (e.g. `XWWP-1551`). Required — if missing or malformed (doesn't match
   `XWWP-\d+`), ask the user before doing anything else.
2. The commit hash from the release branch to cherry-pick. Optional — if omitted, resolve it
   automatically in step 1. If provided, it must be at least 7 plausible hex characters; if it
   looks malformed, ask the user for the corrected value rather than guessing.

Every question for the developer in this skill goes through
`.claude/skills/_shared/slack-escalation.md`.

## 1. Fetch release branches and resolve the commit

- `git fetch --all --quiet` first, always — this pulls the latest commits on every remote
  branch, including `release/rXXX` branches, before anything else happens.
- **If a commit hash was given as the second argument:**
  - Check it's known: `git cat-file -e <sha>^{commit}` (exit code 0 = found). Since we already
    fetched everything, a miss here means the hash is wrong — stop and tell the user the commit
    hash isn't reachable from `origin`; ask them to double check it.
- **If no commit hash was given:**
  - List remote release branches: `git branch -r | grep -E 'origin/release/r[0-9]+$'`.
  - Pick the one with the highest `r` number — that's the latest release branch. It will most
    likely be the one carrying the fix, since hotfixes land as the newest commit on the newest
    cut release branch.
  - Use its tip as the target: `git rev-parse origin/release/r<N>`.
  - Tell the user which release branch and commit you resolved to before continuing, so they can
    correct you if it's the wrong one.
- Either way, confirm the resolved commit actually lives on a release branch:
  `git branch -r --contains <sha> | grep -E 'release/r[0-9]+'`. If that comes back empty, stop —
  this skill only cherry-picks from release branches — and ask the user to double check the
  commit/ticket.

## 2. Gather context (best-effort, for the PR body)

- Which release branch(es) carry it: reuse the result from step 1 (`git branch -r --contains
  <sha> | grep -E 'release/r[0-9]+'`). Not required to succeed — if empty or ambiguous, just omit
  this detail later.
- Files touched: `git show --stat <sha>`. Used in step 4 for branch naming and in step 6 for
  scoping checks.
- Fetch the JIRA ticket (`mcp__atlassian__getJiraIssue`; cloud id via
  `mcp__atlassian__getAccessibleAtlassianResources` if needed) for:
  - **Issue type** → branch prefix: `Bug` → `bugfix/`, else `feature/`.
  - **Summary/description** → for branch naming and the PR body.

## 3. Check the working tree

- `main` is already fresh from the `git fetch --all` in step 1 — no need to fetch it again.
- `git status` on the **current** branch first — if there are uncommitted changes, warn the user
  and confirm before switching away from them.

## 4. Create the fix branch off main

Branch name:

```
<prefix>/XWWP-<number>-cherrypick-<page-area>-<short-description>
```

- `<prefix>`, `<page-area>` and the length/case rules follow `/w-1-coding`'s
  `phases/commit.md` step 3; `<short-description>` is 2–4 words from the ticket summary or the
  original commit's subject.

- If a local branch with this exact name already exists, ask the user whether to reuse it or
  pick a different suffix rather than silently overwriting it.
- `git checkout -b <fix-branch> origin/main`.

## 5. Cherry-pick

- `git cherry-pick -x <sha>` (the `-x` records "(cherry picked from commit ...)" in the message,
  which is useful provenance since the fix originated on a release branch, not main).
- **If it cherry-picks cleanly**, continue to step 6.
- **If there are conflicts** (likely if `main` has diverged from the release branch's base):
  resolve them as `/w-6-rebase-with-main` step 4 describes, with `git cherry-pick --continue` /
  `--abort` in place of the rebase commands.

## 6. Run checks

Run the checks for the files the cherry-picked commit touches as
`.claude/skills/_shared/run-checks.md` describes. If Biome/RuboCop modified files, stage them
and amend: `git commit --amend --no-edit`. If a test fails, **stop**: report it and do not push.
Fix only if the user asks.

## 7. Push

- Brand-new branch: `git push -u origin <fix-branch>`.

## 8. Open the PR into main

- Title **must contain the literal phrase `Release cherrypick`**, e.g.:

  ```
  Release cherrypick: XWWP-<number> <short description>
  ```

- Body from the template at `.github/pull_request_template.md`:
  - **Overview**: what the fix does, and that it cherry-picks commit `<sha>`
    (from `<release-branch>`, if step 2 found one) into `main`.
  - **JIRA Ticket**: `[<TICKET-ID>](https://welligence.atlassian.net/browse/<TICKET-ID>)`.
  - **Dependencies**: note the originating release branch/PR if known, else "None".
  - **Testing Instructions**: derive from the ticket and the cherry-picked diff.

  ```
  gh pr create --base main --title "<title>" --body "<filled template>"
  ```

## 9. Update local-branch state (best-effort)

If `.jira-plans/<TICKET-ID>/local-branch.md` exists, add a `main_cherrypick_pr_url: <pr-url>`
field to it. If it doesn't exist, don't create it — this ticket may never have gone through
`/w-1-coding`'s commit phase, and that file's schema assumes it did.

## 10. Report back

Show the user: the fix branch name, the PR URL, the source commit (and release branch, if found),
and a one-line summary of any conflicts resolved.

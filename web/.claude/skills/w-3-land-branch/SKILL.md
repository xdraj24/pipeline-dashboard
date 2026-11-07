---
name: w-3-land-branch
description: Land a branch produced by the unattended pipeline into the main working directory for a human pass. Rebases it onto fresh origin/main, re-runs code review and QA when the rebase touched the change, surfaces change notes and unresolved findings, keeps the pipeline commit (un-commits with reset-commit), re-commits on approval. Use after a background /w-1-coding or /w-10-sprint-batch run.
argument-hint: "<TICKET-ID> [reset-commit]"
model: sonnet
effort: medium
---

# Land a Pipeline Branch

A sibling of `/w-4-publish` and `/w-4-1-fast-track-push-to-release` — same family, different job.
Those publish a branch that's already `ready-for-push`. This one takes a branch that an
**pipeline run** produced, background or supervised (`status: ready-for-review`, or `draft-pr-open` when the run
ended with a draft PR) and hands it to a human for review in the main working directory before it
can become `ready-for-push`. Along the way it rebases the branch onto
fresh `origin/main` and decides whether main moved enough under the change to warrant another
code-review and QA pass. It also finishes a landing that stalled mid-way (un-committed with
`reset-commit`, never re-committed); `/w-4-publish` step 2 can do the same commit when the
developer goes straight from reviewing to publishing.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

Arguments: `$ARGUMENTS` — a single ticket id matching `ticket_pattern` (`host-runtime.md`), required, plus optionally
`reset-commit`. If the ticket id is missing, ask the developer for it before doing anything else.

Every question for the developer in this skill goes through
`.claude/skills/_shared/slack-escalation.md`.

## 1. Check the ticket's status

- Read `.ai-workspace/jira-plans/<TICKET-ID>/local-branch.md`. If it doesn't exist, stop and tell the user
  there's nothing to land for this ticket (it may not have run through the pipeline at all).
- Check its `status:` field:
  - `ready-for-review` → pipeline output, no PR yet. Continue.
  - `draft-pr-open` → pipeline output, draft PR already pushed (`pr_url:` holds it). Continue.
  - `ready-for-push` (or anything else, e.g. `pushed`, `fast-tracked-to-release`) → stop and tell
    the user this ticket did **not** go through the pipeline (or was already landed)
    — this skill is only for pipeline output, not a general-purpose branch review tool.

## 2. Find the worktree, or detect a stalled landing

`git worktree list --porcelain`, looking for `worktree <repo-root>/.ai-workspace/worktrees/<TICKET-ID>`.

- **Found** → the worktree must be clean per the "Is a pipeline worktree clean?" check in
  `.claude/skills/_shared/run-checks.md` (a bare `git status` always shows the copied-in
  scaffolding). **Not clean** → stop, show what's dirty and ask how to proceed; never remove a
  worktree that still has uncommitted work. Clean → step 3.
- **Not found** → a previous landing or a manual cleanup removed it. Read `branch:` from
  `local-branch.md` and check for the **stalled-landing state**: that branch is checked out here
  (`git branch --show-current`), `git status --porcelain --cached` shows staged changes, and
  `git log --oneline $(git merge-base origin/main <branch>)..<branch>` shows zero commits.
  - All three hold → a previous run un-committed the pipeline commit (step 7) and the session
    ended before approval. The branch was already rebased then; skip steps 3–7 and continue at
    step 8 with "un-committed" as the step-7 outcome. The commit to reuse is `pipeline_commit:`
    in `local-branch.md` (see step 10 for the fallback when it's absent).
  - A different branch is checked out → stop and ask the user to check out `<branch>` first
    rather than switching for them; there may be unrelated work in progress.
  - Otherwise, if `git rev-parse --verify --quiet refs/heads/<branch>` succeeds → skip step 3
    and continue at step 4. Branch gone too → ask how to proceed.

## 3. Sync `.ai-workspace/jira-plans/` and remove the worktree

- The worktree's `.ai-workspace/jira-plans/<TICKET-ID>/` is the freshest copy (the coordinator script copies it
  back after each stage, but this is the last chance to catch anything newer). Diff it against the
  main checkout's copy; if they differ, copy the worktree's version over:
  `cp -r .ai-workspace/worktrees/<TICKET-ID>/.ai-workspace/jira-plans/<TICKET-ID> .ai-workspace/jira-plans/`.
- `git worktree remove --force .ai-workspace/worktrees/<TICKET-ID>` (`--force` only because the
  copied-in scaffolding is untracked; step 2 already proved there is no real work in it).
- `git worktree prune`.

## 4. Check out the branch in the main working directory

- Read `branch:` from `.ai-workspace/jira-plans/<TICKET-ID>/local-branch.md`.
- `git status` on the **current** branch first — if there are uncommitted changes unrelated to
  this ticket, warn the user and confirm before switching (same guard as
  `.claude/skills/_shared/find-branch.md`).
- `git checkout <branch>` (this only works now that step 3 removed the worktree that had it
  checked out).

## 5. Rebase onto fresh origin/main

The branch was cut when the pipeline started and main has moved since. Land it on top of
today's main before anyone reads the diff, so the review covers what will actually ship.

- Confirm the branch has exactly one commit: `git log --oneline $(git merge-base origin/main
  <branch>)..<branch>`. The pipeline always produces a single commit per ticket; more than one →
  stop and ask the user how to proceed rather than assuming which commit(s) to touch.
- Record the pre-rebase state for step 6: `OLD_BASE=$(git merge-base origin/main <branch>)`,
  `OLD_TIP=$(git rev-parse HEAD)`.
- `git fetch origin main`, then `git rebase origin/main`. The working tree must be clean (step 4
  checked); never rebase over staged changes.
- **Conflicts**: resolve them exactly as `/w-6-rebase-with-main` step 4 describes — file by file,
  reading both sides, preserving the branch's functionality and whatever main changed, never
  blindly ours/theirs for logic-bearing code, `pnpm codegen` for `GraphqlSchema.ts`. A conflict
  you are not confident about, or a rebase that spirals → `git rebase --abort`, show the
  developer both sides' hunks and ask; do not guess. With a draft PR open the rebase rewrites
  pushed history — fine, `/w-4-publish` force-pushes with lease.
- Re-run the checks for whatever the branch touches as `.claude/skills/_shared/run-checks.md`
  describes. Biome/RuboCop edits → stage and `git commit --amend --no-edit`. A failing test →
  stop and show it; fix only if the developer asks.

## 6. Assess whether review and QA need to run again

The pipeline's code-review and qa-check looked at the change against the old base. Decide
whether that verdict still holds:

- **Ticket files touched on main**: `git diff --name-only $OLD_BASE origin/main` intersected
  with `git diff --name-only HEAD~1 HEAD`.
- **The change itself moved**: `git range-diff $OLD_BASE..$OLD_TIP origin/main..HEAD` shows
  anything beyond context-line shifts (a conflict resolution always does).
- **Something near it moved**: files on main that the ticket's files import, call or are
  specs for (same directory, a shared helper, a GraphQL type the change reads), from
  `change-notes.md`'s "What changed" list against the main diff.

Any of the three → say which, in one line each, then re-run both phases here on the landed
branch: invoke `/w-1-coding <TICKET-ID> just-code-review here`, and once it reports, `/w-1-coding
<TICKET-ID> just-qa-check here` (the running app now serves this checkout, so the browser pass
is real this time). Their findings land in `code-review.md` and `qa-check.md` and step 7 surfaces
them. If qa-check changes code, w-1 runs review and commit again by itself; on a draft-PR branch
the commit phase will stack a second commit rather than amend a pushed one — fine, the developer
reviews `git diff origin/main...HEAD` either way.

None of the three → say the rebase replayed the change untouched over unrelated main commits and
skip the re-run.

## 7. Decide what happens to the pipeline's commit

- **`reset-commit` was passed** → **un-commit**. First record the commit so it survives
  whatever the developer does to the repo during review (`ORIG_HEAD` does not — any later
  `git reset`, `rebase` or `pull` overwrites it): add `pipeline_commit: <git rev-parse HEAD>` to
  `local-branch.md`'s frontmatter. Then `git reset --soft HEAD~1` moves the commit back into the
  index as staged changes. (If step 6's re-run left more than one commit, reset to
  `origin/main` instead and record the tip; the message to reuse is still the tip's.)
- **Otherwise** → **keep the commit**. The review happens against `git diff origin/main...HEAD`;
  the developer's edits, if any, land as working-tree changes on top of it and get folded in at
  step 10.

Say which of the two you did.

## 8. Surface the change notes and anything decided without a human

Before the user looks at the diff, show verbatim, up front, in this order:

- `.ai-workspace/jira-plans/<TICKET-ID>/change-notes.md` — the whole file (what changed, decisions,
  assumptions). This is the main thing to read before the diff. If it's missing (a run from before
  it existed), say so.
- Step 5's outcome: conflicts resolved (file and one line on how each was settled) or none, and
  any `rebase_assessment:` line a draft publish left in `local-branch.md` (what `/w-4-publish`
  saw move under the change at draft time).
- Step 6's assessment and, when the phases re-ran, their fresh findings: the `## Open findings`
  and any `## Unresolved at pipeline completion` sections from `code-review.md` and
  `qa-check.md`.
- Otherwise, from the pipeline's own run: any `## Unresolved at pipeline completion` section in
  `code-review.md` (the review loop hit its cap or spiraled), and from `qa-check.md` the
  `browser:` line (`skipped` when the run had no QA stack), the `## Open findings` section, and
  any `## Unresolved at pipeline completion` section. No `qa-check.md` → say the branch was never
  QA-checked. When the line is `skipped` or `blocked` and step 6 did not re-run QA, offer the
  staff QA pass on the QA stack as the way to do the browser test:
  `/w-1-coding <TICKET-ID> just-qa-check here`.
- Any `**Human-answered via Slack:**` or fallback notes in `plan.md`'s "Risks / Open questions".
- Any `## Assumptions Made` section in `local-branch.md` (older runs only; newer runs put this in
  `change-notes.md`).

This is the main point of this skill — the developer should see what got decided without a human
in the loop *before* they start reading the diff, not stumble onto it buried in a file later.

## 9. Hand off for review

Show a summary: the branch name, the draft PR URL if there is one, the files changed
(`git diff --stat origin/main...HEAD` for a kept commit, or `git diff --cached --stat` for staged
changes), any unstaged files that are **not** part of the ticket (compare `git status --porcelain`
against the ticket's file list — separate dirty state, left untouched), and everything surfaced
in step 8. Then stop and wait — the user reviews and edits the changes normally in their IDE,
**and must test the change manually in the browser** before approving (unless step 6's QA
re-run already did the browser pass and they accept it). Do not proceed to step 10 until they
explicitly confirm they're ready (e.g. "tested it, commit it", "looks good", "commit with an
edited message") — do not accept a bare "looks good" as sufficient if they haven't mentioned
testing it; ask whether they tried it in the browser first. If the developer instead runs
`/w-4-publish <TICKET-ID>` after reviewing, that skill performs step 10 itself.

End the hand-off message with the URL to test on, as its own last line: the main stack,
`http://localhost:3000`, plus the path of the page the change affects. Take the path from the
testing instructions in `local-branch.md`, `qa-check.md`'s test plan or `change-notes.md`; failing
those, from the frontend route that renders the changed components. No page found (a backend-only
change, or the route is unclear) → print `http://localhost:3000` and say which screen to open
instead of guessing a path. If `web-web-1` or `web-spa-1` is not running
(`docker ps --format '{{.Names}}'`), say so above the URL and suggest `make start`.

## 10. Commit on approval

Only ever stage the ticket's own files — the ticket's file list from step 9 plus any file the
developer edited among them or explicitly names. Never `git add -A`: the unrelated dirty files
from step 9 stay out unless the developer asks, and then it's a separate `git add` called out in
the report.

- **Un-committed in step 7:** the message comes from `pipeline_commit:` in `local-branch.md`.
  Verify it first (`git show --stat <sha>` should reference `<TICKET-ID>` and match the staged
  files). Then `git commit -C <sha>` to reuse the message verbatim, or `git commit -c <sha>` to
  edit it. If the field is absent (a landing started before it existed), try `ORIG_HEAD` with the
  same verification; if that fails too, build the message from `commit_title` /
  `commit_description` in `local-branch.md` and `git commit -m "<message>"`, and tell the user.
- **Commit kept in step 7:**
  - Working tree clean → nothing to do.
  - Working tree has the developer's edits → fold them into the tip commit:
    `git commit --amend --no-edit` (or `--amend` without `--no-edit` to edit the message).
- Either way, if the developer changed anything, append a short `## Post-review edits` section to
  `.ai-workspace/jira-plans/<TICKET-ID>/change-notes.md` — one to three bullets describing what they changed
  versus the pipeline's version (diff the pipeline commit, `pipeline_commit:` or the pre-amend tip
  `HEAD@{1}`, against the new tip). Add a bullet for step 5's conflict resolution too when there
  was one. `/w-4-publish` carries the updated file into the PR body.

## 11. Flip the status

Update `.ai-workspace/jira-plans/<TICKET-ID>/local-branch.md`: set `status: ready-for-push` and drop the
`pipeline_commit:` and `rebase_assessment:` fields. Keep `pr_url:` if present — that's how `/w-4-publish` knows to update
and un-draft the existing PR instead of opening a second one. This is what makes the ticket
eligible for `/w-4-publish` (or `/w-4-1-fast-track-push-to-release`) going forward.

## 12. Report back

Show the user: the branch name, the rebase outcome (clean, or which conflicts and how), whether
review and QA re-ran and why, whether the pipeline's commit was kept or un-committed, whether the
message was reused, edited or amended, whether this run finished a stalled landing, and the
draft PR URL if there is one. End by suggesting the next step: `/w-4-publish <TICKET-ID>` (it
marks an existing draft PR ready for review).

---
name: w-4-publish
description: Rebase a locally-prepared branch onto origin/main, push, and open or update its PR with the ticket's change notes. Commits first when /w-3-land-branch left the pipeline commit un-committed for review. `draft` opens a draft PR straight from pipeline output; otherwise an existing draft is marked ready. Use to publish a branch from /w-1-coding or /w-3-land-branch.
argument-hint: "[branch-name-or-XWWP-XXXX] [draft]"
model: sonnet
effort: high
---

# Push and Open PR

Publish a branch that was already prepared locally (by `/w-1-coding`'s commit phase, landed via
`/w-3-land-branch` when it came out of the pipeline) — rebase it on a fresh `origin/main`, push
it, and open (or update) its pull request.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

Arguments: `$ARGUMENTS` — optional. A branch name, a partial branch name, or a ticket id
(e.g. `XWWP-1551`), plus optionally the word `draft`.

- **`draft`** → open the PR as a **draft**, skip every human gate, keep the ticket's local state.
  This is what `scripts/pipeline/run-ticket-pipeline.sh --draft-pr` runs inside the worktree at
  the end of a `/w-1-coding … draft-pr` run, and it's fine to run by hand too. A draft PR is the
  one place pipeline output is allowed to reach GitHub without a human pass; the human pass
  happens later (`/w-3-land-branch`) and this skill, run again without `draft`, then marks the PR
  ready for review.
- **No `draft`** → the normal path: a non-draft PR, or an existing draft PR flipped to ready.

Every question for the developer in this skill goes through
`.claude/skills/_shared/slack-escalation.md`. Under `PIPELINE_MODE=unattended` there is no
developer in the session: where a step below says "ask", take the documented default; where
there's no safe default (a logic conflict in the rebase, a failing test), abort that step, leave
`local-branch.md` untouched and report the failure — the pipeline detects a missing `pr_url:` and
marks the stage failed.

## 1. Find the target branch

Resolve it as `.claude/skills/_shared/find-branch.md` describes. Without an argument, the
qualifying statuses are `ready-for-push`, any status whose frontmatter carries
`pipeline_commit:`, and a `ready-for-review` / `draft-pr-open` branch that is currently checked
out in the main checkout (with `draft`: every `ready-for-review` and `draft-pr-open`).

Then check `.jira-plans/<TICKET-ID>/local-branch.md`'s `status:`, if the file exists:

- `ready-for-push` or missing file → continue.
- `draft-pr-open` or `ready-for-review` with `pipeline_commit:` in the frontmatter → the
  developer ran `/w-3-land-branch` with the commit reset for review. Confirm the
  **landed-for-review state** before trusting it: that branch is checked out here
  (`git branch --show-current`), `git status --porcelain --cached` shows staged changes, and
  `git log --oneline $(git merge-base origin/main <branch>)..<branch>` shows zero commits. All
  three hold → the human pass happened in the working tree; running this skill is the approval.
  Continue at step 2, which commits the reviewed changes. Any of the three fails → treat the
  status as below, without `pipeline_commit:`.
- `draft-pr-open` or `ready-for-review` without `draft`, outside `PIPELINE_MODE=unattended` →
  check the **landed-committed state**: the branch is checked out in the main checkout
  (`git branch --show-current`, and `git rev-parse --git-dir` equals
  `git rev-parse --git-common-dir`), `git log --oneline $(git merge-base origin/main <branch>)..<branch>`
  shows the ticket's commit(s), and `git status --porcelain` lists none of the branch's files.
  All three hold → the developer has the committed change running locally and tested it in the
  browser before calling this skill; that is the human pass. Set `status: ready-for-push` (keep
  `pr_url:`) and continue at step 3, without asking. Before building the PR body in step 7, read
  `change-notes.md` against `qa-check.md` and fix lines that the run has since made untrue
  (e.g. "no QA phase has run yet" when `qa-check.md` says `status: pass`). Any check fails → the
  rules below apply.
- `draft-pr-open`:
  - with `draft` → a re-push of the draft; continue (step 7 updates the existing PR).
  - without `draft` (and not landed-committed, above) → the draft PR has not had its human pass
    yet. Stop and tell the user to run
    `/w-3-land-branch <TICKET-ID>` first; it flips the status to `ready-for-push` and this skill
    then finalizes the PR.
- `ready-for-review`:
  - with `draft` → pipeline output going out as a draft; continue.
  - without `draft` (and not landed-committed, above) → the branch came out of the unattended
    pipeline and has not had a human pass. Do not publish it as-is, even if explicitly named.
    Stop and tell the user to run `/w-3-land-branch <TICKET-ID>`.

## 2. Commit a landing left un-committed for review

Only when step 1 confirmed the landed-for-review state; otherwise skip to step 3. This is
`/w-3-land-branch` step 10, run here because the developer went straight from reviewing to
publishing. Not possible under `PIPELINE_MODE=unattended` (the state only exists in the main
checkout) — if it somehow shows up there, abort and report.

- Verify the recorded commit: `git show --stat <pipeline_commit>` must reference `<TICKET-ID>`
  and its file list must match the staged files. A mismatch → stop and ask which message to use
  (never guess a commit to reuse).
- Stage only the ticket's own files: the staged list, plus unstaged edits the developer made to
  those same files (`git add <each staged path>`). Never `git add -A`; unrelated dirty files stay
  out and get listed in the report. A new untracked file is included only if the developer names
  it.
- `git commit -C <pipeline_commit>` to reuse the message verbatim. Pre-commit hooks run; if they
  modify files, stage them and `git commit --amend --no-edit`.
- If the new tip differs from `<pipeline_commit>` (`git diff --stat <pipeline_commit> HEAD` is
  not empty), append a short `## Post-review edits` section to
  `.jira-plans/<TICKET-ID>/change-notes.md` — one to three bullets on what the developer changed
  versus the pipeline's version. Step 7 carries it into the PR body.
- Update `local-branch.md`: `status: ready-for-push`, drop `pipeline_commit:`, keep `pr_url:` if
  present. From here the branch is an ordinary `ready-for-push` one.

## 3. Check out the branch

Per the "Before switching branches" guard in `find-branch.md`, then `git checkout <branch-name>`.

## 4. Rebase onto fresh origin/main

Exactly as `/w-3-land-branch` step 5: record `OLD_BASE=$(git merge-base origin/main <branch>)`
and `OLD_TIP=$(git rev-parse HEAD)`, `git fetch origin main`, `git rebase origin/main`, resolve
conflicts as `/w-6-rebase-with-main` step 4 describes (both sides' intent, never blindly
ours/theirs for logic-bearing code, abort and ask when not confident), then re-run the checks for
whatever the branch touches as `.claude/skills/_shared/run-checks.md` describes. Biome/RuboCop
edits → stage and `git commit --amend --no-edit`. A failing test → **stop**, report it, do not
push; fix only if the user asks. Unattended: `git rebase --abort` and report the failure instead
of asking. A branch that `/w-3-land-branch` just landed was rebased minutes ago, so this is
usually a no-op; keep the step anyway, main may have moved since.

## 5. Assess whether review and QA need to run again

Run the three checks of `/w-3-land-branch` step 6 against `$OLD_BASE` / `$OLD_TIP`: main
touched the ticket's files, the change itself moved in the replay (`git range-diff`), or main
touched what the change imports, calls or is specced by. Then:

- **Nothing fired** (or the rebase was a no-op) → say so in one line and continue.
- **Something fired, no `draft`** → say which, then re-run both phases on this checkout:
  `/w-1-coding <TICKET-ID> just-code-review here`, and once it reports, `/w-1-coding <TICKET-ID>
  just-qa-check here`. Unresolved findings from either → **stop**, show them, do not push; the
  developer decides whether to fix, publish as is, or drop the branch. A qa-check that changed code
  has already been re-reviewed and committed by w-1 (possibly as a second commit on a pushed
  branch); step 6's force-push with lease carries it.
- **Something fired, `draft`** → do not re-run here: the draft PR is going out for its human
  pass, and `/w-3-land-branch` rebases and assesses again when it lands. Record the outcome so
  it is not lost: add `rebase_assessment: <one line, which trigger fired>` to `local-branch.md`'s
  frontmatter and repeat it in the report. Unattended runs take this path by construction.

## 6. Push

- Check whether the branch already has a remote counterpart:
  `git ls-remote --exit-code --heads origin <branch-name>`.
  - **No remote branch yet** → `git push -u origin <branch-name>`.
  - **Remote branch exists** (a re-push, or a branch that already has a draft PR) →
    `git push --force-with-lease origin <branch-name>` (safe after a rebase rewrites history;
    never plain `--force`).

## 7. Open or update the PR

- Check for an existing PR on this branch: `gh pr view <branch-name> --json url,number,isDraft,body`.
  If it errors, there's no PR yet.
- **Build the body** from `.jira-plans/<TICKET-ID>/local-branch.md` (fall back to re-deriving
  from the diff/ticket if the file is missing or incomplete), using the template at
  `.github/pull_request_template.md`, as plain text with the `> <Insert here …>` placeholder
  markers dropped:
  - **Overview**: the file's `## Overview` section, then `JIRA Ticket: [<TICKET-ID>](<jira_url>)`,
    then the `commit_description` field if it adds information beyond the title.
  - **Screenshots/Recordings**: leave the template placeholder; step 7b fills it from the QA
    screenshots, or `/w-7-attach-pr-visuals` does later.
  - **Dependencies**: the file's `## Dependencies` section.
  - **Testing Instructions**: the file's `## Testing Instructions` section.
  - **Change Notes** — always the **last** section, draft and final PR alike: a
    `## :memo: Change Notes` header followed by the body of
    `.jira-plans/<TICKET-ID>/change-notes.md` verbatim (everything after its frontmatter,
    including any `## Post-review edits`, with its `##` headers demoted to `###`). Omit the
    section only if the file doesn't exist.
- **No existing PR** →

  ```
  gh pr create --title "<commit_title>" --body "<filled template>" [--draft]
  ```

  `--draft` only when `draft` was passed.
- **Existing PR** → the pushed commits already update its diff. Refresh only the Change Notes
  section of its body so hand edits elsewhere (screenshots, reviewer notes) survive: take the
  current `body`, replace everything from the `## :memo: Change Notes` header to the end with the
  freshly built section (append it if the header isn't there), and `gh pr edit <number> --body
  "<updated body>"`. Then, if `isDraft` is true and `draft` was **not** passed:
  `gh pr ready <number>`.

## 7b. Attach the QA screenshots

When `.jira-plans/<TICKET-ID>/screenshots/index.md` exists (written by a passing qa-check with
a browser pass), `draft` was **not** passed, and this is an interactive Claude Code session:
invoke `/w-7-attach-pr-visuals <TICKET-ID>`, which uploads those files into the PR's
Screenshots/Recordings section. Otherwise skip, and with `draft`, unattended or another host
leave the folder in place so the final publish (or the developer, by hand) attaches it. A failed
attach does not undo the publish; report it.

## 8. Update local-branch state

Update `.jira-plans/<TICKET-ID>/local-branch.md` (create it if this ticket somehow has no such
file yet) and add/refresh a `pr_url:` field with the PR URL:

- `draft` passed → `status: draft-pr-open`. The ticket's local state stays in place: the human
  pass (`/w-3-land-branch`) and the final publish still need it.
- otherwise → `status: pushed`. This keeps it out of future "ready to push" suggestions while
  still leaving a record.

## 9. Clean up local artifacts (final publish only)

Skip this step entirely when `draft` was passed. Otherwise, once the PR is open (or marked ready)
and `local-branch.md` is updated, this ticket's local pipeline state is no longer needed. Only run
this step if step 7 succeeded — leave everything in place on failure so the run can be retried.

- If `.claude/worktrees/<TICKET-ID>` still exists and is clean per the "Is a pipeline worktree
  clean?" check in `.claude/skills/_shared/run-checks.md`: `git worktree remove --force` it
  (the copied-in scaffolding is untracked, so a plain remove refuses), then `git worktree
  prune`. Dirty → leave it and say so.
- `rm -rf .jira-plans/<TICKET-ID>/`, except when step 7b was skipped or failed while
  `screenshots/` exists: then delete everything in the folder but `screenshots/`, and name it
  in the report.
- Remove this ticket's files from every pipeline-logs run:
  `rm -f .claude/pipeline-logs/*/<TICKET-ID>.log .claude/pipeline-logs/*/<TICKET-ID>.status`.
- Prune any pipeline-logs run directory that now holds nothing but its `progress.log`:

  ```bash
  for d in .claude/pipeline-logs/*/; do
    [ -z "$(ls -A "$d" | grep -v '^progress\.log$')" ] && rm -rf "$d"
  done
  ```

`scripts/pipeline/prune.sh` does the same for every ticket whose PR has since merged, for runs
that skipped this step. `/w-5-resolve-pr-comments` falls back to `gh pr list` when a ticket's
`local-branch.md` is gone, so deleting it here doesn't break that lookup.

## 10. Report back

Show the user the PR URL, whether it was newly created (draft or not), updated, or flipped from
draft to ready for review, whether step 2 committed a reviewed landing (and which unrelated dirty
files it left out), a one-line summary of any conflicts that had to be resolved during the
rebase, and step 5's assessment (nothing fired, or what fired and whether review and QA re-ran).
For a draft PR, say the next step is `/w-3-land-branch <TICKET-ID>`. Otherwise say which QA
screenshots step 7b attached, or, when there were none and the PR has UI changes, that
`/w-7-attach-pr-visuals <TICKET-ID>` captures them.

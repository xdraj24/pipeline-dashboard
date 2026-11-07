# Shared: Find a Local Branch to Act On

Used by `/w-4-publish`, `/w-4-1-fast-track-push-to-release` and `/w-6-rebase-with-main`. The
caller says which `local-branch.md` statuses qualify when no argument is given, and what to do
once the branch is found.

## With an argument (branch name, partial name, or a ticket id matching `ticket_pattern`)

`ticket_pattern` is defined in `host-runtime.md`.

1. Exact local match: `git branch --list "<arg>"`.
2. No match and the argument is a ticket id → read `branch:` from
   `.ai-workspace/jira-plans/<TICKET-ID>/local-branch.md`.
3. Still nothing → fuzzy: `git branch --list "*<arg>*"`.
   - Zero → tell the user no matching local branch exists and stop.
   - One → use it.
   - Several → list them and let the developer pick (via `slack-escalation.md`).

Once found, derive the ticket id from the branch name or the argument; the caller checks
`.ai-workspace/jira-plans/<TICKET-ID>/local-branch.md`'s `status:` against its own rules.

## Without an argument

- Scan `.ai-workspace/jira-plans/*/local-branch.md` for the statuses the caller accepts.
- Drop any candidate whose branch no longer exists locally
  (`git rev-parse --verify --quiet refs/heads/<branch>` fails) — typically already merged and
  deleted.
- None left → say there's nothing ready and suggest `/w-1-coding <TICKET-ID> here`; stop.
- Otherwise present them (ticket id, branch, `commit_title`) and let the developer pick. Don't
  auto-pick even if there's exactly one.

## Before switching branches

`git status` on the current branch first. Uncommitted changes that don't belong to the target
ticket → warn and confirm before `git checkout`; never carry unrelated work over silently.
Unattended or supervised (`PIPELINE_MODE` set): the branch is already checked out in the worktree; if it
isn't, stop and report.

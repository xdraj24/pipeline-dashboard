---
name: w-10-sprint-batch
description: Find every ticket assigned to you in the current sprint's To Do column, confirm the list, and hand them all to /w-1-coding (plan here, the rest in parallel worktrees supervised from this session). Same phase and mode arguments as /w-1-coding. Use to run the whole sprint column in one go.
argument-hint: "[<TICKET-ID> ...] [just-plan|just-implement|just-code-review|just-commit|just-qa-check] [supervised|background|here|draft-pr] [--jobs=N] [--waitForReply=N]"
model: sonnet
effort: medium
---

# Sprint Batch

Find the tickets, confirm the scope, and delegate everything else to `/w-1-coding`, which does
the planning in this context and fans the rest out to one git worktree per ticket (`MAX_SLOTS` in
`scripts/pipeline/lib.sh` at a time), coordinated from this session by default. Nothing from the pipeline
reaches a non-draft PR until a human has looked at it via `/w-3-land-branch`.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

`$ARGUMENTS` is optional and is passed through to `/w-1-coding` with the same meaning:

- Bare ticket ids (tokens matching `ticket_pattern`, `host-runtime.md`) → skip the JIRA search, use exactly those.
- `just-plan` / `just-implement` / `just-code-review` / `just-commit` / `just-qa-check` → run
  only that phase for every ticket (`just-plan` is the old "prepare only"). None → all five.
- `supervised` (default in interactive Claude Code) / `background` (default elsewhere) / `here` /
  `draft-pr` → where the implement, code-review, commit and qa-check phases run. `supervised`
  runs them as subagents of this session, which stays open until the batch finishes and asks you
  any question they hit (`.claude/skills/_shared/supervised-run.md`). `background` detaches the
  bash pipeline so the session can be cleared. `here` means one ticket at a time, sequentially, in this working directory — the
  only option on a host without a pipeline runner (`.claude/skills/_shared/host-runtime.md`
  § The unattended pipeline per host). `draft-pr` ends every ticket with a draft PR.
- `--jobs=N` → pipeline concurrency (default and hard max `MAX_SLOTS`).
- `--waitForReply=N` → minutes an escalation waits for a Slack reply before falling back to a
  best guess. Omit it and an escalation waits indefinitely.

Every question for the developer in this skill goes through
`.claude/skills/_shared/slack-escalation.md`.

## This skill is re-entrant

Engineers invoke it to start the sprint and to come back to it mid-flight. `/w-1-coding` loads
each ticket's state (`plan.md` to-dos, `local-branch.md` status, worktree) and skips what's
already done, so re-running this skill is safe. Load the same state here only to show it in the
confirmation table (step 2); don't re-ask anything already recorded in a `plan.md`, and don't ask
for a plan refresh unless the user asked for one.

## 1. Find the tickets

Skip this step entirely if explicit ticket ids were passed in `$ARGUMENTS`.

- Cloud id: `mcp__atlassian__getAccessibleAtlassianResources`.
- Project key from `ticket_pattern` (`host-runtime.md`).
- `mcp__atlassian__searchJiraIssuesUsingJql` with:

  ```
  project = <key> AND assignee = currentUser() AND sprint IN openSprints() AND status = "To Do" ORDER BY rank ASC
  ```

  Request the `key`, `summary`, `issuetype`, and `status` fields.
- If the board's first column isn't literally named `To Do`, the query returns nothing. Before
  concluding the column is empty, re-run without the `status` clause and look at what statuses
  actually come back, then retry with the real name (`To Do`, `Selected for Development`,
  `Open`, …).
- If the search returns nothing either way, stop and say so — don't widen the scope to other
  assignees, other sprints, or the backlog on your own.

## 2. Confirm the list

Show the tickets as a short table (key, type, summary, and the state loaded above: no plan /
`<ticked>/<total>` to-dos / `local-branch.md` status) and get an explicit go-ahead before running
anything, via `.claude/skills/_shared/slack-escalation.md`. There's no single `<TICKET-ID>` at
this point, so tag the message with the ticket ids in the list instead. Offer:

- **Run all** — proceed with the full list.
- **Let me pick a subset** — the reply names the ids to include.
- **Cancel**.

This gate matters: the pipeline spawns several agents that write code. A mis-scoped sprint query
is cheap to catch here and expensive to catch later. Unattended default (Slack not set up and
`PIPELINE_MODE=unattended`): don't run anything — report the list and stop.

## 3. Hand off to `/w-1-coding`

Invoke the skill once (in your host's syntax, see `.claude/skills/_shared/host-runtime.md`
§ Invoke), with every confirmed ticket and the arguments passed through verbatim:

```
/w-1-coding <TICKET-A> <TICKET-B> <TICKET-C> ... [phase] [mode] [--jobs=N] [--waitForReply=N]
```

It plans every ticket that lacks a plan here (one `Plan` agent per ticket, in parallel, with
blocking questions escalated before anything is fanned out), verifies each `plan.md` landed,
drops any ticket whose plan is missing, then runs the remaining phases: as the supervised
coordinator in this session, by launching `./scripts/pipeline/run-batch-implement.sh` in the
background, or, in `here` mode, one ticket at a time in this session.

## 4. Report back

Relay `/w-1-coding`'s report:

- The tickets in the batch and where each log lives (`.ai-workspace/pipeline-logs/<run-id>/` for a
  background run, the heartbeat `progress.log` in each worktree's plan folder for a supervised one), plus
  any ticket skipped as already at `ready-for-review` / `draft-pr-open` or already landed.
- The worktree path per ticket: `.ai-workspace/worktrees/<TICKET-ID>`.
- Any ticket dropped because planning failed, and any ticket that failed partway through the
  pipeline (which stage, and that its worktree is left in place for inspection).
- The natural next step for every ticket that completes the pipeline:
  `/w-3-land-branch <TICKET-ID>` — it pulls the branch into the main working directory, shows the
  change notes and everything decided without a human, hands over for a manual pass (including
  testing in the running app), then flips the ticket to `ready-for-push`. `/w-4-publish` comes
  after that, never directly from this skill's output (in `draft-pr` mode it turns the draft PR
  into a ready one).

If the batch was launched in the background, say plainly that results will arrive later and that
clearing the session is safe now. A supervised batch reports only once every ticket has finished;
until then, keep the session open.

# Shared: Supervised Run (the coordinator)

`supervised` mode of `/w-1-coding` and `/w-10-sprint-batch`. The main session is the
coordinator: it prepares one worktree per ticket and drives every ticket's implement,
code-review, commit and qa-check phases by spawning background subagents, in parallel across
tickets. Questions and stalled agents come back to the coordinator, which asks the developer and
resumes the agent. Nothing runs detached, so the session must stay open until the batch reports;
clearing or quitting mid-run stops it (re-running the skill resumes, since every phase is
re-entrant).

Claude Code only, interactive only: it needs the `Agent`, `SendMessage`, `TaskStop` and `Monitor`
tools (load the last three with `ToolSearch` if they are deferred). On any other host, or under
`PIPELINE_MODE=unattended`, `supervised` is not available; `SKILL.md` says what runs instead.

Subagents cannot spawn subagents, so the coordinator runs the review and QA loops itself and
spawns each role directly. The phase files stay the source of truth for every step and prompt;
this doc only says who runs what.

## Roles

As `host-runtime.md` § Delegation roles, all with `subagent_type: "general-purpose"` and
`run_in_background: true`:

| Role | Model | Runs |
|---|---|---|
| implementer | `sonnet` | `phases/implement.md`, `phases/commit.md` |
| checker | `sonnet` | the linter seat of `review-panel.md`, read-only |
| reviewer | `opus` | every other seat of `review-panel.md`, read-only |
| fixer | `sonnet` | `phases/code-review.md` § 3d, `phases/qa-check.md` § 4c |
| qa | `opus` | the functional and regression testers of `qa-testers.md` |

## 1. Prepare

From the repo root, for each ticket in rank order, up to `--jobs` (default and max `MAX_SLOTS`
in `scripts/pipeline/lib.sh`) at a time; the rest wait until a running ticket finishes:

```bash
./scripts/pipeline/prepare-worktree.sh <TICKET-ID> supervised [<waitForReply minutes>]
```

It prints `SLOT=`, `WORKTREE=` and `CONTAINER_WORKDIR=`, and writes
`<WORKTREE>/.ai-workspace/pipeline.env`. Non-zero exit with "No pipeline slot available" → queue
the ticket and retry when a slot frees up; any other failure → the ticket fails at `prepare`.

The heartbeat file is `<WORKTREE>/.ai-workspace/jira-plans/<TICKET-ID>/progress.log`. Before
spawning each agent, append `<UTC time> coordinator: start <stage>` to it.

So the skills dashboard shows the run like a background one, create
`.ai-workspace/pipeline-logs/<run-id>/` once (`run-id` is `date -u +%Y%m%dT%H%M%SZ`), symlink
each ticket's heartbeat file there as `<TICKET-ID>.log`, and append the pipeline's progress lines
to its `progress.log` as stages move: `[<TICKET-ID>] <stage>: in progress`, `... : done`,
`... : FAILED (<reason>)`, `[<TICKET-ID>] FAILED at <stage>`, `[<TICKET-ID>] all requested stages
complete`.

Arm the stall watchdog once all tickets are prepared, and re-arm it on each expiry while any
ticket is still running. `scripts/pipeline` exists only in the main checkout, so the command
always `cd`s there first (a Monitor started from a worktree otherwise exits 127):

```
Monitor(command: "cd <main checkout> && ./scripts/pipeline/watch-stalls.sh 20 <TICKET-ID> ...",
        description: "supervised run stalls", timeout_ms: 1800000)
```

On macOS, also start `caffeinate -i` with `run_in_background` so idle sleep can't suspend the
agents, and `TaskStop` it in § 6.

## 2. The agent preamble

Every agent prompt starts with this block, filled in:

> You are one stage of a supervised pipeline run for `<TICKET-ID>`, started by the coordinator
> session.
>
> - Work only in the worktree `<WORKTREE>`. Read, Edit and Write with absolute paths under it;
>   never change the main checkout `<REPO_ROOT>`.
> - Start every Bash command with `cd <WORKTREE> && source .ai-workspace/pipeline.env && `. It
>   sets `PIPELINE_MODE=supervised`, `PIPELINE_CONTAINER_WORKDIR`, `TEST_ENV_NUMBER` and
>   `PIPELINE_REPO_ROOT`.
> - Under `PIPELINE_MODE=supervised`, follow every rule the skill files give for
>   `PIPELINE_MODE=unattended`, except the asking: never post to Slack, never sleep or poll for
>   a reply, never run `release-slot.sh` / `reclaim-slot.sh`. When the skill says to ask the
>   developer, stop and end your final message with:
>   ```
>   NEEDS-INPUT
>   question: <one question, answerable without opening the ticket>
>   options: 1. <...> 2. <...>
>   best guess: <what you would do without an answer>
>   ```
>   The coordinator resumes you with the answer.
> - Heartbeat: after each to-do item, each check run, and before any command that can take more
>   than 5 minutes, append `$(date -u +%FT%TZ) <stage>: <what just happened>` to
>   `.ai-workspace/jira-plans/<TICKET-ID>/progress.log`.
> - Run every check in the foreground (`.claude/skills/_shared/run-checks.md`).
> - Your final message is at most 15 lines: outcome, files touched, checks run and their result,
>   anything the coordinator must act on. Detail belongs in the artifacts the phase names.

Never paste a diff or a whole file into a prompt; agents read them from the worktree.

## 3. Per ticket

Stages run in order. "Check" is what the coordinator verifies on disk before moving on, the same
checks `scripts/pipeline/run-ticket-pipeline.sh` makes. A failed check, or an agent that reports
it could not finish, gets one fresh attempt of the same stage (phases are re-entrant); a second
failure fails the ticket at that stage.

1. **implement** (implementer): preamble + "Follow `.claude/skills/w-1-coding/phases/implement.md`
   for `<TICKET-ID>`." Check: the worktree is not clean (the pathspec in `run-checks.md`) and
   `plan.md` has at least one `- [x]`.
2. **code-review**: run `phases/code-review.md` yourself as its conductor, with these
   differences:
   - Pick the seats (§ 2) yourself, reading the diff in the worktree. Each seat's prompt:
     preamble + its `review-panel.md` prompt with § 2's environment block, spawned with its role
     from the table above.
   - Fixer prompt: preamble + the § 3d prompt with the findings triaged **fix**.
   - Triage (§ 3b), the round count and the § 3c spiral check are yours; read code in the
     worktree to triage. Raise follow-up bugs yourself per `raise-follow-up-bug.md`, and write
     § 4's entry into `<WORKTREE>/.ai-workspace/jira-plans/<TICKET-ID>/code-review.md`. Cap or
     spiral → the § 5 **unattended** branch: one more fixer pass, then `status:
     needs-manual-review`; do not ask the developer.
   - Check: `code-review.md` exists.
3. **commit** (implementer): preamble + "Follow `.claude/skills/w-1-coding/phases/commit.md` for
   `<TICKET-ID>`." Check: `local-branch.md` exists with `status: ready-for-review`.
4. **qa-check**: run `phases/qa-check.md` yourself as its conductor, with these differences:
   - One ticket at a time: start only when `./scripts/pipeline/stack.sh info 3` (from the main
     checkout) shows no lock or this ticket's lock. Otherwise log
     `[<TICKET-ID>] qa-check: queued (QA stack held by <owner>)` and start it when the holder
     finishes, in rank order.
   - Do § 1 and § 2 (pick the testers) yourself. No tester → write `qa-check.md` as § 2 says
     and move on. Browser picked → § 3 from the main checkout, syncing the worktree:
     `"$S" sync 3 <WORKTREE>`; both testers' driver is Playwright; hold the lock until the
     artifact is written, and unlock on every outcome.
   - Spawn the picked testers in one message: preamble + the § 4a prompt for each.
     `<shots dir>` is under `<WORKTREE>/.ai-workspace/qa-shots/round-<n>/`.
   - Triage (§ 4b) is yours. **fix** findings → fixer: preamble + the § 4c prompt. Round 2:
     re-sync the stack, then `SendMessage` each tester the triage and the fixer's report: "re-test
     as round 2 says". Round cap is § 4c's; past it → the § 6 **unattended** branch.
   - Raise follow-up bugs, write the screenshots folder and
     `<WORKTREE>/.ai-workspace/jira-plans/<TICKET-ID>/qa-check.md` yourself as § 5 says, then
     unlock the QA stack.
   - Check: `qa-check.md` exists. `code_changed: yes` → stages 2 and 3 once more, never a second
     qa-check.
5. **finish**: `./scripts/pipeline/finish-ticket.sh <TICKET-ID>` (copies the artifacts back,
   releases the slot), then append `FINISHED <ok | failed at <stage>>` to the heartbeat file and
   write `0` or `1` to `.ai-workspace/pipeline-logs/<run-id>/<TICKET-ID>.status`.
   Run it on failure too; the worktree stays for inspection. Start the next queued ticket.
6. **revive**: when the developer asks to re-run a failed stage after the ticket finished, run
   that stage and the ones after it as above, log `[<TICKET-ID>] <stage>: retry (revived)`,
   copy the artifacts back to the main checkout, and on success append `<stage>: done` and
   `all requested stages complete` to the run's `progress.log` and rewrite `<TICKET-ID>.status`
   to `0`, so the dashboard stops showing the old failure.

## 4. Questions

An agent's final message ending in a `NEEDS-INPUT` block is a question for the developer, not a
failure. Ask it as `.claude/skills/_shared/slack-escalation.md` says for an interactive session
(Slack when set up, otherwise directly in the session; the dashboard either way), tagged with the
ticket id. Several open at once → one batched question. Then `SendMessage` the same agent with
the answer verbatim and log it as slack-escalation step 5 says. With `--waitForReply=N` and no
answer within N minutes, resume the agent with "no reply within N minutes — proceed with your
best guess" and log that.

Other tickets keep running while a question is open; their notifications wait for the answer.

## 5. Stalls

A `STALE <TICKET-ID> <n>m | <last line>` event from the watchdog:

- Otherwise `SendMessage` the ticket's running agent: "No heartbeat for <n> minutes. Append a
  heartbeat line with your status, then continue." It reads it at its next tool call.
- No new heartbeat 10 minutes after that → `TaskStop` the agent and spawn the same stage afresh
  (it counts as the stage's one retry). A second stall in the same stage fails the ticket at
  that stage; tell the developer what the last heartbeat said.

## 6. Report

When every ticket has finished, report as `w-1-coding/SKILL.md` § 5 does for a background run,
plus per ticket: the stages run, retries and stalls, every question asked and its answer, and
the worktree path. Next step for each finished ticket: `/w-3-land-branch <TICKET-ID>`.
Stop the `caffeinate` task.

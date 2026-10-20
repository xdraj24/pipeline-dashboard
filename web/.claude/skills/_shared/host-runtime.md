# Shared: Host Runtime (Claude Code, Codex CLI, Cursor CLI, anything else)

The `w-*` skills are plain instructions in the Agent Skills format. They run unchanged in Claude
Code, Codex CLI and Cursor CLI; any other agent can open a `SKILL.md` and follow it. Everything
host-specific is described here, once, and the skills refer to the concepts below by name.

`.claude/skills/`, `.agents/`, `.codex/`, `scripts/pipeline/`, `docs/second-dev-stack.md` and
`.mcp.json` are not part of the web repo. They live in the `pipeline-dashboard` repo (next to the
web checkout) and are absolute symlinks into it, created by its `bin/link-web.sh` (`/w-setup` runs
it). `AGENTS.md` is a local file that `/w-setup` creates or enriches from that repo's root
`AGENTS.md`. `link-web.sh` lists all of them, and the skills' local state (`.jira-plans/`,
`.pr-reviews/`, `.claude/pipeline-*`, `.claude/worktrees/`), in the web clone's
`.git/info/exclude`, so they never show in `git status` and never reach the web remote.
Edit skills in place; commit and push them from the pipeline-dashboard repo.

## Where each host finds things

| | Claude Code | Codex CLI | Cursor CLI |
|---|---|---|---|
| Skills | `.claude/skills/` (canonical) | `.agents/skills` → symlink to `.claude/skills` | reads `.claude/skills/` and `.agents/skills/` directly |
| Repo conventions | `CLAUDE.md` files | `AGENTS.md`, which points at the `CLAUDE.md` files; the skills also name them explicitly | `CLAUDE.md` files named by the skills |
| MCP servers (JIRA, Slack) | `.mcp.json` + `.claude/settings.local.json` | `.codex/config.toml` (loaded once the project is trusted) | `.cursor/mcp.json` → symlink to `.mcp.json` |
| Delegation roles | built-in `Agent` tool | `.codex/agents/w-*.toml` | none; same-session fallback |
| Headless CLI (pipeline) | `claude -p` | `codex exec` | `agent -p` |

One-time setup per developer machine: `SLACK_BOT_TOKEN` exported in the shell (see
`slack-escalation.md` § Setup); `./scripts/pipeline/check-host.sh <claude|codex|cursor>` reports
anything missing for that host. On Codex, if the Slack server fails to authenticate even though
the token is exported, `${SLACK_BOT_TOKEN}` expansion in `.codex/config.toml` is the suspect:
register the server with `codex mcp add` (which writes `~/.codex/config.toml`) and pass the token
there.

## Concepts the skills use

### `$ARGUMENTS`

Everything after the skill name in the message that invoked the skill. Claude Code substitutes
the token before you see it; on every other host read the invoking message yourself. Empty when
nothing followed the skill name.

### "Invoke `/w-x <args>`"

Run that skill with those arguments, in this session, and continue with its report:

- Claude Code and Cursor: type it as written, `/w-x <args>`.
- Codex: `$w-x <args>`.
- A host with no skill invocation: open `.claude/skills/w-x/SKILL.md` and follow it with those
  arguments as its `$ARGUMENTS`.

When you report a next step to the developer, write it in your host's own syntax.

### "Ask the developer"

Always via `slack-escalation.md`. When that doc says to ask directly in the session, Claude Code
uses its structured multi-choice question tool; every other host asks the same questions in one
plain message with the options numbered. Batch related questions; never drip-feed them.

### `mcp__atlassian__<tool>` and `mcp__slack__<tool>`

Claude Code's names for the Atlassian and Slack MCP servers' tools. Other hosts expose the same
servers under their own naming (Codex and Cursor usually drop the `mcp__<server>__` prefix). Treat
each name as "the described operation on that server", not as a literal string.

### "Deferred tools"

Claude Code hides some MCP tools until loaded with `ToolSearch`. Other hosts list every tool
directly; skip the loading step.

### "Scratch directory"

Claude Code provides a per-session scratchpad directory. Elsewhere use `mktemp -d` and report the
path.

### "Clear the session"

`/clear` in Claude Code, `/new` in Codex, a new chat in Cursor. Skills say this is safe only after
work has been detached into the pipeline.

### Long waits

`slack-escalation.md` sleeps nine minutes between unattended polls (`sleep 540`), with Claude
Code's shell tool timeout raised to 600000 ms. If your host's shell tool cannot run a command that
long, loop `sleep 60` nine times instead; the point is to poll rarely so a long wait doesn't
exhaust the stage's turn budget.

### Browser automation

Only Claude Code has the `claude-in-chrome` tools, and only in an interactive session (a
headless pipeline stage has neither the extension nor the tools on its allow-list).
`w-7-attach-pr-visuals` and the `w-1-coding` qa-check phase say what every other case does
instead (Playwright against the local dev server, with the repo's own login setup).

## Delegation roles

Several skills get an independent second model, or parallelism, by delegating a prompt to a named
role. The prompt is always written out in the skill; the role only says how to run it.

| Role | Used by | Claude Code | Codex | Purpose |
|---|---|---|---|---|
| planner | `w-1-coding` plan phase | `Agent`, `subagent_type: "Plan"`, `model: "opus"`; one per ticket in the same message | spawn `w-planner`, one per ticket, in parallel | strong model, read-only |
| reviewer | `w-1-coding` code-review phase, `w-21-review-prs` | `Agent`, `subagent_type: "general-purpose"`, `model: "opus"` | spawn `w-reviewer` | strong model, never the one that wrote or fixes the code |
| fixer | `w-1-coding` code-review and qa-check phases | `Agent`, `subagent_type: "general-purpose"`, `model: "sonnet"` | spawn `w-fixer` | fast model, writes code |
| qa | `w-1-coding` qa-check phase | `Agent`, `subagent_type: "general-purpose"`, `model: "opus"` | spawn `w-qa` | strong model, staff-level QA; runs tests, probes and the browser pass, never fixes |
| verifier | `w-22-verify-review-comments` | `Agent`, `subagent_type: "general-purpose"`, `model: "sonnet"` | spawn `w-verifier` | a different model from the reviewer |

Rules for every host that can delegate:

- Wait for the result before continuing (Claude Code: `run_in_background: false`); the skill
  needs it in the same turn.
- "In parallel" means all spawns in one message / one turn.
- Report which model actually ran each role; write `unknown` if the host doesn't say.
- Codex: the roles ship with `model` unset, so they inherit the session model. The two-model
  review loop is only independent if `.codex/agents/w-reviewer.toml` and `w-fixer.toml` pin
  different models. Until they do, say in the report that reviewer and fixer were the same model.

Hosts without delegation (Cursor CLI today, or any plain agent): do the role's prompt yourself in
the same session, as your own instructions. You lose the independence of a second model, so treat
the result as a single, non-adversarial pass and say so in the report.

Agent Teams are deliberately not used: Claude Code's experimental teams can't be spawned from
`claude -p` (how every pipeline stage runs), in-process teammates don't survive the session ending
(the pipeline is built to survive clearing and quitting), and the review/fix loop is sequential,
which the teams docs call an anti-pattern. Subagents cover the fan-out cases; the bash pipeline
covers the detached ones. Reviewed 2026-10-10.

## The unattended pipeline per host

`scripts/pipeline/run-batch-implement.sh` (launched by the `background` and `draft-pr` modes of
`/w-1-coding` and `/w-10-sprint-batch`) runs every stage as a fresh headless process of the host
CLI, selected by `--agent=<host>` or `PIPELINE_AGENT` (`claude`, the default, `codex` or
`cursor`). The exact command per host lives in `scripts/pipeline/lib.sh` (`run_agent_headless`);
the prompt is the stage's skill invocation in that host's syntax (`skill_invocation`).

What differs per host:

- `PIPELINE_MAX_TURNS` and `PIPELINE_MAX_BUDGET_USD` cap Claude Code stages only; Codex and Cursor
  have no equivalent, so a runaway stage there ends only when the model stops.
- "Unknown command" detection (a stage whose skill didn't resolve) exists for Claude Code only.
  On every host, stage success is judged by the artifacts each phase leaves behind (ticked
  to-dos, `code-review.md`, `local-branch.md`, `qa-check.md`), never by the CLI's output.
- Every host runs the stage with approvals off and no sandbox: stages `docker exec` into the dev
  containers and, with `--draft-pr`, `git push`, which a sandbox blocks.

Any other host has no pipeline: run `/w-1-coding <TICKET-ID> here`, one ticket at a time, in the
same session. The Slack-escalation slot release/reclaim steps run inside the headless process
through its shell tool and work the same way on every host.

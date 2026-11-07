# Shared: Asking the Developer (Slack Escalation)

Every `w-*` skill routes every question it has for the developer through this doc: blocking
business questions, "which branch?" pickers, "tested it?" gates, confirmation before posting to
GitHub or editing a JIRA ticket, all of it. One channel, not two. The only difference between
callers is what they do when nobody answers (see the calling skill's own step for its default).

## Supervised agents don't ask

Under `PIPELINE_MODE=supervised` you are a subagent of a coordinator session
(`supervised-run.md`). Skip everything below: post nothing to Slack or the dashboard, don't poll,
don't touch slots. Stop and end your final message with the `NEEDS-INPUT` block from
`supervised-run.md` § 2. The coordinator asks the developer through this doc's interactive path
and resumes you with the answer.

## Is Slack set up?

Slack is set up when both hold:

- the `slack` MCP server is configured for your host (see Setup below), and
- its tools are available to you in this session: `slack_post_message` and
  `slack_get_thread_replies` (Claude Code lists them as `mcp__slack__…` and may need them loaded
  first; see `host-runtime.md` § Deferred tools).

Check once per session. If a Slack call fails once (bad token, bot not in the channel), treat
Slack as not set up for the rest of the session rather than retrying.

Then:

- **Set up** → post the question in Slack (Procedure below), in every mode. A developer sitting at
  the terminal is still free to answer in the Slack thread.
- **Not set up, interactive** (no `PIPELINE_MODE`) → ask the developer directly in the session
  with the same wording and the same options, in one message (`host-runtime.md` § Ask the
  developer). Skip the slot handling and polling below.
- **Not set up, unattended** (`PIPELINE_MODE=unattended`, set by
  `scripts/pipeline/run-ticket-pipeline.sh`) → nobody can answer. Take the calling skill's
  documented best-guess default immediately and log it (step 5) as
  `"Slack not configured — proceeded with: <best guess>"`. If the calling skill has no safe
  default for that question, stop the phase and report the question as the reason.

## The dashboard channel (always, alongside Slack)

The local skills dashboard (the `pipeline-dashboard` repo, see its README; `node server.ts`
serves it at http://localhost:4848) is a second place the developer answers from. Every question
goes there too, whether or not Slack is set up, in every mode. It is file-based, so it works when
the server is down: the question waits as a JSON file under `<dashboard>/data/questions/` until
the page is opened.

Each w-* skill folder (and `_shared`) is a symlink into that repo, so the dashboard folder is
found through one of them, from the main checkout or a worktree alike:

```bash
DASH="$(cd -P "$(git rev-parse --show-toplevel)/.claude/skills/_shared/../../../.." && pwd)"
```

Skip the channel silently if `$DASH/bin/ask.sh` does not exist.

- **Post**, right after (or instead of) the Slack post:
  ```bash
  QID="$("$DASH/bin/ask.sh" --ticket <TICKET-ID> --phase <plan|implement|code-review|commit|qa-check|...> \
    --question "<the same wording as the Slack message>" --option "<option 1>" --option "<option 2>" \
    [--label "<subject when there is no ticket>"] [--slack-ts <ts from step 1>] --no-wait)"
  ```
  `--option` is repeatable and optional; free-text answers are always possible.
- **Poll** both channels in the same loop as step 3: each iteration, after the Slack check, run
  `"$DASH/bin/answer.sh" "$QID"` — it prints the answer and exits 0 once
  the developer answered on the page, exits 1 while open. First answer from either channel wins.
- **Close the loop**: when the answer came from Slack, record it on the dashboard so the question
  stops showing as open: `"$DASH/bin/mark-answered.sh" "$QID" "<answer>" slack`.
  When it came from the dashboard and Slack is set up, reply in the Slack thread with one line
  ("answered on the dashboard: <answer>"). On timeout, mark it with the fallback text and `timeout`
  as the third argument.
- **Interactive, no Slack**: still post with `--no-wait`, then ask in the session as before; the
  developer may answer in either place. Mark the dashboard question answered with whichever answer
  you act on (`mark-answered.sh "$QID" "<answer>" session`).

## Setup (one-time, per developer machine)

- A Slack MCP server (`@zencoderai/slack-mcp-server`) is wired up as the `slack` server,
  alongside the `atlassian` entry it mirrors, once per host: `.mcp.json` (Claude Code),
  `.codex/config.toml` (Codex), `.cursor/mcp.json` (Cursor, a symlink to `.mcp.json`).
- It needs a bot token with `chat:write` and `channels:history` scopes (also `channels:read` so
  the server can resolve the channel), invited into workspace `T0BNQS0TX40`, channel
  `C0BMYDZLVND` (`/invite @your-bot-name` in that channel).
- Supply the token via a **local, gitignored** environment variable named `SLACK_BOT_TOKEN`
  (e.g. export it from your shell profile, or a root `.env` — `.env*` is already gitignored in
  this repo). **Never** hardcode it in a config file or commit it anywhere — every host config
  references it as `${SLACK_BOT_TOKEN}`, expanded from your environment at startup.
- Claude Code additionally needs `.claude/settings.local.json` to enable the `slack` server
  (`enabledMcpjsonServers`) alongside `atlassian`. `./scripts/pipeline/check-host.sh <host>`
  verifies the setup for a given host.

## Procedure

Call this once you've already decided (using judgment — see the calling skill's own step) that a
question genuinely needs a human, not just a note in a file.

### 1. Post the question

Call `slack_post_message` targeting channel `C0BMYDZLVND`. The message must include:

- The ticket id (`<TICKET-ID>`), or — for a gate that isn't tied to one ticket, like
  `w-10-sprint-batch`'s scope confirmation or a PR-number picker — a short label identifying the
  subject (the ticket ids, the PR number, the branch).
- The specific question, in plain terms — enough for someone with no other context to answer
  without opening the ticket or the terminal.
- If the answer is naturally discrete (e.g. "fix it now vs. proceed as-is", a list of branches),
  list the options explicitly, numbered, so the reply can be a short pick rather than free text.

Save the returned message timestamp (`ts`) — that's the thread root you'll poll for replies.

### 2. Release this run's pipeline slot (unattended pipeline only)

Skip this step if `PIPELINE_REPO_ROOT` isn't set — that means you're running interactively, not
inside the pipeline, and no slot was claimed in the first place.

Polling is idle waiting, not Docker/DB work, so give up the slot while you wait:

```bash
"$PIPELINE_REPO_ROOT/scripts/pipeline/release-slot.sh" "$PIPELINE_REPO_ROOT" "<TICKET-ID>"
```

(`PIPELINE_REPO_ROOT` is exported by the coordinator script — it's the absolute path to the main
repo root, valid from inside the worktree.)

### 3. Poll for a reply

Loop, calling `slack_get_thread_replies` with the channel and the thread `ts` from step 1. A
reply exists once the thread has more than one message. The sleep between checks is a plain
shell call, no MCP call needed for it:

- **Interactive** (no `PIPELINE_MODE`): `sleep 25` between checks — the developer is around.
- **Unattended (`PIPELINE_MODE=unattended`)**: `sleep 540` (Claude Code: with the shell tool's
  `timeout` set to `600000`; a host whose shell tool can't run that long loops `sleep 60` nine
  times, see `host-runtime.md` § Long waits), so one wait plus one poll costs two tool calls per
  nine minutes. A Claude Code stage runs under a `--max-turns` cap (300 by default); at
  25-second polls a 120-minute wait would spend the whole cap on polling and end the stage
  silently before anyone replies.

Then the wait limit:

- **Interactive, `WAIT_FOR_REPLY_MINUTES` unset** (no `--waitForReply=N` was passed): keep
  polling until a reply arrives.
- **Unattended, unset**: use 120 minutes.
- **Set**: that many minutes. Track elapsed wall-clock time yourself (`date -u +%s` once before
  the loop, compare each iteration). Once the limit is exceeded, stop polling and fall back to the
  calling skill's best-guess default.

### 4. Re-claim a pipeline slot (unattended pipeline only)

Skip this step too when `PIPELINE_REPO_ROOT` isn't set.

Whether a reply arrived or the timeout fired, real work is about to resume — reclaim a slot before
doing anything else (this retries/waits if every slot is currently busy, rather than failing):

```bash
"$PIPELINE_REPO_ROOT/scripts/pipeline/reclaim-slot.sh" "$PIPELINE_REPO_ROOT" "<TICKET-ID>"
```

Note the slot number it prints may differ from the one you started with — that's fine, nothing
downstream depends on the specific number.

### 5. Log the outcome

Whatever the route (Slack reply, direct answer, timeout or no-Slack best guess), log it where the
calling skill says to — for `w-1-coding` that's `plan.md`'s "Risks / Open questions" (plan phase)
and `change-notes.md`'s "Assumptions" (every later phase); other skills log it in their final
report. Always include the question asked, and either the human's answer verbatim or
`"no reply within <N> minutes — proceeded with: <your best guess>"` /
`"Slack not configured — proceeded with: <your best guess>"`.

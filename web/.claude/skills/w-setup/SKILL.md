---
name: w-setup
description: Set up the w-* AI dev workflow on a laptop - full setup, or picked components - link the skills from the pipeline-dashboard repo into web, the pipeline dashboard, Slack escalation, stack 2 for PR reviews, stack 3 for AI QA - installing what is missing on the way. Use once per machine, or to add or redo a component.
argument-hint: "[web-dir] [full|skills|dashboard|slack|stack2|stack3 ...] | instructions [repo-dir]"
model: sonnet
effort: medium
---

# Set Up the AI Dev Workflow

A project skill, linked into the web checkout's `.claude/skills/` like the other w-* skills. On a
new machine it becomes available after the bootstrap in the pipeline-dashboard README (clone that
repo next to web, run its `bin/link-web.sh`); re-running it later is safe.

Arguments: `$ARGUMENTS` — optional.
- A path → the web checkout (default: ask, suggesting `~/coding/web`).
- `full`, or any of `skills`, `dashboard`, `slack`, `stack2`, `stack3` → those components, without
  the step 0 question.
- `instructions [repo-dir]` → run only step 3b against that repository (default: the current
  one), for any repo, not only web. Needs the pipeline-dashboard clone; ask for its path if it is
  not next to the repo.

Ask every question with the structured question tool, batched. Never ask for a secret in the
chat (JIRA token, Slack bot token, passwords): tell the developer which file or shell profile to
put it in, and check only that it is set (`[ -n "$VAR" ]`, `grep -q '^KEY=.\+'`), never its value.

Say what you are doing before each step; several take minutes.

## 0. Choose what to set up

Unless the arguments already name components, ask first, before checking or installing anything:

1. "Full setup, or pick components?" — options: **Full setup** (all five below) / **Pick
   components**.
2. On **Pick components**, one multi-select question:
   - **Link skills** — pipeline-dashboard clone, w-* skills linked into web, `CLAUDE.md` /
     `AGENTS.md` (steps 2, 3, 3b)
   - **Pipeline dashboard** — http://localhost:4848 (step 4)
   - **Slack escalation** (step 5)
   - **Stack 2 for PR reviews** — `../web-2nd`, `/w-24-land-branch-for-review` (step 6)
   - **Stack 3 for AI QA** — `../web-3rd`, the qa-check browser pass (step 7)

Every component needs the web checkout and the pipeline-dashboard clone, so steps 2 and 3's
locating part (paths, `DASH`) always run. When **Link skills** is not picked but the skills are
not linked yet (`.claude/skills/_shared` is not a symlink into `$DASH`), say the other components
depend on it and add it. Run only the chosen steps, in order, and skip the rest silently.

## 1. Tools

Check only what the chosen components need: git and the GitHub CLI always; Node for the
dashboard and stack 3 (Playwright); Docker for either stack; jq for the dashboard and Slack.

Collect what is missing:

| Tool | Check | Install (macOS) |
|---|---|---|
| git | `git --version` | `xcode-select --install` |
| Homebrew | `brew --version` | https://brew.sh (the developer runs the installer) |
| GitHub CLI, logged in | `gh auth status` | `brew install gh`, then `gh auth login` (interactive: `! gh auth login`) |
| Node 22.18+ | `node -v` | `brew install node@22` |
| Docker Desktop, running | `docker info` | `brew install --cask docker`, then start it |
| jq | `jq --version` | `brew install jq` |
| Claude Code | `claude --version` | already here if this skill runs |

Show the missing list with the install commands and ask once whether to run them. Run the
`brew` ones on yes; the developer runs anything interactive (`gh auth login`, Docker's first
start) with the `!` prefix. Re-check before continuing; stop on anything still missing.

## 2. Web checkout

- The path from the argument or the answer. Exists with `docker-compose.yml` → use it.
- `<web>/.env` must define `ticket_pattern`, `jira_browse`, `release_branch_pattern`, and
  `dev_docker_image` (`host-runtime.md`). For each key missing from `.env`, append that line from
  `<web>/.env.example`. If the example lacks it too, ask the developer and append the line.
  Confirm each with `grep -q "^<key>=." "<web>/.env"`. Do not print other `.env` lines.
- Missing → offer `git clone git@github.com:welligence/web.git <path>`. Running the main stack
  (`make init`, which needs the team's `.env` and the STG dump) is the web README's job: point at
  it, do not improvise it.
- `PARENT="$(dirname <web>)"`.

## 3. Pipeline repo

- `$PARENT/pipeline-dashboard` exists → `git -C … pull --ff-only`. Otherwise
  `gh repo clone xdraj24/pipeline-dashboard "$PARENT/pipeline-dashboard"`.
- `DASH="$PARENT/pipeline-dashboard"`.

The rest of this step and step 3b run for **Link skills** only:

- A leftover personal copy from older setups duplicates this skill: if `~/.claude/skills/w-setup`
  exists, remove it (`rm -rf`, after saying so).
- `"$DASH/bin/link-web.sh" <web>` — links each w-* skill into `.claude/skills/` (a real folder,
  so skills committed to web stay), plus `.codex`, `.mcp.json`, `scripts/pipeline`,
  `docs/second-dev-stack.md` and `.agents/skills`, and adds them, `AGENTS.md` and the `.ai-workspace/` state folder to `.git/info/exclude`. Show its
  output. A `skip` line means web tracks a file at that path; web's version stays, say so.
- `git -C <web> status --short` must not list any of those paths.

## 3b. CLAUDE.md and AGENTS.md

`$DASH/CLAUDE.md` and `$DASH/AGENTS.md` hold the repo-agnostic conventions. For each of the two,
at the root of the target repository (`<web>`, or the `instructions` argument):

- **Missing** → copy it from `$DASH`.
- **A symlink** (some repos point `AGENTS.md` at `CLAUDE.md`) → leave it alone and say so.
- **Present** → enrich it: go through the template rule by rule and add only what the local file
  does not already say in substance (wording differs, meaning matches → covered). Put each
  addition in the local file's matching section, or a new section in the template's words. Never
  remove, reword or reorder local content. Where a local rule contradicts the template, the local
  rule stays; list the contradiction in the report. Nothing missing → leave the file untouched.

Before writing an enriched file, show the additions as a diff. When the file is tracked in that
repository (`git ls-files --error-unmatch <file>` succeeds), say that the change will appear in
`git status` there for the developer to commit or revert, and ask before writing. Untracked files
are written straight away.

## 4. Dashboard

- Claude Code project settings: create or merge `<web>/.claude/settings.local.json` so
  `enabledMcpjsonServers` contains `"atlassian"` (with `jq`, keeping every other key).
- JIRA REST credentials are optional. They drive the board's JIRA status and the attachment
  helper (`_shared/host-runtime.md` § JIRA attachments). Without them, skills cannot read or
  upload ticket screenshots and PDFs. Offer it: `cp "$DASH/.env.example" "$DASH/.env"` if
  missing, then the developer fills `JIRA_EMAIL` and `JIRA_API_TOKEN` there themselves (token:
  https://id.atlassian.com/manage-profile/security/api-tokens). Check with `grep -q
  '^JIRA_API_TOKEN=.\+' "$DASH/.env"`.
- If the web checkout is not `$PARENT/web`, add `WEB_REPO_ROOT=<web>` to `$DASH/.env`.
- Start it: `"$DASH/bin/up.sh"`. It prints the URL and opens http://localhost:4848.
- Ask: "The dashboard is open at http://localhost:4848. Does the board load and show your
  tickets?" Options: works / broken (describe). Broken → read the last 30 lines of
  `$DASH/data/server.log`, fix what is local (wrong `WEB_REPO_ROOT`, old node, port taken:
  `up.sh stop`), retry once, then report and stop.
- The developer restarts Claude Code in the web checkout afterwards so the linked skills load.

## 5. Slack escalation

Explain first, in one short message, what it does: unattended pipeline runs post their questions to channel `C0BMYDZLVND` and wait for a
thread reply; without it they take their documented default. Then guide, one step at a time,
confirming each:

1. A Slack bot token from the team's bot (or a new Slack app in workspace `T0BNQS0TX40`) with
   scopes `chat:write`, `channels:history`, `channels:read`.
2. Invite the bot into the channel: `/invite @<bot-name>` there.
3. The developer adds `export SLACK_BOT_TOKEN=…` to `~/.zshrc` themselves and opens a new
   shell. Check from a new login shell: `zsh -lc '[ -n "$SLACK_BOT_TOKEN" ] && echo set'`.
4. Add `"slack"` to `enabledMcpjsonServers` in `<web>/.claude/settings.local.json`.
5. `<web>/scripts/pipeline/check-host.sh claude`. Show any `PROBLEM:` lines.
6. After the developer restarts Claude Code: offer one test post to the channel ("w-setup test
   from <git user.name>") with `mcp__slack__slack_post_message`; post only on yes.

The full reference is `.claude/skills/_shared/slack-escalation.md` § Setup.

## 6. Second web stack (PR review)

Used by `/w-24-land-branch-for-review`: `../web-2nd`, compose project `web2`,
http://127.0.0.1:4000. Before starting, say:

- Docker Desktop needs at least 16 GB of memory for two stacks (measured, see
  `docs/second-dev-stack.md`); check Settings → Resources.
- The DB restore copies the STG dump (about 49 GB) and takes a long time.

Then, from the web checkout, with `S=<web>/scripts/pipeline/stack.sh`:

1. `"$S" setup 2` — clones `../web-2nd` if missing and writes its untracked config (`.env`
   copied from the main checkout plus the stack block, `docker-compose.override.yml`, the dump
   cloned from the main checkout). The ports it prints must be exactly 4031/4000/4035/5433/6380.
   No `.env` or no dump in the main checkout → say what is missing (`make syncdb` there fetches
   the dump, with AWS access) and skip this step.
2. `"$S" restore 2` in the background; poll for it to finish. It ends with `errors ignored on
   restore: 5`, which is expected; any other `pg_restore: error` line is real: show it.
3. `"$S" up 2` (first start installs node modules: up to 15 minutes). It creates the
   cluster-wide Postgres roles the dump lacks before migrating.
4. `"$S" seed 2` — creates or refreshes the E2E users (`admin_end_to_end@welligence.com` and
   others, password from `backend/db/seeds/playwright_config.rb`).
5. Ask the developer to open http://127.0.0.1:4000 (not `localhost:4000`), log in with their own
   account or the E2E user, and confirm it works.

## 7. Third web stack (QA)

Used by the qa-check phase of `/w-1-coding` for its browser pass, from the main checkout and from
pipeline worktrees: `../web-3rd`, compose project `web3`, http://qa.localhost:5100. Before starting, say that three stacks need more Docker memory
than two (my estimate: at least 24 GB, not measured) and another full DB restore.

Same as step 6 with `3` instead of `2` (ports 5131/5100/5135/5434/6381), then:

- Test login: seed the main stack too
  (`docker exec -w /app/backend web-web-1 bundle exec rails runner db/seeds/playwright_config.rb`),
  and when `<web>/playwright.env.local.json` does not exist, write it with `baseUrl`
  `http://localhost:3000`, `baseUser` `admin_end_to_end@welligence.com` and `basePassword` the
  seed's `DEFAULT_PASSWORD` (it is gitignored). Never overwrite an existing one.
- Playwright for unattended QA and `/w-7-attach-pr-visuals`:
  `cd "$DASH/tools/playwright" && npm install && npx playwright install chromium`, then check it
  end to end: write `tmp/smoke.spec.ts` that calls `login(page)` from `../login.ts` and expects
  the home page greeting, run it with `WEB_REPO_ROOT=<web> BASE_URL=http://qa.localhost:5100 npx
  playwright test tmp/smoke.spec.ts`, then delete it.
- Ask the developer to open http://qa.localhost:5100 in Chrome, log in and confirm it works. Each stack has its own host, so all three can stay logged in
  with different accounts in one browser.

## 8. Report

One short block: tools installed, web checkout and pipeline repo paths, what step 3b did to
`CLAUDE.md` and `AGENTS.md` (copied, enriched with which rules, untouched, contradictions), dashboard URL and the
developer's check, and per component: done / not chosen / failed with the reason. End with the
restart reminder from step 4 when skills were newly linked.

# pipeline-dashboard

The w-* AI dev workflow for the Welligence web repo, kept outside it:

| Path | What |
|---|---|
| `server.ts`, `lib/`, `public/`, `bin/` | the skills dashboard (below) |
| `web/` | files symlinked into the web checkout: `.claude/skills`, `.agents`, `.codex`, `.mcp.json`, `scripts/pipeline`, `docs/second-dev-stack.md` |
| `CLAUDE.md`, `AGENTS.md` | repo-agnostic conventions; `/w-setup` copies them into a repo that lacks them or adds the missing rules to the existing files (`/w-setup instructions <repo>` for any repo) |
| `bin/link-web.sh [web-dir]` | creates those symlinks and lists them, plus the skills' local state (`.jira-plans/`, `.pr-reviews/`, `.claude/pipeline-*`, `.claude/worktrees/`), in the web clone's `.git/info/exclude` |
| `w-setup/` | the `/w-setup` personal skill that sets all of this up on a new machine |

Skills are edited in place through the symlinks and committed here. The web remote never sees
them.

## New machine

```
mkdir -p ~/.claude/skills/w-setup
gh api repos/xdraj24/pipeline-dashboard/contents/w-setup/SKILL.md -H 'Accept: application/vnd.github.raw' > ~/.claude/skills/w-setup/SKILL.md
```

Then run `/w-setup` in Claude Code. It clones this repo next to the web checkout, installs what
is missing, links the skills, starts the dashboard, and optionally sets up Slack escalation, the
second web stack (PR review, `/w-24-land-branch-for-review`) and the third (QA).

# Skills dashboard

Local web app that watches what the `w-*` skills and the unattended pipeline leave on disk in the
web checkout (`../web`, or `WEB_REPO_ROOT` in `.env`), plus the matching GitHub PR and JIRA
status, and suggests the next command per ticket. It also carries questions from the skills to
you and your answers back (see "Questions").

## Run

```
/w-skill-dashboard [board|history|reviews|stop|status]   # from any w-* host: starts it if needed and opens the page
bin/up.sh [history|reviews] [--no-open]          # the same from a shell
node server.ts                                   # http://localhost:4848, foreground
```

Node 22.18+ (type stripping, no dependencies). `PORT=5000 node server.ts` changes the port.
`pnpm dev` / `npm run dev` restarts on file changes.

## What it reads

| Source | Used for |
|---|---|
| `.jira-plans/<T>/plan.md` | title, to-do progress, risks / open questions, implementation log |
| `.jira-plans/<T>/code-review.md` | rounds, final STATUS, reviewer/fixer models, unresolved findings |
| `.jira-plans/<T>/qa-check.md` | rounds, final QA verdict, browser driver, whether QA changed code, qa model, open findings |
| `.jira-plans/<T>/change-notes.md` | what changed, decisions, assumptions |
| `.jira-plans/<T>/local-branch.md` | status, branch, pr_url, release / cherry-pick PRs |
| `.claude/pipeline-logs/<run>/` | stage timeline (`progress.log`, one chip per stage pass: its `in progress` line is folded into the `done`/`FAILED` line that follows), per-ticket log tail, exit codes |
| `.claude/pipeline-slots/`, `ps` | which tickets are running right now and in which phase |
| `git worktree list`, `refs/heads/*XWWP-*` | worktrees, dirty files, local branches |
| `gh api graphql` | PR state, draft, approvals, unresolved threads, comments since last push, CI |
| JIRA REST (`JIRA_EMAIL` + `JIRA_API_TOKEN` in this repo's `.env`) | ticket status, type, assignee, sprint |
| `.pr-reviews/` | reviews drafted by `/w-21`, verified by `/w-22`, published by `/w-23` |

Models shown per ticket come from what `code-review.md` and `qa-check.md` recorded; "unknown"
means the skill did not write it down. Nothing is inferred.

## Sprint tickets and launching skills

With JIRA configured the board also lists open issues from the active sprint that the skills have
not touched (`SPRINT_JQL` in `lib/jira.ts`, override with `JIRA_SPRINT_JQL` in `.env`). The header
`sprint` selector switches between your assignments (default) and everyone's; the choice is kept in
the browser. Uncovered cards are dashed, carry a `sprint · mine` chip, and suggest `/w-1-coding
<TICKET>` (yours) or `just-plan` (others'). Tickets whose JIRA status implies a PR elsewhere get no
command.

Every suggested command has three buttons. `copy` (or clicking the command) copies it. `▶ run`
spawns `claude --permission-mode dontAsk --allowedTools "mcp__atlassian__*,mcp__slack__*" -p
"<command>"` from the repo root, the same invocation the pipeline uses, with `PIPELINE_REPO_ROOT`
set so questions reach this page; output goes to `data/launches/<id>.log` and shows in the card's
"Launch log" tab and the "Skills launched from this page" section, with a stop button. `terminal`
opens Terminal.app with an interactive `claude "<command>"` instead. Only a single `/w-*`
invocation is accepted; one running launch per ticket.

## History and archiving

`/history` lists archived tickets; the board hides them. A ticket is archived automatically once
its PR is merged (for a fast-tracked hotfix: the release PR and the cherry-pick PR) and its JIRA
status is one of `ARCHIVE_JIRA_STATUSES` in `lib/archive.ts` ("QC'd on STG",
"Delivered IN APP.WELLIGENCE"). Archiving writes `archived: <ISO time>` and `archived_reason:`
into the frontmatter of `.jira-plans/<TICKET>/plan.md` (mtime preserved). A ticket with no plan
folder gets the marker in `data/archive/<TICKET>.md` instead. Delete the two lines (or the side
file) to put a ticket back on the board.

## Reviews

`/reviews` is the code-review queue: open, non-draft PRs by other developers, fetched with one
paginated GraphQL call (`lib/review-queue.ts`, cached 2 min, `Refresh` drops it). A PR lands in
one of four places depending on who has touched it, bot and CI accounts ignored:

- **Waiting for a first review**: no human other than the author has reviewed or commented.
- **You commented, waiting on the author**: your comment or changes-requested review is on it.
  Cards are highlighted; chips show new comments and pushes since your last review.
- **Reviewed by someone else, not by you** (collapsed).
- **History: approved by you**: open PRs with your approval plus merged/closed ones from
  `gh pr list --search "reviewed-by:<you>"`, limited to the 100 most recently updated.

Filters at the top: `small` (≤ 200 changed lines and ≤ 10 files, `SMALL_MAX_*` in
`lib/review-queue.ts`), `frontend focused` / `backend focused` (same 90% rule as
`/w-20-list-prs-for-review`, computed from the first 100 changed files), and `hide bot authors`.
They are kept in the browser. Every card suggests the next skill for that PR, with the same copy /
▶ run / terminal buttons as the board: `/w-21-review-prs <n>` when nothing is drafted,
`/w-22-verify-review-comments <n>` for a `status: draft` file under `.pr-reviews/PR-<n>/`,
`/w-23-publish-review <n>` once verified. The filter bar also offers one `/w-21-review-prs`
over every PR currently shown in the first group. Headless launches from this page are keyed by
PR number (`pr` in `data/launches/<id>.json`) and show in the board's launches section too.

"Review skills running" lists Claude Code sessions (interactive terminals included) whose last
command was a `/w-2x` skill, read from the transcripts under `~/.claude/projects/*/*.jsonl`
(`lib/sessions.ts`, files touched in the last 24 h, re-parsed only when their mtime changes). A
session counts as running until the assistant turn after the command ends; 15 minutes without
transcript activity shows as "quiet". Cards whose PR number is in the command's arguments (or
every card, for an argument-less `/w-21-review-prs`) carry the same chip. Codex and Cursor hosts
leave no such transcript, so their runs are invisible here.

Clicking a card (or a title in the approved history) opens the detail panel
(`GET /api/reviews/<n>/detail`, `buildReviewDetail` in `lib/review-state.ts`). Its **Ticket** tab
shows the JIRA issue (status, type, assignee, sprint, parent, dates and the rendered description,
fetched with `expand=renderedFields` by `jiraIssueDetail` in `lib/jira.ts`, cached 90 s) followed
by the PR facts and the next-step command; the **Review file** tab shows the frontmatter and one
block per comment: a Publish checkbox, the `path:line` linked to the file on the PR branch, the
surrounding code (±5 lines from the GitHub contents API at the head branch, `snippet` in
`lib/review-file.ts`, cached 2 min, the commented line highlighted) and the comment body. Ticking a
box (`POST /api/reviews/<n>/publish-flags`) rewrites the table in `review.md` with a third
`Publish` column holding `[x]` / `[ ]`; `/w-23-publish-review` posts only the `[x]` rows when that
column exists, and the card's next step says "k of n ticked". `/w-22` drops the column when it
rewrites the table. `preview` on a card opens the panel straight on that tab. The
ticket comes from the PR, or from the review file's `jira_ticket` / `branch` frontmatter while the
PR list is still loading. Without JIRA credentials the tab shows "JIRA off" and the PR facts only.

## Questions

Skills post questions with `bin/ask.sh` (documented in
`.claude/skills/_shared/slack-escalation.md`). Each question is a JSON file in
`data/questions/`, so posting works even when the server is down; the page shows open questions
at the top and writes the answer back into the same file, which `ask.sh` / `answer.sh` return
to the waiting skill.

```
bin/ask.sh --ticket XWWP-1234 --phase commit \
  --question "Implementation seems to miss requirement X. Fix it, or prepare as is?" \
  --option "fix it" --option "still prepare" --timeout-minutes 120
```

HTTP equivalents: `POST /api/questions`, `GET /api/questions/<id>`, `POST /api/questions/<id>/answer`.

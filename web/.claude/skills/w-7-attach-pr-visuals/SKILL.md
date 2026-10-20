---
name: w-7-attach-pr-visuals
description: Capture screenshots and a GIF of a PR's UI changes with Playwright (and Chrome automation in Claude Code) and attach them to the PR's Screenshots/Recordings section. Use to add visual evidence to an open PR.
argument-hint: "<XWWP-XXXX|PR-link-or-number>"
model: sonnet
effort: high
---

# Attach Visual Evidence to a PR

Capture screenshots (and a GIF for multi-step interactions) of an already-open PR's UI changes,
then attach them to that PR's `## :camera: Screenshots/Recordings` section on GitHub.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

There is no tool named "visual-pr" in this repo or environment — don't look for one. The real
mechanism: Playwright (already this repo's E2E framework, see `playwright.config.js` and
`tests/`) captures deterministic screenshots against the local dev server; in Claude Code the
`claude-in-chrome` browser tools record an interaction as a GIF (`gif_creator`) and literally
drag the resulting files into GitHub's PR text box (`file_upload`) — GitHub has no public REST
endpoint for uploading inline images, so the browser drop is the only way to get a real
`github.com/user-attachments/...` link that renders in the PR. Every other host (see
`.claude/skills/_shared/host-runtime.md` § Browser automation) captures with Playwright only and
hands the files to the developer to attach by hand; steps 6 and 7 say exactly what to do.

Argument: `$ARGUMENTS` — required, one of:
- An XWWP ticket id (e.g. `XWWP-1551`).
- A GitHub PR URL.
- A bare PR number (resolved against this repo's `origin`).

If missing, ask the user for one before doing anything else.

Every question for the developer in this skill goes through
`.claude/skills/_shared/slack-escalation.md`.

## 1. Resolve the PR

As `.claude/skills/_shared/resolve-pr.md` describes; the `gh pr view` fields needed here are
`state,headRefName,baseRefName,url,body`.

## 1b. Reuse the QA screenshots when they exist

Ticket id known (from the argument or the PR's branch/title) and
`.jira-plans/<TICKET-ID>/screenshots/index.md` exists → the qa-check phase of `/w-1-coding`
already captured the change working on the QA stack. Skip steps 2–6: the files listed in
`index.md` are the media, its captions are the descriptions. Go to step 7.

## 2. Check there's something worth screenshotting

`git fetch origin <baseRefName> <headRefName>`, then:

```
git diff --name-only origin/<baseRefName>...origin/<headRefName> -- \
  'frontend/**/*.tsx' 'frontend/**/*.jsx' 'frontend/**/*.css' \
  ':!frontend/**/*.test.*' ':!frontend/**/*.stories.*' ':!frontend/**/__tests__/**'
```

If this is empty, tell the user the PR has no user-visible frontend changes and stop — don't
screenshot a backend-only or test-only diff.

## 3. Identify what to capture

From the changed component/page files, look for matching entries under `frontend/router/` (this
app uses TanStack Router) to find the route(s) that render them. For each candidate route, decide:

- **Static screenshot** — the change is a visual/layout change visible in one state (styling, a
  new field, a chart, a table column).
- **GIF** — the change spans an interaction (a filter flow, a modal, a multi-step form, a hover/
  drag behavior) where a single frame doesn't show it.

If the mapping from changed files to a route isn't obvious, or a route needs specific state
(a particular country/asset/filter selected) to show the change, ask the developer for the
route(s) and the minimal steps to reach the relevant state, rather than guessing.

## 4. Make sure the app is reachable

- Check the dev containers are up: `docker ps --filter name=web-web-1 --filter name=web-spa-1
  --format '{{.Names}}'`. If either is missing, run `make start` and wait for it to report ready
  before continuing — this is a local, reversible action, no need to ask first.
- App URL `http://localhost:3000`. Login credentials come from `BASE_USER`/`BASE_PASSWORD` or
  the main checkout's `playwright.env.local.json` (`/w-setup` writes it for the seeded E2E user).

## 5. Capture screenshots with Playwright

Playwright runs from the pipeline-dashboard repo's `tools/playwright/` (installed by
`/w-setup`; `DASH` as in `.claude/skills/_shared/slack-escalation.md`). Write a one-off spec to
`$DASH/tools/playwright/tmp/<TICKET-ID>-visuals.spec.ts` (never under the web repo's `tests/`)
that starts with `await login(page)` from `../login.ts`. For each static route identified in
step 3:

- `page.goto(<route>)`, wait for the relevant content to be visible (a specific locator, not a
  fixed timeout where avoidable), then `page.screenshot({ path, fullPage: true })`.
- Save to the scratch directory as `<TICKET-ID>-<slug>.png`.

Run it: `cd "$DASH/tools/playwright" && WEB_REPO_ROOT=<main checkout> BASE_URL=<app URL> npx
playwright test tmp/<file>`, then delete the spec.

## 6. Capture a GIF for interactive flows

**Claude Code**: use the `claude-in-chrome` browser tools instead of Playwright (a real,
already-authenticated Chrome tab is simpler than scripting auth + a video-to-GIF pipeline):

1. Load the tools if not already available (deferred tools, `ToolSearch` with
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__gif_creator,mcp__claude-in-chrome__file_upload`).
2. `tabs_context_mcp`, then open a new tab at the target route (don't reuse an unrelated existing
   tab).
3. Start `gif_creator`, perform the exact steps from step 3 (or from the user's answer), capture
   extra frames before/after each action for smooth playback, then save as
   `<TICKET-ID>-<slug>.gif` in the scratch directory.
4. Never trigger a native `confirm`/`alert`/`prompt` while doing this — if a step would, stop and
   ask the user first (see the `claude-in-chrome` guidance on dialogs).

**Every other host**: extend the Playwright spec from step 5 with a second test that performs the
same steps under `recordVideo: { dir: <scratch directory> }` (set on the browser context), then
convert the resulting `.webm` with `ffmpeg -i <video>.webm -vf "fps=10,scale=1200:-1" <TICKET-ID>-<slug>.gif`
if `ffmpeg` is installed; otherwise keep the `.webm` and say so.

## 7. Attach the media to the PR

**Every host except Claude Code**: stop here. List the captured files with their absolute paths
and what each shows, and tell the developer to drag them into the PR's
`## :camera: Screenshots/Recordings` section (or a new comment) themselves; GitHub offers no API
for it. Then report as in step 8.

**Claude Code**: use the browser (same tools as step 6) against the actual PR page — this is the
only way to get a real GitHub-hosted image link:

1. Navigate to the PR's URL from step 1.
2. If `body` (from step 1's `gh pr view`) still has the template's `> \<Insert here screenshots or
   recordings, if applicable.>` placeholder under `## :camera: Screenshots/Recordings`: click
   **Edit** on the PR description, place the cursor on that placeholder line, use `file_upload` to
   drop the captured file(s) into the textbox, wait for GitHub's upload to finish (the markdown
   `![...](https://github.com/user-attachments/...)` appears in the textarea — confirm via
   `read_page`/`get_page_text` before proceeding), replace the placeholder text with the uploaded
   image markdown (one per line, GIFs and screenshots both), then save.
3. If that section already has real content (not the placeholder — e.g. a previous run of this
   skill, or something the author added manually), don't overwrite it: post a new PR comment
   instead, same drag-and-drop mechanism, prefixed with a one-line note on what it shows.
4. If GitHub's upload for a file fails or times out, don't retry more than once — report it to the
   user and move on to the remaining files.

## 8. Report back

Show the user the PR URL, which files were attached (screenshot vs. GIF, and which route/flow each
one demonstrates), and whether they landed in the PR description or a new comment.

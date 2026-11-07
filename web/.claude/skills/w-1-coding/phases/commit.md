# Phase: Commit

Input from `SKILL.md`: a single ticket id.

Turn the current local changes into a clean, committed branch tied to a JIRA ticket — everything
short of pushing to remote. Publishing is a separate skill (`/w-4-publish`) so many tickets can
be prepared locally and picked up for push later.

Follow the steps below **in order**. Do not skip the JIRA validation step.

## 1. Fetch the JIRA ticket

- Fetch the issue with the Atlassian MCP tool (`mcp__atlassian__getJiraIssue`, cloud id via
  `mcp__atlassian__getAccessibleAtlassianResources` if needed).
- Extract:
  - **Issue type** → determines branch prefix: `Bug` → `bugfix/`, anything else
    (Story/Task/Feature/Improvement) → `feature/`.
  - **Summary and description** → used for validation, naming, and later for the PR body in
    `/w-4-publish`.

## 2. Validate local changes against the ticket

- Inspect the local changes: `git status` and `git diff HEAD` (include staged and unstaged;
  read new untracked files too). Leave out anything the Implementation Log in `plan.md` marked
  as unrelated pre-existing dirt.
- If the ticket description is **well defined** (contains concrete requirements or acceptance
  criteria), compare the diff against each requirement.
- If everything is covered, or the description is too vague to check against, continue to step 3.
- If one or more requirements appear to be **missing** from the diff, ask the developer via
  `.claude/skills/_shared/slack-escalation.md`, in every mode:

  > "Local implementation seems to miss this requirement of the JIRA task: `<requirement>`.
  > Do you want to fix it, or still prepare the current local changes?"

  Interpret whatever comes back (human reply, or the shared doc's fallback — default the
  best guess to "still prepare", since it's the non-destructive option and a human reviews the
  result anyway before a non-draft PR):

  - Resolves to **fix it** → attempt to implement the missing requirement(s) directly, then
    re-check this requirement before continuing to step 3.
  - Resolves to **still prepare** (or fallback) → continue to step 3 with the changes as they are.

  Either way, keep a short note of the question and the resolution — it goes into
  `change-notes.md`'s "Assumptions" in step 5.

## 3. Create the branch

Branch name format:

```
<prefix>/<TICKET-ID>-<page-area>-<sub-area>-<short-fix-description>
```

- `<prefix>`: `feature/` or `bugfix/` from step 1 (per repo convention in CLAUDE.md).
- `<page-area>`: the app area the diff touches — e.g. `smart-reports`, `og-map`,
  `portfolio-analysis`, `exploration-page`, `ma`, `ma-opps`, `valuation-page`, `home-page`.
  Derive it from the changed file paths (e.g. `frontend/admins/SmartReports/...` → `smart-reports`).
- `<sub-area>`: the sub-page or component area, 1–2 words (e.g. `view-and-pdf`).
- `<short-fix-description>`: what the change does, 2–4 words (e.g. `title-alignment`).
- **Keep the whole branch name short** — everything lowercase, dash-separated, roughly
  ≤ 60 characters total. Prefer dropping words over exceeding this.

Example: `feature/<TICKET-ID>-smart-reports-view-and-pdf-title-alignment`

- If already on a branch matching this ticket id, stay on it (don't create a second branch for
  the same ticket).
- Otherwise create it from the current state: `git checkout -b <branch-name>` (do not commit
  directly to `main`).

## 4. Lint and test

Run the checks for every file in the diff as `.claude/skills/_shared/run-checks.md` describes.
Stage whatever Biome or RuboCop modified. If any test fails, **stop this phase**: report the
failures and do not commit. Fix them only if the developer asks.

## 5. Write the change notes

Write `.ai-workspace/jira-plans/<TICKET-ID>/change-notes.md` (overwrite if it exists — this is a refresh).
This is the document the developer reads before the diff when they land the branch, and
`/w-4-publish` appends it verbatim as the last section of the PR body (draft and final alike). It
exists because the code itself carries almost no comments: everything a reviewer would otherwise
want explained in-line goes here instead. Write it for someone who hasn't seen the diff; bullets;
under a page; no restating the ticket.

```
---
ticket: <TICKET-ID>
branch: <branch-name>
---

## What changed
- `path/or/area` — what changed there and why, one line per file or coherent group of files

## Decisions
- Each non-obvious design choice and its reason: why this seam, why this shape, what existing
  pattern it follows, anything a reviewer might reasonably question. "None" if nothing qualifies.

## Assumptions
- Every assumption made where the ticket, the plan or the code left room for interpretation —
  from the plan's "Risks / Open questions", the Implementation Log in plan.md, and this phase.
- Every question asked via Slack, with the answer verbatim or the fallback phrasing the shared doc
  describes.
- The `## Won't fix` and `## Follow-up bugs` entries from `code-review.md` and `qa-check.md`,
  open QA findings, and the browser line from `qa-check.md`, if any.
```

Sources to draw from: `plan.md` (Summary, Risks / Open questions, Implementation Log),
`code-review.md`, `qa-check.md` (when this is the re-commit after the QA phase changed code),
the diff itself, and step 2's resolution. Don't pad: a one-line "What changed"
and "None" for the other two is a valid file for a trivial ticket.

## 6. Commit

- Commit message = the branch title, humanized: strip the prefix, keep the ticket id, convert
  dashes to spaces with sensible capitalization. Example:

  ```
  <TICKET-ID> Smart Reports view and PDF title alignment
  ```

- Only if it genuinely adds information, append one short extra sentence on a second paragraph.
- Commit the ticket's files: `git add -A && git commit -m "<message>"` (pre-commit hooks will
  run; if hooks modify files, stage and amend/retry the commit). If step 2 found unrelated
  pre-existing dirt, add the ticket's files explicitly instead of `-A` and leave the rest alone.
- **Re-commit after qa-check** (or any other re-run): when `HEAD`'s subject already starts with
  `<TICKET-ID>` and the branch has no upstream (`git rev-parse --abbrev-ref @{upstream}` fails),
  fold the new changes into that commit with `git commit --amend --no-edit` instead of stacking
  a second one — the pipeline and `/w-3-land-branch` expect one commit per ticket. A branch that
  already has an upstream was pushed; never rewrite it here, make a new commit and let
  `/w-4-publish` push it.

## 7. Record local-branch state

Write `.ai-workspace/jira-plans/<TICKET-ID>/local-branch.md` (create the ticket folder if needed; overwrite if
it already exists — this is a refresh; keep any `pr_url:` and other fields a later skill added). This file is how `/w-4-publish` discovers branches that are
ready to publish, so keep it accurate:

```
---
ticket: <TICKET-ID>
branch: <branch-name>
status: ready-for-push
jira_url: <jira_browse>/<TICKET-ID>
commit_title: <the commit message first line>
commit_description: <the extra sentence from step 6, or "None">
---

## Overview
<the branch name in nice capitalization and dash formatting, e.g. "Smart Reports — View and
PDF — Title Alignment" — reused verbatim by /w-4-publish for the PR body>

## Dependencies
<any known dependent PRs/projects mentioned by the user or ticket, otherwise "None">

## Testing Instructions
<concrete steps derived from the diff and the ticket: which page to open, what to click, what
to verify>
```

**Under `PIPELINE_MODE=unattended` or `supervised`** (set in the worktree's `pipeline.env`): write
`status: ready-for-review` instead of `status: ready-for-push` — this branch went through the
pipeline unattended and always needs a human pass via `/w-3-land-branch` before `/w-4-publish`
is allowed to open a non-draft PR for it. (`/w-4-publish <TICKET-ID> draft`, which the pipeline
runs itself in `draft-pr` mode, is the one exception: a draft PR is fine without the human pass.)

## 8. Report

Summarize: files changed, tests run and their result, the branch name, the commit (and whether it
was amended), and the path to `change-notes.md`. Do **not** push — suggest the next step: with no
`qa-check.md` yet, `/w-1-coding <TICKET-ID> just-qa-check`; otherwise `/w-4-publish <branch-name>`
(or `/w-4-publish` with no argument to see all branches ready to be picked up). **Under
`PIPELINE_MODE=unattended` or `supervised`**, suggest `/w-3-land-branch <TICKET-ID>` instead.

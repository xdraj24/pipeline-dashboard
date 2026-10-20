---
name: w-0-create-jira-task
description: Create a new XWWP JIRA ticket (asks assignee, bug/feature, backlog/sprint, estimates story points) or, given a ticket id, refine a thin ticket's description through a short Q&A. Use before planning or implementing a ticket.
argument-hint: "[short description of the task] | XWWP-XXXX"
model: sonnet
effort: low
---

# Create or Refine a JIRA Task

Argument: `$ARGUMENTS`.

Host-specific mechanics (arguments, invoking other skills, delegation, asking the developer):
`.claude/skills/_shared/host-runtime.md`.

- Matches an existing ticket id (`XWWP-\d+`, case-insensitive) → **Refine mode**: go to
  "Refine an Existing Ticket" below. This is what the developer wants when they already filed a
  thin ticket and now wants it fleshed out before `/w-1-coding`'s plan phase has to guess at it.
- Anything else → **Create mode**: a new ticket, described below. If `$ARGUMENTS` is missing
  entirely, ask the user for a one-line description before doing anything else (don't guess at
  scope) — don't assume Refine mode just because the text looks short.

Every question for the developer in this skill goes through
`.claude/skills/_shared/slack-escalation.md` (Slack when it's set up, a direct question
otherwise).

## Create Mode

Create a new ticket in the `XWWP` JIRA project, ready to feed into `/w-1-coding`.

### 1. Gather ticket content

- From `$ARGUMENTS` (or the user's follow-up answer), derive:
  - **Summary**: a short, clear title (this is what shows in ticket lists).
  - **Description**: 1 short paragraph expanding on the summary — what needs to be done and why,
    based only on what the user actually said. Don't invent requirements or acceptance criteria
    the user didn't mention.
- If the description is too thin to write even a one-paragraph body, use the summary text as the
  description verbatim rather than padding it with invented detail.

### 2. Ask the three questions

Ask the developer all three together in one message, batched rather than asked one at a time,
with the options numbered so the reply can be a short pick (see
`.claude/skills/_shared/slack-escalation.md`).

1. **Assignee** — "Assign to me, or leave unassigned?" → `Assign to me` / `Leave unassigned`.
2. **Type** — "Bug or feature?" → `Bug` / `Feature`.
3. **Placement** — "Backlog, or current sprint?" → `Backlog` / `Current sprint`.

### 3. Resolve JIRA metadata

- Cloud id: `mcp__atlassian__getAccessibleAtlassianResources` (reuse if already known this
  session).
- **Assignee account id** (only if "Assign to me"): `mcp__atlassian__atlassianUserInfo` for the
  current user's account id.
- **Issue type name**: `mcp__atlassian__getJiraProjectIssueTypesMetadata` for project `XWWP`.
  - "Bug" → the type literally named `Bug`.
  - "Feature" → prefer `Story`; fall back to `Task` if the project has no `Story` type.
- **Story points field id**: `mcp__atlassian__getJiraIssueTypeMetaWithFields` for the resolved
  issue type, with `requiredFieldsOnly: false`. Find the field named `Story Points` (or `Story
  point estimate`) and note its `customfield_XXXXX` id. If no such field exists on this issue
  type's screen, skip setting it and mention that in the final report.
- **Current sprint id** (only if "Current sprint" was chosen):
  `mcp__atlassian__searchJiraIssuesUsingJql` with
  `jql: "project = XWWP AND sprint in openSprints()"`, `fields: ["sprint"]`, `maxResults: 1`.
  - Read the `sprint` field off the returned issue (or whichever field in the response carries
    sprint data) and take the id of the sprint whose state is active.
  - If no issues are currently in an open sprint (so there's nothing to read the field/sprint id
    from), tell the user and fall back to creating it in the backlog instead.

### 4. Estimate story points

Estimate story points yourself — do not ask the user. Use a Fibonacci-ish scale based on the
described scope and, if you can tell from the description, how many layers of the monorepo
(`frontend/`, `backend/`, `data-loader/`) it likely touches:

- `1` — trivial: copy/config/one-line fix.
- `2` — small: a well-understood change confined to one file or component.
- `3` — moderate: a few files in one layer, straightforward logic, needs tests.
- `5` — substantial: spans multiple files or crosses one layer boundary (e.g. frontend + GraphQL).
- `8` — large: spans multiple layers (frontend + backend + db), non-trivial design.
- `13` — very large: note in the final report that the ticket is probably worth splitting.

### 5. Create the issue

Call `mcp__atlassian__createJiraIssue`:

- `cloudId`, `projectKey: "XWWP"`, `issueTypeName` (from step 3), `summary`, `description`
  (step 1).
- `assignee_account_id` — only if "Assign to me" was chosen.
- `additional_fields` — the story points field id set to the step 4 estimate, plus the sprint
  field id set to the resolved sprint id if "Current sprint" was chosen and one was found.

### 6. Report back

Show: the new ticket id and URL (`https://welligence.atlassian.net/browse/<TICKET-ID>`), the
issue type, assignee (or "unassigned"), placement (backlog/sprint, and if a requested sprint
placement fell back to backlog, say so), and the story point estimate with a one-line reason.

Suggest the natural next step: `/w-1-coding <TICKET-ID>` (or `… just-plan` to only plan it).

## Refine Mode

The developer already has a ticket — often filed in a hurry, or by someone else — and wants it
fleshed out before `/w-1-coding`'s plan phase has to guess at missing requirements. This never
creates a second ticket; it edits the one given.

### 1. Fetch the ticket

- Cloud id: `mcp__atlassian__getAccessibleAtlassianResources` (reuse if already known this
  session).
- `mcp__atlassian__getJiraIssue` for `<TICKET-ID>`. If it doesn't resolve, stop and tell the user
  rather than falling back to Create mode.
- Show the developer the current summary and description verbatim before asking anything, so
  they're working from the same text you are.

### 2. Find the real gaps

Judge the existing description against what the plan phase actually needs to draft a plan without
guessing (see `.claude/skills/w-1-coding/phases/plan.md`):

- **Acceptance criteria** — is it clear what "done" looks like, concretely?
- **Scope** — which layer(s) of the monorepo this touches (`frontend/`, `backend/`, GraphQL,
  `data-loader/`), and anything explicitly out of scope.
- **Repro / current vs. expected behavior** (bugs only) — steps to reproduce, what happens now,
  what should happen instead.
- **Dependencies** — other tickets, PRs, or external work this is blocked by or blocks.
- **Attachments** — the Atlassian MCP tools return text/ADF only, never attachment binary content.
  If the description references a screenshot, recording, or other attached file, you cannot see
  what it shows — never guess its content.

Only flag sections that are genuinely thin or missing. A ticket that already states acceptance
criteria clearly doesn't need a question about it — don't run the developer through a rote
checklist.

### 3. Ask only about the real gaps

For each gap found in step 2, ask the developer one focused question, batched together with the
others in one message rather than asked one at a time. For a flagged attachment, ask the developer
to paste its content or describe it in text — don't proceed on that section until they do, since
guessing at an unseen screenshot is exactly the failure the plan phase is built to avoid.

If step 2 found no real gaps, say so and skip straight to step 7 — nothing to change.

### 4. Draft the enriched description

Rewrite the description incorporating the answers, organized under clear sections as needed (e.g.
What / Why, Acceptance Criteria, Out of Scope, Dependencies). Keep the developer's own wording
where they gave specifics. Do not invent requirements, numbers, or acceptance criteria beyond what
the ticket already said or the developer just answered.

### 5. Confirm before writing

Show the developer the full proposed new description and get explicit go-ahead before touching
JIRA — this edits a shared ticket other people may already be looking at, so a silent overwrite is
not acceptable. Let them request changes and re-show until they approve.

### 6. Update the issue

`mcp__atlassian__editJiraIssue` on `<TICKET-ID>` with the approved description only — don't touch
assignee, type, sprint, or story points in Refine mode; that's Create mode's job for a different
ticket, and this one's metadata was already deliberately set when it was filed.

### 7. Report back

Show the ticket id and URL, and a one-line summary of what was added or clarified (e.g. "added
acceptance criteria and flagged the login-flow dependency on XWWP-1200"). Suggest the natural next
step: `/w-1-coding <TICKET-ID>`.

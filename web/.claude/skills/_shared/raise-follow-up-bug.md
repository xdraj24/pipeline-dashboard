# Shared: Raise a Follow-up Bug

`w-1-coding`'s code-review and qa-check phases and `w-21-review-prs` use this for findings
triaged as **follow-up bug** (`review-panel.md` § 3, `qa-testers.md` § 3): real, worth fixing,
but pre-existing and outside the change's scope. Each one
becomes a Bug in the backlog unless JIRA already has it. Never blocks the calling phase: a JIRA
failure is recorded and the phase carries on.

Runs in every mode, unattended included, without asking the developer: the triage already
decided the bug is worth tracking.

## 1. Prepare the list

- Merge the phase's follow-up findings that describe the same defect into one.
- Drop any already listed under `## Follow-up bugs` in this ticket's `code-review.md` or
  `qa-check.md`, or in the PR's `triage.md`; record them again with the existing key.
- At most **5 new bugs per phase run**. Raise the most severe first; list the rest as
  `not raised (cap of 5 reached)`.

## 2. Look for an existing bug

Cloud id via `mcp__atlassian__getAccessibleAtlassianResources` (reuse if already known). Project
key from `ticket_pattern` (`host-runtime.md`). For each finding, run up to two
`mcp__atlassian__searchJiraIssuesUsingJql` queries, `maxResults: 10`, fields `summary`,
`status`, `description`:

1. `project = <key> AND issuetype = Bug AND statusCategory != Done AND text ~ "<2-4 distinctive
   terms: the symptom, the component or class name>" ORDER BY created DESC`
2. The same with the file's base name or the GraphQL field / route instead of the terms.

It's a duplicate when an open issue describes the same defect: the same symptom, or the same code
path failing the same way. A bug in the same area with a different cause is not a duplicate.
Duplicate → don't create, don't comment; record its key as `existing`.

## 3. Create it

`mcp__atlassian__createJiraIssue`: `projectKey`, `issueTypeName: "Bug"`, no assignee, no sprint
(it lands in the backlog), no story points.

- `summary`: the symptom, under 80 characters, no ticket id.
- `description`:
  ```
  Found during <code review | QA> of <TICKET-ID | PR #number>; it is not caused by that change.

  Where: <file:line on origin/main at <short sha>, or URL plus steps>
  What happens: <failure scenario>
  Expected: <what should happen>
  Evidence: <failing command, probe result or the reviewer's reasoning, a few lines>
  ```
  Use only what the finding and your own checks established. No guessed impact, frequency or
  customer names.

Then link it to the ticket under review (for a PR, its JIRA ticket; none → no link):
`mcp__atlassian__createIssueLink` with type `Relates`, inward `<new key>`, outward `<TICKET-ID>`. A failed link doesn't undo the bug; note it.

## 4. Record

Return one line per finding for the caller's `## Follow-up bugs` section:

- `<finding id> — <KEY> (new) — <summary>`
- `<finding id> — <KEY> (existing) — <its summary>`
- `<finding id> — not raised (<reason: JIRA unavailable, cap reached, …>) — <summary>`

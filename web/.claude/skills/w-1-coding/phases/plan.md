# Phase: Plan

Input from `SKILL.md`: one or more validated, de-duplicated ticket ids.

Plans are saved under `.ai-workspace/jira-plans/<TICKET-ID>/plan.md` at the repo root. That folder is
excluded from git through `.git/info/exclude` (set up by `link-web.sh`) — it is local scratch space, never pushed.

## This phase is re-entrant

Load state first: for every ticket id, check whether `.ai-workspace/jira-plans/<TICKET-ID>/plan.md` already
exists and read its `## To-do` list. That list is the state. On a return visit, don't re-ask
anything already recorded in `plan.md`: carry forward its ticked to-do items, its answered risks,
and its `## Implementation Log` rather than regenerating them.

## 1. Draft a plan per ticket

- **One ticket** → still delegate to the **planner** role (step below), so behavior and output
  format stay identical regardless of ticket count.
- **Multiple tickets** → one planner per ticket, all in parallel (same message), so they run
  concurrently instead of one after another.

For each ticket, delegate this self-contained prompt (fill in the real ticket id and the concrete `jira_browse` URL from `host-runtime.md`) to the
**planner** role as `.claude/skills/_shared/host-runtime.md` § Delegation roles describes for
your host, and wait for every planner to return. A host without delegation does the planning
pass itself, following the same prompt as its own instructions:

> Fetch JIRA ticket `<TICKET-ID>` (`mcp__atlassian__getJiraIssue`; use
> `mcp__atlassian__getAccessibleAtlassianResources` first if you don't have the cloud id yet).
> Read its summary, description, and acceptance criteria.
>
> Download the ticket's attachments with the helper in
> `.claude/skills/_shared/host-runtime.md` § JIRA attachments, into
> `.ai-workspace/jira-plans/<TICKET-ID>/attachments/`, and open every image and PDF so that the
> plan reflects what they show. Anything you still cannot see (a video, a Loom or other external
> link, an unsupported format, or every attachment if the helper failed) must not be guessed at.
> Add a bullet to "Risks / Open questions" naming it as it appears on the ticket and stating
> plainly that the developer needs to describe it, or drop a viewable copy under
> `.ai-workspace/jira-plans/<TICKET-ID>/`, before that part of the plan can be trusted.
>
> Then explore this Rails + React + Go monorepo (see the root, `frontend/` and `backend/app/`
> `CLAUDE.md` files for conventions) to find the files and areas the ticket touches.
>
> Produce a **short, skimmable** implementation plan — no fluff, no restating the ticket
> verbatim, bullets over prose. Output **only** the following Markdown, with no extra commentary
> before or after it:
>
> ```
> ---
> ticket: <TICKET-ID>
> title: <jira summary, short>
> type: <jira issue type>
> branch_prefix: <"bugfix" if issue type is Bug, else "feature">
> jira_url: <jira_browse>/<TICKET-ID>
> ---
>
> # <TICKET-ID> — <short title>
>
> ## Summary
> 1-3 sentences: what needs to change and why.
>
> ## Files to touch
> - `path/to/file` — one line on what changes
>
> ## Approach
> 1. Concrete step
> 2. Concrete step
> ...
>
> ## Tests
> - What test(s) to add/update (this repo requires tests for every code change)
>
> ## To-do
> - [ ] One checkbox per unit of work, in execution order, covering every Approach step and every
>       test above. Leave them all unchecked: the implement phase ticks them as it goes, and a
>       returning session resumes from the first unchecked box. Only work the implement phase can
>       finish without a browser (code, tests, commands); checks in the running app go under
>       Manual checks.
>
> ## Manual checks
> - What to verify in the running app, one line each, no checkbox (qa-check's browser pass covers
>   these; "None" when the change has no UI or runtime behaviour to see)
>
> ## Risks / Open questions
> - Anything ambiguous in the ticket, or a decision the developer should confirm
> ```
>
> Keep every section tight — this must be readable in under a minute. If a section has nothing
> notable (e.g. no open questions), write "None" instead of omitting the header.

## 2. Save the plans

Once all agent(s) return:

- Ensure `.ai-workspace/jira-plans/` exists (create it if not).
- Before writing each ticket's plan, look at its "Risks / Open questions" section. For any item
  that's genuinely **blocking** — the implementation can't proceed sensibly without a human
  decision, not just something informational worth flagging — ask the developer via
  `.claude/skills/_shared/slack-escalation.md`, in every mode. Once that resolves, replace the
  bullet with `<original question> — **Human-answered via Slack:** <answer>` (or the
  fallback phrasing the shared doc describes) directly in the plan's "Risks / Open questions"
  section before saving. Use judgment — most open questions are fine left as-is for later human
  reading; only escalate real blockers. An unreadable screenshot, recording, or attached file the
  agent flagged always counts as a blocker if the plan's Approach or Tests actually depend on what
  it shows — escalate it by name and ask the developer to paste its content or describe it in the
  reply; don't let the plan silently proceed without it. Handle tickets one at a time for this
  step even if multiple were planned in parallel above.
- For each ticket with no existing plan, write its agent's returned text verbatim to
  `.ai-workspace/jira-plans/<TICKET-ID>/plan.md` (create the ticket subfolder if needed).
- If a plan already exists for that ticket, this is a refresh, not a reset. Merge: keep the ticked
  to-do items, the answers already recorded under "Risks / Open questions", and any
  `## Implementation Log` section. Only untick or rewrite a to-do item whose work the refreshed
  plan actually changed, and name those items in step 3 so the developer knows what came back
  open.

## 3. Report

List each ticket processed with the saved path, the one-line Summary from its plan, and its to-do
count as `<ticked>/<total>`. For a refreshed plan, name any item that came back unchecked. If any
ticket's JIRA fetch or planning failed, say so explicitly rather than writing a partial file.

# Phase: Implement

Input from `SKILL.md`: a single ticket id.

## This phase is re-entrant

Load state first: read `.ai-workspace/jira-plans/<TICKET-ID>/plan.md`, including its `## To-do` list and any
`## Implementation Log`. That to-do list is the state. On a return visit, don't re-ask anything
already recorded in `plan.md`: pick up from the first unchecked to-do item.

## 1. Load the plan

- Read `.ai-workspace/jira-plans/<TICKET-ID>/plan.md`.
- If it doesn't exist, **stop** and tell the developer to run `/w-1-coding <TICKET-ID> just-plan`
  first. Do not improvise a plan yourself.
- If it exists but has no `## To-do` section (a plan written before that section existed), derive
  one from its **Approach** and **Tests** sections, tick anything the `## Implementation Log`
  already claims as done, and write it back before touching any code.
- If every item is already ticked, don't redo the work. Say so and point at
  `/w-1-coding <TICKET-ID> just-code-review`.

## 2. Check the working tree

- Run `git status`. If there are uncommitted changes that look unrelated to this ticket, ask the
  developer (via `.claude/skills/_shared/slack-escalation.md`) before continuing rather than
  mixing unrelated work into the same branch. Unattended best-guess default: continue, and note
  the unrelated files in the Implementation Log (step 6) so the commit phase can leave them out.

## 3. Get on the right branch

- Read `branch_prefix` from the plan's frontmatter and derive the branch name exactly as
  `phases/commit.md` step 3 defines it.
- If already on a branch matching this ticket id, stay on it. Otherwise:
  - If the branch already exists locally, `git checkout <branch-name>`.
  - Otherwise create it from the current state: `git checkout -b <branch-name>` (never commit
    directly to `main`).

## 4. Implement

- Work through the plan's `## To-do` list from the first unchecked item, editing/creating the
  files listed under **Files to touch**. Tick each item in `plan.md` (`- [ ]` → `- [x]`) the
  moment its work is done, not in a batch at the end: a session that dies or gets cleared resumes
  from the first unchecked box, so a stale tick costs lost work and a stale untick costs rework.
- If the ticket needs work no to-do item covers, add the item to the list before doing it.
- A to-do item that can only be done in the running app (a visual or manual check) is not yours
  to leave unchecked: move it to `## Manual checks` (create the section if missing) as a plain
  bullet. qa-check's browser pass covers it, and an unchecked box would mark implement unfinished.
- Follow this repo's conventions (root, `frontend/`, and `backend/app/` `CLAUDE.md` files) — component
  structure, styling, no barrel files, etc.
- Add/update the tests listed under the plan's **Tests** section. Every code change needs a
  test per repo policy — don't skip this even if the plan under-specified it.
- If you hit something the plan's **Risks / Open questions** flagged and it materially changes
  the approach, resolve it as sensibly as you can and note the deviation (for step 6) rather than
  stopping, unless it's a genuine ambiguity only the developer can resolve — then ask via
  `.claude/skills/_shared/slack-escalation.md`.

### Comments: write almost none

Reviewers in this repo consistently push back on comment volume. Code is expected to explain
itself through naming and structure; a comment is the exception, not the default. The explanation
a reviewer needs goes into `.ai-workspace/jira-plans/<TICKET-ID>/change-notes.md` in the commit phase and from
there into the PR body — not into the source.

- **Never** write a comment that narrates what the code does, restates a name, explains the
  diff to a reviewer, or summarizes a class/method that already reads clearly. If you catch
  yourself explaining your own reasoning, delete it and keep the reasoning for the Implementation
  Log (step 6) instead.
- Only a genuinely non-obvious constraint earns a comment: a trap that would silently break the
  code if a future reader didn't know it, a library/data quirk, or the origin of a magic value.
- When one does earn it, cap it at **one or two lines** and state only the constraint. Multi-line
  essays, background, and "considered but rejected" asides do not go in the source.
- Budget: at most one such comment per file, and rarely more than two or three across a whole
  ticket. If your diff has more, you are explaining code that should have been written clearer.
- Test files get no comments at all — the `describe`/`it` strings carry the intent.

### Reuse the repo's own seams

Before inventing a structure, find the existing one and follow it. Reviewers reject new code
that reimplements a pattern the repo already has — for example a GraphQL resolver that holds
query logic instead of delegating to an `ApplicationQuery` object under `backend/app/queries/`
(see `backend/app/CLAUDE.md`). Grep for two or three existing examples of whatever you're about
to add and match the closest one.

## 5. Lint and test

Run the checks for everything you touched as `.claude/skills/_shared/run-checks.md` describes
(it carries the container paths, the worktree rule and the foreground-only rule). Files the
linters modify stay as working-tree changes; nothing is committed in this phase. If a failure
isn't resolvable within a few attempts, stop and report it rather than working around it.

## 6. Record what happened

Append an `## Implementation Log` section to `.ai-workspace/jira-plans/<TICKET-ID>/plan.md` (don't remove the
existing content): a few bullets on what was actually done, any deviation from the original plan,
and every assumption you made where the ticket or the plan left room for interpretation. This is
context for the code-review phase, and the raw material for `change-notes.md` in the commit
phase — be specific here so that file can be.

## 7. Report

Summarize: files changed, tests run and their result, the branch name, and the to-do count as
`<ticked>/<total>` with any item left unchecked and why. Do **not** commit or push — that's the
commit phase's job, after code review.

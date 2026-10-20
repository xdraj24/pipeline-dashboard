# CLAUDE.md

Conventions shared by every repository the w-* workflow runs in. A repository's own `CLAUDE.md`
adds its structure, commands and stack-specific rules on top of these.

## Pull Requests

- Use the repository's PR template (`.github/pull_request_template.md`) when it has one.
- **Keep descriptions succinct.** A few lines of overview plus one line per logical change is the
  target. Detail belongs in commit messages, not the PR body — reviewers read the description to
  orient themselves, not to relive the investigation. Cut background, measurement dumps, rationale
  walls, and "considered but deferred" asides; if something genuinely needs a reviewer's attention,
  one sentence flagging it is enough.
- Write the template's sections as plain text. Drop the `> <Insert here ...>` placeholder markers
  rather than leaving the leading `>`; avoid blockquotes generally.
- Link the JIRA ticket as `[KEY-123](https://welligence.atlassian.net/browse/KEY-123)`.
- Include screenshots/recordings for UI changes.
- List dependencies on other PRs or projects.
- Include testing instructions when applicable.

## Branch Naming

- Feature branches: `feature/<description>` or `feature/<KEY-123>-<description>` when a JIRA ticket is provided
- Bug fix branches: `bugfix/<description>` or `bugfix/<KEY-123>-<description>` when a JIRA ticket is provided
- Release branches: `release/<description>`
- When a JIRA ticket is provided, always prefix the branch name with the ticket slug.

## Testing Requirements

- Every code change must be accompanied by tests.
- New logic gets unit tests in the repository's own test framework.
- Do not skip or disable failing tests — fix them.

## Comments

Code is expected to explain itself through naming and structure. A comment is the exception, not
the default, and reviewers push back on volume.

- Don't write comments that narrate what the code does, restate a name, explain the diff, or
  summarize a class/method that already reads clearly. Reasoning belongs in the commit message.
- Only a non-obvious constraint earns one: a trap that would silently break the code, a
  library/data quirk, or the origin of a magic value.
- Keep it to one or two lines, roughly one per file. Test files get none — test names carry the
  intent.
- Doc blocks (`/** … */`) on internal helpers, constants, props and hooks are over-commenting too:
  a paragraph explaining a well-named function is still a comment nobody asked for.
- Tooling directives (`biome-ignore`, `rubocop:disable`, `eslint-disable`, `@ts-expect-error`,
  `frozen_string_literal`, …) are load-bearing, not comments; never strip them.

**Before opening a PR, re-read the diff and delete the comments that don't clear the bar.** The
target for a whole multi-file change is a handful of comments, not one per block — if a file has
two, one of them is probably narration. Prefer one short line over three explanatory ones, and cut
the background: the "why we ended up here" story belongs in the commit message and the PR.

## Code Quality

- Before committing, review the diff for dead code and remove it: unused variables,
  functions/methods, imports, and exports introduced by the change. Linters catch some of this;
  always do a manual pass for unused exports, constants, and files they don't flag.

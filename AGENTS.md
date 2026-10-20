# AGENTS.md

Instructions for coding agents (Codex, Cursor, and others). The project conventions live in
`CLAUDE.md` at the repo root and in any per-directory `CLAUDE.md` files. Read and follow them;
they apply to every agent, not only Claude.

## w-* skills

- The skills are in `.claude/skills/` (`.agents/skills` points at the same folder). How each host
  runs them, delegates and asks the developer: `.claude/skills/_shared/host-runtime.md`.
- They, the pipeline scripts and their local state (`.jira-plans/`, `.pr-reviews/`,
  `.claude/pipeline-*`, `.claude/worktrees/`) are excluded from this repository's git through
  `.git/info/exclude`. Never commit them here; skill changes are committed in the
  pipeline-dashboard repo.

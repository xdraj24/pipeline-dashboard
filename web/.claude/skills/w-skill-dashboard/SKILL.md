---
name: w-skill-dashboard
description: Start the local skills dashboard (the pipeline-dashboard repo, http://localhost:4848) if it is not running and open it in the browser. Use to watch what the w-* skills and the pipeline are doing, answer their questions, and see PR and JIRA status per ticket.
argument-hint: "[board|history|reviews|stop|status]"
model: haiku
effort: low
---

# Skills Dashboard

Argument: `$ARGUMENTS` — optional, one of:
- empty or `board` — open the main board.
- `history` — open the archived-tickets page.
- `reviews` — open the PR review queue (other developers' PRs waiting for a review).
- `status` — report whether the server is running, do not open anything.
- `stop` — stop the server.

## 1. Run the helper

The skills folder is a symlink into the dashboard repo, which resolves it from the main checkout
or a worktree:

```bash
DASH="$(cd -P "$(git rev-parse --show-toplevel)/.claude/skills/../../.." && pwd)"
"$DASH/bin/up.sh" $ARGUMENTS
```

The script starts `node server.ts` in the background when port 4848 does not answer, waits for it
to come up, prints the URL and opens it with `open` (macOS). It is idempotent: when the server is
already running it only opens the page.

If `$DASH/bin/up.sh` does not exist, `.claude/skills` is not linked from the pipeline-dashboard
repo: say so, point at `/w-setup`, and stop.

## 2. Report back

One line: the URL that was opened (or the status / stop result) and, on a fresh start, the pid and
log path the script printed. If the script failed, show its stderr verbatim; the usual causes are
node older than 22 and a stale process on the port (`up.sh stop` then retry).

Do not touch the browser automation tools for this; the script opens the page itself.

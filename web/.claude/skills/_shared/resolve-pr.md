# Shared: Resolve a Pull Request From an Argument

Used by `/w-5-resolve-pr-comments`, `/w-7-attach-pr-visuals` and `/w-23-publish-review`. Input
is one of a ticket id, a PR URL, or a bare PR number; output is `<owner>/<repo>` plus the PR
number, confirmed open.

- `gh repo view --json nameWithOwner -q .nameWithOwner` → `<owner>/<repo>` (not needed for a
  full URL).
- **Ticket id** (`XWWP-\d+`):
  1. `.jira-plans/<TICKET-ID>/local-branch.md` — use `pr_url` (from `/w-4-publish`) or
     `release_pr_url` (from `/w-4-1-fast-track-push-to-release`). Both present → ask which.
  2. Neither → `gh pr list --search "<TICKET-ID> in:title" --state open --json number,url,headRefName`.
     Zero or more than one result → tell the user and ask for the PR link or number.
- **PR URL**: parse `<owner>/<repo>` and the number out of it.
- **Bare number**: use it against `<owner>/<repo>`.

Then confirm it's open with `gh pr view <number> --repo <owner>/<repo> --json state,...` (the
caller adds the fields it needs). Merged or closed → tell the user and stop.

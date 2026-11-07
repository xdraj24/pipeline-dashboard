---
name: w-8-enable-feature-flag
description: Turn a Web feature flag on (or change it) in a deployed environment (stg, pre, app) by editing AWS AppConfig's flag list in the nv-infrastructure repo, then branch, commit, push and open its PR. Use when a flag that exists in web's backend/flags.json has to be enabled outside localhost.
argument-hint: "<flag_name> <stg|pre|app>[,...] [<TICKET-ID>] [users=a@x.com,b@x.com]"
model: sonnet
effort: medium
---

# Enable a Web Feature Flag in a Deployed Environment

`web` reads flags from `backend/flags.json` only when `APP_ENV=dev`. Every deployed environment
reads them from AWS AppConfig, which is defined as code in `welligence/nv-infrastructure`. So
enabling a flag on stg, pre or app is a one-entry change to that repo's `cdk.json`, plus a PR.
The PR's merge and deploy are the human gate; this skill never deploys.

Host-specific mechanics (arguments, asking the developer):
`.claude/skills/_shared/host-runtime.md`. Every question goes through
`.claude/skills/_shared/slack-escalation.md`.

## 1. Parse the arguments

- The flag: accept `downloads_v2` or `DOWNLOADS_V2`. The AppConfig name is ALL CAPS with `_`;
  `lib/resources/app-config.ts` lowercases it, so it must equal a key in web's
  `Util::FeatureFlags::FLAGS` (`backend/app/services/util/feature_flags.rb`) once lowercased.
  If it isn't there, stop: the backend would ignore it.
- The environments: any of `dev`, `stg`, `pre`, `app`. Enable only the ones named; never widen to
  pre or app on your own.
- Optional ticket id (for the branch name and PR link) and an optional `users=` allowlist.
- Missing flag or environment → ask.

## 2. Get the repo

Clone it next to the web checkout if it isn't there, otherwise update it:

```bash
cd "$(git -C <web checkout> rev-parse --show-toplevel)/.."
[ -d nv-infrastructure ] || git clone git@github.com:welligence/nv-infrastructure.git
git -C nv-infrastructure checkout main && git -C nv-infrastructure pull --ff-only
```

Read its `README.md` § Managing Feature Flags before editing: it is the source of truth for the
format if it differs from this skill.

## 3. Edit `cdk.json`

The Web flags live at `context.app.AppConfig.applications[name = "Web"].flags` (the `dev` stack
has no Web app). Edit the text, not a re-serialised dump, so the diff stays one hunk.

- **New flag** → append an entry after the last Web flag:

  ```json
  {
    "name": "DOWNLOADS_V2",
    "description": "Enable the Downloads V2 page (/downloads) in the Web project.",
    "value": {
      "stg": true,
      "pre": false,
      "app": false
    }
  }
  ```

  List each environment explicitly (named ones `true`, the rest `false`); an omitted environment
  is disabled anyway, but explicit values make the rollout state readable. The description must
  say what the flag gates.
- **Existing flag** → change only the named environments' values.
- **User allowlist** → `"stg": { "enabled": true, "attributes": { "users": ["a@welligence.com"] } }`.

Validate: the file parses (`python3 -c "import json; json.load(open('cdk.json'))"`) and the new
or changed entry reads back as intended. `yarn build` / `yarn synth` need AWS credentials and are
not required for a `cdk.json`-only change.

## 4. Branch, commit, push, PR

- Branch: `feature/<TICKET-ID>-<flag-slug>-flag` (e.g. `feature/<TICKET-ID>-downloads-v2-flag`);
  without a ticket, `feature/<flag-slug>-flag` or `feature/<flag-slug>-<env>` for a rollout change.
- Commit, in the repo's style: `feat(appconfig): add DOWNLOADS_V2 flag for the Web app` (or
  `feat(appconfig): open <FLAG> to all of stg`, `chore(appconfig): ...`). Body: what the flag gates
  with the web PR, and which environments are on or off and why. Stage only `cdk.json`.
- `git push -u origin <branch>`, then `gh pr create --base main` with a short body (the repo has
  no PR template): one line on what the flag gates, linking the web PR and ticket; one line on
  which environments are on, plus "`app-config.ts` lowercases the name, so the backend reads it
  as `<flag_name>`"; one line "Dependency: welligence/web#<n> — the flag is inert until that
  ships." Follow `#228` and `#230` in that repo as examples.

## 5. Report back

The nv-infrastructure PR URL, the environments it turns on, and that the flag takes effect only
after the PR is merged and the CDK deploy runs (the repo's `deploy.yml` workflow), and on the
target environment only once the web code that reads the flag is deployed there. Also check the
web PR's description: if it says the flag still has to be created in AppConfig, point at this PR.

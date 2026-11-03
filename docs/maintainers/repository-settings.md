# Repository settings (official repository)

The repository is public: anyone may read, install, copy and fork it under the MIT license. Only the owner and explicitly authorized collaborators may change the official repository. RepoGuide does not try to prevent forks or changes in copies.

`CODEOWNERS` only defines reviewers — it does **not** restrict who can push. Write restriction comes from repository permissions (only the owner has write access unless collaborators are added) and from the rulesets below.

## Desired configuration

| Control | How | Definition |
|---|---|---|
| `main` requires PR, `ci-ok` check, resolved conversations; blocks force push and deletion. **No bypass** — applies to the owner too. | Ruleset | `github-settings/ruleset-main.json` |
| Owner (code owner) review for PRs by anyone else. The admin role may bypass **only when merging a PR** (`bypass_mode: pull_request`), so a single maintainer can merge their own PRs while PR + CI from the ruleset above still apply. | Ruleset | `github-settings/ruleset-owner-review.json` |
| Tags `v*` can only be created/updated/deleted by admins (release protection). | Tag ruleset | `github-settings/ruleset-release-tags.json` |
| `GITHUB_TOKEN` default permissions read-only; Actions cannot approve PRs. | Actions settings | `scripts/github-settings.mjs` |
| Approval required for workflows from all external contributors. | Actions settings | `scripts/github-settings.mjs` |
| `release` environment: owner approval required; only `v*` tags may deploy. | Environment | `scripts/github-settings.mjs` |
| Private vulnerability reporting enabled (channel used in `SECURITY.md`). | Security settings | `scripts/github-settings.mjs` |
| Collaborators inspected, never removed/added automatically. | Read-only | `scripts/github-settings.mjs` |

Why two branch rulesets: a single ruleset with "1 approval" would block a sole maintainer (GitHub does not let authors approve their own PRs). Splitting keeps PR + CI mandatory for everyone while only the review requirement has a narrow, PR-only admin exception.

## Applying

The implementation session could not write these settings: its GitHub proxy returned `403 Write access to this GitHub API path is not permitted through this proxy` for rulesets, Actions permissions, environments and private vulnerability reporting, and blocked reading collaborators. **None of these settings were applied.**

Apply them as the owner (requires GitHub CLI and Node.js):

```sh
gh auth login                                  # as tassiopereira
node scripts/github-settings.mjs               # shows current state and plan, writes nothing
node scripts/github-settings.mjs --apply       # applies, reads back and verifies each item
```

The `ci-ok` required check must have run at least once with that name (it runs on PR #1). Apply the rulesets after confirming CI passes on PR #1; otherwise the merge stays blocked until CI is green.

### Manual alternative (web UI)

1. **Settings → Rules → Rulesets → New branch ruleset**, target "Default branch": enable *Restrict deletions*, *Block force pushes*, *Require a pull request before merging* (0 approvals, *Require conversation resolution*), *Require status checks to pass* → add `ci-ok` (GitHub Actions). No bypass list.
2. Second branch ruleset, target "Default branch": *Require a pull request* with 1 approval and *Require review from Code Owners*; Bypass list → *Repository admin* → *For pull requests only*.
3. **New tag ruleset**, pattern `v*`: *Restrict creations, updates, deletions*; Bypass list → *Repository admin* (always).
4. **Settings → Actions → General**: Workflow permissions = *Read repository contents*; leave *Allow GitHub Actions to create and approve pull requests* off; *Approval for running fork pull request workflows* = *Require approval for all external contributors*.
5. **Settings → Environments → New environment `release`**: *Required reviewers* = tassiopereira; *Deployment branches and tags* = selected, add tag rule `v*`.
6. **Settings → Code security → Private vulnerability reporting** → Enable.
7. **Settings → Collaborators**: confirm only expected people have access.

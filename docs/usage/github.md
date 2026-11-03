# GitHub integration (opt-in)

Nothing here runs unless you enable it. `repoguide check` only *reads* public GitHub data (branch rules, PR search), uses `GITHUB_TOKEN`/`GH_TOKEN` if present, and caches results for 24 h. All write operations are separate commands.

## Workflows for your repository

```sh
repoguide init --github-workflows        # new install
repoguide github install-workflows       # existing install
```

This adds two managed workflows:

| Workflow | Trigger | Permissions | What it does |
|---|---|---|---|
| `repoguide-check.yml` | `pull_request`, manual | `contents: read` | Installs the CLI and runs `repoguide check --fail-on blocking`. Works for forks: `pull_request` gets a read-only token and no secrets; the job does not execute project code. No `pull_request_target`. |
| `repoguide-maintenance.yml` | weekly schedule, manual | per job (top-level `{}`) | `update-pr`: `contents: write`, `pull-requests: write`. `sync-issues` (only if repository variable `REPOGUIDE_SYNC_ISSUES=true`): `issues: write`. Runs on the default branch only. |

Repository variables (Settings → Secrets and variables → Actions → Variables):

- `REPOGUIDE_PACKAGE` — where to install the CLI from (default: the release tarball of the adopted version).
- `REPOGUIDE_FAIL_ON` — `blocking` (default), `pending`, `unknown` or `never`.
- `REPOGUIDE_SYNC_ISSUES` — `true` to enable issue tracking.
- `REPOGUIDE_UPDATE_PR` — `false` to disable update PRs.

## GITHUB_TOKEN restrictions (no broad PAT needed)

- To let `update-pr` open PRs with `GITHUB_TOKEN`, enable **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"**. Without it, the branch is created and the CLI reports the impediment (exit 5) so you can open the PR manually.
- PRs opened with `GITHUB_TOKEN` do **not** trigger other workflows (GitHub prevents recursive runs). Close and reopen the update PR, or push a commit, to run CI. Alternatively use a GitHub App token with `contents: write` and `pull-requests: write` — a fine-grained, repository-scoped credential, not a classic PAT.
- Organization policies may force the default workflow permissions to read-only; the per-job `permissions` blocks above request only what each job needs.

## Issue tracking

`repoguide github sync-issues [--dry-run]`:

- One issue per requirement and scope, labelled `repoguide` and identified by a hidden marker `<!-- repoguide:issue {"id":…,"scope":…} -->`.
- Re-runs do not create duplicates and do not comment when nothing changed (a state hash is stored in the body).
- It never edits issues without both the label and the marker.
- `met` closes as completed; valid waivers / not applicable close as *not planned* with a comment saying the requirement was **not** implemented; expiry reopens the issue. `unknown` (lack of evidence) keeps the issue open.

## Update PRs

`repoguide github update-pr [--dry-run]` compares the adopted version with the stable channel. If newer, it creates branch `repoguide/update-<version>` through the Git Data API and opens a PR describing changed files and decisions that will need review. Re-runs find the existing PR and do nothing. It never merges.

# Versions and updates

RepoGuide keeps four version numbers apart:

1. **RepoGuide version** (SemVer) — CLI and content are released together, e.g. `0.2.0`.
2. **Schema version** — format of the catalog and bundle (`schemaVersion`, currently 1). A CLI refuses content with a schema it does not support.
3. **Requirement revision** — per requirement (`revision`, `materialRevision`).
4. **Your project's version** — never touched by RepoGuide.

## Stable channel

Releases are published as GitHub releases of `tassiopereira/RepoGuide`. Each release has:

- `repoguide-content.json` — the content bundle (every file with its sha256),
- `stable.json` — the channel index (latest version, all versions with relative URLs and bundle sha256),
- `tassiopereira-repoguide-<version>.tgz` — the installable CLI package,
- `SHA256SUMS`.

The default channel URL is `https://github.com/tassiopereira/RepoGuide/releases/latest/download/stable.json`. Prereleases (`v1.0.0-rc.1`) are not "latest" and therefore never appear in the stable channel. Override with `--source`, `REPOGUIDE_SOURCE` or `.ai/config.json` `source` (HTTPS only; plain HTTP is accepted only for localhost, for tests).

## What `update` does

1. Downloads the index and the bundle (size limits, timeout) — or uses the bundled content with `--from-package` / `--offline`.
2. Verifies the bundle hash against the index, each file hash, the allowed file list, the schema and the catalog. Bundle paths cannot choose where files are written: destinations are fixed in the CLI.
3. Refuses downgrades (`--allow-downgrade`) and major changes (`--allow-major`); checks `minCliVersion`.
4. Detects local edits to managed files (`.ai/sdk/*`, the `AGENTS.md`/`CLAUDE.md` blocks, installed workflows). On conflict it aborts with a diagnosis (exit 4) and writes nothing.
5. Shows a diff. With `--dry-run` it stops here.
6. Applies all writes as one transaction: temp files, backup, rename; on failure everything is restored (exit 3). The lock file is written last.
7. Lists decisions that will require review because their requirement changed materially.

Checking for news (`check`) never adopts anything. The adopted version stays fixed until `update` or an approved update PR.

## Recovery

All changes are plain files in Git:

```sh
git diff                                         # review
git restore --staged --worktree AGENTS.md .ai    # undo before committing
git revert <commit>                              # undo after committing
```

## Limits of the integrity check

The hashes in `stable.json` come from the same origin (GitHub releases of this repository) as the content. They detect corruption and truncation, not a compromised origin or account. For independent verification, compare `SHA256SUMS` with a copy obtained through another channel, or pin a reviewed version with `--to`. Catalogs never contain commands: verification uses only checkers implemented in the CLI.

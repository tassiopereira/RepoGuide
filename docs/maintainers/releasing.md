# Releasing

Only the owner (or a process the owner approves) creates official releases. Nothing is published automatically from `main`.

## Steps

1. On a branch, bump `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`), update `content/meta.json` `highlights` (and `minCliVersion`/`schemaVersion` if needed), open a PR, wait for CI, merge.
2. Create and push the tag from the merged `main` (tag creation is restricted to repository admins by the `release-tags` ruleset):
   ```sh
   git checkout main && git pull
   git tag v0.1.0 && git push origin v0.1.0
   ```
3. The `Release` workflow builds, tests, verifies `tag == package.json version`, merges the previous `stable.json` and produces `repoguide-content.json`, `stable.json`, the `.tgz` and `SHA256SUMS`.
4. The `github-release` job waits for approval in the `release` environment (configure required reviewers — see repository-settings.md), then creates the GitHub release. Tags with `-` (e.g. `v1.0.0-rc.1`) become prereleases and stay out of the stable channel.

## npm (optional, disabled)

The npm name `repoguide` is taken by an unrelated package; this project uses `@tassiopereira/repoguide`. Before the first publish confirm the scope belongs to the owner (`npm access ls-packages tassiopereira` after `npm login`) and the name is still free (`npm view @tassiopereira/repoguide`).

To enable: configure **trusted publishing** on npmjs.com for this repository and the `release.yml` workflow (no long-lived token), create an `npm` environment with required reviewers, then set repository variable `NPM_PUBLISH=true`. The job publishes the exact tarball attached to the GitHub release with provenance.

## Local dry run

```sh
npm run build && npm run release:assets   # writes .release/ (git-ignored)
```

Point a test project at it with a local static server and `REPOGUIDE_SOURCE=http://127.0.0.1:<port>/stable.json`.

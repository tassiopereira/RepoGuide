# Examples (synthetic)

Two small fictional projects to try RepoGuide. They contain no real credentials or personal data.

- `existing-project/` — an app that already has its own `AGENTS.md`, a Sentry dependency without initialization and a Dependabot config that misses GitHub Actions.
- `new-project/` — an empty project.

Try them on a copy (so this repository stays clean):

```sh
npm run build
cp -r examples/existing-project /tmp/rg-demo && cd /tmp/rg-demo
node <path-to-RepoGuide>/build/src/bin.js init --dry-run
node <path-to-RepoGuide>/build/src/bin.js init
node <path-to-RepoGuide>/build/src/bin.js check --offline
node <path-to-RepoGuide>/build/src/bin.js explain RG-OBS-001 --offline
```

Expected for `existing-project` (offline): RG-OBS-001 pending (dependency without initialization), RG-DEP-001 pending (github-actions not covered), RG-PRD-001 pending (web frontend without analytics), RG-GOV-001 unknown (remote protection not verified). The existing `AGENTS.md` text stays untouched above the RepoGuide block.

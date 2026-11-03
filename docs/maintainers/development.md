# Development

## Layout

```
src/            CLI code (TypeScript, no runtime dependencies)
  bin.ts        executable entry
  cli.ts        argument parsing and dispatch
  commands/     one file per command
  lib/          core: catalog, decisions, install planner, transaction, checkers, remote, GitHub client
content/        distributable content — the only non-code part shipped to consumers
  sdk/          INSTRUCOES.md, requisitos.json (installed to .ai/sdk/)
  templates/    AGENTS.md/CLAUDE.md blocks, MAPA.md, VALIDACAO.md
  workflows/    optional consumer workflows
  meta.json     schemaVersion, minCliVersion, release highlights
test/           behaviour tests (node:test) with local mock servers
scripts/        clean, pack test, release assets
docs/usage/     user documentation
docs/maintainers/ this folder
examples/       synthetic consumer projects
.ai/, AGENTS.md, docs/ai/  RepoGuide adopted in its own repository (dogfood)
```

The npm package contains only `build/src`, `content`, READMEs and `LICENSE` (enforced by `npm run test:pack`).

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test            # builds, then runs node --test on build/test
npm run test:pack   # npm pack → install in a temp consumer → run the real binary
npm run dogfood     # repoguide check on this repository
```

Tests are hermetic: release downloads and the GitHub API are simulated with local HTTP servers (`test/helpers.ts`). No test uses real credentials or a public release. Tests that talk to a mock are simulations — they do not prove anything about GitHub's live behaviour.

## Adding or changing a requirement

1. Edit `content/sdk/requisitos.json`. Increment `revision` on any change; set `materialRevision = revision` when existing decisions must be re-evaluated.
2. If verification needs new logic, add a checker in `src/lib/checkers.ts` and register it in `CHECKERS`. Catalogs only reference checker ids; they never contain commands.
3. A checker must never return "met" from a dependency or file name alone. Return `staticOk: null` (unknown) with a reason when it cannot decide.
4. Add tests for positive, negative and unknown cases.

## Dogfooding without circularity

This repository has adopted RepoGuide (`AGENTS.md` block, `.ai/`, `docs/ai/`). Build and tests never read those files. CI runs `node build/src/bin.js check --offline` after the build, using the freshly built CLI. To refresh the adopted content after changing `content/`: `npm run build && node build/src/bin.js update --from-package`.

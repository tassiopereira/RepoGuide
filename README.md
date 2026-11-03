# RepoGuide

[Português](README.pt-BR.md)

RepoGuide installs a small, versioned set of instructions for AI coding assistants into your repository and tracks engineering requirements (error monitoring, usage analytics, dependency updates, PR workflow) until they are met — or explicitly deferred, waived or declared not applicable by a person.

- **Local first.** No LLM calls, no account, no server, no paid service. Works offline.
- **Small context for the AI.** One short `repoguide check` at the start of a session; details only on demand with `repoguide explain <id>`.
- **Your files stay yours.** It inserts one delimited block into `AGENTS.md` and never overwrites project docs.
- **Honest results.** A dependency or config file is never treated as proof. Results are `met`, `pending`, `unknown` (with a reason) or `error`.
- **Optional GitHub integration.** PR check, update PRs and one issue per requirement — opt-in, least-privilege, never auto-merges.

> **Language:** the distributed instructions and CLI messages are in Brazilian Portuguese (pt-BR). This README is in English.

## Status

Version `0.1.0`, not yet published to npm. The npm name `repoguide` belongs to an unrelated project; this package is prepared as `@tassiopereira/repoguide` (binary: `repoguide`). Until a release exists, use the local install below. **`npx @tassiopereira/repoguide` does not work yet.**

## Install (works today, from source)

Requires Node.js 22 or newer (current LTS lines: 22, 24, 26).

```sh
git clone https://github.com/tassiopereira/RepoGuide.git
cd RepoGuide
npm ci
npm run build
npm pack                      # creates tassiopereira-repoguide-0.1.0.tgz
```

Then, in the project that will adopt it:

```sh
npm install --save-dev /path/to/RepoGuide/tassiopereira-repoguide-0.1.0.tgz
npx --no-install repoguide --version
```

Or globally: `npm install -g /path/to/RepoGuide/tassiopereira-repoguide-0.1.0.tgz`.

*After the first GitHub release* (planned, not available yet), the tarball will be attached to each release:
`npm install -g https://github.com/tassiopereira/RepoGuide/releases/download/v0.1.0/tassiopereira-repoguide-0.1.0.tgz`.

## Use in a new or existing project

```sh
repoguide init --dry-run      # see what would change
repoguide init                # install
git diff                      # review, then commit via PR
```

`init` creates:

```
AGENTS.md                 ← existing content preserved; one <!-- repoguide:begin/end --> block added
.ai/sdk/INSTRUCOES.md     ← managed by RepoGuide
.ai/sdk/requisitos.json   ← managed requirement catalog
.ai/sdk.lock.json         ← adopted version, schema, hashes
.ai/decisoes.json         ← your explicit decisions
.ai/.gitignore            ← ignores .ai/.cache (local cache)
docs/ai/MAPA.md           ← yours (created once, never overwritten)
docs/ai/VALIDACAO.md      ← yours (created once, never overwritten)
```

Options: `--claude` (adds a short `@AGENTS.md` import to `CLAUDE.md`), `--github-workflows`, `--scope web=apps/web` for monorepos. Running `init` again changes nothing.

## Check

```text
$ repoguide check
RepoGuide adotado: 0.1.0 | Disponível: 0.2.0
Pendências: 2 | Revisões: 0 | Desconhecidos: 1 | Adiados: 0 | Dispensas válidas: 1 | N/A: 0 | Atendidos: 1
Novidade: política de PR revisada.
Atualização disponível: repoguide update --dry-run (adoção só ocorre com update explícito)
- RG-DEP-001 pendente: ecossistemas sem cobertura: github-actions
- RG-OBS-001 pendente: dependência presente, mas nenhuma inicialização encontrada no código
- RG-GOV-001 desconhecido: proteção remota não verificada (modo offline)
Detalhes: repoguide explain <id>
```

`check` never edits decisions, code, the adopted version or GitHub; it only refreshes a git-ignored cache (remote lookups are cached for 24 h; `--refresh` forces, `--offline` skips). Use `--json` for a stable machine format. Ordinary pending items do not fail CI; see [exit codes](docs/usage/commands.md#exit-codes) and `--fail-on`.

## Update

```sh
repoguide update --dry-run    # show diffs for the latest stable release
repoguide update              # adopt it (atomic; aborts on local edits to managed files)
```

Checking for news never adopts anything. Major versions require `--allow-major`. Recovery is plain Git: `git restore --staged --worktree AGENTS.md .ai`. Details: [docs/usage/updates.md](docs/usage/updates.md).

## Defer, waive, not applicable

Decisions require a reason and a declared owner. Deferrals require an expiry date; expired or outdated decisions come back as "review required".

```sh
repoguide requirement defer RG-OBS-001 --until 2026-12-31 --reason "Launch in January" --by "Maria"
repoguide requirement waive RG-DEP-001 --reason "Repository will be archived" --by "Maria"
repoguide requirement not-applicable RG-PRD-001 --reason "Internal API, no audience" --by "Maria"
repoguide requirement attest RG-OBS-001 --note "Test error captured; alert received in #ops" --by "Maria"
repoguide requirement reset RG-OBS-001 --reason "Monitoring deployed" --by "Maria"
```

The name in `--by` is a declaration, not authentication: governance happens in GitHub PR review. AI assistants are instructed never to record decisions to turn checks green. See [docs/usage/requirements.md](docs/usage/requirements.md).

## Compatibility and limitations

- Node.js ≥ 22 on Windows, Linux and macOS (CI covers all three).
- Detection is static and bounded (it does not read your whole repository). Operational facts — alerts firing, analytics data arriving — cannot be observed locally; they are `unknown` until a person attests them (attestations expire, max 365 days).
- AI tools differ in which entry file they load. Many read `AGENTS.md`; Claude Code reads it when there is no `CLAUDE.md` (otherwise use `--claude`). RepoGuide does not guarantee any tool loads it automatically. See [docs/usage/ai-tools.md](docs/usage/ai-tools.md).
- Release hashes come from the same origin as the content: they detect corruption, not a compromised origin. See [docs/usage/updates.md](docs/usage/updates.md).

## Documentation

- Users: [commands](docs/usage/commands.md) · [requirements & decisions](docs/usage/requirements.md) · [updates](docs/usage/updates.md) · [GitHub integration](docs/usage/github.md) · [AI tools](docs/usage/ai-tools.md) · [examples](examples/)
- Maintainers: [development](docs/maintainers/development.md) · [releasing](docs/maintainers/releasing.md) · [repository settings](docs/maintainers/repository-settings.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License (MIT)](LICENSE)

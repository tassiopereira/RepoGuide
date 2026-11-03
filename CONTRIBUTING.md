# Contributing

Thanks for your interest. RepoGuide is public: anyone may use, copy and fork it under the [MIT license](LICENSE). Changes to this official repository are made only by the owner (@tassiopereira) and explicitly authorized collaborators.

**External contributions are proposals made through pull requests.** Fork the repository, work on a branch and open a PR. The owner reviews and decides; opening a PR does not grant any access.

Before opening a PR:

1. Open or reference an issue for non-trivial changes (use the "Proposta" template for new catalog requirements).
2. Keep the change focused; no unrelated refactors.
3. Run `npm run lint`, `npm run typecheck`, `npm test` and, when packaging/CLI/content changes, `npm run test:pack`.
4. For changes in `content/`, follow [docs/maintainers/development.md](docs/maintainers/development.md#adding-or-changing-a-requirement): revisions, material revisions, no vendor lock-in, no commands in the catalog.
5. Never include credentials or real personal data in code, tests or examples.

Workflows from first-time and external contributors require maintainer approval before running. Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

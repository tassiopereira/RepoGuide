# Requirements, results and decisions

## Catalog

The catalog lives in `.ai/sdk/requisitos.json` (managed; do not edit). Each requirement has a stable `id`, its own `revision`, a `materialRevision` (last change that invalidates earlier decisions), title, description, category, `introducedIn`, applicability, acceptance criteria (each tagged `static`, `operational` or `human`), suggested tools and accepted equivalents, severity, `blocking`, how it is verified, implementation guidance and a decision policy (maximum deferral/waiver, and whether a material revision requires review).

Initial requirements:

| ID | Title | Scope | Example tool | Accepted equivalents |
|---|---|---|---|---|
| RG-OBS-001 | Production error monitoring | per application | Sentry | Bugsnag, Rollbar, Datadog, New Relic, … |
| RG-PRD-001 | Usage / audience analytics | per application (depends on product) | Google Analytics | Plausible, Matomo, PostHog, … |
| RG-DEP-001 | Automated dependency updates | repository | Dependabot | Renovate |
| RG-GOV-001 | New features via pull request | repository | GitHub rulesets | classic branch protection |

RepoGuide never adds tracking, SDKs or configuration to your code. It only observes.

## Observed result vs. human decision

- **Result** (observed): `met`, `pending`, `unknown` (with a reason) or `error`.
- **Decision** (human): none, `deferred`, `waived` or `not-applicable`.
- **Effective state**: combination of both plus revision and expiry: `met`, `pending`, `unknown`, `error`, `deferred`, `waived`, `not-applicable`, `review-required`.

Evidence kinds are kept separate:

- **static** — something seen in files (a dependency, an init call, a config file). Never sufficient alone for operational criteria.
- **operational** — something observed remotely (e.g. GitHub rules requiring PRs, recent Dependabot PRs). Cached for the TTL only; never trusted forever.
- **human** — an attestation (`repoguide requirement attest`) that a person verified an operational fact. Expires (default 180 days, max 365) and is invalidated by a material revision.

`met` requires all static criteria observed *and* operational criteria either observed or attested. "Deferred" means tracked, not met.

## Decisions

```sh
repoguide requirement defer <id> --until YYYY-MM-DD --reason "..." --by "Name" [--scope <id>]
repoguide requirement waive <id> --reason "..." --by "Name" [--review-by YYYY-MM-DD]
repoguide requirement not-applicable <id> --reason "..." --by "Name"
repoguide requirement attest <id> --note "what was verified, how" --by "Name" [--until YYYY-MM-DD] [--evidence URL]
repoguide requirement reset <id> --reason "..." --by "Name" [--attestation]
```

Rules:

- A reason (≥ 10 characters) and a declared owner are mandatory. Non-interactive runs fail if they are missing.
- Each decision records the date and the requirement revision.
- Deferrals need an expiry within the requirement's `maxDeferralDays`. Waivers get a review date (default: the policy maximum, when there is one).
- Expired decisions and decisions older than the requirement's `materialRevision` come back as `review-required`.
- Replacing or resetting a decision moves the old one to `history` in the same file. Nothing is removed silently; Git history provides traceability.

**Governance:** the name in `--by` is a declaration, not authentication. Review of `.ai/decisoes.json` changes in pull requests (with CODEOWNERS and branch rules) is the governance mechanism.

**AI assistants** are instructed (in `.ai/sdk/INSTRUCOES.md` and the `AGENTS.md` block) not to record decisions to make checks pass. They may record a decision only when the user explicitly authorizes it, with the reason and owner provided by the user.

## Monorepos

Declare application scopes in `.ai/config.json` (or `repoguide init --scope web=apps/web --scope api=apps/api`). Repository-level requirements (RG-DEP-001, RG-GOV-001) are evaluated once with scope `repo`; application-level requirements are evaluated per scope, each with independent decisions (`--scope` is then required).

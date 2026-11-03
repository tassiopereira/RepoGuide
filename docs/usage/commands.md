# Command reference

All commands accept `-C, --cwd <dir>` (project directory), `--json` (stable JSON output), `--no-input` (never prompt) and `--help`. The CLI never prompts when `--json`, `--no-input`, `CI` is set or stdin is not a TTY; missing required arguments then fail with exit code 2.

| Command | Writes files? | Network | Purpose |
|---|---|---|---|
| `repoguide init` | yes (`--dry-run` available) | no | Install into a new or existing project from the content bundled in the CLI. Idempotent. |
| `repoguide check` | only `.ai/.cache/` | optional (`--offline`) | Short status for the start of a session or task. |
| `repoguide explain <id>` | only `.ai/.cache/` | optional | Full details of one requirement. |
| `repoguide update` | yes (`--dry-run`) | yes, unless `--from-package`/`--offline` | Explicitly adopt another version. |
| `repoguide doctor` | no | optional | Diagnose installation, integrity, scopes, cache, channel. |
| `repoguide requirement <action> <id>` | `.ai/decisoes.json` (`--dry-run`) | no | `defer`, `waive`, `not-applicable`, `attest`, `reset`. |
| `repoguide github sync-issues` | GitHub issues (`--dry-run`) | yes | One managed issue per requirement and scope. |
| `repoguide github update-pr` | GitHub branch + PR (`--dry-run`) | yes | Open an update PR; never merges. |
| `repoguide github install-workflows` | `.github/workflows/` (`--dry-run`) | if versions differ | Install the optional workflows for the adopted version. |

## check options

`--offline`, `--refresh` (ignore the 24 h cache), `--timeout <ms>` (default 5000), `--fail-on blocking|pending|unknown|never` (default `blocking`), `--max-items <n>` (default 5), `--repo owner/name`, `--no-cache`.

Cache TTL and network timeout can be set per project in `.ai/config.json`:

```json
{ "cacheTtlHours": 24, "timeoutMs": 5000, "blocking": ["RG-GOV-001"], "scopes": [{ "id": "web", "path": "apps/web" }] }
```

`blocking` promotes requirements to blocking for this project: pending or review-required items become violations (exit 1).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. `check`: no blocking violations (pending items may exist). |
| 1 | `check`: blocking violation (blocking requirement pending, or managed files modified) or the `--fail-on` threshold was reached. |
| 2 | Invalid usage or arguments (including missing required arguments in non-interactive mode). |
| 3 | Execution failure: not installed, invalid JSON/catalog/decisions, I/O failure, aborted apply (rolled back). `doctor` returns 3 when a diagnostic fails. |
| 4 | Conflict: managed file edited locally, corrupted/ambiguous `AGENTS.md` delimiters, existing branch. Nothing was written. |
| 5 | Remote failure: network, timeout, invalid/tampered release, unsupported schema, GitHub refusal. Nothing was written locally. |

## JSON output

Every command with `--json` prints one object:

```json
{
  "repoguide": { "cliVersion": "0.1.0", "command": "check", "jsonSchema": 1 },
  "ok": true,
  "exitCode": 0,
  "...": "command payload"
}
```

Errors: `{ "ok": false, "exitCode": N, "error": { "message", "hint?", "details?" } }`.

`check` payload: `project`, `remote` (`checked`, `fromCache`, `latest`, `updateAvailable`, `ageSeconds`, `highlights`, `error`), `counts` (by effective state), `violations`, `integrity`, `items[]` (`id`, `scope`, `result`, `effective`, `blocking`, `severity`, `reason`, `decision`), `failOn`. New fields may be added; existing fields keep their meaning while `jsonSchema` is 1.

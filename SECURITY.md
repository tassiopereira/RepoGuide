# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting:

**https://github.com/tassiopereira/RepoGuide/security/advisories/new**

(Repository → Security → Report a vulnerability.) Include the affected version (`repoguide --version`), steps to reproduce and impact. You will get a response through the advisory.

## Supported versions

Only the latest released minor version receives fixes while the project is in `0.x`.

## Scope notes

- RepoGuide never executes commands from downloaded catalogs; verification uses only checkers built into the CLI.
- Release hashes are published by the same origin as the content and detect corruption, not a compromised origin (see docs/usage/updates.md).
- Workflows provided to consumers request minimal permissions and do not use `pull_request_target`.

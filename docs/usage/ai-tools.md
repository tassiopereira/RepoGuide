# AI tools and entry files

RepoGuide writes its entry point into `AGENTS.md` (a delimited block) and keeps the canonical instructions in `.ai/sdk/INSTRUCOES.md`. Whether a tool reads `AGENTS.md` automatically depends on the tool and its version — **RepoGuide does not promise that any tool loads it**. If yours does not, point it to `AGENTS.md` in its own configuration.

## Claude Code

According to the [Claude Code memory documentation](https://code.claude.com/docs/en/memory) (checked 2026-11-03):

- Recent versions (v2.1.277+) read `AGENTS.md` when there is no `CLAUDE.md`/`CLAUDE.local.md` in the working directory or above it.
- If a `CLAUDE.md` exists, Claude Code reads it instead; the documented way to include `AGENTS.md` is an `@AGENTS.md` import inside `CLAUDE.md`.

`repoguide init --claude` (or `repoguide update --claude`) inserts a short managed block with `@AGENTS.md` into `CLAUDE.md` (creating it if absent). It does not duplicate the instructions. `repoguide doctor` warns when a `CLAUDE.md` exists without that import.

## Token economy

- The block asks for one `repoguide check` at the start of a session or task — not on every message.
- `check` prints at most ~12 lines; details are only shown by `repoguide explain <id>`.
- Checks never call an LLM and never read the whole repository: scans are bounded (depth, file count, file size) and per-file results are cached by size and modification time.

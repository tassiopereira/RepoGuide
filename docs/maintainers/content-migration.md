# Migration of the original kit (pending)

The implementation request listed the original kit files as the base of the distributed content:
`LEIA-ME.md`, `AGENTS.md`, `MAPA.md`, `VALIDACAO.md`, `ARQUITETURA.template.md`, `DECISAO.template.md`, `PLANO.template.md`, `01-ADOTAR-PROJETO-EXISTENTE.md`, `02-ADOTAR-PROJETO-NOVO.md`, `03-EXECUTAR-TAREFA.md`, `04-RETOMAR-TRABALHO.md`.

**These files were not available** during the initial implementation (not attached, not present in the repository or the local working folder). They were not read.

The content in `content/` was written from the principles stated in the request (progressive discovery, reuse before creating, minimal docs and canonical sources, facts vs. hypotheses vs. proposals, proportional validation, human-readable code, no extensive reports by default, no out-of-scope work). The faithful migration is pending:

1. Add the original files to a branch.
2. Merge their wording into `content/sdk/INSTRUCOES.md` (keep it short; it is read every session) and `content/templates/MAPA.md` / `VALIDACAO.md`.
3. Decide whether `ARQUITETURA`, `DECISAO` and `PLANO` templates and the 01–04 flows become additional managed files (`content/sdk/fluxos/…`, requiring an allowed path in `src/lib/content.ts`) or sections of `INSTRUCOES.md`.
4. Bump the version; consumers adopt it via `repoguide update`.

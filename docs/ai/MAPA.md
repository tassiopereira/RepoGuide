# Mapa do projeto

> Documento do projeto (não gerenciado pelo RepoGuide).

## Visão geral
CLI `repoguide` (Node.js ≥ 22, TypeScript) que instala orientações para IA em repositórios e acompanha requisitos de engenharia localmente, com integração opcional ao GitHub.

## Onde fica cada coisa
- `src/commands/` — um arquivo por comando (`init`, `check`, `explain`, `update`, `doctor`, `requirement`, `github`).
- `src/lib/install.ts` — planejamento de instalação/atualização (conflitos, blocos, lock). `fsx.ts` — caminhos seguros e transação.
- `src/lib/checkers.ts` — verificadores dos requisitos; `evaluate.ts` — resultado × decisão → estado efetivo.
- `src/lib/remote.ts` — canal estável (releases); `github.ts` — cliente REST mínimo.
- `content/` — conteúdo distribuível. `test/` — testes de comportamento. `scripts/` — empacotamento e release.

## Fontes canônicas
- Catálogo: `content/sdk/requisitos.json` (validação em `src/lib/catalog.ts`).
- Códigos de saída: `src/lib/errors.ts` (documentados em `docs/usage/commands.md`).
- Caminhos instalados no consumidor: `src/lib/content.ts` e `src/lib/project.ts` (`PATHS`).

## Componentes reutilizáveis
- `safeJoin`, `atomicWrite`, `Transaction` (`src/lib/fsx.ts`); `httpFetch` com timeout/limite (`src/lib/net.ts`); helpers de teste em `test/helpers.ts` (`run`, `releaseServer`, `listen`).

## Pontos de atenção
- Migração fiel do kit original pendente: `docs/maintainers/content-migration.md`.
- Hashes normalizam CRLF→LF para funcionar em checkouts Windows.

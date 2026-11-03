# Validação

> Documento do projeto (não gerenciado pelo RepoGuide).

## Rápida (a cada alteração pequena)
- `npm run typecheck`
- `npm run build && node --test build/test/<arquivo>.test.js`

## Completa (antes de abrir PR)
- `npm run lint && npm run typecheck && npm test && npm run test:pack`
- `npm run dogfood`

## Manual (quando não houver automação)
- Em uma cópia de `examples/existing-project`, rode `init`, `check --offline` e `explain` e compare com `examples/README.md`.

## Não executar sem autorização
- Criar tags `v*`, publicar releases ou pacotes, alterar rulesets/configurações do repositório.

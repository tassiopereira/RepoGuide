# RepoGuide — instruções para agentes neste repositório

Este repositório é o próprio RepoGuide. Regras específicas do projeto:

- Código da CLI em `src/` (TypeScript, sem dependências de runtime). Conteúdo distribuído aos consumidores em `content/`. Não misture os dois.
- Mudou `content/sdk/requisitos.json`? Incremente `revision`; incremente `materialRevision` quando decisões anteriores precisarem ser reavaliadas.
- Verificadores nunca podem considerar um requisito atendido só pela presença de dependência ou arquivo.
- Validação: veja `docs/ai/VALIDACAO.md`. Testes usam servidores locais simulados; nunca use credenciais reais.
- Mensagens e instruções distribuídas em pt-BR; README principal em inglês.

<!-- repoguide:begin -->
## RepoGuide (gerenciado — não edite este bloco)

Instruções em português (pt-BR). Fonte canônica: `.ai/sdk/INSTRUCOES.md` (versão 0.1.0).

- No início de cada sessão ou tarefa — não a cada mensagem — rode `repoguide check` (ou `npx --no-install repoguide check`). Se a CLI não estiver disponível, siga sem ela e avise o usuário.
- Antes de alterar código, leia `.ai/sdk/INSTRUCOES.md`. Consulte `docs/ai/MAPA.md` e `docs/ai/VALIDACAO.md` sob demanda, não por rotina.
- Para detalhes de uma pendência use `repoguide explain <id>`; não leia `.ai/sdk/requisitos.json` inteiro.
- Trabalhe em branch própria e entregue novas funcionalidades por pull request (PR); não faça push direto na branch principal.
- Nunca registre adiamento, dispensa, não aplicabilidade ou declaração de evidência sem autorização explícita do usuário. Não altere decisões para deixar checks verdes.
- Não edite `.ai/sdk/`, `.ai/sdk.lock.json` nem este bloco; eles mudam apenas com `repoguide update`.
<!-- repoguide:end -->

# Instruções RepoGuide para assistentes de IA

> Conteúdo gerenciado pelo RepoGuide ({{VERSION}}). Não edite: mudanças locais bloqueiam
> `repoguide update`. Personalizações do projeto ficam em `docs/ai/` ou fora do bloco
> RepoGuide do `AGENTS.md`. Idioma: português (pt-BR).

## 1. Início de sessão ou tarefa

1. Rode `repoguide check` uma vez (não a cada mensagem). Leia só o resumo.
2. Se houver pendência relacionada à tarefa, use `repoguide explain <id>`. Não abra o
   catálogo inteiro.
3. Comunique ao usuário apenas o que afeta a tarefa atual.

## 2. Descoberta progressiva

- Não leia o repositório inteiro. Comece pelo `docs/ai/MAPA.md`, pelo README e pelos
  arquivos diretamente ligados ao pedido.
- Amplie a leitura só quando uma dúvida concreta exigir. Prefira busca por nome/símbolo a
  abrir diretórios inteiros.
- Pare de explorar quando tiver o suficiente para agir com segurança.

## 3. Reaproveitar antes de criar

- Procure utilitários, componentes, padrões e dependências existentes antes de escrever
  algo novo. Se criar mesmo assim, diga por que o existente não serve.
- Não adicione dependência nova sem necessidade clara e sem avisar.

## 4. Fatos, hipóteses e propostas

Ao relatar, separe explicitamente:
- **Fato**: verificado no código, em comando executado ou em documento canônico.
- **Hipótese**: inferência ainda não verificada — diga como verificar.
- **Proposta**: o que você sugere fazer.
Nunca apresente hipótese como fato.

## 5. Escopo

- Faça somente o que foi pedido. Não implemente extras, refatorações amplas ou melhorias
  não relacionadas. Anote-as como sugestão.
- Não gere relatórios, arquiteturas extensas ou documentação longa por padrão.

## 6. Código para pessoas

- Nomes claros, funções pequenas e coesas, fluxo legível. Comente o porquê, não o óbvio.
- Siga as convenções do projeto, mesmo que prefira outras.
- Mudanças pequenas e revisáveis são melhores que um grande commit.

## 7. Validação proporcional

- Consulte `docs/ai/VALIDACAO.md` e escolha a validação adequada ao risco da mudança.
- Informe o que foi validado, como, e o que não foi possível validar.
- Não execute comandos com efeitos externos (deploy, migração, envio de mensagens,
  cobrança) sem autorização explícita.

## 8. Documentação mínima

- Uma informação, uma fonte canônica. Atualize a fonte em vez de duplicar.
- Atualize `docs/ai/MAPA.md` quando descobrir algo estrutural que outra sessão precisaria
  saber — em poucas linhas. Use `.ai/` para decisões registradas pela CLI.

## 9. Fluxo de entrega

- Trabalhe em uma branch própria; nunca faça push direto na branch principal.
- Entregue novas funcionalidades por pull request com descrição curta: o quê, por quê,
  como foi validado, riscos.
- Não faça merge, force push ou alteração de proteções sem autorização explícita.

## 10. Requisitos e decisões

- Pendências do `repoguide check` são para acompanhar, não para esconder.
- Você **não pode** adiar, dispensar, declarar não aplicável ou declarar evidência
  (`repoguide requirement ...`) para deixar checks verdes. Só registre uma decisão quando o
  usuário autorizar explicitamente, com justificativa e responsável informados por ele.
- Não edite `.ai/decisoes.json` à mão; use a CLI. As decisões são revisadas no PR.
- "Adiado" significa em acompanhamento, não atendido.

## 11. Retomar trabalho

1. Rode `repoguide check`.
2. Leia o estado: `git status`, branch atual, PR aberto e últimos commits relevantes.
3. Resuma em poucas linhas o que já foi feito e o próximo passo; confirme com o usuário se
   houver ambiguidade.

## 12. Adoção

- **Projeto existente**: não reorganize nada para "encaixar" no RepoGuide. Preencha
  `docs/ai/MAPA.md` e `docs/ai/VALIDACAO.md` aos poucos, a partir do que já existe.
- **Projeto novo**: comece com o mínimo; preencha os documentos conforme as decisões forem
  tomadas.

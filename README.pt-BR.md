# RepoGuide

[English](README.md)

O RepoGuide instala no seu repositório um conjunto pequeno e versionado de orientações para assistentes de IA e acompanha requisitos de engenharia (monitoramento de erros, análise de uso, atualização de dependências, fluxo por PR) até serem atendidos — ou explicitamente adiados, dispensados ou declarados não aplicáveis por uma pessoa.

- **Local.** Sem chamadas a LLM, conta, servidor ou serviço pago. Funciona offline.
- **Pouco contexto para a IA.** Um `repoguide check` curto no início da sessão; detalhes só com `repoguide explain <id>`.
- **Seus arquivos continuam seus.** Insere um único bloco delimitado no `AGENTS.md` e nunca sobrescreve documentos do projeto.
- **Resultados honestos.** Dependência ou arquivo de configuração nunca é tratado como prova. Resultados: `atendido`, `pendente`, `desconhecido` (com motivo) ou `erro de verificação`.
- **Integração opcional com GitHub.** Check em PR, PRs de atualização e uma issue por requisito — opt-in, permissões mínimas, nunca faz merge automático.

## Situação

Versão `0.1.0`, ainda não publicada no npm. O nome `repoguide` no npm pertence a outro projeto; o pacote está preparado como `@tassiopereira/repoguide` (binário `repoguide`). Até existir uma release, use a instalação local abaixo. **`npx @tassiopereira/repoguide` ainda não funciona.**

## Instalação (funciona hoje, a partir do código)

Requer Node.js 22 ou superior.

```sh
git clone https://github.com/tassiopereira/RepoGuide.git
cd RepoGuide
npm ci
npm run build
npm pack                      # gera tassiopereira-repoguide-0.1.0.tgz
```

No projeto que vai adotar:

```sh
npm install --save-dev /caminho/RepoGuide/tassiopereira-repoguide-0.1.0.tgz
npx --no-install repoguide --version
```

Ou global: `npm install -g /caminho/RepoGuide/tassiopereira-repoguide-0.1.0.tgz`.

*Após a primeira release no GitHub* (planejada, ainda indisponível), o pacote ficará anexado à release:
`npm install -g https://github.com/tassiopereira/RepoGuide/releases/download/v0.1.0/tassiopereira-repoguide-0.1.0.tgz`.

## Uso em projeto novo ou existente

```sh
repoguide init --dry-run      # mostra o que mudaria
repoguide init                # instala
git diff                      # revise e versione via PR
```

Estrutura criada: veja o [README em inglês](README.md#use-in-a-new-or-existing-project). `AGENTS.md` existente é preservado (só um bloco `<!-- repoguide:begin/end -->` é inserido); `docs/ai/MAPA.md` e `docs/ai/VALIDACAO.md` pertencem ao projeto e nunca são sobrescritos. Opções: `--claude`, `--github-workflows`, `--scope web=apps/web` (monorepo). Repetir `init` não altera nada.

## Check

```sh
repoguide check               # resumo curto para o início da sessão
repoguide check --json        # formato estável para automação
repoguide check --offline     # sem rede; informa a idade da última consulta
repoguide explain RG-OBS-001  # detalhes de um requisito
```

O `check` não altera decisões, código, versão adotada nem o GitHub; só atualiza um cache ignorado pelo Git (consultas remotas valem 24 h). Pendências comuns não quebram o CI; veja os [códigos de saída](docs/usage/commands.md#exit-codes).

## Atualização

```sh
repoguide update --dry-run    # diferenças da última versão estável
repoguide update              # adota (atômico; aborta se arquivos gerenciados foram editados)
```

Consultar novidades não adota nada. Versões principais exigem `--allow-major`. Recuperação via Git: `git restore --staged --worktree AGENTS.md .ai`.

## Adiamento, dispensa e não aplicabilidade

```sh
repoguide requirement defer RG-OBS-001 --until 2026-12-31 --reason "Lançamento em janeiro" --by "Maria"
repoguide requirement waive RG-DEP-001 --reason "Repositório será arquivado" --by "Maria"
repoguide requirement not-applicable RG-PRD-001 --reason "API interna sem público" --by "Maria"
repoguide requirement attest RG-OBS-001 --note "Erro de teste capturado; alerta no #ops" --by "Maria"
repoguide requirement reset RG-OBS-001 --reason "Monitoramento implantado" --by "Maria"
```

O nome em `--by` é uma declaração, não autenticação: a governança acontece na revisão do PR no GitHub. As instruções proíbem a IA de registrar decisões para deixar checks verdes. Detalhes: [docs/usage/requirements.md](docs/usage/requirements.md).

## Compatibilidade e limitações

- Node.js ≥ 22 em Windows, Linux e macOS.
- A detecção é estática e limitada (não lê o repositório inteiro). Fatos operacionais — alertas disparando, dados de uso chegando — não são observáveis localmente; ficam `desconhecido` até uma pessoa declarar (declarações vencem, máximo 365 dias).
- Ferramentas de IA carregam arquivos de entrada diferentes; o RepoGuide não garante carregamento automático do `AGENTS.md`. Veja [docs/usage/ai-tools.md](docs/usage/ai-tools.md).
- Os hashes das releases vêm da mesma origem do conteúdo: detectam corrupção, não uma origem comprometida.

Documentação de uso em [docs/usage/](docs/usage/), de manutenção em [docs/maintainers/](docs/maintainers/). Licença: [MIT](LICENSE).

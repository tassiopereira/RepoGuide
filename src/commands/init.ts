import { loadBundledContent } from "../lib/content.js";
import { ExitCode, RgError, usageError } from "../lib/errors.js";
import { readJsonIfExists, safeJoin } from "../lib/fsx.js";
import { applyPlan, planInstall } from "../lib/install.js";
import { PATHS, parseLock, resolveRoot } from "../lib/project.js";
import { nowFromEnv, result, type CommandResult, type Globals } from "./common.js";
import { describePlan } from "./plan-output.js";

export const INIT_HELP = `Uso: repoguide init [opções]

Instala o RepoGuide em um projeto novo ou existente usando o conteúdo embutido nesta CLI
(funciona offline). Preserva AGENTS.md e documentos existentes: insere apenas um bloco
delimitado. Idempotente: repetir o comando não altera nada.

Opções:
  -C, --cwd <dir>          Diretório do projeto (padrão: atual)
      --dry-run            Mostra o que seria feito, sem escrever
      --claude             Também referencia AGENTS.md a partir de CLAUDE.md (@AGENTS.md)
      --github-workflows   Instala workflows opcionais em .github/workflows
      --scope <id=caminho> Escopo de aplicação (monorepo). Repita para vários.
      --json               Saída JSON

Exemplos:
  repoguide init
  repoguide init --dry-run
  repoguide init --scope web=apps/web --scope api=apps/api
`;

export interface InitFlags {
  "dry-run"?: boolean;
  claude?: boolean;
  "github-workflows"?: boolean;
  scope?: string[];
}

export function parseScopes(list: string[] | undefined): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  for (const s of list ?? []) {
    const m = /^([a-z0-9][a-z0-9-]{0,39})=(.+)$/.exec(s);
    if (!m || m[1] === "repo") throw usageError(`--scope inválido: ${s}`, 'Use id=caminho, por exemplo "web=apps/web" (id "repo" é reservado).');
    if (out.some((x) => x.id === m[1])) throw usageError(`--scope duplicado: ${m[1]}`);
    out.push({ id: m[1]!, path: m[2]!.replace(/\\/g, "/").replace(/\/+$/, "") });
  }
  return out;
}

export async function runInit(g: Globals, f: InitFlags): Promise<CommandResult> {
  const root = resolveRoot(g.cwd);
  const scopes = parseScopes(f.scope);
  for (const s of scopes) safeJoin(root, s.path); // validates path stays inside the project
  const bundle = loadBundledContent();
  const prevRaw = readJsonIfExists<unknown>(safeJoin(root, PATHS.lock));
  const previous = prevRaw === undefined ? undefined : parseLock(prevRaw);
  if (previous && previous.sdkVersion !== bundle.version) {
    return result(
      ExitCode.OK,
      [
        `RepoGuide já está instalado (versão adotada ${previous.sdkVersion}; esta CLI traz ${bundle.version}).`,
        "Nada foi alterado. Para mudar de versão use: repoguide update --dry-run",
      ],
      { changed: false, alreadyInstalled: true, adoptedVersion: previous.sdkVersion },
    );
  }
  const plan = planInstall(root, bundle, previous, `bundled@${bundle.version}`, {
    claude: !!f.claude || !!previous?.integrations.claude,
    githubWorkflows: !!f["github-workflows"] || !!previous?.integrations.githubWorkflows,
    createProjectFiles: true,
    scopes,
    now: nowFromEnv(),
  });
  if (plan.conflicts.length) {
    throw new RgError(ExitCode.CONFLICT, "Instalação abortada: conflitos encontrados. Nada foi alterado.", {
      details: plan.conflicts.map((c) => `${c.path}: ${c.problem}`),
      hint: "Revise os arquivos listados. Para delimitadores corrompidos, deixe exatamente um par <!-- repoguide:begin --> / <!-- repoguide:end --> ou remova ambos.",
    });
  }
  const dry = !!f["dry-run"];
  if (plan.noop) {
    return result(ExitCode.OK, [`RepoGuide ${bundle.version} já instalado. Nada a fazer.`], { changed: false, dryRun: dry, adoptedVersion: bundle.version, writes: [] });
  }
  if (!dry) applyPlan(root, plan);
  const lines = describePlan(plan, dry, { showDiffs: dry });
  if (!dry) {
    lines.push("", "Próximos passos:", "  1. Revise e versione as alterações (git diff; git add; abra um PR).", "  2. Preencha docs/ai/MAPA.md e docs/ai/VALIDACAO.md aos poucos.", "  3. Rode: repoguide check");
  }
  return result(ExitCode.OK, lines, {
    changed: !dry,
    dryRun: dry,
    adoptedVersion: bundle.version,
    writes: plan.writes.map((w) => ({ path: w.rel, reason: w.reason })),
    notes: plan.notes,
  });
}

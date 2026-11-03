import { parseCatalog, type Catalog } from "../lib/catalog.js";
import { assertCliCompatible, cliVersion, fileOf, loadBundledContent, type ContentBundle } from "../lib/content.js";
import { parseDecisions, type DecisionsFile } from "../lib/decisions.js";
import { usageError } from "../lib/errors.js";
import { readJsonIfExists, safeJoin } from "../lib/fsx.js";
import { applyPlan, planInstall, type InstallPlan } from "../lib/install.js";
import { DEFAULT_SOURCE, PATHS, parseConfig, parseLock, resolveRoot, type LockFile } from "../lib/project.js";
import { fetchBundle } from "../lib/remote.js";
import { compareSemVer, isSemVer, majorOf } from "../lib/semver.js";
import { ExitCode, RgError, nowFromEnv, parseTimeout, result, sourceFrom, type CommandResult, type Globals } from "./common.js";
import { describePlan } from "./plan-output.js";

export const UPDATE_HELP = `Uso: repoguide update [opções]

Adota explicitamente uma nova versão das orientações e do catálogo. Mostra diferenças,
preserva arquivos do projeto, aborta sem escrever se houver modificações locais em
arquivos gerenciados e aplica tudo de forma atômica.

Opções:
  -C, --cwd <dir>        Diretório do projeto
      --dry-run          Mostra diferenças sem alterar arquivos
      --to <versão>      Versão alvo (padrão: última estável do canal)
      --from-package     Usa o conteúdo embutido nesta CLI (não acessa a rede)
      --offline          Igual a --from-package
      --source <url>     Índice do canal (padrão: releases do GitHub)
      --allow-major      Permite mudar de versão principal (ex.: 1.x → 2.x)
      --allow-downgrade  Permite voltar para versão anterior
      --claude           Ativa também a referência em CLAUDE.md
      --github-workflows Instala/atualiza workflows opcionais
      --timeout <ms>     Tempo limite de rede (padrão: 5000)
      --json             Saída JSON

Recuperação: as alterações ficam no Git. Para desfazer antes do commit:
  git restore --staged --worktree AGENTS.md CLAUDE.md .ai .github/workflows
`;

export interface UpdateFlags {
  "dry-run"?: boolean;
  to?: string;
  "from-package"?: boolean;
  offline?: boolean;
  source?: string;
  "allow-major"?: boolean;
  "allow-downgrade"?: boolean;
  claude?: boolean;
  "github-workflows"?: boolean;
  timeout?: string;
}

export interface PreparedUpdate {
  bundle: ContentBundle;
  source: string;
  previous: LockFile;
  plan: InstallPlan;
  reviewNeeded: string[];
}

export async function prepareUpdate(root: string, f: UpdateFlags): Promise<PreparedUpdate> {
  const lockRaw = readJsonIfExists<unknown>(safeJoin(root, PATHS.lock));
  if (lockRaw === undefined) throw new RgError(ExitCode.EXECUTION, "RepoGuide não está instalado neste projeto.", { hint: "Execute `repoguide init`." });
  const previous = parseLock(lockRaw);
  const config = parseConfig(readJsonIfExists(safeJoin(root, PATHS.config)), root);
  const timeoutMs = parseTimeout(f.timeout, config.timeoutMs);
  if (f.to !== undefined && !isSemVer(f.to)) throw usageError(`--to inválido: ${f.to}`);
  let bundle: ContentBundle;
  let source: string;
  if (f["from-package"] || f.offline) {
    bundle = loadBundledContent();
    source = `bundled@${bundle.version}`;
    if (f.to && f.to !== bundle.version) throw usageError(`Esta CLI traz o conteúdo ${bundle.version}; --to ${f.to} exige acesso ao canal remoto.`);
  } else {
    const indexUrl = sourceFrom(f.source, config.source, DEFAULT_SOURCE);
    const fetched = await fetchBundle(indexUrl, f.to, timeoutMs);
    bundle = fetched.bundle;
    source = fetched.url;
  }
  assertCliCompatible(bundle, cliVersion());
  const cmp = compareSemVer(bundle.version, previous.sdkVersion);
  if (cmp < 0 && !f["allow-downgrade"]) {
    throw new RgError(ExitCode.USAGE, `A versão alvo ${bundle.version} é anterior à adotada ${previous.sdkVersion}.`, { hint: "Use --allow-downgrade se for intencional." });
  }
  if (majorOf(bundle.version) !== majorOf(previous.sdkVersion) && !f["allow-major"]) {
    throw new RgError(ExitCode.USAGE, `Mudança de versão principal (${previous.sdkVersion} → ${bundle.version}) não é aplicada silenciosamente.`, {
      hint: "Leia as notas da release e repita com --allow-major.",
    });
  }
  const plan = planInstall(root, bundle, previous, source, {
    claude: !!f.claude || previous.integrations.claude,
    githubWorkflows: !!f["github-workflows"] || previous.integrations.githubWorkflows,
    createProjectFiles: false,
    now: nowFromEnv(),
  });
  return { bundle, source, previous, plan, reviewNeeded: decisionsNeedingReview(root, bundle) };
}

/** Decisions that will require review because their requirement changed materially. */
function decisionsNeedingReview(root: string, bundle: ContentBundle): string[] {
  let decisions: DecisionsFile | undefined;
  let next: Catalog;
  try {
    const raw = readJsonIfExists<unknown>(safeJoin(root, PATHS.decisions));
    decisions = raw === undefined ? undefined : parseDecisions(raw, PATHS.decisions);
    next = parseCatalog(JSON.parse(fileOf(bundle, "sdk/requisitos.json")!), "novo catálogo");
  } catch {
    return [];
  }
  if (!decisions) return [];
  const out: string[] = [];
  for (const d of decisions.decisions) {
    const req = next.requirements.find((r) => r.id === d.requirement);
    if (!req) out.push(`${d.requirement}@${d.scope}: requisito removido do catálogo; decisão mantida no histórico do arquivo`);
    else if (req.decisionPolicy.onMaterialRevision === "require-review" && d.requirementRevision < req.materialRevision) {
      out.push(`${d.requirement}@${d.scope}: ${d.type} registrado na revisão ${d.requirementRevision}; requisito agora na revisão material ${req.materialRevision}`);
    }
  }
  return out;
}

export async function runUpdate(g: Globals, f: UpdateFlags): Promise<CommandResult> {
  const root = resolveRoot(g.cwd);
  const prep = await prepareUpdate(root, f);
  const { plan, bundle, previous } = prep;
  if (plan.conflicts.length) {
    throw new RgError(ExitCode.CONFLICT, `Atualização para ${bundle.version} abortada: conflitos em arquivos gerenciados. Nada foi alterado.`, {
      details: plan.conflicts.map((c) => `${c.path}: ${c.problem}`),
      hint:
        "Mova personalizações para docs/ai/ ou para fora do bloco RepoGuide e restaure os arquivos gerenciados " +
        "(ex.: git checkout -- .ai/sdk). Depois repita `repoguide update --dry-run`.",
    });
  }
  const dry = !!f["dry-run"];
  if (plan.noop) {
    return result(ExitCode.OK, [`Já na versão ${bundle.version}. Nada a fazer.`], { changed: false, from: previous.sdkVersion, to: bundle.version, writes: [] });
  }
  if (!dry) applyPlan(root, plan);
  const lines = [`RepoGuide ${previous.sdkVersion} → ${bundle.version} (${prep.source})`, ...describePlan(plan, dry, { showDiffs: true })];
  if (prep.reviewNeeded.length) {
    lines.push("Decisões que exigirão revisão:");
    for (const r of prep.reviewNeeded) lines.push(`  - ${r}`);
  }
  if (!dry) lines.push("Revise com git diff e abra um PR. Para desfazer antes do commit: git restore --staged --worktree AGENTS.md .ai");
  return result(ExitCode.OK, lines, {
    changed: !dry,
    dryRun: dry,
    from: previous.sdkVersion,
    to: bundle.version,
    source: prep.source,
    writes: plan.writes.map((w) => ({ path: w.rel, reason: w.reason })),
    diffs: plan.diffs,
    reviewNeeded: prep.reviewNeeded,
  });
}

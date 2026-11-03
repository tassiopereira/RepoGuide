import { existsSync } from "node:fs";
import path from "node:path";
import { parseBlock } from "../lib/block.js";
import { SUPPORTED_SCHEMA_VERSIONS } from "../lib/catalog.js";
import { cliVersion } from "../lib/content.js";
import { todayIso } from "../lib/decisions.js";
import { checkIntegrity } from "../lib/evaluate.js";
import { readJsonIfExists, readTextIfExists, safeJoin } from "../lib/fsx.js";
import { detectRepo, githubToken } from "../lib/github.js";
import { DEFAULT_SOURCE, PATHS, loadProject, resolveRoot, type LoadedProject } from "../lib/project.js";
import { fetchChannel } from "../lib/remote.js";
import { walk } from "../lib/scan.js";
import { compareSemVer } from "../lib/semver.js";
import { ExitCode, nowFromEnv, parseTimeout, result, sourceFrom, type CommandResult, type Globals } from "./common.js";

export const DOCTOR_HELP = `Uso: repoguide doctor [opções]

Diagnostica a instalação: versão do Node, arquivos gerenciados, delimitadores, decisões,
configuração de escopos, cache, compatibilidade e acesso ao canal de versões.

Opções:
  -C, --cwd <dir>    Diretório do projeto
      --offline      Não testa a rede
      --timeout <ms> Tempo limite de rede
      --json         Saída JSON

Código de saída 3 quando há falhas; avisos não alteram o código.
`;

type Status = "ok" | "warn" | "fail" | "info";
interface Diag {
  check: string;
  status: Status;
  detail: string;
}

export async function runDoctor(g: Globals, f: { offline?: boolean; timeout?: string }): Promise<CommandResult> {
  const root = resolveRoot(g.cwd);
  const d: Diag[] = [];
  const add = (check: string, status: Status, detail: string) => d.push({ check, status, detail });
  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 22 ? "ok" : "fail", `Node.js ${process.versions.node} (requer 22 ou superior)`);
  add("cli", "info", `repoguide ${cliVersion()}`);
  add("git", existsSync(path.join(root, ".git")) ? "ok" : "warn", existsSync(path.join(root, ".git")) ? "repositório Git encontrado" : "sem .git: decisões e recuperação dependem do Git");

  let project: LoadedProject | undefined;
  try {
    project = loadProject(root);
    add("instalação", "ok", `conteúdo adotado ${project.lock.sdkVersion} (${project.lock.source})`);
  } catch (e) {
    add("instalação", "fail", (e as Error).message);
  }

  if (project) {
    const p = project;
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(p.lock.contentSchemaVersion as 1)) add("schema", "fail", `schema ${p.lock.contentSchemaVersion} não suportado por esta CLI`);
    if (compareSemVer(cliVersion(), p.lock.sdkVersion) < 0) add("compatibilidade", "warn", `CLI ${cliVersion()} é anterior ao conteúdo ${p.lock.sdkVersion}; atualize a CLI`);
    const integrity = checkIntegrity(p);
    if (integrity.length) for (const i of integrity) add("integridade", "fail", `${i.path}: ${i.problem}`);
    else add("integridade", "ok", "arquivos e blocos gerenciados intactos");

    const claude = readTextIfExists(safeJoin(root, PATHS.claude));
    if (claude !== undefined) {
      const imports = /(^|\s)@AGENTS\.md\b/m.test(claude.replace(/`[^`]*`/g, ""));
      add(
        "claude",
        imports ? "ok" : "warn",
        imports
          ? "CLAUDE.md importa @AGENTS.md"
          : "CLAUDE.md existe sem importar AGENTS.md; o Claude Code lerá só o CLAUDE.md. Rode `repoguide update --claude --from-package` ou adicione @AGENTS.md",
      );
      if (parseBlock(claude).status === "corrupt") add("claude", "fail", "delimitadores RepoGuide corrompidos em CLAUDE.md");
    }

    const today = todayIso(nowFromEnv());
    const expired = p.decisions.decisions.filter((x) => (x.expires && x.expires < today) || (x.reviewBy && x.reviewBy < today));
    add("decisões", expired.length ? "warn" : "ok", `${p.decisions.decisions.length} ativa(s), ${expired.length} vencida(s), ${p.decisions.attestations.length} declaração(ões)`);
    const unknown = p.decisions.decisions.filter((x) => !p.catalog.requirements.some((r) => r.id === x.requirement));
    if (unknown.length) add("decisões", "warn", `decisões para requisitos fora do catálogo: ${unknown.map((x) => x.requirement).join(", ")}`);

    const gi = readTextIfExists(safeJoin(root, PATHS.aiGitignore));
    add("cache", gi && /^\.cache\/?\s*$/m.test(gi) ? "ok" : "warn", gi ? ".ai/.cache ignorado pelo Git" : ".ai/.gitignore ausente; cache pode ser versionado");

    if (p.config.scopes.length === 0) {
      const hint = monorepoHint(root);
      if (hint) add("escopos", "warn", `${hint}; considere declarar escopos em ${PATHS.config} (repoguide init --scope id=caminho em projeto novo)`);
      else add("escopos", "ok", "projeto de escopo único");
    } else add("escopos", "ok", p.config.scopes.map((s) => `${s.id}=${s.path}`).join(", "));
  }

  const repo = (() => {
    try {
      return detectRepo(root);
    } catch {
      return undefined;
    }
  })();
  add("github", repo ? "info" : "warn", repo ? `repositório ${repo.owner}/${repo.repo}; token ${githubToken() ? "presente" : "ausente (consultas públicas limitadas)"}` : "repositório GitHub não identificado (origin)");

  if (!f.offline) {
    const source = sourceFrom(undefined, project?.config.source, DEFAULT_SOURCE);
    try {
      const { index } = await fetchChannel(source, parseTimeout(f.timeout, project?.config.timeoutMs ?? 5000));
      add("canal", "ok", `canal estável acessível; última versão ${index.latest}`);
    } catch (e) {
      add("canal", "warn", `canal de versões indisponível: ${(e as Error).message}`);
    }
  } else add("canal", "info", "não testado (--offline)");

  const icon: Record<Status, string> = { ok: "✔", warn: "!", fail: "✖", info: "·" };
  const lines = d.map((x) => `${icon[x.status]} ${x.check}: ${x.detail}`);
  const failed = d.some((x) => x.status === "fail");
  return result(failed ? ExitCode.EXECUTION : ExitCode.OK, lines, { diagnostics: d });
}

function monorepoHint(root: string): string | undefined {
  const pkg = readJsonIfExists<{ workspaces?: unknown }>(path.join(root, "package.json"));
  if (pkg?.workspaces) return "package.json declara workspaces";
  for (const f of ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json", "go.work"]) if (existsSync(path.join(root, f))) return `${f} encontrado`;
  const manifests = walk(root, { maxDepth: 3, maxEntries: 5000 }).files.filter((x) => /(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/.test(x.rel) && x.rel.includes("/"));
  if (manifests.length >= 2) return `${manifests.length} manifestos em subdiretórios`;
  return undefined;
}

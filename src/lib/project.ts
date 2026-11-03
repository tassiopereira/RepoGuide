import { existsSync } from "node:fs";
import path from "node:path";
import { parseCatalog, type Catalog } from "./catalog.js";
import { emptyDecisions, parseDecisions, type DecisionsFile } from "./decisions.js";
import { ExitCode, RgError, execError } from "./errors.js";
import { isDirectory, readJsonIfExists, safeJoin } from "./fsx.js";
import { isSemVer } from "./semver.js";

export const PATHS = {
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
  sdkDir: ".ai/sdk",
  instructions: ".ai/sdk/INSTRUCOES.md",
  catalog: ".ai/sdk/requisitos.json",
  lock: ".ai/sdk.lock.json",
  decisions: ".ai/decisoes.json",
  config: ".ai/config.json",
  aiGitignore: ".ai/.gitignore",
  cacheDir: ".ai/.cache",
  map: "docs/ai/MAPA.md",
  validation: "docs/ai/VALIDACAO.md",
} as const;

export interface LockFile {
  schemaVersion: 1;
  /** Adopted RepoGuide content version. */
  sdkVersion: string;
  channel: "stable";
  /** Where the adopted content came from: "bundled@<cli version>" or a URL. */
  source: string;
  /** Catalog schema version of the adopted content. */
  contentSchemaVersion: number;
  adoptedAt: string;
  /** sha256 (LF-normalized) of each managed file, by project-relative path. */
  files: Record<string, string>;
  /** sha256 of the inner content of managed blocks, by file. */
  blocks: Record<string, string>;
  /** Opt-in integrations installed. */
  integrations: { claude: boolean; githubWorkflows: boolean };
}

export interface Scope {
  id: string;
  path: string;
}

export interface ProjectConfig {
  scopes: Scope[];
  cacheTtlHours: number;
  source?: string;
  blocking: string[];
  timeoutMs: number;
}

export const DEFAULT_SOURCE = "https://github.com/tassiopereira/RepoGuide/releases/latest/download/stable.json";
export const REPO_SCOPE: Scope = { id: "repo", path: "." };

const SCOPE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function parseConfig(raw: unknown, root: string): ProjectConfig {
  const cfg: ProjectConfig = { scopes: [], cacheTtlHours: 24, blocking: [], timeoutMs: 5000 };
  if (raw === undefined) return cfg;
  if (typeof raw !== "object" || raw === null) throw execError(`${PATHS.config} inválido`);
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (r.scopes !== undefined) {
    if (!Array.isArray(r.scopes)) problems.push("scopes deve ser lista");
    else
      for (const s of r.scopes as Record<string, unknown>[]) {
        if (typeof s?.id !== "string" || !SCOPE_ID.test(s.id) || s.id === "repo") {
          problems.push(`scope.id inválido: ${JSON.stringify(s?.id)} (use minúsculas, números e hífen; "repo" é reservado)`);
          continue;
        }
        if (typeof s.path !== "string") {
          problems.push(`scope ${s.id} sem path`);
          continue;
        }
        try {
          const abs = s.path === "." ? root : safeJoin(root, s.path);
          if (!isDirectory(abs)) problems.push(`scope ${s.id}: diretório não existe (${s.path})`);
        } catch (e) {
          problems.push(`scope ${s.id}: ${(e as Error).message}`);
        }
        if (cfg.scopes.some((x) => x.id === s.id)) problems.push(`scope duplicado: ${s.id}`);
        cfg.scopes.push({ id: s.id, path: s.path.replace(/\\/g, "/") });
      }
  }
  if (r.cacheTtlHours !== undefined) {
    if (typeof r.cacheTtlHours !== "number" || r.cacheTtlHours < 0 || r.cacheTtlHours > 24 * 30) problems.push("cacheTtlHours deve estar entre 0 e 720");
    else cfg.cacheTtlHours = r.cacheTtlHours;
  }
  if (r.timeoutMs !== undefined) {
    if (typeof r.timeoutMs !== "number" || r.timeoutMs < 100 || r.timeoutMs > 120000) problems.push("timeoutMs deve estar entre 100 e 120000");
    else cfg.timeoutMs = r.timeoutMs;
  }
  if (r.source !== undefined) {
    if (typeof r.source !== "string") problems.push("source deve ser URL");
    else cfg.source = r.source;
  }
  if (r.blocking !== undefined) {
    if (!Array.isArray(r.blocking) || !r.blocking.every((x) => typeof x === "string")) problems.push("blocking deve ser lista de IDs");
    else cfg.blocking = r.blocking as string[];
  }
  if (problems.length) throw execError(`${PATHS.config} inválido`, undefined, problems);
  return cfg;
}

export function parseLock(raw: unknown): LockFile {
  const r = raw as Partial<LockFile> | undefined;
  if (
    !r ||
    r.schemaVersion !== 1 ||
    !isSemVer(r.sdkVersion) ||
    typeof r.files !== "object" ||
    typeof r.blocks !== "object" ||
    typeof r.source !== "string"
  ) {
    throw execError(`${PATHS.lock} inválido ou de formato desconhecido.`, "Restaure-o pelo Git ou execute `repoguide init` novamente.");
  }
  return {
    ...r,
    integrations: { claude: !!r.integrations?.claude, githubWorkflows: !!r.integrations?.githubWorkflows },
  } as LockFile;
}

export interface LoadedProject {
  root: string;
  lock: LockFile;
  config: ProjectConfig;
  decisions: DecisionsFile;
  catalog: Catalog;
}

export function resolveRoot(dir: string | undefined): string {
  const root = path.resolve(dir ?? process.cwd());
  if (!isDirectory(root)) throw new RgError(ExitCode.USAGE, `Diretório do projeto não existe: ${root}`);
  return root;
}

export function isInitialized(root: string): boolean {
  return existsSync(path.join(root, PATHS.lock));
}

export function loadProject(root: string): LoadedProject {
  const lockRaw = readJsonIfExists<unknown>(safeJoin(root, PATHS.lock));
  if (lockRaw === undefined) {
    throw execError(`RepoGuide não está instalado em ${root}.`, "Execute `repoguide init` (use -C <dir> para outro diretório).");
  }
  const lock = parseLock(lockRaw);
  const config = parseConfig(readJsonIfExists(safeJoin(root, PATHS.config)), root);
  const decRaw = readJsonIfExists<unknown>(safeJoin(root, PATHS.decisions));
  const decisions = decRaw === undefined ? emptyDecisions() : parseDecisions(decRaw, PATHS.decisions);
  const catRaw = readJsonIfExists<unknown>(safeJoin(root, PATHS.catalog), 2 * 1024 * 1024);
  if (catRaw === undefined) throw execError(`Catálogo ausente: ${PATHS.catalog}`, "Execute `repoguide update --from-package` ou restaure pelo Git.");
  const catalog = parseCatalog(catRaw, PATHS.catalog);
  return { root, lock, config, decisions, catalog };
}

/** Scopes a requirement is evaluated in. Repository-level requirements use the implicit "repo" scope. */
export function scopesFor(level: "repository" | "application", config: ProjectConfig): Scope[] {
  if (level === "repository" || config.scopes.length === 0) return [REPO_SCOPE];
  return config.scopes;
}

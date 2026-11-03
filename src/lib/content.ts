import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseCatalog, SUPPORTED_SCHEMA_VERSIONS } from "./catalog.js";
import { ExitCode, RgError } from "./errors.js";
import { normalizeEol, sha256 } from "./fsx.js";
import { compareSemVer, isSemVer } from "./semver.js";

export interface ContentFile {
  path: string;
  sha256: string;
  content: string;
}

export interface ContentBundle {
  format: "repoguide-content";
  schemaVersion: number;
  version: string;
  minCliVersion: string;
  highlights?: string;
  files: ContentFile[];
}

/** Bundle path → destination in the consumer project, for files fully managed by RepoGuide. */
export const MANAGED_FILES: Record<string, string> = {
  "sdk/INSTRUCOES.md": ".ai/sdk/INSTRUCOES.md",
  "sdk/requisitos.json": ".ai/sdk/requisitos.json",
};

/** Created once if absent; afterwards owned by the project and never overwritten. */
export const PROJECT_TEMPLATES: Record<string, string> = {
  "templates/MAPA.md": "docs/ai/MAPA.md",
  "templates/VALIDACAO.md": "docs/ai/VALIDACAO.md",
};

export const BLOCK_TEMPLATES = {
  agents: "templates/agents-block.md",
  claude: "templates/claude-block.md",
} as const;

/** Opt-in GitHub workflows, managed like SDK files. */
export const WORKFLOW_FILES: Record<string, string> = {
  "workflows/repoguide-check.yml": ".github/workflows/repoguide-check.yml",
  "workflows/repoguide-maintenance.yml": ".github/workflows/repoguide-maintenance.yml",
};

const REQUIRED = ["sdk/INSTRUCOES.md", "sdk/requisitos.json", "templates/agents-block.md"];
const ALLOWED = new Set<string>([
  ...Object.keys(MANAGED_FILES),
  ...Object.keys(PROJECT_TEMPLATES),
  ...Object.values(BLOCK_TEMPLATES),
  ...Object.keys(WORKFLOW_FILES),
]);

export const LIMITS = {
  bundleBytes: 2 * 1024 * 1024,
  fileBytes: 512 * 1024,
  maxFiles: 50,
  indexBytes: 256 * 1024,
};

export function packageRoot(): string {
  // build/src/lib/content.js → package root is three levels up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function cliVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

/** Loads the content shipped inside this CLI package. */
export function loadBundledContent(): ContentBundle {
  const root = path.join(packageRoot(), "content");
  const meta = JSON.parse(readFileSync(path.join(root, "meta.json"), "utf8")) as {
    schemaVersion: number;
    minCliVersion: string;
    highlights?: string;
  };
  const files: ContentFile[] = [];
  for (const rel of ALLOWED) {
    let content: string;
    try {
      content = normalizeEol(readFileSync(path.join(root, ...rel.split("/")), "utf8"));
    } catch {
      continue;
    }
    files.push({ path: rel, sha256: sha256(content), content });
  }
  const bundle: ContentBundle = {
    format: "repoguide-content",
    schemaVersion: meta.schemaVersion,
    version: cliVersion(),
    minCliVersion: meta.minCliVersion,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    ...(meta.highlights ? { highlights: meta.highlights } : {}),
  };
  validateBundle(bundle, "pacote da CLI");
  return bundle;
}

/**
 * Validates structure, paths, sizes, hashes, schema and catalog of a content bundle.
 * The hash check guards against corruption/truncation. It does NOT prove authenticity when
 * hashes come from the same origin as the content.
 */
export function validateBundle(raw: unknown, source: string): ContentBundle {
  const fail = (msg: string, details: string[] = []) =>
    new RgError(ExitCode.REMOTE, `Conteúdo inválido (${source}): ${msg}`, { details, hint: "Nada foi alterado." });
  if (typeof raw !== "object" || raw === null) throw fail("não é um objeto");
  const b = raw as Partial<ContentBundle>;
  if (b.format !== "repoguide-content") throw fail("formato desconhecido");
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(b.schemaVersion as 1)) {
    throw new RgError(ExitCode.REMOTE, `Conteúdo ${b.version ?? "?"} usa schema ${String(b.schemaVersion)}, não suportado por esta CLI.`, {
      hint: "Atualize a CLI do RepoGuide antes de adotar esta versão.",
    });
  }
  if (!isSemVer(b.version)) throw fail("versão inválida");
  if (!isSemVer(b.minCliVersion)) throw fail("minCliVersion inválida");
  if (!Array.isArray(b.files) || b.files.length === 0 || b.files.length > LIMITS.maxFiles) throw fail("lista de arquivos inválida");
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of b.files) {
    if (typeof f?.path !== "string" || !ALLOWED.has(f.path)) {
      problems.push(`caminho não permitido: ${JSON.stringify(f?.path)}`);
      continue;
    }
    if (seen.has(f.path)) problems.push(`duplicado: ${f.path}`);
    seen.add(f.path);
    if (typeof f.content !== "string" || Buffer.byteLength(f.content, "utf8") > LIMITS.fileBytes) problems.push(`conteúdo inválido ou grande demais: ${f.path}`);
    else if (typeof f.sha256 !== "string" || sha256(f.content) !== f.sha256) problems.push(`hash não confere: ${f.path}`);
  }
  for (const req of REQUIRED) if (!seen.has(req)) problems.push(`arquivo obrigatório ausente: ${req}`);
  if (problems.length) throw fail("verificação de integridade falhou", problems);
  const catalogFile = b.files.find((f) => f.path === "sdk/requisitos.json")!;
  let catalogRaw: unknown;
  try {
    catalogRaw = JSON.parse(catalogFile.content);
  } catch {
    throw fail("requisitos.json não é JSON válido");
  }
  try {
    parseCatalog(catalogRaw, `${source}: sdk/requisitos.json`);
  } catch (e) {
    const err = e as RgError;
    throw fail(err.message, err.details);
  }
  return b as ContentBundle;
}

export function assertCliCompatible(bundle: ContentBundle, cli: string): void {
  if (compareSemVer(cli, bundle.minCliVersion) < 0) {
    throw new RgError(ExitCode.REMOTE, `O conteúdo ${bundle.version} exige a CLI ${bundle.minCliVersion} ou superior (atual: ${cli}).`, {
      hint: "Atualize a CLI do RepoGuide e repita a operação.",
    });
  }
}

export function fileOf(bundle: ContentBundle, p: string): string | undefined {
  return bundle.files.find((f) => f.path === p)?.content;
}

export function render(template: string, version: string): string {
  return normalizeEol(template).replace(/\{\{VERSION\}\}/g, version);
}

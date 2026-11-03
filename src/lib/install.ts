import path from "node:path";
import { parseBlock, upsertBlock } from "./block.js";
import { BLOCK_TEMPLATES, MANAGED_FILES, PROJECT_TEMPLATES, WORKFLOW_FILES, fileOf, render, type ContentBundle } from "./content.js";
import { emptyDecisions } from "./decisions.js";
import { lineDiff } from "./diff.js";
import { normalizeEol, readTextIfExists, safeJoin, sha256, toJson, Transaction, type PlannedWrite } from "./fsx.js";
import { PATHS, type LockFile } from "./project.js";

export interface InstallOptions {
  claude: boolean;
  githubWorkflows: boolean;
  /** True for init (creates project-owned files when absent). */
  createProjectFiles: boolean;
  scopes?: { id: string; path: string }[];
  now: Date;
}

export interface Conflict {
  path: string;
  problem: string;
}

export interface InstallPlan {
  writes: PlannedWrite[];
  conflicts: Conflict[];
  notes: string[];
  diffs: string[];
  lock: LockFile;
  /** True when nothing besides the lock timestamp would change. */
  noop: boolean;
}

function read(root: string, rel: string): string | undefined {
  const t = readTextIfExists(safeJoin(root, rel));
  return t === undefined ? undefined : normalizeEol(t);
}

/**
 * Computes every write needed to bring a project to `bundle`, detecting local modifications
 * of managed files and corrupted blocks. Never writes anything itself.
 */
export function planInstall(root: string, bundle: ContentBundle, previous: LockFile | undefined, source: string, opts: InstallOptions): InstallPlan {
  const writes: PlannedWrite[] = [];
  const conflicts: Conflict[] = [];
  const notes: string[] = [];
  const diffs: string[] = [];
  const files: Record<string, string> = {};
  const blocks: Record<string, string> = {};

  const managed: [string, string][] = Object.entries(MANAGED_FILES);
  if (opts.githubWorkflows) managed.push(...Object.entries(WORKFLOW_FILES));

  for (const [src, dest] of managed) {
    const raw = fileOf(bundle, src);
    if (raw === undefined) {
      if (src.startsWith("workflows/")) notes.push(`Workflow ${dest} não existe na versão ${bundle.version}.`);
      continue;
    }
    const next = render(raw, bundle.version);
    const nextHash = sha256(next);
    files[dest] = nextHash;
    const current = read(root, dest);
    const recorded = previous?.files[dest];
    if (current !== undefined) {
      const curHash = sha256(current);
      if (recorded !== undefined && curHash !== recorded && curHash !== nextHash) {
        conflicts.push({ path: dest, problem: "arquivo gerenciado modificado localmente desde a última instalação" });
        continue;
      }
      if (recorded === undefined && curHash !== nextHash) {
        conflicts.push({ path: dest, problem: "arquivo já existe e não foi criado pelo RepoGuide" });
        continue;
      }
      if (curHash === nextHash) continue;
      diffs.push(lineDiff(current, next, dest));
      writes.push({ rel: dest, content: next, reason: "atualizar conteúdo gerenciado" });
    } else {
      if (recorded !== undefined) notes.push(`${dest} estava ausente e será restaurado.`);
      writes.push({ rel: dest, content: next, reason: "criar conteúdo gerenciado" });
    }
  }

  // Workflows previously installed but no longer requested: keep files, stop tracking? We keep tracking.
  if (!opts.githubWorkflows && previous?.integrations.githubWorkflows) {
    for (const dest of Object.values(WORKFLOW_FILES)) {
      if (previous.files[dest] !== undefined) files[dest] = previous.files[dest]!;
    }
  }

  const blockTargets: [string, string, boolean][] = [[PATHS.agents, BLOCK_TEMPLATES.agents, true]];
  if (opts.claude) blockTargets.push([PATHS.claude, BLOCK_TEMPLATES.claude, true]);
  for (const [dest, src] of blockTargets) {
    const raw = fileOf(bundle, src);
    if (raw === undefined) {
      notes.push(`Modelo ${src} ausente na versão ${bundle.version}; ${dest} não foi alterado.`);
      continue;
    }
    const inner = render(raw, bundle.version).replace(/\n+$/, "");
    const innerHash = sha256(inner);
    blocks[dest] = innerHash;
    const currentRaw = readTextIfExists(safeJoin(root, dest));
    const current = currentRaw === undefined ? undefined : normalizeEol(currentRaw);
    if (current !== undefined) {
      const parsed = parseBlock(current);
      if (parsed.status === "corrupt") {
        conflicts.push({ path: dest, problem: `delimitadores do bloco RepoGuide corrompidos: ${parsed.problem}` });
        continue;
      }
      if (parsed.status === "ok") {
        const curHash = sha256(parsed.inner);
        const recorded = previous?.blocks[dest];
        if (recorded !== undefined && curHash !== recorded && curHash !== innerHash) {
          conflicts.push({ path: dest, problem: "bloco gerenciado editado localmente (o restante do arquivo é preservado)" });
          continue;
        }
      }
    }
    const up = upsertBlock(currentRaw, inner);
    if (up.action === "unchanged") continue;
    if (current !== undefined) diffs.push(lineDiff(current, normalizeEol(up.content), dest));
    writes.push({
      rel: dest,
      content: up.content,
      reason:
        up.action === "created" ? "criar com bloco RepoGuide" : up.action === "inserted" ? "inserir bloco RepoGuide (conteúdo existente preservado)" : "atualizar bloco RepoGuide",
    });
  }

  if (opts.createProjectFiles) {
    for (const [src, dest] of Object.entries(PROJECT_TEMPLATES)) {
      const raw = fileOf(bundle, src);
      if (raw === undefined) continue;
      if (read(root, dest) !== undefined) {
        notes.push(`${dest} já existe e foi preservado.`);
        continue;
      }
      writes.push({ rel: dest, content: render(raw, bundle.version), reason: "criar documento do projeto (não será sobrescrito)" });
    }
    if (read(root, PATHS.decisions) === undefined) {
      writes.push({ rel: PATHS.decisions, content: toJson(emptyDecisions()), reason: "criar registro de decisões" });
    }
    if (opts.scopes && opts.scopes.length > 0 && read(root, PATHS.config) === undefined) {
      writes.push({ rel: PATHS.config, content: toJson({ scopes: opts.scopes, cacheTtlHours: 24 }), reason: "criar configuração de escopos" });
    } else if (opts.scopes && opts.scopes.length > 0) {
      notes.push(`${PATHS.config} já existe; escopos informados não foram aplicados. Edite o arquivo manualmente.`);
    }
  }
  const gi = read(root, PATHS.aiGitignore);
  if (gi === undefined) {
    writes.push({ rel: PATHS.aiGitignore, content: "# Cache local do RepoGuide (não versionar)\n.cache/\n", reason: "ignorar cache local" });
  } else if (!/^\.cache\/?\s*$/m.test(gi)) {
    writes.push({ rel: PATHS.aiGitignore, content: gi.replace(/\n?$/, "\n") + ".cache/\n", reason: "ignorar cache local" });
  }

  const lock: LockFile = {
    schemaVersion: 1,
    sdkVersion: bundle.version,
    channel: "stable",
    source,
    contentSchemaVersion: bundle.schemaVersion,
    adoptedAt: previous && previous.sdkVersion === bundle.version && conflicts.length === 0 && writes.length === 0 ? previous.adoptedAt : opts.now.toISOString(),
    files,
    blocks,
    integrations: { claude: opts.claude, githubWorkflows: opts.githubWorkflows },
  };
  const lockText = toJson(lock);
  const prevLockText = read(root, PATHS.lock);
  const noop = writes.length === 0 && conflicts.length === 0 && prevLockText !== undefined && sameLock(prevLockText, lock);
  if (!noop && conflicts.length === 0) {
    writes.push({ rel: PATHS.lock, content: lockText, reason: "registrar versão adotada e hashes" });
  }
  return { writes, conflicts, notes, diffs, lock, noop };
}

function sameLock(prevText: string, next: LockFile): boolean {
  try {
    const prev = JSON.parse(prevText) as LockFile;
    return JSON.stringify({ ...prev, adoptedAt: "" , source: ""}) === JSON.stringify({ ...next, adoptedAt: "", source: "" });
  } catch {
    return false;
  }
}

export function applyPlan(root: string, plan: InstallPlan): void {
  const tx = new Transaction(root);
  for (const w of plan.writes) tx.add(w);
  tx.commit(path.join(root, PATHS.cacheDir, `backup-${Date.now()}`));
}

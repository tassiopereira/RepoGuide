import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { ExitCode, RgError, execError } from "./errors.js";

/** Normalizes line endings so hashes are stable across Windows (CRLF checkouts) and Unix. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function sha256(text: string): string {
  return createHash("sha256").update(normalizeEol(text), "utf8").digest("hex");
}

export function sha256Raw(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

const SAFE_REL = /^[A-Za-z0-9._@-][A-Za-z0-9._@/ -]*$/;

/**
 * Resolves a project-relative path and guarantees the result stays inside `root`,
 * including through symlinks of existing parent directories.
 */
export function safeJoin(root: string, rel: string): string {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 300) {
    throw new RgError(ExitCode.EXECUTION, `Caminho inválido: ${JSON.stringify(rel)}`);
  }
  const posix = rel.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix) || posix.split("/").some((s) => s === ".." || s === "") || !SAFE_REL.test(posix)) {
    throw new RgError(ExitCode.EXECUTION, `Caminho recusado (fora do diretório permitido ou com caracteres inválidos): ${rel}`);
  }
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, ...posix.split("/"));
  assertInside(rootAbs, target, rel);
  // Check the deepest existing ancestor through realpath to defeat symlink escapes.
  let probe = target;
  while (!existsSync(probe) && probe !== rootAbs) probe = path.dirname(probe);
  if (existsSync(probe)) {
    const realRoot = realpathSync(rootAbs);
    const realProbe = realpathSync(probe);
    assertInside(realRoot, realProbe, rel);
  }
  return target;
}

function assertInside(root: string, target: string, label: string): void {
  const relative = path.relative(root, target);
  if (relative === "" ) return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RgError(ExitCode.EXECUTION, `Caminho recusado (escaparia do diretório do projeto): ${label}`);
  }
}

export function readTextIfExists(file: string, maxBytes = 2 * 1024 * 1024): string | undefined {
  if (!existsSync(file)) return undefined;
  const st = lstatSync(file);
  if (st.isSymbolicLink()) {
    throw execError(`Arquivo gerenciado não pode ser link simbólico: ${file}`);
  }
  if (!st.isFile()) throw execError(`Esperado arquivo, encontrado outro tipo: ${file}`);
  if (st.size > maxBytes) throw execError(`Arquivo excede o limite de ${maxBytes} bytes: ${file}`);
  return readFileSync(file, "utf8");
}

export function readJsonIfExists<T>(file: string, maxBytes = 1024 * 1024): T | undefined {
  const text = readTextIfExists(file, maxBytes);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw execError(`JSON inválido em ${file}: ${(e as Error).message}`, "Corrija o arquivo ou restaure-o pelo Git (git checkout -- <arquivo>).");
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Writes a file atomically: temp file in the same directory, fsync, rename. */
export function atomicWrite(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.repoguide-tmp-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export interface PlannedWrite {
  /** Project-relative POSIX path. */
  rel: string;
  content: string;
  /** Short description for output. */
  reason: string;
}

/**
 * Applies a set of writes with all-or-nothing semantics:
 * 1. every new content is staged to a temp file next to its target;
 * 2. existing targets are backed up;
 * 3. temp files are renamed into place;
 * 4. on any failure, already-replaced files are restored from backup and new files removed.
 */
export class Transaction {
  private readonly root: string;
  private readonly writes: PlannedWrite[] = [];
  private readonly faultAfter: number | undefined;

  constructor(root: string, options: { faultAfter?: number } = {}) {
    this.root = root;
    const envFault = process.env.REPOGUIDE_INTERNAL_FAULT_AFTER;
    this.faultAfter = options.faultAfter ?? (envFault !== undefined && envFault !== "" ? Number(envFault) : undefined);
  }

  add(write: PlannedWrite): void {
    this.writes.push(write);
  }

  get size(): number {
    return this.writes.length;
  }

  list(): readonly PlannedWrite[] {
    return this.writes;
  }

  commit(backupDir: string): void {
    const staged: { target: string; tmp: string; backup?: string; existed: boolean }[] = [];
    const token = randomBytes(4).toString("hex");
    try {
      for (const w of this.writes) {
        const target = safeJoin(this.root, w.rel);
        mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.repoguide-tmp-${token}`;
        const fd = openSync(tmp, "w");
        try {
          writeSync(fd, w.content, null, "utf8");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        staged.push({ target, tmp, existed: existsSync(target) });
      }
    } catch (e) {
      for (const s of staged) rmSync(s.tmp, { force: true });
      throw new RgError(ExitCode.EXECUTION, `Falha ao preparar escrita; nada foi alterado: ${(e as Error).message}`);
    }

    mkdirSync(backupDir, { recursive: true });
    const applied: typeof staged = [];
    try {
      let i = 0;
      for (const s of staged) {
        if (this.faultAfter !== undefined && i >= this.faultAfter) {
          throw new Error(`falha simulada após ${i} arquivo(s)`);
        }
        if (s.existed) {
          const backup = path.join(backupDir, `${i}-${path.basename(s.target)}`);
          copyFileSync(s.target, backup);
          s.backup = backup;
        }
        renameSync(s.tmp, s.target);
        applied.push(s);
        i++;
      }
    } catch (e) {
      const restoreErrors: string[] = [];
      for (const s of applied.reverse()) {
        try {
          if (s.backup) copyFileSync(s.backup, s.target);
          else rmSync(s.target, { force: true });
        } catch (re) {
          restoreErrors.push(`${s.target}: ${(re as Error).message}`);
        }
      }
      for (const s of staged) rmSync(s.tmp, { force: true });
      throw new RgError(
        ExitCode.EXECUTION,
        `Falha durante a aplicação; alterações revertidas: ${(e as Error).message}`,
        {
          hint: restoreErrors.length
            ? `Não foi possível restaurar tudo automaticamente. Backup em ${backupDir}. Use "git status" e "git checkout -- <arquivo>" para recuperar.`
            : "Nenhum arquivo ficou em estado parcial. Corrija a causa e repita o comando.",
          details: restoreErrors,
        },
      );
    }
    rmSync(backupDir, { recursive: true, force: true });
  }
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

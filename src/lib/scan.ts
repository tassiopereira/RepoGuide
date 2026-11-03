import { openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Directories never walked: dependencies, build outputs, VCS and tool caches. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".ai", "vendor", "dist", "build", "out", "target", ".next", ".nuxt", ".svelte-kit",
  ".venv", "venv", "env", "__pycache__", ".tox", ".mypy_cache", ".gradle", ".idea", ".vscode", "coverage",
  "bin", "obj", "Pods", ".terraform", ".cache", "tmp", "temp", ".turbo", ".yarn", "bower_components",
  // Tests, fixtures and examples are not production evidence (e.g. Sentry.init in a test).
  "test", "tests", "__tests__", "spec", "e2e", "fixtures", "__fixtures__", "__mocks__", "examples", "example",
]);

export interface ScanLimits {
  maxDepth: number;
  maxEntries: number;
}

export interface FileEntry {
  rel: string;
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  files: FileEntry[];
  truncated: boolean;
}

/**
 * Bounded, deterministic walk. Never follows symlinks, never reads file contents.
 * `rel` paths are POSIX-style and relative to `base`.
 */
export function walk(base: string, limits: ScanLimits = { maxDepth: 6, maxEntries: 20000 }): ScanResult {
  const files: FileEntry[] = [];
  let entries = 0;
  let truncated = false;
  const visit = (dir: string, rel: string, depth: number) => {
    if (truncated) return;
    let list: import("node:fs").Dirent[];
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of list) {
      if (++entries > limits.maxEntries) {
        truncated = true;
        return;
      }
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || (d.name.startsWith(".") && d.name !== ".github")) continue;
        if (depth < limits.maxDepth) visit(path.join(dir, d.name), childRel, depth + 1);
      } else if (d.isFile()) {
        try {
          const st = statSync(path.join(dir, d.name));
          files.push({ rel: childRel, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* vanished */
        }
      }
    }
  };
  visit(base, "", 0);
  return { files, truncated };
}

/** Reads at most `maxBytes` of a file as UTF-8 text. */
export function readHead(file: string, maxBytes: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export interface GrepCache {
  get(key: string): string[] | undefined;
  set(key: string, value: string[]): void;
}

export const SOURCE_EXT = /\.(m?[jt]sx?|cjs|cts|py|rb|go|php|java|kt|kts|cs|rs|swift|dart|exs?|scala|vue|svelte|astro|html?)$/i;

/**
 * Searches source files for named patterns with strict limits. Results per file are cached by
 * (path, size, mtime) so unchanged files are not re-read on the next check.
 */
export function grepFiles(
  base: string,
  files: FileEntry[],
  patterns: Record<string, RegExp>,
  cache: GrepCache | undefined,
  limits = { maxFiles: 3000, maxBytes: 256 * 1024 },
): { hits: Record<string, string[]>; filesRead: number; skipped: number } {
  const hits: Record<string, string[]> = {};
  for (const k of Object.keys(patterns)) hits[k] = [];
  let filesRead = 0;
  let skipped = 0;
  const sig = Object.entries(patterns).map(([k, r]) => `${k}=${r.source}`).join("|");
  for (const f of files) {
    if (!SOURCE_EXT.test(f.rel)) continue;
    if (filesRead >= limits.maxFiles) {
      skipped++;
      continue;
    }
    if (f.size > limits.maxBytes) {
      skipped++;
      continue;
    }
    const key = `${f.rel}|${f.size}|${Math.floor(f.mtimeMs)}|${hashStr(sig)}`;
    let found = cache?.get(key);
    if (!found) {
      filesRead++;
      let text = "";
      try {
        text = readHead(path.join(base, ...f.rel.split("/")), limits.maxBytes);
      } catch {
        continue;
      }
      found = Object.entries(patterns)
        .filter(([, re]) => re.test(text))
        .map(([k]) => k);
      cache?.set(key, found);
    }
    for (const k of found) if (hits[k]!.length < 5) hits[k]!.push(f.rel);
  }
  return { hits, filesRead, skipped };
}

function hashStr(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

import { normalizeEol } from "./fsx.js";

export const BLOCK_BEGIN = "<!-- repoguide:begin -->";
export const BLOCK_END = "<!-- repoguide:end -->";
const BEGIN_RE = /<!--\s*repoguide:begin\b[^>]*-->/g;
const END_RE = /<!--\s*repoguide:end\b[^>]*-->/g;

export type BlockParse =
  | { status: "absent" }
  | { status: "ok"; before: string; inner: string; after: string }
  | { status: "corrupt"; problem: string };

/** Finds the single RepoGuide-managed block inside a Markdown file. */
export function parseBlock(text: string): BlockParse {
  const src = normalizeEol(text);
  const begins = [...src.matchAll(BEGIN_RE)];
  const ends = [...src.matchAll(END_RE)];
  if (begins.length === 0 && ends.length === 0) return { status: "absent" };
  if (begins.length !== 1 || ends.length !== 1) {
    return {
      status: "corrupt",
      problem: `Delimitadores ambíguos: ${begins.length} início(s) e ${ends.length} fim(ns). Esperado exatamente um par.`,
    };
  }
  const b = begins[0]!;
  const e = ends[0]!;
  if (e.index! < b.index!) {
    return { status: "corrupt", problem: "Delimitador de fim aparece antes do início." };
  }
  const innerStart = b.index! + b[0].length;
  return {
    status: "ok",
    before: src.slice(0, b.index!),
    inner: src.slice(innerStart, e.index!).replace(/^\n/, "").replace(/\n$/, ""),
    after: src.slice(e.index! + e[0].length),
  };
}

export function renderBlock(inner: string): string {
  return `${BLOCK_BEGIN}\n${normalizeEol(inner).replace(/\n+$/, "")}\n${BLOCK_END}`;
}

/**
 * Inserts or replaces the managed block without touching anything outside it.
 * Throws on corrupted delimiters (caller turns that into a conflict).
 */
export function upsertBlock(existing: string | undefined, inner: string): { content: string; action: "created" | "inserted" | "replaced" | "unchanged" } {
  const block = renderBlock(inner);
  if (existing === undefined) return { content: block + "\n", action: "created" };
  // Preserve the file's line endings (CRLF is common on Windows checkouts).
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const out = (text: string) => (eol === "\n" ? text : text.replace(/\n/g, "\r\n"));
  const parsed = parseBlock(existing);
  if (parsed.status === "corrupt") throw new Error(parsed.problem);
  if (parsed.status === "absent") {
    const base = normalizeEol(existing);
    const sep = base.length === 0 ? "" : base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n";
    return { content: existing + out(sep + block + "\n"), action: "inserted" };
  }
  if (parsed.inner === normalizeEol(inner).replace(/\n+$/, "")) {
    return { content: existing, action: "unchanged" };
  }
  return { content: out(parsed.before + block + parsed.after), action: "replaced" };
}

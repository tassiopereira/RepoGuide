import { normalizeEol } from "./fsx.js";

/**
 * Minimal unified-style line diff (LCS based). Intended for human review of small managed
 * files; falls back to a summary for very large inputs.
 */
export function lineDiff(oldText: string, newText: string, label: string, maxLines = 200): string {
  const a = normalizeEol(oldText).split("\n");
  const b = normalizeEol(newText).split("\n");
  if (a.length * b.length > 4_000_000) {
    return `--- ${label}\n+++ ${label}\n(arquivo grande: ${a.length} → ${b.length} linhas; diff omitido)`;
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [`--- ${label} (atual)`, `+++ ${label} (novo)`];
  let i = 0;
  let j = 0;
  let unchangedRun: string[] = [];
  const flushContext = () => {
    if (unchangedRun.length > 4) {
      out.push(`  ${unchangedRun[0]}`, `  … (${unchangedRun.length - 2} linhas iguais)`, `  ${unchangedRun[unchangedRun.length - 1]}`);
    } else for (const l of unchangedRun) out.push(`  ${l}`);
    unchangedRun = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      unchangedRun.push(a[i]!);
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      flushContext();
      out.push(`+ ${b[j]}`);
      j++;
    } else {
      flushContext();
      out.push(`- ${a[i]}`);
      i++;
    }
  }
  // Trailing unchanged lines are noise.
  unchangedRun = [];
  if (out.length > maxLines) return [...out.slice(0, maxLines), `… (${out.length - maxLines} linhas de diff omitidas)`].join("\n");
  return out.join("\n");
}

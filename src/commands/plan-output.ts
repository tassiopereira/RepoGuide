import type { InstallPlan } from "../lib/install.js";

export function describePlan(plan: InstallPlan, dry: boolean, opts: { showDiffs: boolean }): string[] {
  const lines: string[] = [];
  lines.push(dry ? "Simulação (--dry-run): nenhum arquivo foi alterado." : "Alterações aplicadas:");
  for (const w of plan.writes) lines.push(`  ${dry ? "~" : "✔"} ${w.rel} — ${w.reason}`);
  for (const n of plan.notes) lines.push(`  · ${n}`);
  if (opts.showDiffs && plan.diffs.length) {
    lines.push("", "Diferenças:");
    for (const d of plan.diffs) lines.push(d, "");
  }
  return lines;
}

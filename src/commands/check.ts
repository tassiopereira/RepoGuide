import { formatAge } from "../lib/cache.js";
import { cliVersion } from "../lib/content.js";
import { usageError } from "../lib/errors.js";
import { EFFECTIVE_LABEL, evaluate, type Evaluation, type Item } from "../lib/evaluate.js";
import { DEFAULT_SOURCE, loadProject, resolveRoot } from "../lib/project.js";
import { describeRemote, remoteStatus, type RemoteStatus } from "../lib/remote.js";
import { compareSemVer } from "../lib/semver.js";
import { ExitCode, nowFromEnv, parseTimeout, result, sourceFrom, truncate, type CommandResult, type Globals } from "./common.js";

export const CHECK_HELP = `Uso: repoguide check [opções]

Checagem curta para o início de uma sessão ou tarefa. Não altera decisões, código,
versão adotada nem cria issues; apenas atualiza o cache local (.ai/.cache).

Opções:
  -C, --cwd <dir>        Diretório do projeto (padrão: atual)
      --json             Saída JSON estável
      --offline          Não acessa a rede; usa a última consulta conhecida
      --refresh          Ignora o cache de consultas remotas (TTL padrão: 24 h)
      --timeout <ms>     Tempo limite por requisição de rede (padrão: 5000)
      --fail-on <nível>  blocking (padrão) | pending | unknown | never
      --max-items <n>    Máximo de itens listados (padrão: 5)
      --repo <dono/nome> Repositório GitHub (padrão: detectado)
      --no-cache         Não lê nem grava cache local

Exemplos:
  repoguide check
  repoguide check --offline --json
  repoguide check --fail-on pending      # CI mais rígido
`;

export type FailOn = "blocking" | "pending" | "unknown" | "never";

export interface CheckFlags {
  offline?: boolean;
  refresh?: boolean;
  timeout?: string;
  "fail-on"?: string;
  "max-items"?: string;
  repo?: string;
  "no-cache"?: boolean;
}

export function countBy(items: Item[]): Record<string, number> {
  const c: Record<string, number> = { met: 0, pending: 0, unknown: 0, error: 0, deferred: 0, waived: 0, "not-applicable": 0, "review-required": 0 };
  for (const i of items) c[i.effective] = (c[i.effective] ?? 0) + 1;
  return c;
}

export function exitFor(ev: Evaluation, failOn: FailOn): number {
  if (failOn === "never") return ExitCode.OK;
  if (ev.violations.length > 0) return ExitCode.BLOCKING;
  const bad = ev.items.filter((i) => {
    if (failOn === "blocking") return false;
    if (["pending", "review-required", "error"].includes(i.effective)) return true;
    return failOn === "unknown" && i.effective === "unknown";
  });
  return bad.length ? ExitCode.BLOCKING : ExitCode.OK;
}

const ORDER: Item["effective"][] = ["review-required", "pending", "error", "unknown", "deferred"];

export async function runCheck(g: Globals, f: CheckFlags): Promise<CommandResult> {
  const failOn = (f["fail-on"] ?? "blocking") as FailOn;
  if (!["blocking", "pending", "unknown", "never"].includes(failOn)) throw usageError(`--fail-on inválido: ${failOn}`);
  const maxItems = f["max-items"] === undefined ? 5 : Number(f["max-items"]);
  if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > 100) throw usageError("--max-items deve estar entre 0 e 100");
  const root = resolveRoot(g.cwd);
  const project = loadProject(root);
  const now = nowFromEnv();
  const timeoutMs = parseTimeout(f.timeout, project.config.timeoutMs);
  const offline = !!f.offline;
  const { evaluation, cache } = await evaluate(project, {
    offline,
    refresh: !!f.refresh,
    now,
    timeoutMs,
    useCache: !f["no-cache"],
    ...(f.repo ? { repo: f.repo } : {}),
  });
  const source = sourceFrom(undefined, project.config.source, DEFAULT_SOURCE);
  const remote: RemoteStatus = await remoteStatus(cache, source, { offline, refresh: !!f.refresh, ttlHours: project.config.cacheTtlHours, timeoutMs, now });
  cache.save();

  const counts = countBy(evaluation.items);
  const installed = project.lock.sdkVersion;
  const newer = remote.latest && compareSemVer(remote.latest, installed) > 0;
  const lines: string[] = [];
  let header = `RepoGuide adotado: ${installed} | Disponível: ${describeRemote(remote)}`;
  if (remote.latest && !newer && remote.checked) header = `RepoGuide adotado: ${installed} | Disponível: ${remote.latest} (atualizado${remote.fromCache ? `; consultado há ${formatAge(remote.ageMs ?? 0)}` : ""})`;
  lines.push(header);
  lines.push(
    `Pendências: ${counts.pending! + counts.error!} | Revisões: ${counts["review-required"]} | Desconhecidos: ${counts.unknown} | Adiados: ${counts.deferred} | Dispensas válidas: ${counts.waived} | N/A: ${counts["not-applicable"]} | Atendidos: ${counts.met}`,
  );
  if (newer && remote.highlights) lines.push(`Novidade: ${truncate(remote.highlights, 120)}`);
  if (newer) lines.push(`Atualização disponível: repoguide update --dry-run (adoção só ocorre com update explícito)`);
  if (compareSemVer(cliVersion(), installed) < 0) lines.push(`Aviso: CLI ${cliVersion()} é anterior ao conteúdo adotado ${installed}; atualize a CLI.`);
  if (evaluation.violations.length) {
    lines.push(`Violações bloqueantes: ${evaluation.violations.length}`);
    for (const v of evaluation.violations.slice(0, maxItems)) lines.push(`  ! ${truncate(v, 140)}`);
  }
  const shown = evaluation.items
    .filter((i) => ORDER.includes(i.effective))
    .sort((a, b) => ORDER.indexOf(a.effective) - ORDER.indexOf(b.effective));
  for (const it of shown.slice(0, maxItems)) {
    const why = it.decision?.why ?? it.reasons[0] ?? "";
    lines.push(`- ${it.id}${it.scope === "repo" ? "" : `@${it.scope}`} ${EFFECTIVE_LABEL[it.effective]}${why ? `: ${truncate(why, 110)}` : ""}`);
  }
  if (shown.length > maxItems) lines.push(`  … mais ${shown.length - maxItems} item(ns)`);
  if (shown.length || evaluation.violations.length) lines.push("Detalhes: repoguide explain <id>");

  const exitCode = exitFor(evaluation, failOn) as CommandResult["exitCode"];
  return result(exitCode, lines, {
    project: { root, adoptedVersion: installed, cliVersion: cliVersion() },
    remote: {
      checked: remote.checked,
      fromCache: remote.fromCache,
      latest: remote.latest ?? null,
      updateAvailable: !!newer,
      ageSeconds: remote.ageMs !== undefined ? Math.round(remote.ageMs / 1000) : null,
      highlights: remote.highlights ?? null,
      error: remote.error ?? null,
    },
    counts,
    violations: evaluation.violations,
    integrity: evaluation.integrity,
    items: evaluation.items.map((i) => ({
      id: i.id,
      scope: i.scope,
      result: i.result,
      effective: i.effective,
      blocking: i.blocking,
      severity: i.severity,
      reason: i.decision?.why ?? i.reasons[0] ?? null,
      decision: i.decision ? { type: i.decision.type, status: i.decision.status, expires: i.decision.expires ?? null } : null,
    })),
    failOn,
  });
}

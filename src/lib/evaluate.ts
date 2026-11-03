import path from "node:path";
import { parseBlock } from "./block.js";
import { LocalCache } from "./cache.js";
import type { Requirement } from "./catalog.js";
import { CHECKERS, type Evidence, type Observation } from "./checkers.js";
import { decisionStatus, todayIso, validAttestation, type Attestation, type Decision } from "./decisions.js";
import { normalizeEol, readTextIfExists, safeJoin, sha256 } from "./fsx.js";
import { GitHubClient, detectRepo, githubToken } from "./github.js";
import { PATHS, scopesFor, type LoadedProject, type Scope } from "./project.js";
import { walk, type ScanResult } from "./scan.js";

/** Observed result, independent of human decisions. */
export type Result = "met" | "pending" | "unknown" | "error";
/** Combination of result, decision, revision and expiry. */
export type Effective = "met" | "pending" | "unknown" | "error" | "deferred" | "waived" | "not-applicable" | "review-required";

export interface Item {
  id: string;
  scope: string;
  title: string;
  severity: Requirement["severity"];
  blocking: boolean;
  result: Result;
  effective: Effective;
  decision?: { type: Decision["type"]; status: "active" | "expired" | "stale"; declaredBy: string; date: string; expires?: string; reviewBy?: string; reason: string; why?: string };
  attestation?: { declaredBy: string; date: string; expires: string };
  evidence: Evidence[];
  reasons: string[];
  isNew: boolean;
}

export interface IntegrityProblem {
  path: string;
  problem: string;
}

export interface Evaluation {
  items: Item[];
  integrity: IntegrityProblem[];
  violations: string[];
}

export interface EvalOptions {
  offline: boolean;
  refresh: boolean;
  now: Date;
  repo?: string;
  timeoutMs: number;
  /** Only evaluate these requirement ids. */
  only?: string[];
  useCache?: boolean;
}

/** Interprets a checker observation into a result. Missing evidence never yields "met". */
export function interpret(obs: Observation, attestation: Attestation | undefined): { result: Result; evidence: Evidence[]; reasons: string[] } {
  const evidence = [...obs.evidence];
  const reasons = [...obs.reasons];
  if (obs.staticOk === false) return { result: "pending", evidence, reasons };
  if (obs.staticOk === null) return { result: "unknown", evidence, reasons };
  if (obs.operational === "confirmed" || obs.operational === "not-required") return { result: "met", evidence, reasons: [] };
  if (obs.operational === "missing") return { result: "pending", evidence, reasons };
  if (attestation) {
    evidence.push({ kind: "human", detail: `declaração de ${attestation.declaredBy} em ${attestation.date} (válida até ${attestation.expires})${attestation.evidence ? `: ${attestation.evidence}` : ""}` });
    return { result: "met", evidence, reasons: [] };
  }
  return { result: "unknown", evidence, reasons };
}

export function combine(result: Result, status: ReturnType<typeof decisionStatus>): Effective {
  if (status.state === "expired" || status.state === "stale") return result === "met" ? "met" : "review-required";
  if (status.state === "active") {
    if (result === "met" && status.decision.type === "deferred") return "met";
    return status.decision.type;
  }
  return result;
}

export function checkIntegrity(project: LoadedProject): IntegrityProblem[] {
  const out: IntegrityProblem[] = [];
  for (const [rel, expected] of Object.entries(project.lock.files)) {
    let text: string | undefined;
    try {
      text = readTextIfExists(safeJoin(project.root, rel));
    } catch (e) {
      out.push({ path: rel, problem: (e as Error).message });
      continue;
    }
    if (text === undefined) out.push({ path: rel, problem: "arquivo gerenciado ausente" });
    else if (sha256(text) !== expected) out.push({ path: rel, problem: "arquivo gerenciado modificado localmente" });
  }
  for (const [rel, expected] of Object.entries(project.lock.blocks)) {
    const text = readTextIfExists(safeJoin(project.root, rel));
    if (text === undefined) {
      out.push({ path: rel, problem: "arquivo com bloco RepoGuide ausente" });
      continue;
    }
    const b = parseBlock(text);
    if (b.status === "absent") out.push({ path: rel, problem: "bloco RepoGuide removido" });
    else if (b.status === "corrupt") out.push({ path: rel, problem: b.problem });
    else if (sha256(normalizeEol(b.inner)) !== expected) out.push({ path: rel, problem: "bloco RepoGuide editado localmente" });
  }
  return out;
}

export async function evaluate(project: LoadedProject, opts: EvalOptions): Promise<{ evaluation: Evaluation; cache: LocalCache }> {
  const cache = new LocalCache(project.root, opts.useCache !== false);
  const today = todayIso(opts.now);
  const ttlMs = project.config.cacheTtlHours * 3600000;
  const repo = opts.offline ? undefined : safeDetect(project.root, opts.repo);
  const github = repo ? { client: new GitHubClient({ token: githubToken(), timeoutMs: opts.timeoutMs }), repo } : undefined;
  const scans = new Map<string, ScanResult>();
  const scanFor = (s: Scope): ScanResult => {
    if (!scans.has(s.path)) scans.set(s.path, walk(s.path === "." ? project.root : safeJoin(project.root, s.path)));
    return scans.get(s.path)!;
  };
  const items: Item[] = [];
  for (const req of project.catalog.requirements) {
    if (opts.only && !opts.only.includes(req.id)) continue;
    for (const scope of scopesFor(req.scopeLevel, project.config)) {
      const scopeAbs = scope.path === "." ? project.root : safeJoin(project.root, scope.path);
      const checker = CHECKERS[req.verification.checker];
      let obs: Observation;
      let errored = false;
      if (!checker) {
        obs = { staticOk: null, operational: "unverified", evidence: [], reasons: [`verificador "${req.verification.checker}" não existe nesta versão da CLI; atualize a CLI`] };
      } else {
        try {
          const scan = scanFor(scope);
          obs = await checker({
            root: project.root,
            scope,
            scopeAbs,
            files: scan.files,
            truncated: scan.truncated,
            cache,
            now: opts.now,
            offline: opts.offline,
            refresh: opts.refresh,
            ttlMs,
            ...(github ? { github } : {}),
          });
        } catch (e) {
          errored = true;
          obs = { staticOk: null, operational: "unverified", evidence: [], reasons: [`erro de verificação: ${(e as Error).message}`] };
        }
      }
      const att = validAttestation(project.decisions, req, scope.id, today);
      const interp = errored ? { result: "error" as Result, evidence: obs.evidence, reasons: obs.reasons } : interpret(obs, att);
      const status = decisionStatus(project.decisions, req, scope.id, today);
      const effective = combine(interp.result, status);
      const item: Item = {
        id: req.id,
        scope: scope.id,
        title: req.title,
        severity: req.severity,
        blocking: req.blocking || project.config.blocking.includes(req.id),
        result: interp.result,
        effective,
        evidence: interp.evidence,
        reasons: interp.reasons,
        isNew: req.introducedIn === project.lock.sdkVersion,
      };
      if (status.state !== "none") {
        const d = status.decision;
        item.decision = {
          type: d.type,
          status: status.state,
          declaredBy: d.declaredBy,
          date: d.date,
          reason: d.reason,
          ...(d.expires ? { expires: d.expires } : {}),
          ...(d.reviewBy ? { reviewBy: d.reviewBy } : {}),
          ...("why" in status ? { why: status.why } : {}),
        };
      }
      if (att) item.attestation = { declaredBy: att.declaredBy, date: att.date, expires: att.expires };
      items.push(item);
    }
  }
  const integrity = checkIntegrity(project);
  const violations: string[] = [];
  for (const p of integrity) violations.push(`${p.path}: ${p.problem}`);
  for (const it of items) {
    if (it.blocking && (it.effective === "pending" || it.effective === "review-required")) {
      violations.push(`${it.id}@${it.scope}: requisito bloqueante ${it.effective === "pending" ? "pendente" : "com decisão a revisar"}`);
    }
  }
  return { evaluation: { items, integrity, violations }, cache };
}

function safeDetect(root: string, explicit?: string) {
  try {
    return detectRepo(root, explicit);
  } catch {
    return undefined;
  }
}

export const EFFECTIVE_LABEL: Record<Effective, string> = {
  met: "atendido",
  pending: "pendente",
  unknown: "desconhecido",
  error: "erro de verificação",
  deferred: "adiado (em acompanhamento)",
  waived: "dispensado",
  "not-applicable": "não aplicável",
  "review-required": "decisão a revisar",
};

export const RESULT_LABEL: Record<Result, string> = {
  met: "atendido",
  pending: "pendente",
  unknown: "desconhecido",
  error: "erro de verificação",
};

export function relPathFrom(root: string, p: string): string {
  return path.relative(root, p).replace(/\\/g, "/");
}

export { PATHS };

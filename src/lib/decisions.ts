import { execError } from "./errors.js";
import type { Requirement } from "./catalog.js";

export type DecisionType = "deferred" | "waived" | "not-applicable";

export interface Decision {
  requirement: string;
  scope: string;
  type: DecisionType;
  reason: string;
  /** Declared identity. A declaration, not authentication: governance happens in PR review. */
  declaredBy: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Requirement revision at the time of the decision. */
  requirementRevision: number;
  /** Required for deferrals. ISO date after which the decision no longer counts. */
  expires?: string;
  /** Optional future review date for waivers / not-applicable. */
  reviewBy?: string;
}

export interface Attestation {
  requirement: string;
  scope: string;
  note: string;
  declaredBy: string;
  date: string;
  requirementRevision: number;
  expires: string;
  evidence?: string;
}

export interface HistoryEntry {
  entry: Decision | Attestation;
  kind: "decision" | "attestation";
  endedAt: string;
  endedBy: string;
  endReason: string;
}

export interface DecisionsFile {
  schemaVersion: 1;
  decisions: Decision[];
  attestations: Attestation[];
  history: HistoryEntry[];
}

export function emptyDecisions(): DecisionsFile {
  return { schemaVersion: 1, decisions: [], attestations: [], history: [] };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86400000);
}

export function parseDecisions(raw: unknown, source: string): DecisionsFile {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null) throw execError(`Arquivo de decisões inválido: ${source}`);
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) problems.push("schemaVersion deve ser 1");
  const decisions = Array.isArray(r.decisions) ? r.decisions : (problems.push("decisions deve ser lista"), []);
  const attestations = Array.isArray(r.attestations) ? r.attestations : [];
  const history = Array.isArray(r.history) ? r.history : [];
  decisions.forEach((d: Record<string, unknown>, i: number) => {
    const at = `decisions[${i}]`;
    if (typeof d?.requirement !== "string") problems.push(`${at}.requirement ausente`);
    if (typeof d?.scope !== "string") problems.push(`${at}.scope ausente`);
    if (!["deferred", "waived", "not-applicable"].includes(d?.type as string)) problems.push(`${at}.type inválido`);
    if (typeof d?.reason !== "string" || d.reason.trim().length < 3) problems.push(`${at}.reason ausente`);
    if (typeof d?.declaredBy !== "string" || d.declaredBy.trim().length === 0) problems.push(`${at}.declaredBy ausente`);
    if (!isIsoDate(d?.date)) problems.push(`${at}.date inválida`);
    if (typeof d?.requirementRevision !== "number") problems.push(`${at}.requirementRevision ausente`);
    if (d?.type === "deferred" && !isIsoDate(d?.expires)) problems.push(`${at}.expires obrigatório para adiamento`);
    if (d?.expires !== undefined && !isIsoDate(d.expires)) problems.push(`${at}.expires inválida`);
    if (d?.reviewBy !== undefined && !isIsoDate(d.reviewBy)) problems.push(`${at}.reviewBy inválida`);
  });
  attestations.forEach((a: Record<string, unknown>, i: number) => {
    const at = `attestations[${i}]`;
    if (typeof a?.requirement !== "string" || typeof a?.scope !== "string") problems.push(`${at} sem requirement/scope`);
    if (typeof a?.declaredBy !== "string" || a.declaredBy.trim() === "") problems.push(`${at}.declaredBy ausente`);
    if (!isIsoDate(a?.date) || !isIsoDate(a?.expires)) problems.push(`${at} com datas inválidas`);
  });
  const keys = new Set<string>();
  for (const d of decisions as Decision[]) {
    const k = `${d.requirement}@${d.scope}`;
    if (keys.has(k)) problems.push(`decisão duplicada para ${k}; mantenha apenas uma ativa e mova a outra para history`);
    keys.add(k);
  }
  if (problems.length) {
    throw execError(`Arquivo de decisões inválido: ${source}`, "Corrija o JSON ou restaure pelo Git.", problems.slice(0, 20));
  }
  return { schemaVersion: 1, decisions: decisions as Decision[], attestations: attestations as Attestation[], history: history as HistoryEntry[] };
}

export type DecisionStatus =
  | { state: "none" }
  | { state: "active"; decision: Decision }
  | { state: "expired"; decision: Decision; why: string }
  | { state: "stale"; decision: Decision; why: string };

export function decisionStatus(file: DecisionsFile, req: Requirement, scope: string, today: string): DecisionStatus {
  const decision = file.decisions.find((d) => d.requirement === req.id && d.scope === scope);
  if (!decision) return { state: "none" };
  if (decision.expires && decision.expires < today) {
    return { state: "expired", decision, why: `venceu em ${decision.expires}` };
  }
  if (decision.reviewBy && decision.reviewBy < today) {
    return { state: "expired", decision, why: `revisão prevista para ${decision.reviewBy}` };
  }
  if (req.decisionPolicy.onMaterialRevision === "require-review" && decision.requirementRevision < req.materialRevision) {
    return {
      state: "stale",
      decision,
      why: `requisito mudou materialmente (revisão ${decision.requirementRevision} → ${req.materialRevision})`,
    };
  }
  return { state: "active", decision };
}

export function validAttestation(file: DecisionsFile, req: Requirement, scope: string, today: string): Attestation | undefined {
  return file.attestations.find(
    (a) => a.requirement === req.id && a.scope === scope && a.expires >= today && a.requirementRevision >= req.materialRevision,
  );
}

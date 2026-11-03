import { execError } from "./errors.js";
import { isSemVer } from "./semver.js";

export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;
export const CURRENT_SCHEMA_VERSION = 1;

export type Severity = "high" | "medium" | "low";
export type ScopeLevel = "repository" | "application";
export type EvidenceKind = "static" | "operational" | "human";

export interface AcceptanceCriterion {
  id: string;
  text: string;
  /** How this criterion can be proven. */
  evidence: EvidenceKind;
}

export interface Requirement {
  id: string;
  /** Increments on any change to the requirement. */
  revision: number;
  /** Revision of the last *material* change. Decisions recorded before it may require review. */
  materialRevision: number;
  title: string;
  description: string;
  category: string;
  introducedIn: string;
  scopeLevel: ScopeLevel;
  applicability: { summary: string; default: "applicable" | "depends" };
  acceptanceCriteria: AcceptanceCriterion[];
  suggestedTools: string[];
  acceptedEquivalents: string[];
  severity: Severity;
  blocking: boolean;
  verification: { checker: string; summary: string };
  guidance: string[];
  decisionPolicy: {
    /** What happens to existing decisions when materialRevision increases. */
    onMaterialRevision: "require-review" | "keep";
    /** Maximum validity of a waiver, in days. Null means no maximum. */
    maxWaiverDays: number | null;
    /** Maximum deferral, in days. */
    maxDeferralDays: number;
  };
  changes?: { revision: number; summary: string; material: boolean }[];
}

export interface Catalog {
  schemaVersion: number;
  catalogVersion: string;
  language: string;
  requirements: Requirement[];
}

const ID_RE = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown, max = 2000): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}
function strArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length <= 500);
}
function posInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100000;
}

/** Validates a catalog. Returns a list of problems; empty means valid. */
export function catalogProblems(raw: unknown): string[] {
  const p: string[] = [];
  if (!isObj(raw)) return ["catálogo não é um objeto JSON"];
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(raw.schemaVersion as 1)) {
    p.push(`schemaVersion ${String(raw.schemaVersion)} não suportada por esta CLI (suporta: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`);
    return p;
  }
  if (!isSemVer(raw.catalogVersion)) p.push("catalogVersion inválida");
  if (!str(raw.language, 20)) p.push("language ausente");
  if (!Array.isArray(raw.requirements)) return [...p, "requirements deve ser uma lista"];
  if (raw.requirements.length > 500) p.push("catálogo excede 500 requisitos");
  const seen = new Set<string>();
  raw.requirements.forEach((r: unknown, i: number) => {
    const at = `requirements[${i}]`;
    if (!isObj(r)) return void p.push(`${at} não é objeto`);
    if (!str(r.id, 60) || !ID_RE.test(r.id)) p.push(`${at}.id inválido`);
    else if (seen.has(r.id)) p.push(`${at}.id duplicado: ${r.id}`);
    else seen.add(r.id);
    if (!posInt(r.revision)) p.push(`${at}.revision inválida`);
    if (!posInt(r.materialRevision) || (posInt(r.revision) && (r.materialRevision as number) > r.revision)) p.push(`${at}.materialRevision inválida`);
    for (const k of ["title", "description", "category"]) if (!str(r[k])) p.push(`${at}.${k} ausente`);
    if (!isSemVer(r.introducedIn)) p.push(`${at}.introducedIn inválida`);
    if (r.scopeLevel !== "repository" && r.scopeLevel !== "application") p.push(`${at}.scopeLevel inválido`);
    if (!isObj(r.applicability) || !str(r.applicability.summary) || !["applicable", "depends"].includes(r.applicability.default as string)) p.push(`${at}.applicability inválida`);
    if (!Array.isArray(r.acceptanceCriteria) || r.acceptanceCriteria.length === 0) p.push(`${at}.acceptanceCriteria vazio`);
    else
      r.acceptanceCriteria.forEach((c: unknown, j: number) => {
        if (!isObj(c) || !str(c.id, 40) || !str(c.text) || !["static", "operational", "human"].includes(c.evidence as string)) p.push(`${at}.acceptanceCriteria[${j}] inválido`);
      });
    if (!strArr(r.suggestedTools)) p.push(`${at}.suggestedTools inválido`);
    if (!strArr(r.acceptedEquivalents)) p.push(`${at}.acceptedEquivalents inválido`);
    if (!["high", "medium", "low"].includes(r.severity as string)) p.push(`${at}.severity inválida`);
    if (typeof r.blocking !== "boolean") p.push(`${at}.blocking deve ser booleano`);
    if (!isObj(r.verification) || !str(r.verification.checker, 60) || !str(r.verification.summary)) p.push(`${at}.verification inválida`);
    if (!strArr(r.guidance)) p.push(`${at}.guidance inválido`);
    const dp = r.decisionPolicy;
    if (
      !isObj(dp) ||
      !["require-review", "keep"].includes(dp.onMaterialRevision as string) ||
      !(dp.maxWaiverDays === null || posInt(dp.maxWaiverDays)) ||
      !posInt(dp.maxDeferralDays)
    )
      p.push(`${at}.decisionPolicy inválida`);
    if (r.changes !== undefined && !Array.isArray(r.changes)) p.push(`${at}.changes inválido`);
  });
  return p;
}

export function parseCatalog(raw: unknown, source: string): Catalog {
  const problems = catalogProblems(raw);
  if (problems.length) {
    throw execError(`Catálogo de requisitos inválido (${source}).`, "Restaure o conteúdo gerenciado com `repoguide update` ou pelo Git.", problems.slice(0, 20));
  }
  return raw as Catalog;
}

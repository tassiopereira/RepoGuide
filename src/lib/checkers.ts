import path from "node:path";
import { parseBlock } from "./block.js";
import { LocalCache, formatAge } from "./cache.js";
import type { EvidenceKind } from "./catalog.js";
import { readTextIfExists } from "./fsx.js";
import { GitHubClient, enc, type RepoRef } from "./github.js";
import { PATHS, type Scope } from "./project.js";
import { grepFiles, readHead, type FileEntry } from "./scan.js";

export type Operational = "confirmed" | "missing" | "unverified" | "not-required";

export interface Evidence {
  kind: EvidenceKind;
  detail: string;
}

/** What a checker observed. Interpretation into a result happens in evaluate.ts. */
export interface Observation {
  /** true: static criteria satisfied; false: not satisfied; null: cannot determine (applicability unknown). */
  staticOk: boolean | null;
  operational: Operational;
  evidence: Evidence[];
  /** Short reasons explaining what is missing or unknown. */
  reasons: string[];
}

export interface CheckContext {
  root: string;
  scope: Scope;
  scopeAbs: string;
  files: FileEntry[];
  truncated: boolean;
  cache: LocalCache;
  now: Date;
  offline: boolean;
  refresh: boolean;
  ttlMs: number;
  github?: { client: GitHubClient; repo: RepoRef };
}

export type Checker = (ctx: CheckContext) => Promise<Observation>;

function readRel(ctx: CheckContext, rel: string, max = 512 * 1024): string | undefined {
  try {
    return readHead(path.join(ctx.scopeAbs, ...rel.split("/")), max);
  } catch {
    return undefined;
  }
}

const MANIFEST = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py|Gemfile|go\.mod|Cargo\.toml|composer\.json|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj|mix\.exs|pubspec\.yaml|Package\.swift)$/;

function manifests(ctx: CheckContext): FileEntry[] {
  return ctx.files.filter((f) => MANIFEST.test(f.rel) && f.size < 1024 * 1024);
}

function manifestMatches(ctx: CheckContext, re: RegExp): { file: string; match: string }[] {
  const out: { file: string; match: string }[] = [];
  for (const m of manifests(ctx)) {
    const text = readRel(ctx, m.rel);
    if (!text) continue;
    const hit = re.exec(text);
    if (hit) out.push({ file: m.rel, match: hit[0] });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Remote evidence with TTL. Cached values are trusted only within the TTL; offline runs report
 * stale evidence as unverified instead of silently trusting it forever.
 */
async function remoteEvidence<T>(
  ctx: CheckContext,
  key: string,
  fetcher: (gh: NonNullable<CheckContext["github"]>) => Promise<T>,
): Promise<{ value?: T; note: string }> {
  const cached = ctx.cache.getEvidence<T>(key, ctx.ttlMs, ctx.now);
  if (cached && "value" in cached && !ctx.refresh) return { value: cached.value, note: `consultado há ${formatAge(cached.ageMs)}` };
  if (ctx.offline || !ctx.github) {
    const why = ctx.offline ? "modo offline" : "repositório GitHub não identificado";
    if (cached && "expired" in cached) return { note: `${why}; última evidência expirou (há ${formatAge(cached.ageMs)})` };
    if (cached && "value" in cached) return { value: cached.value, note: `consultado há ${formatAge(cached.ageMs)}` };
    return { note: why };
  }
  try {
    const value = await fetcher(ctx.github);
    ctx.cache.setEvidence(key, value, ctx.now);
    return { value, note: "consultado agora" };
  } catch (e) {
    return { note: `consulta remota falhou: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// RG-OBS-001: production error monitoring
// ---------------------------------------------------------------------------

const ERROR_SDK = /["'\s/=:]((@sentry\/[a-z-]+)|sentry[-_](sdk|ruby|rails|go|laravel|symfony)|getsentry\/sentry-go|io\.sentry|sentry\/sentry|@bugsnag\/[a-z-]+|bugsnag|rollbar|@honeybadger-io\/[a-z-]+|honeybadger|dd-trace|ddtrace|newrelic(_rpm)?|elastic-apm(-node)?|@appsignal\/[a-z-]+|appsignal|raygun[a-z0-9]*|@airbrake\/[a-z-]+|airbrake|@highlight-run\/[a-z-]+)["'\s=:<>~^@]/i;

const ERROR_INIT: Record<string, RegExp> = {
  init: /Sentry\.init\s*\(|sentry_sdk\.init\s*\(|sentry\.Init\s*\(|SentrySdk\.Init|Sentry::init|\\Sentry\\init|Sentry\.configure|Bugsnag\.(start|configure|notify)|new\s+Rollbar\s*\(|Rollbar\.(init|configure)|Honeybadger\.(configure|init)|tracer\.init\s*\(|require\(\s*['"]newrelic['"]\s*\)|import\s+['"]newrelic['"]|elastic-apm-node\/start|Appsignal\.(start|config)|new\s+Appsignal|Airbrake\.(configure|Notifier)|H\.init\s*\(/,
  environment: /\benvironment\s*[:=]|SENTRY_ENVIRONMENT|DD_ENV|NEW_RELIC_ENVIRONMENT|\benv\s*:/,
  release: /\brelease\s*[:=]|SENTRY_RELEASE|DD_VERSION|\bappVersion\s*[:=]|\bversion\s*:\s*process\.env/,
};

export const errorMonitoring: Checker = async (ctx) => {
  const deps = manifestMatches(ctx, ERROR_SDK);
  const ev: Evidence[] = [];
  const reasons: string[] = [];
  if (manifests(ctx).length === 0) {
    return { staticOk: null, operational: "unverified", evidence: [], reasons: ["nenhum manifesto de dependências encontrado neste escopo; aplicabilidade indeterminada"] };
  }
  if (deps.length === 0) {
    return {
      staticOk: false,
      operational: "unverified",
      evidence: [],
      reasons: ["nenhuma dependência de monitoramento de erros encontrada (ex.: Sentry ou equivalente)", "se o escopo não roda em produção, registre não aplicável"],
    };
  }
  for (const d of deps) ev.push({ kind: "static", detail: `dependência ${d.match.replace(/["'\s=:<>~^]/g, "")} em ${d.file}` });
  const g = grepFiles(ctx.scopeAbs, ctx.files, ERROR_INIT, ctx.cache);
  if (g.hits.init!.length === 0) {
    reasons.push("dependência presente, mas nenhuma inicialização encontrada no código");
    return { staticOk: false, operational: "unverified", evidence: ev, reasons };
  }
  ev.push({ kind: "static", detail: `inicialização em ${g.hits.init!.slice(0, 2).join(", ")}` });
  const initFiles = new Set(g.hits.init);
  const envNear = g.hits.environment!.some((f) => initFiles.has(f));
  const relNear = g.hits.release!.some((f) => initFiles.has(f));
  if (envNear) ev.push({ kind: "static", detail: "indício de configuração de ambiente junto à inicialização" });
  else reasons.push("ambiente (environment) não identificado junto à inicialização");
  if (relNear) ev.push({ kind: "static", detail: "indício de versão/release junto à inicialização" });
  else reasons.push("versão/release não identificada junto à inicialização");
  reasons.push("captura real e encaminhamento de alertas não são verificáveis localmente; confirme com `repoguide requirement attest`");
  if (g.skipped > 0) reasons.push(`${g.skipped} arquivo(s) não lidos por limite de tamanho/quantidade`);
  return { staticOk: true, operational: "unverified", evidence: ev, reasons };
};

// ---------------------------------------------------------------------------
// RG-PRD-001: product usage / audience analytics
// ---------------------------------------------------------------------------

const ANALYTICS_DEP = /["'\s/=:](react-ga4?|@next\/third-parties|vue-gtag|ngx-google-analytics|@vercel\/analytics|plausible-tracker|next-plausible|@plausible[a-z/-]*|posthog-js|posthog-node|posthog|mixpanel(-browser)?|@amplitude\/[a-z-]+|amplitude-js|@segment\/[a-z-]+|analytics-node|matomo[a-z-]*|@umami[a-z/-]*|fathom-client|@cloudflare\/web-analytics|@microsoft\/applicationinsights-web|heap-api|@heap\/[a-z-]+|@rudderstack\/[a-z-]+|@snowplow\/[a-z-]+)["'\s=:<>~^@]/i;
const ANALYTICS_CODE: Record<string, RegExp> = {
  snippet: /googletagmanager\.com\/(gtag|gtm)|gtag\(\s*['"]config['"]|plausible\.io\/js|cdn\.usefathom\.com|static\.cloudflareinsights\.com\/beacon|umami\.is|script\.js["'][^>]*data-website-id|matomo\.js|piwik\.js|posthog\.init\s*\(|mixpanel\.init\s*\(|amplitude\.(init|getInstance)|analytics\.load\s*\(|<Analytics\s*\/>/,
};
const FRONTEND_DEP = /["'\s](react|react-dom|vue|svelte|next|nuxt|@angular\/core|astro|gatsby|@remix-run\/[a-z-]+|solid-js|preact|vite|@sveltejs\/kit|ember-source|jquery)["'\s:]/;

export const analytics: Checker = async (ctx) => {
  const deps = manifestMatches(ctx, ANALYTICS_DEP);
  const g = grepFiles(ctx.scopeAbs, ctx.files, ANALYTICS_CODE, ctx.cache);
  const ev: Evidence[] = deps.map((d) => ({ kind: "static" as const, detail: `dependência ${d.match.replace(/["'\s=:<>~^]/g, "")} em ${d.file}` }));
  if (g.hits.snippet!.length) ev.push({ kind: "static", detail: `trecho de análise em ${g.hits.snippet!.slice(0, 2).join(", ")}` });
  if (ev.length > 0) {
    return {
      staticOk: true,
      operational: "unverified",
      evidence: ev,
      reasons: ["recebimento real de dados e conformidade com consentimento/privacidade não são verificáveis localmente; confirme com `repoguide requirement attest`"],
    };
  }
  const frontend = manifestMatches(ctx, FRONTEND_DEP).length > 0 || ctx.files.some((f) => /(^|\/)(index\.html?|public\/[^/]+\.html?)$/i.test(f.rel));
  if (frontend) {
    return {
      staticOk: false,
      operational: "unverified",
      evidence: [{ kind: "static", detail: "sinais de interface pública (framework web ou HTML)" }],
      reasons: ["nenhuma ferramenta de análise de uso encontrada", "se o produto não tiver público a medir, registre não aplicável"],
    };
  }
  return {
    staticOk: null,
    operational: "unverified",
    evidence: [],
    reasons: ["aplicabilidade indeterminada: nenhum sinal de interface pública nem de ferramenta de análise", "registre não aplicável se o produto não precisar medir uso"],
  };
};

// ---------------------------------------------------------------------------
// RG-DEP-001: automated dependency updates
// ---------------------------------------------------------------------------

const ECOSYSTEMS: [RegExp, string][] = [
  [/(^|\/)package\.json$/, "npm"],
  [/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py)$/, "pip"],
  [/(^|\/)Gemfile$/, "bundler"],
  [/(^|\/)go\.mod$/, "gomod"],
  [/(^|\/)Cargo\.toml$/, "cargo"],
  [/(^|\/)composer\.json$/, "composer"],
  [/(^|\/)pom\.xml$/, "maven"],
  [/(^|\/)build\.gradle(\.kts)?$/, "gradle"],
  [/(^|\/)([^/]+\.(cs|fs)proj|packages\.config)$/, "nuget"],
  [/(^|\/)Dockerfile[^/]*$/, "docker"],
  [/^\.github\/workflows\/[^/]+\.ya?ml$/, "github-actions"],
  [/(^|\/)mix\.exs$/, "mix"],
  [/(^|\/)pubspec\.yaml$/, "pub"],
  [/(^|\/)Package\.swift$/, "swift"],
  [/(^|\/)[^/]+\.tf$/, "terraform"],
];
/** Dependabot ecosystem names that cover a detected ecosystem. */
const DEPENDABOT_ALIASES: Record<string, string[]> = { pip: ["pip", "uv"], npm: ["npm", "bun"], docker: ["docker", "docker-compose"] };
const RENOVATE_FILES = ["renovate.json", "renovate.json5", ".github/renovate.json", ".github/renovate.json5", ".gitlab/renovate.json", ".renovaterc", ".renovaterc.json", ".renovaterc.json5"];

export function detectEcosystems(files: FileEntry[]): string[] {
  const set = new Set<string>();
  for (const f of files) for (const [re, eco] of ECOSYSTEMS) if (re.test(f.rel)) set.add(eco);
  return [...set].sort();
}

export function dependabotEcosystems(yml: string): string[] {
  const out = new Set<string>();
  for (const m of yml.matchAll(/^\s*-?\s*package-ecosystem\s*:\s*["']?([a-z0-9-]+)["']?/gm)) out.add(m[1]!);
  return [...out];
}

export const dependencyUpdates: Checker = async (ctx) => {
  const ecosystems = detectEcosystems(ctx.files);
  const ev: Evidence[] = [];
  const reasons: string[] = [];
  const read = (rel: string) => {
    try {
      return readTextIfExists(path.join(ctx.root, ...rel.split("/")), 256 * 1024);
    } catch {
      return undefined;
    }
  };
  const dependabotPath = [".github/dependabot.yml", ".github/dependabot.yaml"].find((p) => read(p) !== undefined);
  const renovatePath = RENOVATE_FILES.find((p) => read(p) !== undefined);
  let renovateInPkg = false;
  if (!renovatePath) {
    const pkg = read("package.json");
    renovateInPkg = !!pkg && /"renovate"\s*:\s*\{/.test(pkg);
  }
  let tool: "dependabot" | "renovate" | undefined;
  let uncovered: string[] = ecosystems;
  if (dependabotPath) {
    tool = "dependabot";
    const configured = dependabotEcosystems(read(dependabotPath)!);
    ev.push({ kind: "static", detail: `${dependabotPath} cobre: ${configured.join(", ") || "(nenhum ecossistema)"}` });
    uncovered = ecosystems.filter((e) => !(DEPENDABOT_ALIASES[e] ?? [e]).some((a) => configured.includes(a)));
  }
  if (renovatePath || renovateInPkg) {
    tool = tool ?? "renovate";
    const where = renovatePath ?? "package.json (chave renovate)";
    const text = renovatePath ? read(renovatePath)! : "";
    const restricted = /"?enabledManagers"?\s*:/.test(text);
    ev.push({ kind: "static", detail: `configuração Renovate em ${where}${restricted ? " (enabledManagers restrito)" : ""}` });
    if (!restricted) uncovered = [];
    else reasons.push("Renovate com enabledManagers: cobertura não calculada automaticamente; revise manualmente");
  }
  if (!tool) {
    if (ecosystems.length === 0) {
      return { staticOk: null, operational: "unverified", evidence: [], reasons: ["nenhum ecossistema de dependências detectado; aplicabilidade indeterminada"] };
    }
    return {
      staticOk: false,
      operational: "unverified",
      evidence: [],
      reasons: [`nenhuma configuração de Dependabot ou Renovate; ecossistemas detectados: ${ecosystems.join(", ")}`],
    };
  }
  if (ctx.truncated) reasons.push("varredura truncada por limite; ecossistemas podem estar incompletos");
  if (uncovered.length) {
    reasons.unshift(`ecossistemas sem cobertura: ${uncovered.join(", ")}`);
    return { staticOk: false, operational: "unverified", evidence: ev, reasons };
  }
  // Operational evidence: recent update PRs opened by the bot.
  const author = tool === "dependabot" ? "app/dependabot" : "app/renovate";
  const since = new Date(ctx.now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const key = ctx.github ? `deps-prs:${ctx.github.repo.owner}/${ctx.github.repo.repo}:${author}` : "deps-prs:none";
  const r = await remoteEvidence(ctx, key, async (gh) => {
    const q = enc(`repo:${gh.repo.owner}/${gh.repo.repo} is:pr author:${author} created:>=${since}`);
    const res = await gh.client.must<{ total_count: number }>("GET", `/search/issues?q=${q}&per_page=1`, undefined, "busca de PRs de atualização");
    return res.total_count;
  });
  if (typeof r.value === "number" && r.value > 0) {
    ev.push({ kind: "operational", detail: `${r.value} PR(s) de ${tool} nos últimos 90 dias (${r.note})` });
    return { staticOk: true, operational: "confirmed", evidence: ev, reasons };
  }
  reasons.push(
    typeof r.value === "number"
      ? `nenhum PR de ${tool} nos últimos 90 dias (${r.note}); a configuração sozinha não comprova execução`
      : `execução remota não comprovada (${r.note}); a configuração sozinha não comprova execução`,
  );
  return { staticOk: true, operational: "unverified", evidence: ev, reasons };
};

// ---------------------------------------------------------------------------
// RG-GOV-001: pull requests for new features
// ---------------------------------------------------------------------------

interface BranchRuleSummary {
  defaultBranch: string;
  pullRequestRule: boolean;
  classicProtected: boolean | null;
}

export const prWorkflow: Checker = async (ctx) => {
  const ev: Evidence[] = [];
  const reasons: string[] = [];
  let agents: string | undefined;
  try {
    agents = readTextIfExists(path.join(ctx.root, PATHS.agents));
  } catch {
    agents = undefined;
  }
  const block = agents ? parseBlock(agents) : { status: "absent" as const };
  const guidance = block.status === "ok" && /pull request|\bPR\b/i.test(block.inner);
  if (guidance) ev.push({ kind: "static", detail: "orientação escrita para trabalhar via PR no bloco RepoGuide do AGENTS.md" });
  else reasons.push("orientação de PR ausente no AGENTS.md (bloco RepoGuide ausente ou alterado)");

  const key = ctx.github ? `branch-rules:${ctx.github.repo.owner}/${ctx.github.repo.repo}` : "branch-rules:none";
  const r = await remoteEvidence<BranchRuleSummary>(ctx, key, async (gh) => {
    const { owner, repo } = gh.repo;
    const info = await gh.client.must<{ default_branch: string }>("GET", `/repos/${enc(owner)}/${enc(repo)}`, undefined, "dados do repositório");
    const branch = info.default_branch;
    const rules = await gh.client.must<{ type: string }[]>("GET", `/repos/${enc(owner)}/${enc(repo)}/rules/branches/${enc(branch)}`, undefined, "regras da branch");
    const pullRequestRule = Array.isArray(rules) && rules.some((x) => x.type === "pull_request");
    let classicProtected: boolean | null = null;
    if (!pullRequestRule) {
      const prot = await gh.client.request<{ required_pull_request_reviews?: unknown }>("GET", `/repos/${enc(owner)}/${enc(repo)}/branches/${enc(branch)}/protection`);
      if (prot.status === 200) classicProtected = !!prot.data?.required_pull_request_reviews;
      else if (prot.status === 404) classicProtected = false;
    }
    return { defaultBranch: branch, pullRequestRule, classicProtected };
  });
  let operational: Operational = "unverified";
  if (r.value) {
    if (r.value.pullRequestRule || r.value.classicProtected) {
      operational = "confirmed";
      ev.push({ kind: "operational", detail: `branch ${r.value.defaultBranch} exige PR no GitHub (${r.note})` });
    } else if (r.value.classicProtected === false) {
      operational = "missing";
      reasons.push(`branch ${r.value.defaultBranch} não exige PR no GitHub (${r.note})`);
    } else {
      reasons.push(`nenhum ruleset exige PR; proteção clássica não pôde ser lida sem permissão de administração (${r.note})`);
    }
  } else {
    reasons.push(`proteção remota não verificada (${r.note}); orientação escrita não comprova proteção aplicada`);
  }
  return { staticOk: guidance, operational, evidence: ev, reasons };
};

export const CHECKERS: Record<string, Checker> = {
  "error-monitoring": errorMonitoring,
  analytics,
  "dependency-updates": dependencyUpdates,
  "pr-workflow": prWorkflow,
};

import { createHash } from "node:crypto";
import { fileOf, loadBundledContent, type ContentBundle } from "../lib/content.js";
import { usageError } from "../lib/errors.js";
import { EFFECTIVE_LABEL, evaluate, type Item } from "../lib/evaluate.js";
import { applyPlan, planInstall } from "../lib/install.js";
import { GitHubClient, detectRepo, enc, githubToken, type RepoRef } from "../lib/github.js";
import { DEFAULT_SOURCE, loadProject, resolveRoot } from "../lib/project.js";
import { fetchBundle } from "../lib/remote.js";
import { compareSemVer } from "../lib/semver.js";
import { ExitCode, RgError, nowFromEnv, parseTimeout, result, sourceFrom, type CommandResult, type Globals } from "./common.js";
import { prepareUpdate } from "./update.js";
import { describePlan } from "./plan-output.js";

export const GITHUB_HELP = `Uso: repoguide github <ação> [opções]

Integração opcional com GitHub. Operações de escrita são explícitas e separadas do check.
Token: GITHUB_TOKEN ou GH_TOKEN. API: GITHUB_API_URL (padrão https://api.github.com).

Ações:
  sync-issues        Uma issue por requisito e escopo. Reexecuções não duplicam,
                     não comentam sem mudança e só tocam issues gerenciadas
                     (rótulo "repoguide" + marcador oculto). Permissão: issues: write.
  update-pr          Abre um PR com a atualização para a última versão estável
                     (nunca faz merge). Permissões: contents: write, pull-requests: write.
  install-workflows  Instala os workflows opcionais da versão adotada.

Opções:
  -C, --cwd <dir>     Diretório do projeto
      --repo <o/r>    Repositório (padrão: GITHUB_REPOSITORY ou origin)
      --dry-run       Mostra o que seria feito, sem escrever
      --offline       (sync-issues) avalia sem consultas remotas de evidência
      --source <url>  (update-pr) índice do canal
      --timeout <ms>  Tempo limite por requisição
      --json          Saída JSON
`;

export interface GithubFlags {
  repo?: string;
  "dry-run"?: boolean;
  offline?: boolean;
  source?: string;
  timeout?: string;
  to?: string;
}

const LABEL = "repoguide";
const MARKER_RE = /<!--\s*repoguide:issue\s+(\{[^}]*\})\s*-->/;
const STATE_RE = /<!--\s*repoguide:state\s+([a-f0-9]{16})\s*-->/;

interface GhIssue {
  number: number;
  state: "open" | "closed";
  body: string | null;
  html_url?: string;
  pull_request?: unknown;
  labels: ({ name: string } | string)[];
}

type Desired = "open" | "closed";

function desiredState(it: Item): { state: Desired; reason?: "completed" | "not_planned" } {
  switch (it.effective) {
    case "met":
      return { state: "closed", reason: "completed" };
    case "waived":
    case "not-applicable":
      return { state: "closed", reason: "not_planned" };
    default:
      // pending, unknown, error, deferred, review-required: keep tracking. Lack of evidence never closes as met.
      return { state: "open" };
  }
}

function stateHash(it: Item): string {
  const material = { e: it.effective, r: it.result, d: it.decision ? [it.decision.type, it.decision.status, it.decision.expires ?? "", it.decision.reviewBy ?? ""] : null, reasons: it.reasons };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}

export function issueBody(it: Item, hash: string): string {
  const L = [
    `<!-- repoguide:issue ${JSON.stringify({ id: it.id, scope: it.scope })} -->`,
    `<!-- repoguide:state ${hash} -->`,
    `**Estado:** ${EFFECTIVE_LABEL[it.effective]} · **Resultado observado:** ${it.result} · **Escopo:** \`${it.scope}\` · **Severidade:** ${it.severity}${it.blocking ? " · bloqueante" : ""}`,
    "",
  ];
  if (it.decision) {
    L.push(`**Decisão registrada:** ${it.decision.type} por ${it.decision.declaredBy} em ${it.decision.date}${it.decision.expires ? ` (vence ${it.decision.expires})` : ""}${it.decision.status !== "active" ? ` — **revisão necessária:** ${it.decision.why}` : ""}`);
    L.push(`> ${it.decision.reason}`, "");
  }
  if (it.evidence.length) {
    L.push("**Evidências:**");
    for (const e of it.evidence) L.push(`- (${e.kind}) ${e.detail}`);
    L.push("");
  }
  if (it.reasons.length) {
    L.push("**Pendências / motivos:**");
    for (const r of it.reasons) L.push(`- ${r}`);
    L.push("");
  }
  L.push(`Detalhes: \`repoguide explain ${it.id}\``, "", "_Issue gerenciada pelo RepoGuide. Edições no corpo podem ser substituídas; use comentários para discussão._");
  return L.join("\n");
}

function transitionComment(it: Item, desired: Desired): string {
  if (desired === "open") return `Reaberta pelo RepoGuide: estado atual **${EFFECTIVE_LABEL[it.effective]}**.`;
  if (it.effective === "met") return "Encerrada pelo RepoGuide: critérios observados como atendidos.";
  const d = it.decision!;
  return `Encerrada pelo RepoGuide: **${EFFECTIVE_LABEL[it.effective]}** por decisão de ${d.declaredBy} em ${d.date}${d.reviewBy ? ` (revisão em ${d.reviewBy})` : ""}. O requisito **não** foi implementado; a cobrança volta se a decisão vencer ou for revogada.`;
}

function requireRepo(root: string, flag: string | undefined): RepoRef {
  const repo = detectRepo(root, flag);
  if (!repo) throw usageError("Repositório GitHub não identificado.", "Use --repo owner/nome ou execute dentro de um checkout com origin no GitHub.");
  return repo;
}

function requireToken(dry: boolean): string | undefined {
  const t = githubToken();
  if (!t && !dry) throw new RgError(ExitCode.USAGE, "GITHUB_TOKEN (ou GH_TOKEN) é necessário para escrever no GitHub.", { hint: "Use --dry-run para simular sem token." });
  return t;
}

async function listManagedIssues(gh: GitHubClient, repo: RepoRef): Promise<GhIssue[]> {
  const out: GhIssue[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await gh.request<GhIssue[]>("GET", `/repos/${enc(repo.owner)}/${enc(repo.repo)}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
    if (r.status === 404 || r.status === 410) return out;
    if (r.status !== 200) throw new RgError(ExitCode.REMOTE, `Falha ao listar issues (HTTP ${r.status}).`);
    out.push(...r.data.filter((i) => !i.pull_request));
    if (r.data.length < 100) break;
  }
  return out;
}

export async function runSyncIssues(g: Globals, f: GithubFlags): Promise<CommandResult> {
  const root = resolveRoot(g.cwd);
  const project = loadProject(root);
  const dry = !!f["dry-run"];
  const repo = requireRepo(root, f.repo);
  const token = requireToken(dry);
  const timeoutMs = parseTimeout(f.timeout, project.config.timeoutMs);
  const gh = new GitHubClient({ ...(token ? { token } : {}), timeoutMs });
  const { evaluation, cache } = await evaluate(project, { offline: !!f.offline, refresh: false, now: nowFromEnv(), timeoutMs, repo: `${repo.owner}/${repo.repo}` });
  cache.save();
  const base = `/repos/${enc(repo.owner)}/${enc(repo.repo)}`;

  const issues = await listManagedIssues(gh, repo);
  const byKey = new Map<string, GhIssue[]>();
  for (const i of issues) {
    const m = MARKER_RE.exec(i.body ?? "");
    if (!m) continue; // labelled but not ours: never touched
    try {
      const k = JSON.parse(m[1]!) as { id: string; scope: string };
      const key = `${k.id}@${k.scope}`;
      byKey.set(key, [...(byKey.get(key) ?? []), i]);
    } catch {
      continue;
    }
  }

  const actions: { key: string; action: string; issue?: number }[] = [];
  const doWrite = async (method: string, route: string, body: unknown, what: string) => {
    if (dry) return undefined;
    return gh.must<GhIssue>(method, route, body, what);
  };

  if (!dry && evaluation.items.some((it) => desiredState(it).state === "open" && !byKey.has(`${it.id}@${it.scope}`))) {
    const lab = await gh.request("GET", `${base}/labels/${LABEL}`);
    if (lab.status === 404) await gh.must("POST", `${base}/labels`, { name: LABEL, color: "5319e7", description: "Requisito acompanhado pelo RepoGuide" }, "criação de rótulo");
  }

  for (const it of evaluation.items) {
    const key = `${it.id}@${it.scope}`;
    const want = desiredState(it);
    const hash = stateHash(it);
    const existing = (byKey.get(key) ?? []).sort((a, b) => (a.state === b.state ? a.number - b.number : a.state === "open" ? -1 : 1));
    const issue = existing[0];
    if (existing.length > 1) actions.push({ key, action: `duplicatas ignoradas: #${existing.slice(1).map((x) => x.number).join(", #")}` });
    if (!issue) {
      if (want.state === "closed") {
        actions.push({ key, action: "nada (sem issue; nada a cobrar)" });
        continue;
      }
      const created = await doWrite("POST", `${base}/issues`, { title: `[RepoGuide] ${it.id}${it.scope === "repo" ? "" : ` (${it.scope})`}: ${it.title}`, body: issueBody(it, hash), labels: [LABEL] }, "criação de issue");
      actions.push({ key, action: "criar", ...(created ? { issue: created.number } : {}) });
      continue;
    }
    const sameState = issue.state === want.state;
    const sameBody = STATE_RE.exec(issue.body ?? "")?.[1] === hash;
    if (sameState && sameBody) {
      actions.push({ key, action: "sem mudança", issue: issue.number });
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (!sameBody) patch.body = issueBody(it, hash);
    if (!sameState) {
      patch.state = want.state;
      if (want.reason) patch.state_reason = want.reason;
      if (want.state === "open") patch.state_reason = "reopened";
    }
    await doWrite("PATCH", `${base}/issues/${issue.number}`, patch, `atualização da issue #${issue.number}`);
    if (!sameState) await doWrite("POST", `${base}/issues/${issue.number}/comments`, { body: transitionComment(it, want.state) }, `comentário na issue #${issue.number}`);
    actions.push({ key, action: sameState ? "atualizar corpo" : want.state === "open" ? "reabrir" : "encerrar", issue: issue.number });
  }
  const orphan = [...byKey.keys()].filter((k) => !evaluation.items.some((i) => `${i.id}@${i.scope}` === k));
  for (const k of orphan) actions.push({ key: k, action: "fora do catálogo/escopos atuais: mantida sem alteração" });

  const lines = [`${dry ? "Simulação" : "Sincronização"} de issues em ${repo.owner}/${repo.repo}:`, ...actions.map((a) => `  ${a.key}: ${a.action}${a.issue ? ` (#${a.issue})` : ""}`)];
  return result(ExitCode.OK, lines, { repo: `${repo.owner}/${repo.repo}`, dryRun: dry, actions });
}

export async function runUpdatePr(g: Globals, f: GithubFlags): Promise<CommandResult> {
  const root = resolveRoot(g.cwd);
  const dry = !!f["dry-run"];
  const repo = requireRepo(root, f.repo);
  const token = requireToken(dry);
  const prep = await prepareUpdate(root, { ...(f.source ? { source: f.source } : {}), ...(f.timeout ? { timeout: f.timeout } : {}), ...(f.to ? { to: f.to } : {}) });
  const { bundle, previous, plan } = prep;
  if (compareSemVer(bundle.version, previous.sdkVersion) <= 0 || plan.noop) {
    return result(ExitCode.OK, [`Nenhuma atualização: adotado ${previous.sdkVersion}, disponível ${bundle.version}.`], { created: false, from: previous.sdkVersion, to: bundle.version });
  }
  if (plan.conflicts.length) {
    throw new RgError(ExitCode.CONFLICT, `PR de atualização não criado: conflitos em arquivos gerenciados.`, { details: plan.conflicts.map((c) => `${c.path}: ${c.problem}`) });
  }
  const gh = new GitHubClient({ ...(token ? { token } : {}), timeoutMs: parseTimeout(f.timeout, 10000) });
  const base = `/repos/${enc(repo.owner)}/${enc(repo.repo)}`;
  const branch = `repoguide/update-${bundle.version}`;
  const marker = `<!-- repoguide:update-pr ${bundle.version} -->`;
  const open = await gh.request<{ number: number; html_url: string }[]>("GET", `${base}/pulls?state=open&head=${enc(`${repo.owner}:${branch}`)}`);
  if (open.status === 200 && open.data.length > 0) {
    return result(ExitCode.OK, [`PR de atualização já existe: #${open.data[0]!.number} ${open.data[0]!.html_url}`], { created: false, existing: open.data[0]!.number, to: bundle.version });
  }
  const body = [
    marker,
    `Atualiza o RepoGuide de **${previous.sdkVersion}** para **${bundle.version}**.`,
    "",
    bundle.highlights ? `**Novidades:** ${bundle.highlights}\n` : "",
    "**Arquivos:**",
    ...plan.writes.map((w) => `- \`${w.rel}\` — ${w.reason}`),
    "",
    prep.reviewNeeded.length ? "**Decisões que exigirão revisão:**\n" + prep.reviewNeeded.map((r) => `- ${r}`).join("\n") + "\n" : "",
    "Gerado por `repoguide github update-pr`. Este PR não é mesclado automaticamente; revise as diferenças antes do merge.",
  ].join("\n");
  if (dry) {
    return result(ExitCode.OK, [`Simulação: criaria a branch ${branch} e um PR ${previous.sdkVersion} → ${bundle.version}.`, ...describePlan(plan, true, { showDiffs: false })], {
      created: false,
      dryRun: true,
      branch,
      to: bundle.version,
    });
  }
  const existingRef = await gh.request("GET", `${base}/git/ref/heads/${branch.split("/").map(enc).join("/")}`);
  if (existingRef.status === 200) {
    throw new RgError(ExitCode.CONFLICT, `A branch ${branch} já existe sem PR aberto.`, { hint: "Abra o PR manualmente a partir dela ou apague a branch e repita." });
  }
  const info = await gh.must<{ default_branch: string }>("GET", base, undefined, "dados do repositório");
  const ref = await gh.must<{ object: { sha: string } }>("GET", `${base}/git/ref/heads/${enc(info.default_branch)}`, undefined, "branch padrão");
  const commit = await gh.must<{ tree: { sha: string } }>("GET", `${base}/git/commits/${ref.object.sha}`, undefined, "commit base");
  const tree = [];
  for (const w of plan.writes) {
    const blob = await gh.must<{ sha: string }>("POST", `${base}/git/blobs`, { content: w.content, encoding: "utf-8" }, "criação de blob");
    tree.push({ path: w.rel, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await gh.must<{ sha: string }>("POST", `${base}/git/trees`, { base_tree: commit.tree.sha, tree }, "criação de árvore");
  const newCommit = await gh.must<{ sha: string }>(
    "POST",
    `${base}/git/commits`,
    { message: `chore(repoguide): atualizar para ${bundle.version}`, tree: newTree.sha, parents: [ref.object.sha] },
    "criação de commit",
  );
  await gh.must("POST", `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: newCommit.sha }, "criação de branch");
  const pr = await gh.request<{ number: number; html_url: string; message?: string }>("POST", `${base}/pulls`, {
    title: `chore(repoguide): atualizar para ${bundle.version}`,
    head: branch,
    base: info.default_branch,
    body,
    maintainer_can_modify: true,
  });
  if (pr.status === 403 || pr.status === 422) {
    throw new RgError(ExitCode.REMOTE, `Branch ${branch} criada, mas o token não pôde abrir o PR (HTTP ${pr.status}${pr.data?.message ? `: ${pr.data.message}` : ""}).`, {
      hint:
        "Com GITHUB_TOKEN, habilite em Settings → Actions → General: \"Allow GitHub Actions to create and approve pull requests\", " +
        "ou use um GitHub App com pull-requests: write. Você também pode abrir o PR manualmente a partir da branch.",
    });
  }
  if (pr.status !== 201) throw new RgError(ExitCode.REMOTE, `Falha ao criar PR (HTTP ${pr.status}).`);
  return result(ExitCode.OK, [`PR criado: #${pr.data.number} ${pr.data.html_url}`, "O merge não é automático: revise e aprove no GitHub."], {
    created: true,
    number: pr.data.number,
    url: pr.data.html_url,
    branch,
    to: bundle.version,
  });
}

export async function runInstallWorkflows(g: Globals, f: GithubFlags): Promise<CommandResult> {
  const root = resolveRoot(g.cwd);
  const project = loadProject(root);
  const version = project.lock.sdkVersion;
  let bundle: ContentBundle = loadBundledContent();
  if (bundle.version !== version) {
    if (f.offline) throw usageError(`Esta CLI traz o conteúdo ${bundle.version}, mas o projeto adota ${version}; sem rede não é possível obter os workflows dessa versão.`);
    bundle = (await fetchBundle(sourceFrom(f.source, project.config.source, DEFAULT_SOURCE), version, parseTimeout(f.timeout, project.config.timeoutMs))).bundle;
  }
  if (!fileOf(bundle, "workflows/repoguide-check.yml")) throw new RgError(ExitCode.EXECUTION, `A versão ${version} não inclui workflows.`);
  const plan = planInstall(root, bundle, project.lock, project.lock.source, {
    claude: project.lock.integrations.claude,
    githubWorkflows: true,
    createProjectFiles: false,
    now: nowFromEnv(),
  });
  if (plan.conflicts.length) throw new RgError(ExitCode.CONFLICT, "Conflitos; nada foi alterado.", { details: plan.conflicts.map((c) => `${c.path}: ${c.problem}`) });
  const dry = !!f["dry-run"];
  if (!plan.noop && !dry) applyPlan(root, plan);
  const lines = plan.noop ? ["Workflows já instalados."] : describePlan(plan, dry, { showDiffs: dry });
  lines.push("Permissões e configuração: veja docs/usage/github.md (não exige PAT por padrão).");
  return result(ExitCode.OK, lines, { dryRun: dry, writes: plan.writes.map((w) => w.rel) });
}

// Applies and verifies the protections of the official RepoGuide repository using the GitHub CLI.
// Run as the owner (repository admin) after `gh auth login`.
//
//   node scripts/github-settings.mjs            # show current state and planned changes (no writes)
//   node scripts/github-settings.mjs --apply    # apply, then read back and verify
//
// Idempotent: rulesets are matched by name and updated in place. Never removes collaborators,
// never adds users, never changes account-wide settings.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.REPO ?? "tassiopereira/RepoGuide";
const OWNER = REPO.split("/")[0];
const apply = process.argv.includes("--apply");
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "maintainers", "github-settings");
const results = [];

function gh(method, route, body) {
  const args = ["api", "-X", method, route, "-H", "X-GitHub-Api-Version: 2022-11-28"];
  if (body !== undefined) args.push("--input", "-");
  try {
    const out = execFileSync("gh", args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    return { ok: true, data: out ? JSON.parse(out) : null };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || "").toString().trim().split("\n")[0] };
  }
}

function step(name, fn) {
  try {
    const r = fn();
    results.push({ name, ...r });
  } catch (e) {
    results.push({ name, status: "erro", detail: e.message });
  }
}

const repo = gh("GET", `repos/${REPO}`);
if (!repo.ok) {
  console.error(`Não foi possível ler ${REPO}: ${repo.error}\nExecute "gh auth login" com a conta proprietária.`);
  process.exit(1);
}
if (!repo.data.permissions?.admin) {
  console.error("A conta autenticada não é administradora do repositório. Nada foi alterado.");
  process.exit(1);
}

// 1. Rulesets (branch principal e tags de release)
const existing = gh("GET", `repos/${REPO}/rulesets?includes_parents=false`).data ?? [];
for (const file of readdirSync(dir).filter((f) => f.startsWith("ruleset-")).sort()) {
  const def = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  step(`ruleset "${def.name}"`, () => {
    const found = existing.find((r) => r.name === def.name);
    if (!apply) return { status: "planejado", detail: found ? `atualizar #${found.id}` : "criar" };
    const r = found ? gh("PUT", `repos/${REPO}/rulesets/${found.id}`, def) : gh("POST", `repos/${REPO}/rulesets`, def);
    if (!r.ok) return { status: "falhou", detail: r.error };
    const back = gh("GET", `repos/${REPO}/rulesets/${r.data.id}`);
    const okRules = back.ok && back.data.enforcement === "active" && def.rules.every((x) => back.data.rules.some((y) => y.type === x.type));
    return { status: okRules ? "aplicado e verificado" : "aplicado, verificação divergente", detail: `#${r.data.id}` };
  });
}

// 2. Permissões padrão mínimas para o GITHUB_TOKEN
step("Actions: permissões padrão somente leitura", () => {
  const body = { default_workflow_permissions: "read", can_approve_pull_request_reviews: false };
  if (!apply) return { status: "planejado", detail: JSON.stringify(body) };
  const r = gh("PUT", `repos/${REPO}/actions/permissions/workflow`, body);
  if (!r.ok) return { status: "falhou", detail: r.error };
  const back = gh("GET", `repos/${REPO}/actions/permissions/workflow`);
  return { status: back.data?.default_workflow_permissions === "read" ? "aplicado e verificado" : "verificação divergente", detail: JSON.stringify(back.data) };
});

// 3. Aprovação obrigatória para workflows de colaboradores externos
step("Actions: aprovação para todos os colaboradores externos", () => {
  const body = { approval_policy: "all_external_contributors" };
  if (!apply) return { status: "planejado", detail: JSON.stringify(body) };
  const r = gh("PUT", `repos/${REPO}/actions/permissions/fork-pr-contributor-approval`, body);
  if (!r.ok) return { status: "falhou", detail: r.error };
  const back = gh("GET", `repos/${REPO}/actions/permissions/fork-pr-contributor-approval`);
  return { status: back.data?.approval_policy === body.approval_policy ? "aplicado e verificado" : "verificação divergente", detail: JSON.stringify(back.data) };
});

// 4. Environment "release" com aprovação do proprietário, restrito a tags v*
step('environment "release" com aprovação do proprietário', () => {
  const user = gh("GET", `users/${OWNER}`);
  if (!user.ok) return { status: "falhou", detail: user.error };
  const body = {
    wait_timer: 0,
    prevent_self_review: false,
    reviewers: [{ type: "User", id: user.data.id }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  if (!apply) return { status: "planejado", detail: `revisor ${OWNER} (#${user.data.id}); somente tags v*` };
  const r = gh("PUT", `repos/${REPO}/environments/release`, body);
  if (!r.ok) return { status: "falhou", detail: r.error };
  const pols = gh("GET", `repos/${REPO}/environments/release/deployment-branch-policies`);
  if (!pols.data?.branch_policies?.some((p) => p.name === "v*" && p.type === "tag")) {
    const p = gh("POST", `repos/${REPO}/environments/release/deployment-branch-policies`, { name: "v*", type: "tag" });
    if (!p.ok) return { status: "parcial", detail: `environment criado; política de tag falhou: ${p.error}` };
  }
  const back = gh("GET", `repos/${REPO}/environments/release`);
  const reviewers = back.data?.protection_rules?.find((x) => x.type === "required_reviewers");
  return { status: reviewers ? "aplicado e verificado" : "verificação divergente", detail: reviewers ? `revisores: ${reviewers.reviewers.map((x) => x.reviewer.login).join(", ")}` : "" };
});

// 5. Relato privado de vulnerabilidades (canal do SECURITY.md)
step("relato privado de vulnerabilidades", () => {
  if (!apply) return { status: "planejado", detail: `atual: ${JSON.stringify(gh("GET", `repos/${REPO}/private-vulnerability-reporting`).data)}` };
  const r = gh("PUT", `repos/${REPO}/private-vulnerability-reporting`);
  if (!r.ok) return { status: "falhou", detail: r.error };
  const back = gh("GET", `repos/${REPO}/private-vulnerability-reporting`);
  return { status: back.data?.enabled ? "aplicado e verificado" : "verificação divergente", detail: "" };
});

// 6. Colaboradores: somente inspeção
step("colaboradores (somente leitura)", () => {
  const r = gh("GET", `repos/${REPO}/collaborators?affiliation=all&per_page=100`);
  if (!r.ok) return { status: "não verificado", detail: r.error };
  const others = r.data.filter((c) => c.login.toLowerCase() !== OWNER.toLowerCase());
  return {
    status: others.length ? "ATENÇÃO" : "ok",
    detail: others.length ? `acesso além do proprietário: ${others.map((c) => `${c.login} (${c.role_name})`).join(", ")} — revise manualmente; nada foi removido` : "somente o proprietário",
  };
});

console.log(`${apply ? "Aplicação" : "Simulação (use --apply para aplicar)"} em ${REPO}:`);
for (const r of results) console.log(`- ${r.name}: ${r.status}${r.detail ? ` — ${r.detail}` : ""}`);
if (results.some((r) => ["falhou", "erro", "parcial"].includes(r.status))) process.exitCode = 1;

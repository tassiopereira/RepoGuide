import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ISO, makeBundle, read, releaseServer, run, snapshot, tmpProject } from "./helpers.js";

type Item = { id: string; scope: string; effective: string; result: string; reason: string | null; decision: { type: string; status: string } | null };
const item = (j: Record<string, unknown>, id: string, scope = "repo") => (j.items as Item[]).find((i) => i.id === id && i.scope === scope)!;
const NOW = { REPOGUIDE_INTERNAL_NOW: ISO("2026-11-03") };

async function project(files: Record<string, string> = { "package.json": "{}" }, args: string[] = []) {
  const dir = tmpProject(files);
  assert.equal((await run(["init", ...args], { cwd: dir, env: NOW })).code, 0);
  return dir;
}
const check = async (dir: string, now = "2026-11-03") => (await run(["check", "--offline", "--json"], { cwd: dir, env: { REPOGUIDE_INTERNAL_NOW: ISO(now) } })).json;

describe("decisões", () => {
  it("adiamento exige vencimento, justificativa e responsável em modo não interativo", async () => {
    const dir = await project();
    const base = ["requirement", "defer", "RG-DEP-001", "--no-input"];
    assert.equal((await run([...base, "--reason", "Migrando CI este mês", "--by", "Ana"], { cwd: dir, env: NOW })).code, 2, "sem --until");
    assert.equal((await run([...base, "--until", "2026-12-01", "--by", "Ana"], { cwd: dir, env: NOW })).code, 2, "sem --reason");
    assert.equal((await run([...base, "--until", "2026-12-01", "--reason", "Migrando CI este mês"], { cwd: dir, env: NOW })).code, 2, "sem --by");
    assert.equal((await run([...base, "--until", "2026-10-01", "--reason", "Migrando CI este mês", "--by", "Ana"], { cwd: dir, env: NOW })).code, 2, "data passada");
    assert.equal((await run([...base, "--until", "2027-12-01", "--reason", "Migrando CI este mês", "--by", "Ana"], { cwd: dir, env: NOW })).code, 2, "acima do máximo");
    const ok = await run([...base, "--until", "2026-12-01", "--reason", "Migrando CI este mês", "--by", "Ana"], { cwd: dir, env: NOW });
    assert.equal(ok.code, 0, ok.stderr);
    const d = JSON.parse(read(dir, ".ai/decisoes.json")).decisions[0];
    assert.deepEqual({ ...d }, { requirement: "RG-DEP-001", scope: "repo", type: "deferred", reason: "Migrando CI este mês", declaredBy: "Ana", date: "2026-11-03", requirementRevision: 1, expires: "2026-12-01" });
  });

  it("adiado é acompanhamento (não atendimento) e vencido volta como revisão pendente", async () => {
    const dir = await project();
    await run(["requirement", "defer", "RG-DEP-001", "--until", "2026-12-01", "--reason", "Migrando CI este mês", "--by", "Ana"], { cwd: dir, env: NOW });
    let it = item(await check(dir), "RG-DEP-001");
    assert.equal(it.effective, "deferred");
    assert.equal(it.result, "pending", "resultado observado continua separado da decisão");
    it = item(await check(dir, "2026-12-02"), "RG-DEP-001");
    assert.equal(it.effective, "review-required");
    assert.equal(it.decision!.status, "expired");
  });

  it("dispensa encerra a cobrança enquanto válida e respeita revisão futura", async () => {
    const dir = await project();
    const r = await run(["requirement", "waive", "RG-DEP-001", "--reason", "Repositório arquivado em breve", "--by", "Ana"], { cwd: dir, env: NOW });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Revisão da dispensa definida para 2027-11-03/);
    assert.equal(item(await check(dir), "RG-DEP-001").effective, "waived");
    assert.equal(item(await check(dir, "2027-11-04"), "RG-DEP-001").effective, "review-required");
    const tooLong = await run(["requirement", "waive", "RG-DEP-001", "--review-by", "2030-01-01", "--reason", "Repositório arquivado", "--by", "Ana"], { cwd: dir, env: NOW });
    assert.equal(tooLong.code, 2);
  });

  it("não aplicável, reset com histórico e dry-run", async () => {
    const dir = await project();
    const before = snapshot(dir);
    const dry = await run(["requirement", "not-applicable", "RG-PRD-001", "--reason", "Ferramenta interna sem público", "--by", "Ana", "--dry-run"], { cwd: dir, env: NOW });
    assert.equal(dry.code, 0);
    assert.deepEqual(snapshot(dir), before, "dry-run não grava");
    await run(["requirement", "not-applicable", "RG-PRD-001", "--reason", "Ferramenta interna sem público", "--by", "Ana"], { cwd: dir, env: NOW });
    assert.equal(item(await check(dir), "RG-PRD-001").effective, "not-applicable");
    const reset = await run(["requirement", "reset", "RG-PRD-001", "--reason", "Produto ganhou público", "--by", "Bia"], { cwd: dir, env: NOW });
    assert.equal(reset.code, 0, reset.stderr);
    const file = JSON.parse(read(dir, ".ai/decisoes.json"));
    assert.equal(file.decisions.length, 0);
    assert.equal(file.history.length, 1, "decisão antiga não é removida silenciosamente");
    assert.equal(file.history[0].entry.type, "not-applicable");
    assert.equal(file.history[0].endedBy, "Bia");
    assert.equal(item(await check(dir), "RG-PRD-001").effective, "unknown");
    assert.equal((await run(["requirement", "reset", "RG-PRD-001", "--reason", "nada", "--by", "Bia"], { cwd: dir })).code, 2);
  });

  it("substituir decisão move a anterior para o histórico", async () => {
    const dir = await project();
    await run(["requirement", "defer", "RG-DEP-001", "--until", "2026-12-01", "--reason", "Migrando CI este mês", "--by", "Ana"], { cwd: dir, env: NOW });
    await run(["requirement", "waive", "RG-DEP-001", "--reason", "Decidimos não automatizar agora", "--by", "Ana"], { cwd: dir, env: NOW });
    const file = JSON.parse(read(dir, ".ai/decisoes.json"));
    assert.equal(file.decisions.length, 1);
    assert.equal(file.decisions[0].type, "waived");
    assert.equal(file.history[0].entry.type, "deferred");
  });

  it("revisão material do requisito exige reavaliar decisões anteriores", async () => {
    const dir = await project();
    await run(["requirement", "waive", "RG-OBS-001", "--reason", "Usamos logs centralizados por ora", "--by", "Ana"], { cwd: dir, env: NOW });
    assert.equal(item(await check(dir), "RG-OBS-001").effective, "waived");
    const v020 = makeBundle("0.2.0", (f) => {
      const cat = JSON.parse(f.get("sdk/requisitos.json")!);
      const r = cat.requirements.find((x: { id: string }) => x.id === "RG-OBS-001");
      r.revision = 2;
      r.materialRevision = 2;
      r.acceptanceCriteria.push({ id: "pii", text: "Dados pessoais filtrados.", evidence: "human" });
      // Mudança não material em outro requisito não afeta decisões.
      const dep = cat.requirements.find((x: { id: string }) => x.id === "RG-DEP-001");
      dep.revision = 2;
      f.set("sdk/requisitos.json", JSON.stringify(cat, null, 2) + "\n");
    });
    const srv = await releaseServer([makeBundle("0.1.0"), v020]);
    try {
      const up = await run(["update", "--json"], { cwd: dir, env: { ...NOW, REPOGUIDE_SOURCE: srv.source } });
      assert.equal(up.code, 0, JSON.stringify(up.json));
      assert.ok((up.json.reviewNeeded as string[]).some((s) => s.startsWith("RG-OBS-001@repo")));
    } finally {
      await srv.close();
    }
    const it = item(await check(dir), "RG-OBS-001");
    assert.equal(it.effective, "review-required");
    assert.equal(it.decision!.status, "stale");
  });

  it("arquivo de decisões inválido é falha de execução com diagnóstico", async () => {
    const dir = await project();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${dir}/.ai/decisoes.json`, JSON.stringify({ schemaVersion: 1, decisions: [{ requirement: "RG-DEP-001", scope: "repo", type: "deferred", reason: "x", declaredBy: "", date: "ontem" }] }));
    const r = await run(["check", "--offline", "--json"], { cwd: dir });
    assert.equal(r.code, 3);
    assert.match(JSON.stringify(r.json.error), /declaredBy ausente/);
    assert.match(JSON.stringify(r.json.error), /expires obrigatório/);
  });
});

describe("monorepositório", () => {
  it("avalia requisitos por aplicação em cada escopo, com decisões independentes", async () => {
    const dir = tmpProject({
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "apps/web/package.json": JSON.stringify({ dependencies: { react: "18", "@sentry/react": "8" } }),
      "apps/web/src/main.tsx": "Sentry.init({ dsn, environment: 'prod', release: v })",
      "apps/api/package.json": JSON.stringify({ dependencies: { express: "5" } }),
    });
    assert.equal((await run(["init", "--scope", "web=apps/web", "--scope", "api=apps/api"], { cwd: dir, env: NOW })).code, 0);
    let j = await check(dir);
    const ids = (j.items as Item[]).map((i) => `${i.id}@${i.scope}`).sort();
    assert.deepEqual(ids, ["RG-DEP-001@repo", "RG-GOV-001@repo", "RG-OBS-001@api", "RG-OBS-001@web", "RG-PRD-001@api", "RG-PRD-001@web"]);
    assert.equal(item(j, "RG-OBS-001", "web").result, "unknown");
    assert.equal(item(j, "RG-OBS-001", "api").result, "pending");
    assert.equal(item(j, "RG-PRD-001", "web").result, "pending");
    assert.equal(item(j, "RG-PRD-001", "api").result, "unknown");

    const noScope = await run(["requirement", "not-applicable", "RG-PRD-001", "--reason", "API interna sem público", "--by", "Ana"], { cwd: dir, env: NOW });
    assert.equal(noScope.code, 2, "exige --scope");
    assert.match(noScope.stderr, /--scope \(web, api\)/);
    assert.equal((await run(["requirement", "not-applicable", "RG-DEP-001", "--scope", "web", "--reason", "nada a ver", "--by", "A"], { cwd: dir })).code, 2, "requisito de repositório só aceita escopo repo");
    await run(["requirement", "not-applicable", "RG-PRD-001", "--scope", "api", "--reason", "API interna sem público", "--by", "Ana"], { cwd: dir, env: NOW });
    j = await check(dir);
    assert.equal(item(j, "RG-PRD-001", "api").effective, "not-applicable");
    assert.equal(item(j, "RG-PRD-001", "web").effective, "pending", "decisão de um escopo não afeta outro");
  });

  it("doctor sugere escopos quando detecta monorepo sem configuração", async () => {
    const dir = tmpProject({ "package.json": JSON.stringify({ workspaces: ["apps/*"] }) });
    await run(["init"], { cwd: dir });
    const r = await run(["doctor", "--offline", "--json"], { cwd: dir });
    assert.equal(r.code, 0);
    assert.ok((r.json.diagnostics as { check: string; status: string }[]).some((d) => d.check === "escopos" && d.status === "warn"));
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ISO, makeBundle, read, releaseServer, run, snapshot, tmpProject, write } from "./helpers.js";

type Item = { id: string; scope: string; result: string; effective: string; reason: string | null };
const items = (j: Record<string, unknown>) => j.items as Item[];
const item = (j: Record<string, unknown>, id: string, scope = "repo") => items(j).find((i) => i.id === id && i.scope === scope)!;

async function project(files: Record<string, string>, initArgs: string[] = []) {
  const dir = tmpProject(files);
  const r = await run(["init", ...initArgs], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  return dir;
}

describe("check", () => {
  it("produz JSON estável e saída humana curta", async () => {
    const dir = await project({});
    const r = await run(["check", "--offline", "--json"], { cwd: dir });
    assert.equal(r.code, 0);
    const j = r.json;
    assert.deepEqual(Object.keys(j.repoguide as object).sort(), ["cliVersion", "command", "jsonSchema"]);
    for (const k of ["ok", "exitCode", "project", "remote", "counts", "violations", "integrity", "items", "failOn"]) assert.ok(k in j, `campo ${k}`);
    assert.equal(items(j).length, 4);
    for (const i of items(j)) {
      assert.ok(["met", "pending", "unknown", "error"].includes(i.result));
      assert.ok(typeof i.id === "string" && typeof i.scope === "string");
    }
    const human = await run(["check", "--offline"], { cwd: dir });
    assert.ok(human.stdout.trim().split("\n").length <= 12, "saída curta");
    assert.match(human.stdout, /Detalhes: repoguide explain <id>/);
  });

  it("não altera decisões, lock, código nem docs (só o cache)", async () => {
    const dir = await project({ "package.json": "{}" });
    const before = snapshot(dir);
    await run(["check", "--offline"], { cwd: dir });
    await run(["check"], { cwd: dir });
    assert.deepEqual(snapshot(dir), before);
  });

  it("projeto sem sinais resulta em desconhecido, nunca em atendido", async () => {
    const dir = await project({});
    const j = (await run(["check", "--offline", "--json"], { cwd: dir })).json;
    assert.equal(item(j, "RG-OBS-001").result, "unknown");
    assert.equal(item(j, "RG-PRD-001").result, "unknown");
    assert.equal(item(j, "RG-DEP-001").result, "unknown");
    assert.equal(item(j, "RG-GOV-001").result, "unknown", "orientação escrita não comprova proteção");
    assert.equal((j.counts as Record<string, number>).met, 0);
  });

  it("dependência instalada sem inicialização não conta como monitoramento", async () => {
    const dir = await project({ "package.json": JSON.stringify({ dependencies: { "@sentry/node": "^8" } }) });
    const j = (await run(["check", "--offline", "--json"], { cwd: dir })).json;
    assert.equal(item(j, "RG-OBS-001").result, "pending");
    assert.match(item(j, "RG-OBS-001").reason!, /nenhuma inicialização/);
  });

  it("inicialização em testes ou exemplos não é evidência de produção", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ dependencies: { "@sentry/node": "^8" } }),
      "test/setup.ts": "Sentry.init({ dsn: 'x', environment: 'test', release: '1' });",
      "examples/app/main.ts": "Sentry.init({ dsn: 'x' });",
    });
    assert.equal(item((await run(["check", "--offline", "--json"], { cwd: dir })).json, "RG-OBS-001").result, "pending");
  });

  it("indícios estáticos completos ainda exigem evidência operacional ou declaração humana", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ dependencies: { "@sentry/node": "^8", react: "18" } }),
      "src/app.ts": "Sentry.init({ dsn: process.env.DSN, environment: process.env.ENV, release: process.env.SHA });",
    });
    let j = (await run(["check", "--offline", "--json"], { cwd: dir })).json;
    assert.equal(item(j, "RG-OBS-001").result, "unknown");
    const a = await run(["requirement", "attest", "RG-OBS-001", "--note", "Erro de teste capturado e alerta no #ops", "--by", "Ana"], { cwd: dir });
    assert.equal(a.code, 0, a.stderr);
    j = (await run(["check", "--offline", "--json"], { cwd: dir })).json;
    assert.equal(item(j, "RG-OBS-001").result, "met");
    // A declaração expira: depois disso volta a ser desconhecido.
    j = (await run(["check", "--offline", "--json"], { cwd: dir, env: { REPOGUIDE_INTERNAL_NOW: ISO("2099-01-01") } })).json;
    assert.equal(item(j, "RG-OBS-001").result, "unknown");
    // Declaração não supre critério estático ausente.
    write(dir, "src/app.ts", "// removido\n");
    j = (await run(["check", "--offline", "--json"], { cwd: dir })).json;
    assert.equal(item(j, "RG-OBS-001").result, "pending");
  });

  it("análise de uso: aplicabilidade depende de sinais de interface pública", async () => {
    const lib = await project({ "package.json": JSON.stringify({ name: "lib", main: "index.js" }) });
    assert.equal(item((await run(["check", "--offline", "--json"], { cwd: lib })).json, "RG-PRD-001").result, "unknown");
    const web = await project({ "package.json": JSON.stringify({ dependencies: { next: "15" } }) });
    assert.equal(item((await run(["check", "--offline", "--json"], { cwd: web })).json, "RG-PRD-001").result, "pending");
    const withGa = await project({ "package.json": JSON.stringify({ dependencies: { next: "15" } }), "app/layout.tsx": '<script src="https://www.googletagmanager.com/gtag/js?id=G-X" />' });
    assert.equal(item((await run(["check", "--offline", "--json"], { cwd: withGa })).json, "RG-PRD-001").result, "unknown");
  });

  it("atualização de dependências: cobertura de ecossistemas e config não comprova execução", async () => {
    const files = {
      "package.json": "{}",
      ".github/workflows/ci.yml": "on: push\n",
      ".github/dependabot.yml": 'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/"\n    schedule:\n      interval: weekly\n',
    };
    const dir = await project(files);
    let j = (await run(["check", "--offline", "--json"], { cwd: dir })).json;
    assert.equal(item(j, "RG-DEP-001").result, "pending");
    assert.match(item(j, "RG-DEP-001").reason!, /github-actions/);
    write(dir, ".github/dependabot.yml", files[".github/dependabot.yml"] + '  - package-ecosystem: "github-actions"\n    directory: "/"\n    schedule:\n      interval: weekly\n');
    j = (await run(["check", "--offline", "--json"], { cwd: dir })).json;
    assert.equal(item(j, "RG-DEP-001").result, "unknown", "configuração sozinha não comprova execução");
    const ren = await project({ "package.json": "{}", "renovate.json": '{ "extends": ["config:recommended"] }' });
    assert.equal(item((await run(["check", "--offline", "--json"], { cwd: ren })).json, "RG-DEP-001").result, "unknown");
  });

  it("códigos de saída: bloqueante, --fail-on e integridade", async () => {
    const dir = await project({ "package.json": "{}" });
    assert.equal((await run(["check", "--offline"], { cwd: dir })).code, 0, "pendências comuns não quebram CI por padrão");
    assert.equal((await run(["check", "--offline", "--fail-on", "pending"], { cwd: dir })).code, 1);
    assert.equal((await run(["check", "--offline", "--fail-on", "nope"], { cwd: dir })).code, 2);
    write(dir, ".ai/config.json", JSON.stringify({ blocking: ["RG-DEP-001"] }));
    const blocking = await run(["check", "--offline", "--json"], { cwd: dir });
    assert.equal(blocking.code, 1);
    assert.ok((blocking.json.violations as string[]).some((v) => v.startsWith("RG-DEP-001")));
    assert.equal((await run(["check", "--offline", "--fail-on", "never"], { cwd: dir })).code, 0);
    write(dir, ".ai/config.json", "{}");
    write(dir, ".ai/sdk/requisitos.json", read(dir, ".ai/sdk/requisitos.json").replace('"blocking": false', '"blocking": false '));
    const tampered = await run(["check", "--offline", "--json"], { cwd: dir });
    assert.equal(tampered.code, 1, "catálogo adulterado é violação bloqueante");
    write(dir, ".ai/sdk/requisitos.json", "{ quebrado");
    const broken = await run(["check", "--offline", "--json"], { cwd: dir });
    assert.equal(broken.code, 3, "falha de execução é distinta de violação");
    assert.equal((await run(["check"], { cwd: tmpProject() })).code, 3, "não instalado");
  });

  it("consulta remota com cache de 24 h, --refresh, offline com idade e novidade", async () => {
    const dir = await project({});
    const srv = await releaseServer([makeBundle("0.1.0"), makeBundle("0.2.0", () => {}, { highlights: "política de PR" })]);
    try {
      const env = { REPOGUIDE_SOURCE: srv.source };
      const first = await run(["check", "--json"], { cwd: dir, env });
      const remote = first.json.remote as Record<string, unknown>;
      assert.equal(remote.latest, "0.2.0");
      assert.equal(remote.updateAvailable, true);
      assert.equal(remote.highlights, "política de PR");
      assert.equal(JSON.parse(read(dir, ".ai/sdk.lock.json")).sdkVersion, "0.1.0", "consultar não adota");
      const human = await run(["check"], { cwd: dir, env });
      assert.match(human.stdout, /Novidade: política de PR/);
      const n = srv.requests.length;
      await run(["check"], { cwd: dir, env });
      assert.equal(srv.requests.length, n, "dentro do TTL não consulta de novo");
      await run(["check", "--refresh"], { cwd: dir, env });
      assert.ok(srv.requests.length > n, "--refresh força consulta");
      const later = await run(["check", "--json"], { cwd: dir, env: { ...env, REPOGUIDE_INTERNAL_NOW: new Date(Date.now() + 25 * 3600000).toISOString() } });
      assert.equal((later.json.remote as Record<string, unknown>).fromCache, false, "TTL expirado consulta de novo");
      const off = await run(["check", "--offline"], { cwd: dir, env });
      assert.match(off.stdout, /não verificado agora: offline; última consulta há/);
    } finally {
      await srv.close();
    }
  });

  it("rede lenta não quebra o check e não afirma estar atualizado", async () => {
    const dir = await project({});
    const srv = await releaseServer([makeBundle("0.1.0")]);
    srv.delayMs = 1500;
    try {
      const r = await run(["check", "--timeout", "200", "--json"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
      assert.equal(r.code, 0);
      const remote = r.json.remote as Record<string, unknown>;
      assert.equal(remote.checked, false);
      assert.match(String(remote.error), /Tempo esgotado/);
      const human = await run(["check", "--timeout", "200"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
      assert.doesNotMatch(human.stdout, /atualizado/);
    } finally {
      await srv.close();
    }
  });
});

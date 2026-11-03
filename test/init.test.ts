import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { read, run, snapshot, tmpProject } from "./helpers.js";

describe("init", () => {
  it("instala em projeto novo com a estrutura esperada", async () => {
    const dir = tmpProject();
    const r = await run(["init", "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.changed, true);
    for (const f of ["AGENTS.md", ".ai/sdk/INSTRUCOES.md", ".ai/sdk/requisitos.json", ".ai/sdk.lock.json", ".ai/decisoes.json", ".ai/.gitignore", "docs/ai/MAPA.md", "docs/ai/VALIDACAO.md"]) {
      assert.ok(existsSync(path.join(dir, f)), `${f} deveria existir`);
    }
    assert.ok(!existsSync(path.join(dir, "CLAUDE.md")), "CLAUDE.md só com --claude");
    assert.ok(!existsSync(path.join(dir, ".github")), "workflows só com --github-workflows");
    const lock = JSON.parse(read(dir, ".ai/sdk.lock.json"));
    assert.equal(lock.sdkVersion, "0.1.0");
    assert.ok(lock.files[".ai/sdk/requisitos.json"]);
    assert.ok(lock.blocks["AGENTS.md"]);
    assert.match(read(dir, ".ai/.gitignore"), /^\.cache\/$/m);
  });

  it("adota repositório existente preservando AGENTS.md e documentos locais", async () => {
    const original = "# Regras da equipe\r\n\r\nUse pnpm. Nunca altere migrations antigas.\r\n";
    const dir = tmpProject({ "AGENTS.md": original, "docs/ai/MAPA.md": "# Nosso mapa\n", "README.md": "# App\n" });
    const r = await run(["init"], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const agents = read(dir, "AGENTS.md");
    assert.ok(agents.startsWith(original), "conteúdo original preservado byte a byte (inclusive CRLF)");
    assert.ok(!/[^\r]\n/.test(agents), "mantém CRLF no arquivo inteiro");
    assert.equal(agents.match(/repoguide:begin/g)?.length, 1);
    assert.equal(read(dir, "docs/ai/MAPA.md"), "# Nosso mapa\n");
    assert.equal(read(dir, "README.md"), "# App\n");
    assert.match(r.stdout, /MAPA\.md já existe e foi preservado/);
  });

  it("é idempotente", async () => {
    const dir = tmpProject({ "AGENTS.md": "# X\n" });
    assert.equal((await run(["init"], { cwd: dir })).code, 0);
    const before = snapshot(dir);
    const r = await run(["init", "--json"], { cwd: dir });
    assert.equal(r.code, 0);
    assert.equal(r.json.changed, false);
    assert.deepEqual(snapshot(dir), before);
  });

  it("dry-run não tem efeitos colaterais", async () => {
    const dir = tmpProject({ "AGENTS.md": "# X\n" });
    const before = snapshot(dir, false);
    const r = await run(["init", "--dry-run", "--json"], { cwd: dir });
    assert.equal(r.code, 0);
    assert.equal(r.json.dryRun, true);
    assert.ok((r.json.writes as unknown[]).length > 0);
    assert.deepEqual(snapshot(dir, false), before);
  });

  it("detecta delimitadores corrompidos e não escreve nada", async () => {
    for (const agents of [
      "# X\n<!-- repoguide:begin -->\nsem fim\n",
      "# X\n<!-- repoguide:end -->\n<!-- repoguide:begin -->\n",
      "<!-- repoguide:begin -->\na\n<!-- repoguide:end -->\n<!-- repoguide:begin -->\nb\n<!-- repoguide:end -->\n",
    ]) {
      const dir = tmpProject({ "AGENTS.md": agents });
      const before = snapshot(dir, false);
      const r = await run(["init", "--json"], { cwd: dir });
      assert.equal(r.code, 4, r.stdout);
      assert.match(JSON.stringify(r.json.error), /delimitadores|Delimitador/);
      assert.deepEqual(snapshot(dir, false), before);
    }
  });

  it("--claude referencia AGENTS.md num CLAUDE.md existente sem duplicar instruções", async () => {
    const dir = tmpProject({ "CLAUDE.md": "# Preferências\n- Responda em pt-BR\n" });
    const r = await run(["init", "--claude"], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const claude = read(dir, "CLAUDE.md");
    assert.ok(claude.startsWith("# Preferências\n- Responda em pt-BR\n"));
    assert.match(claude, /^@AGENTS\.md$/m);
    assert.ok(!claude.includes("Descoberta progressiva"), "não copia as instruções");
  });

  it("recusa arquivo gerenciado pré-existente que não foi criado pelo RepoGuide", async () => {
    const dir = tmpProject({ ".ai/sdk/INSTRUCOES.md": "minhas instruções\n" });
    const r = await run(["init"], { cwd: dir });
    assert.equal(r.code, 4);
    assert.equal(read(dir, ".ai/sdk/INSTRUCOES.md"), "minhas instruções\n");
    assert.ok(!existsSync(path.join(dir, ".ai/sdk.lock.json")));
  });

  it("init com --scope grava escopos e valida caminhos", async () => {
    const dir = tmpProject({ "apps/web/package.json": "{}", "apps/api/package.json": "{}" });
    const ok = await run(["init", "--scope", "web=apps/web", "--scope", "api=apps/api"], { cwd: dir });
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(JSON.parse(read(dir, ".ai/config.json")).scopes, [
      { id: "web", path: "apps/web" },
      { id: "api", path: "apps/api" },
    ]);
    const bad = await run(["init", "--scope", "x=../fora"], { cwd: tmpProject() });
    assert.equal(bad.code, 3);
    const reserved = await run(["init", "--scope", "repo=."], { cwd: tmpProject() });
    assert.equal(reserved.code, 2);
  });

  it("aceita -C para escolher o diretório do projeto", async () => {
    const dir = tmpProject();
    const r = await run(["init", "-C", dir]);
    assert.equal(r.code, 0);
    assert.ok(existsSync(path.join(dir, ".ai/sdk.lock.json")));
    const missing = await run(["check", "-C", path.join(dir, "nao-existe")]);
    assert.equal(missing.code, 2);
  });

  it("instala workflows opcionais com permissões mínimas e sem pull_request_target", async () => {
    const dir = tmpProject();
    assert.equal((await run(["init", "--github-workflows"], { cwd: dir })).code, 0);
    const check = read(dir, ".github/workflows/repoguide-check.yml");
    const maint = read(dir, ".github/workflows/repoguide-maintenance.yml");
    assert.match(check, /permissions:\n {2}contents: read/);
    assert.ok(!/pull_request_target/.test(check + maint));
    assert.match(maint, /^permissions: \{\}$/m);
    assert.match(check, /v0\.1\.0\/tassiopereira-repoguide-0\.1\.0\.tgz/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256 } from "../src/lib/fsx.js";
import { makeBundle, read, releaseServer, run, snapshot, tmpProject, write } from "./helpers.js";

async function installed(files: Record<string, string> = {}) {
  const dir = tmpProject({ "AGENTS.md": "# Time\n\nRegra local.\n", ...files });
  const r = await run(["init"], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  return dir;
}

const v020 = () =>
  makeBundle("0.2.0", (f) => {
    f.set("sdk/INSTRUCOES.md", f.get("sdk/INSTRUCOES.md")! + "\n## 13. Novidade\n\nPolítica de PR revisada.\n");
    f.set("templates/agents-block.md", f.get("templates/agents-block.md")!.replace("Instruções em português", "Instruções revisadas em português"));
  });

describe("update", () => {
  it("atualiza para a última versão estável mostrando diferenças e preservando arquivos do projeto", async () => {
    const dir = await installed();
    write(dir, "docs/ai/MAPA.md", "# Mapa editado pelo time\n");
    const srv = await releaseServer([makeBundle("0.1.0"), v020()]);
    try {
      const dry = await run(["update", "--dry-run", "--json"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
      assert.equal(dry.code, 0, dry.stdout + dry.stderr);
      assert.equal(dry.json.to, "0.2.0");
      assert.ok((dry.json.diffs as string[]).some((d) => d.includes("+ ## 13. Novidade")));
      assert.equal(JSON.parse(read(dir, ".ai/sdk.lock.json")).sdkVersion, "0.1.0", "dry-run não adota");

      const r = await run(["update"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /0\.1\.0 → 0\.2\.0/);
      const lock = JSON.parse(read(dir, ".ai/sdk.lock.json"));
      assert.equal(lock.sdkVersion, "0.2.0");
      assert.match(lock.source, /v0\.2\.0\/repoguide-content\.json$/);
      assert.match(read(dir, ".ai/sdk/INSTRUCOES.md"), /## 13\. Novidade/);
      const agents = read(dir, "AGENTS.md");
      assert.ok(agents.startsWith("# Time\n\nRegra local.\n"));
      assert.match(agents, /Instruções revisadas/);
      assert.equal(read(dir, "docs/ai/MAPA.md"), "# Mapa editado pelo time\n");
      const again = await run(["update", "--json"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
      assert.equal(again.json.changed, false);
    } finally {
      await srv.close();
    }
  });

  it("aborta sem sobrescrever quando um arquivo gerenciado foi modificado", async () => {
    const dir = await installed();
    write(dir, ".ai/sdk/INSTRUCOES.md", read(dir, ".ai/sdk/INSTRUCOES.md") + "\nregra local\n");
    const before = snapshot(dir);
    const srv = await releaseServer([makeBundle("0.1.0"), v020()]);
    try {
      const r = await run(["update", "--json"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
      assert.equal(r.code, 4);
      const err = r.json.error as { details: string[]; hint: string };
      assert.ok(err.details.some((d) => d.includes(".ai/sdk/INSTRUCOES.md")));
      assert.match(err.hint, /git checkout/);
      assert.deepEqual(snapshot(dir), before);
    } finally {
      await srv.close();
    }
  });

  it("detecta edição do bloco gerenciado no AGENTS.md", async () => {
    const dir = await installed();
    write(dir, "AGENTS.md", read(dir, "AGENTS.md").replace("Não edite `.ai/sdk/`", "Pode editar `.ai/sdk/`"));
    const srv = await releaseServer([makeBundle("0.1.0"), v020()]);
    try {
      const r = await run(["update"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
      assert.equal(r.code, 4);
      assert.match(r.stderr, /bloco gerenciado editado localmente/);
    } finally {
      await srv.close();
    }
  });

  it("falha no meio da aplicação não deixa estado parcial", async () => {
    const dir = await installed();
    const before = snapshot(dir);
    const srv = await releaseServer([makeBundle("0.1.0"), v020()]);
    try {
      const r = await run(["update"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source, REPOGUIDE_INTERNAL_FAULT_AFTER: "1" } });
      assert.equal(r.code, 3, r.stdout + r.stderr);
      assert.match(r.stderr, /revertidas/);
      assert.deepEqual(snapshot(dir), before);
      const ok = await run(["update"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
      assert.equal(ok.code, 0, "repetir após a falha funciona");
    } finally {
      await srv.close();
    }
  });

  it("offline usa o conteúdo embutido e não acessa a rede", async () => {
    const dir = await installed();
    const r = await run(["update", "--offline", "--json"], { cwd: dir, env: { REPOGUIDE_SOURCE: "https://invalid.example.invalid/stable.json" } });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.changed, false);
  });

  it("rede indisponível e timeout geram erro compreensível sem alterar nada", async () => {
    const dir = await installed();
    const before = snapshot(dir);
    const down = await run(["update"], { cwd: dir });
    assert.equal(down.code, 5);
    assert.match(down.stderr, /Falha de rede|--offline/);
    const srv = await releaseServer([makeBundle("0.1.0"), v020()]);
    srv.delayMs = 1500;
    try {
      const r = await run(["update", "--timeout", "300"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
      assert.equal(r.code, 5);
      assert.match(r.stderr, /Tempo esgotado após 300 ms/);
    } finally {
      await srv.close();
    }
    assert.deepEqual(snapshot(dir), before);
  });

  it("rejeita catálogo inválido, hash adulterado, schema desconhecido e caminhos maliciosos", async () => {
    const dir = await installed();
    const before = snapshot(dir);
    const cases = [
      { bundles: [makeBundle("0.2.0", (f) => f.set("sdk/requisitos.json", JSON.stringify({ schemaVersion: 1, catalogVersion: "x", requirements: "?" })))], expect: /inválid/ },
      { bundles: [v020()], opts: { tamperHash: "0.2.0" }, expect: /Hash do conteúdo/ },
      { bundles: [{ ...v020(), schemaVersion: 99 }], expect: /schema 99/ },
      { bundles: [{ ...v020(), files: [...v020().files, { path: "../../.bashrc", content: "x", sha256: sha256("x") }] }], expect: /não permitido/ },
      { bundles: [{ ...v020(), files: v020().files.map((f) => (f.path === "sdk/INSTRUCOES.md" ? { ...f, content: f.content + "!" } : f)) }], expect: /hash não confere/ },
      { bundles: [{ ...v020(), minCliVersion: "9.0.0" }], expect: /exige a CLI 9\.0\.0/ },
    ];
    for (const c of cases) {
      const srv = await releaseServer(c.bundles, c.opts ?? {});
      try {
        const r = await run(["update", "--json"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
        assert.equal(r.code, 5, JSON.stringify(r.json));
        assert.match(JSON.stringify(r.json.error), c.expect);
      } finally {
        await srv.close();
      }
    }
    assert.deepEqual(snapshot(dir), before);
  });

  it("não migra de versão principal silenciosamente", async () => {
    const dir = await installed();
    const srv = await releaseServer([makeBundle("0.1.0"), makeBundle("1.0.0")]);
    try {
      const r = await run(["update"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /--allow-major/);
      const ok = await run(["update", "--allow-major"], { cwd: dir, env: { REPOGUIDE_SOURCE: srv.source } });
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal(JSON.parse(read(dir, ".ai/sdk.lock.json")).sdkVersion, "1.0.0");
    } finally {
      await srv.close();
    }
  });

  it("restaura arquivo gerenciado apagado", async () => {
    const dir = await installed();
    const { rmSync } = await import("node:fs");
    rmSync(`${dir}/.ai/sdk/INSTRUCOES.md`);
    const r = await run(["update", "--from-package"], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /restaurado/);
    assert.match(read(dir, ".ai/sdk/INSTRUCOES.md"), /Instruções RepoGuide/);
  });

  it("recusa URL de canal sem HTTPS fora de loopback", async () => {
    const dir = await installed();
    const r = await run(["update", "--source", "http://example.com/stable.json"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /use HTTPS/);
  });
});

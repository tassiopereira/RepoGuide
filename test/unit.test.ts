import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseBlock, upsertBlock } from "../src/lib/block.js";
import { catalogProblems } from "../src/lib/catalog.js";
import { dependabotEcosystems, detectEcosystems } from "../src/lib/checkers.js";
import { loadBundledContent, validateBundle } from "../src/lib/content.js";
import { combine, interpret } from "../src/lib/evaluate.js";
import { safeJoin, sha256, Transaction } from "../src/lib/fsx.js";
import { parseGitHubRemote } from "../src/lib/github.js";
import { assertAllowedUrl } from "../src/lib/net.js";
import { parseConfig } from "../src/lib/project.js";
import { compareSemVer } from "../src/lib/semver.js";
import { read, snapshot, tmpProject } from "./helpers.js";

describe("caminhos maliciosos", () => {
  const root = tmpProject();
  it("recusa travessia, absolutos, unidades Windows e vazios", () => {
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/Windows/x", "C:\\x", "", "a//b", "a/./b/..", "..\\x"]) {
      assert.throws(() => safeJoin(root, bad), /recusado|inválido/, bad);
    }
    assert.equal(safeJoin(root, "docs/ai/MAPA.md"), path.join(root, "docs", "ai", "MAPA.md"));
  });
  it("recusa escapar por link simbólico", (t) => {
    const outside = mkdtempSync(path.join(tmpdir(), "rg-out-"));
    try {
      symlinkSync(outside, path.join(root, "link"), "junction");
    } catch {
      t.skip("sem permissão para criar links simbólicos neste sistema");
      return;
    }
    assert.throws(() => safeJoin(root, "link/evil.txt"), /escaparia/);
  });
  it("config com escopo fora do projeto é recusada", () => {
    assert.throws(() => parseConfig({ scopes: [{ id: "x", path: "../fora" }] }, root), /inválido/);
  });
  it("bundle com caminho não permitido é rejeitado", () => {
    const b = loadBundledContent();
    const evil = { ...b, files: [...b.files, { path: "../../evil.sh", content: "x", sha256: sha256("x") }] };
    assert.throws(() => validateBundle(evil, "teste"), /não permitido|integridade/);
  });
  it("URLs só HTTPS (HTTP apenas em loopback)", () => {
    assert.ok(assertAllowedUrl("https://github.com/x"));
    assert.ok(assertAllowedUrl("http://127.0.0.1:8080/x"));
    assert.throws(() => assertAllowedUrl("http://example.com"));
    assert.throws(() => assertAllowedUrl("file:///etc/passwd"));
  });
});

describe("bloco delimitado", () => {
  it("insere, substitui e preserva o restante", () => {
    const a = upsertBlock("# A\n\ntexto", "um");
    assert.equal(a.action, "inserted");
    assert.equal(a.content, "# A\n\ntexto\n\n<!-- repoguide:begin -->\num\n<!-- repoguide:end -->\n");
    const b = upsertBlock(a.content + "\n## Depois\n", "dois");
    assert.equal(b.action, "replaced");
    assert.ok(b.content.startsWith("# A\n\ntexto\n\n<!-- repoguide:begin -->\ndois\n"));
    assert.ok(b.content.endsWith("<!-- repoguide:end -->\n\n## Depois\n"));
    assert.equal(upsertBlock(b.content, "dois").action, "unchanged");
  });
  it("detecta ambiguidade", () => {
    assert.equal(parseBlock("<!-- repoguide:begin -->").status, "corrupt");
    assert.equal(parseBlock("<!-- repoguide:end --><!-- repoguide:begin -->").status, "corrupt");
    assert.equal(parseBlock("nada").status, "absent");
  });
});

describe("transação", () => {
  it("reverte todos os arquivos se falhar no meio", () => {
    const dir = tmpProject({ "a.txt": "A0", "b.txt": "B0" });
    const before = snapshot(dir);
    const tx = new Transaction(dir, { faultAfter: 2 });
    tx.add({ rel: "a.txt", content: "A1", reason: "" });
    tx.add({ rel: "novo/c.txt", content: "C1", reason: "" });
    tx.add({ rel: "b.txt", content: "B1", reason: "" });
    assert.throws(() => tx.commit(path.join(dir, ".bk")), /revertidas/);
    const after = snapshot(dir);
    delete after[".bk"];
    assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([k]) => !k.startsWith(".bk/"))), before);
    assert.equal(read(dir, "a.txt"), "A0");
  });
  it("aplica tudo quando não há falha", () => {
    const dir = tmpProject({ "a.txt": "A0" });
    mkdirSync(path.join(dir, "x"));
    const tx = new Transaction(dir);
    tx.add({ rel: "a.txt", content: "A1", reason: "" });
    tx.add({ rel: "x/b.txt", content: "B1", reason: "" });
    tx.commit(path.join(dir, ".bk"));
    assert.equal(read(dir, "a.txt"), "A1");
    assert.equal(read(dir, "x/b.txt"), "B1");
  });
});

describe("interpretação de evidências", () => {
  const obs = (staticOk: boolean | null, operational: "confirmed" | "missing" | "unverified" | "not-required") => ({ staticOk, operational, evidence: [], reasons: ["r"] });
  it("sem evidência nunca resulta em atendido", () => {
    assert.equal(interpret(obs(true, "unverified"), undefined).result, "unknown");
    assert.equal(interpret(obs(null, "confirmed"), undefined).result, "unknown");
    assert.equal(interpret(obs(false, "confirmed"), undefined).result, "pending");
    assert.equal(interpret(obs(true, "missing"), undefined).result, "pending");
    assert.equal(interpret(obs(true, "confirmed"), undefined).result, "met");
  });
  it("estado efetivo combina resultado e decisão", () => {
    const d = { requirement: "X", scope: "repo", type: "deferred" as const, reason: "r", declaredBy: "a", date: "2026-01-01", requirementRevision: 1, expires: "2026-02-01" };
    assert.equal(combine("pending", { state: "active", decision: d }), "deferred");
    assert.equal(combine("met", { state: "active", decision: d }), "met");
    assert.equal(combine("pending", { state: "expired", decision: d, why: "" }), "review-required");
    assert.equal(combine("unknown", { state: "none" }), "unknown");
  });
});

describe("diversos", () => {
  it("SemVer", () => {
    assert.equal(compareSemVer("1.2.0", "1.10.0"), -1);
    assert.equal(compareSemVer("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareSemVer("v2.0.0", "2.0.0"), 0);
  });
  it("detecta repositório GitHub em URLs https e ssh", () => {
    assert.deepEqual(parseGitHubRemote("https://github.com/tassiopereira/RepoGuide.git"), { owner: "tassiopereira", repo: "RepoGuide" });
    assert.deepEqual(parseGitHubRemote("git@github.com:o/r.git"), { owner: "o", repo: "r" });
    assert.equal(parseGitHubRemote("https://gitlab.com/o/r"), undefined);
  });
  it("catálogo embutido é válido e completo", () => {
    const cat = JSON.parse(loadBundledContent().files.find((f) => f.path === "sdk/requisitos.json")!.content);
    assert.deepEqual(catalogProblems(cat), []);
    assert.deepEqual(cat.requirements.map((r: { id: string }) => r.id).sort(), ["RG-DEP-001", "RG-GOV-001", "RG-OBS-001", "RG-PRD-001"]);
  });
  it("ecossistemas e Dependabot", () => {
    const files = ["package.json", "api/go.mod", ".github/workflows/ci.yml", "Dockerfile"].map((rel) => ({ rel, size: 1, mtimeMs: 1 }));
    assert.deepEqual(detectEcosystems(files), ["docker", "github-actions", "gomod", "npm"]);
    assert.deepEqual(dependabotEcosystems('updates:\n  - package-ecosystem: "npm"\n  - package-ecosystem: gomod\n'), ["npm", "gomod"]);
  });
});

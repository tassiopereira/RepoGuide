import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { json, listen, makeBundle, releaseServer, run, tmpProject } from "./helpers.js";

interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  state_reason?: string | null;
  labels: { name: string }[];
  comments: string[];
  pull_request?: unknown;
}

/** Minimal in-memory GitHub REST API (issues, labels, git data, pulls, rules). Simulation only. */
async function fakeGitHub(opts: { prStatus?: number; seed?: Partial<Issue>[] } = {}) {
  const issues: Issue[] = [];
  const labels = new Set<string>();
  const refs = new Map<string, string>([["heads/main", "sha-main"]]);
  const pulls: { number: number; head: string; base: string; title: string; body: string }[] = [];
  const writes: string[] = [];
  const log: string[] = [];
  let n = 100;
  for (const s of opts.seed ?? []) issues.push({ number: ++n, title: "x", body: "", state: "open", labels: [], comments: [], ...s });
  const srv = await listen((req, res, raw) => {
    const url = new URL(req.url!, "http://x");
    const p = url.pathname;
    const method = req.method!;
    log.push(`${method} ${p}${url.search}`);
    if (method !== "GET") writes.push(`${method} ${p}`);
    const body = raw ? JSON.parse(raw) : {};
    if (req.headers.authorization !== "Bearer test-token" && method !== "GET") return json(res, 401, { message: "Bad credentials" });
    let m: RegExpExecArray | null;
    if (p === "/repos/acme/app" && method === "GET") return json(res, 200, { default_branch: "main" });
    if (p === "/repos/acme/app/rules/branches/main") return json(res, 200, []);
    if ((m = /^\/repos\/acme\/app\/branches\/main\/protection$/.exec(p))) return json(res, 404, { message: "Branch not protected" });
    if (p.startsWith("/search/issues")) return json(res, 200, { total_count: 0, items: [] });
    if (p === "/repos/acme/app/issues" && method === "GET") {
      const lab = url.searchParams.get("labels");
      return json(res, 200, issues.filter((i) => !lab || i.labels.some((l) => l.name === lab)));
    }
    if (p === "/repos/acme/app/issues" && method === "POST") {
      const i: Issue = { number: ++n, title: body.title, body: body.body, state: "open", labels: (body.labels ?? []).map((name: string) => ({ name })), comments: [] };
      issues.push(i);
      return json(res, 201, i);
    }
    if ((m = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(p)) && method === "PATCH") {
      const i = issues.find((x) => x.number === Number(m![1]))!;
      Object.assign(i, body);
      return json(res, 200, i);
    }
    if ((m = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(p)) && method === "POST") {
      issues.find((x) => x.number === Number(m![1]))!.comments.push(body.body);
      return json(res, 201, {});
    }
    if (p === "/repos/acme/app/labels/repoguide") return labels.has("repoguide") ? json(res, 200, {}) : json(res, 404, {});
    if (p === "/repos/acme/app/labels" && method === "POST") {
      labels.add(body.name);
      return json(res, 201, {});
    }
    if (p === "/repos/acme/app/pulls" && method === "GET") {
      const head = url.searchParams.get("head")!.split(":")[1];
      return json(res, 200, pulls.filter((x) => x.head === head).map((x) => ({ number: x.number, html_url: `https://github.com/acme/app/pull/${x.number}` })));
    }
    if (p === "/repos/acme/app/pulls" && method === "POST") {
      if (opts.prStatus) return json(res, opts.prStatus, { message: "GitHub Actions is not permitted to create or approve pull requests." });
      const pr = { number: ++n, head: body.head, base: body.base, title: body.title, body: body.body };
      pulls.push(pr);
      return json(res, 201, { number: pr.number, html_url: `https://github.com/acme/app/pull/${pr.number}` });
    }
    if ((m = /^\/repos\/acme\/app\/git\/ref\/(.+)$/.exec(p))) {
      const sha = refs.get(decodeURIComponent(m[1]!));
      return sha ? json(res, 200, { object: { sha } }) : json(res, 404, { message: "Not Found" });
    }
    if (p.startsWith("/repos/acme/app/git/commits/") && method === "GET") return json(res, 200, { tree: { sha: "tree-main" } });
    if (p === "/repos/acme/app/git/blobs") return json(res, 201, { sha: `blob-${writes.length}` });
    if (p === "/repos/acme/app/git/trees") return json(res, 201, { sha: "tree-new" });
    if (p === "/repos/acme/app/git/commits") return json(res, 201, { sha: "commit-new" });
    if (p === "/repos/acme/app/git/refs") {
      refs.set(body.ref.replace("refs/", ""), body.sha);
      return json(res, 201, {});
    }
    json(res, 404, { message: `not mocked: ${method} ${p}` });
  });
  return { ...srv, issues, pulls, writes, log, labels };
}

async function project(files: Record<string, string> = { "package.json": "{}" }) {
  const dir = tmpProject(files, { remote: "git@github.com:acme/app.git" });
  assert.equal((await run(["init"], { cwd: dir })).code, 0);
  return dir;
}

describe("github sync-issues (simulado)", () => {
  it("cria uma issue por requisito/escopo e reexecuções não duplicam nem comentam", async () => {
    const gh = await fakeGitHub({
      seed: [
        { title: "Bug do usuário", body: "nada", labels: [{ name: "bug" }] },
        { title: "Issue com rótulo mas sem marcador", body: "manual", labels: [{ name: "repoguide" }] },
      ],
    });
    const dir = await project();
    const env = { GITHUB_API_URL: gh.url, GITHUB_TOKEN: "test-token" };
    try {
      const dry = await run(["github", "sync-issues", "--offline", "--dry-run", "--json"], { cwd: dir, env });
      assert.equal(dry.code, 0, dry.stdout + dry.stderr);
      assert.equal(gh.writes.length, 0, "dry-run não escreve");

      const first = await run(["github", "sync-issues", "--offline", "--json"], { cwd: dir, env });
      assert.equal(first.code, 0, first.stdout + first.stderr);
      const managed = gh.issues.filter((i) => i.body.includes("repoguide:issue"));
      assert.equal(managed.length, 4);
      assert.ok(gh.labels.has("repoguide"));
      const writesAfterFirst = gh.writes.length;

      const second = await run(["github", "sync-issues", "--offline", "--json"], { cwd: dir, env });
      assert.equal(second.code, 0);
      assert.equal(gh.writes.length, writesAfterFirst, "nada mudou → nenhuma escrita");
      assert.equal(gh.issues.filter((i) => i.body.includes("repoguide:issue")).length, 4);
      assert.ok(gh.issues.every((i) => i.comments.length === 0));
      assert.equal(gh.issues.find((i) => i.title === "Bug do usuário")!.body, "nada", "issue alheia intocada");
      assert.equal(gh.issues.find((i) => i.title.startsWith("Issue com rótulo"))!.body, "manual", "issue sem marcador intocada");
    } finally {
      await gh.close();
    }
  });

  it("dispensa encerra como not_planned sem fingir implementação; vencimento reabre", async () => {
    const gh = await fakeGitHub();
    const dir = await project();
    const env = { GITHUB_API_URL: gh.url, GITHUB_TOKEN: "test-token", REPOGUIDE_INTERNAL_NOW: "2026-11-03T12:00:00Z" };
    try {
      await run(["github", "sync-issues", "--offline"], { cwd: dir, env });
      await run(["requirement", "waive", "RG-DEP-001", "--reason", "Repositório será arquivado", "--by", "Ana", "--review-by", "2026-12-01"], { cwd: dir, env });
      const r = await run(["github", "sync-issues", "--offline", "--json"], { cwd: dir, env });
      assert.equal(r.code, 0, r.stdout);
      const dep = gh.issues.find((i) => i.body.includes('"RG-DEP-001"'))!;
      assert.equal(dep.state, "closed");
      assert.equal(dep.state_reason, "not_planned");
      assert.equal(dep.comments.length, 1);
      assert.match(dep.comments[0]!, /\*\*não\*\* foi implementado/);
      await run(["github", "sync-issues", "--offline"], { cwd: dir, env });
      assert.equal(dep.comments.length, 1, "sem comentário repetido");
      await run(["github", "sync-issues", "--offline"], { cwd: dir, env: { ...env, REPOGUIDE_INTERNAL_NOW: "2026-12-05T12:00:00Z" } });
      assert.equal(dep.state, "open", "dispensa vencida volta a cobrar");
      assert.equal(dep.comments.length, 2);
      const unknown = gh.issues.find((i) => i.body.includes('"RG-GOV-001"'))!;
      assert.equal(unknown.state, "open", "falta de evidência não encerra como atendida");
    } finally {
      await gh.close();
    }
  });

  it("exige token para escrever", async () => {
    const dir = await project();
    const r = await run(["github", "sync-issues", "--offline"], { cwd: dir, env: { GITHUB_API_URL: "http://127.0.0.1:9" } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /GITHUB_TOKEN/);
  });
});

describe("github update-pr (simulado)", () => {
  it("abre um PR de atualização uma única vez e nunca faz merge", async () => {
    const gh = await fakeGitHub();
    const rel = await releaseServer([makeBundle("0.1.0"), makeBundle("0.2.0")]);
    const dir = await project();
    const env = { GITHUB_API_URL: gh.url, GITHUB_TOKEN: "test-token", REPOGUIDE_SOURCE: rel.source };
    try {
      const r = await run(["github", "update-pr", "--json"], { cwd: dir, env });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(r.json.created, true);
      assert.equal(gh.pulls.length, 1);
      assert.equal(gh.pulls[0]!.head, "repoguide/update-0.2.0");
      assert.ok(!gh.log.some((l) => /merge/.test(l)), "nenhuma chamada de merge");
      const again = await run(["github", "update-pr", "--json"], { cwd: dir, env });
      assert.equal(again.code, 0);
      assert.equal(again.json.created, false);
      assert.equal(gh.pulls.length, 1, "sem PR duplicado");
      assert.equal(JSON.parse((await import("node:fs")).readFileSync(`${dir}/.ai/sdk.lock.json`, "utf8")).sdkVersion, "0.1.0", "workspace local não é alterado");
    } finally {
      await gh.close();
      await rel.close();
    }
  });

  it("relata o impedimento quando o token não pode criar PR", async () => {
    const gh = await fakeGitHub({ prStatus: 403 });
    const rel = await releaseServer([makeBundle("0.1.0"), makeBundle("0.2.0")]);
    const dir = await project();
    try {
      const r = await run(["github", "update-pr"], { cwd: dir, env: { GITHUB_API_URL: gh.url, GITHUB_TOKEN: "test-token", REPOGUIDE_SOURCE: rel.source } });
      assert.equal(r.code, 5);
      assert.match(r.stderr, /não pôde abrir o PR/);
      assert.match(r.stderr, /Allow GitHub Actions to create and approve pull requests/);
    } finally {
      await gh.close();
      await rel.close();
    }
  });

  it("sem nova versão não faz nada", async () => {
    const gh = await fakeGitHub();
    const rel = await releaseServer([makeBundle("0.1.0")]);
    const dir = await project();
    try {
      const r = await run(["github", "update-pr", "--json"], { cwd: dir, env: { GITHUB_API_URL: gh.url, GITHUB_TOKEN: "test-token", REPOGUIDE_SOURCE: rel.source } });
      assert.equal(r.code, 0);
      assert.equal(r.json.created, false);
      assert.equal(gh.writes.length, 0);
    } finally {
      await gh.close();
      await rel.close();
    }
  });
});

describe("check com GitHub (simulado)", () => {
  it("branch sem exigência de PR é pendente; orientação escrita não basta", async () => {
    const gh = await fakeGitHub();
    const dir = await project();
    try {
      const r = await run(["check", "--json"], { cwd: dir, env: { GITHUB_API_URL: gh.url } });
      const gov = (r.json.items as { id: string; result: string; reason: string }[]).find((i) => i.id === "RG-GOV-001")!;
      assert.equal(gov.result, "pending");
      assert.match(gov.reason, /não exige PR/);
    } finally {
      await gh.close();
    }
  });
});

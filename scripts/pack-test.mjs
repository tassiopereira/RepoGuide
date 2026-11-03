// Packs the CLI with `npm pack`, installs the tarball into a temporary consumer project and
// runs the real binary there. Proves the published package works without the source tree.
// Usage: npm run build && npm run test:pack
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const npm = win ? "npm.cmd" : "npm";
const npx = win ? "npx.cmd" : "npx";
const work = mkdtempSync(path.join(tmpdir(), "repoguide-pack-"));
const fail = (msg) => {
  console.error(`pack-test: FALHOU — ${msg}`);
  process.exit(1);
};

try {
  const packed = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", work], { cwd: root, encoding: "utf8", shell: win }));
  const info = packed[0];
  const tarball = path.join(work, info.filename.replace(/^.*[\\/]/, ""));
  const files = info.files.map((f) => f.path);
  for (const forbidden of ["src/", "test/", "build/test/", "docs/", ".github/", "scripts/", ".ai/"]) {
    if (files.some((f) => f.startsWith(forbidden))) fail(`o pacote não deve conter ${forbidden}`);
  }
  for (const required of ["build/src/bin.js", "content/sdk/requisitos.json", "content/sdk/INSTRUCOES.md", "package.json", "LICENSE"]) {
    if (!files.includes(required)) fail(`o pacote deve conter ${required}`);
  }

  const consumer = path.join(work, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0", private: true }, null, 2));
  writeFileSync(path.join(consumer, "AGENTS.md"), "# Instruções existentes\n\nPreservar.\n");
  execFileSync(npm, ["install", "--no-audit", "--no-fund", "--save-dev", tarball], { cwd: consumer, stdio: "inherit", shell: win });

  const run = (...args) => {
    const r = spawnSync(npx, ["--no-install", "repoguide", ...args], { cwd: consumer, encoding: "utf8", shell: win });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const v = run("--version");
  if (v.code !== 0 || v.out.trim() !== info.version) fail(`--version retornou ${v.code} ${v.out}`);
  const init = run("init", "--json");
  if (init.code !== 0) fail(`init falhou: ${init.out}${init.err}`);
  const agents = readFileSync(path.join(consumer, "AGENTS.md"), "utf8");
  if (!agents.startsWith("# Instruções existentes") || !agents.includes("<!-- repoguide:begin -->")) fail("AGENTS.md não foi preservado/atualizado");
  if (!existsSync(path.join(consumer, ".ai", "sdk.lock.json"))) fail("lock ausente");
  const check = run("check", "--offline", "--json");
  const parsed = JSON.parse(check.out);
  if (check.code !== 0 || parsed.repoguide.command !== "check" || !Array.isArray(parsed.items)) fail(`check inesperado: ${check.code} ${check.out}`);
  const again = run("init", "--json");
  if (JSON.parse(again.out).changed !== false) fail("init não é idempotente");
  console.log(`pack-test: OK (${info.filename}, ${files.length} arquivos, consumidor em ${consumer})`);
} finally {
  if (!process.env.KEEP_PACK_TEST) rmSync(work, { recursive: true, force: true });
}

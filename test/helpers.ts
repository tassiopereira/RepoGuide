import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundledContent, type ContentBundle } from "../src/lib/content.js";
import { sha256 } from "../src/lib/fsx.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.resolve(here, "..", "src", "bin.js");

export function tmpProject(files: Record<string, string> = {}, opts: { remote?: string } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rg-test-"));
  if (opts.remote !== undefined) {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${opts.remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  }
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return dir;
}

export function write(dir: string, rel: string, content: string): void {
  const p = path.join(dir, ...rel.split("/"));
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function read(dir: string, rel: string): string {
  return readFileSync(path.join(dir, ...rel.split("/")), "utf8");
}

/** Snapshot of every file (path → sha) excluding the local cache, for "no side effects" asserts. */
export function snapshot(dir: string, skipCache = true): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (abs: string, rel: string) => {
    for (const name of readdirSync(abs)) {
      const r = rel ? `${rel}/${name}` : name;
      if (skipCache && r === ".ai/.cache") continue;
      const p = path.join(abs, name);
      if (statSync(p).isDirectory()) visit(p, r);
      else out[r] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  visit(dir, "");
  return out;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> & { [k: string]: unknown };
}

const SCRUB = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_API_URL", "CI", "REPOGUIDE_SOURCE", "REPOGUIDE_INTERNAL_NOW", "REPOGUIDE_INTERNAL_FAULT_AFTER"];

/** Runs the built CLI asynchronously (so in-process mock servers can answer). */
export function run(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<RunResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of SCRUB) delete env[k];
  // Hermetic by default: unreachable local endpoints unless a test provides a mock server.
  Object.assign(env, { REPOGUIDE_SOURCE: "http://127.0.0.1:9/none/stable.json", GITHUB_API_URL: "http://127.0.0.1:9" }, opts.env ?? {});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: opts.cwd ?? process.cwd(), env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let json = {} as RunResult["json"];
      if (args.includes("--json")) {
        try {
          json = JSON.parse(stdout);
        } catch {
          /* leave empty */
        }
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

export async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      Promise.resolve(handler(req, res, body)).catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}

/** Builds a bundle for another version from the bundled content, applying edits. */
export function makeBundle(version: string, edit: (files: Map<string, string>) => void = () => {}, extra: Partial<ContentBundle> = {}): ContentBundle {
  const base = loadBundledContent();
  const files = new Map(base.files.map((f) => [f.path, f.content]));
  edit(files);
  return {
    format: "repoguide-content",
    schemaVersion: 1,
    version,
    minCliVersion: "0.1.0",
    highlights: `Novidades da ${version}`,
    files: [...files.entries()].map(([p, content]) => ({ path: p, content, sha256: sha256(content) })),
    ...extra,
  };
}

export interface ReleaseServer {
  url: string;
  source: string;
  requests: string[];
  close: () => Promise<void>;
  delayMs: number;
}

/**
 * Simulates GitHub release downloads: /latest/stable.json redirects to /v<latest>/stable.json,
 * bundles are served at /v<version>/repoguide-content.json.
 */
export async function releaseServer(bundles: ContentBundle[], opts: { tamperHash?: string; rawBundle?: Record<string, string> } = {}): Promise<ReleaseServer> {
  const texts = new Map<string, string>();
  for (const b of bundles) texts.set(b.version, opts.rawBundle?.[b.version] ?? JSON.stringify(b));
  const latest = bundles[bundles.length - 1]!.version;
  const index = (dirVersion: string) => ({
    format: "repoguide-channel",
    channel: "stable",
    latest,
    releases: bundles.map((b) => ({
      version: b.version,
      url: b.version === dirVersion ? "repoguide-content.json" : `../v${b.version}/repoguide-content.json`,
      sha256: opts.tamperHash === b.version ? "0".repeat(64) : createHash("sha256").update(texts.get(b.version)!).digest("hex"),
      ...(b.highlights ? { highlights: b.highlights } : {}),
    })),
  });
  const state: ReleaseServer = { url: "", source: "", requests: [], close: async () => {}, delayMs: 0 };
  const srv = await listen(async (req, res) => {
    state.requests.push(req.url ?? "");
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    const u = req.url ?? "";
    if (u === "/latest/stable.json") {
      res.statusCode = 302;
      res.setHeader("location", `/v${latest}/stable.json`);
      return void res.end();
    }
    let m = /^\/v([^/]+)\/stable\.json$/.exec(u);
    if (m) return json(res, 200, index(m[1]!));
    m = /^\/v([^/]+)\/repoguide-content\.json$/.exec(u);
    if (m && texts.has(m[1]!)) {
      res.statusCode = 200;
      return void res.end(texts.get(m[1]!));
    }
    json(res, 404, { message: "Not Found" });
  });
  state.url = srv.url;
  state.source = `${srv.url}/latest/stable.json`;
  state.close = srv.close;
  return state;
}

export const ISO = (d: string) => `${d}T12:00:00Z`;

import { readFileSync } from "node:fs";
import path from "node:path";
import { ExitCode, RgError } from "./errors.js";
import { httpFetch } from "./net.js";

export interface RepoRef {
  owner: string;
  repo: string;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseRepoSlug(s: string): RepoRef | undefined {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(s.trim());
  if (!m || !NAME.test(m[1]!) || !NAME.test(m[2]!)) return undefined;
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, "") };
}

/** Parses a GitHub remote URL (https or ssh). Returns undefined for non-GitHub hosts. */
export function parseGitHubRemote(url: string, host = "github.com"): RepoRef | undefined {
  const h = host.replace(/\./g, "\\.");
  const m = new RegExp(`^(?:https?://(?:[^@/]+@)?${h}/|(?:ssh://)?git@${h}[:/])([^/]+)/([^/]+?)(?:\\.git)?/?$`).exec(url.trim());
  if (!m) return undefined;
  return parseRepoSlug(`${m[1]}/${m[2]}`);
}

/** Detects the GitHub repository without running git: env (Actions) first, then .git/config. */
export function detectRepo(root: string, explicit?: string): RepoRef | undefined {
  if (explicit) {
    const r = parseRepoSlug(explicit);
    if (!r) throw new RgError(ExitCode.USAGE, `--repo inválido: ${explicit} (use owner/nome)`);
    return r;
  }
  if (process.env.GITHUB_REPOSITORY) return parseRepoSlug(process.env.GITHUB_REPOSITORY);
  try {
    const cfg = readFileSync(path.join(root, ".git", "config"), "utf8");
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(cfg);
    const url = section ? /\n\s*url\s*=\s*(.+)/.exec(section[1]!)?.[1] : undefined;
    return url ? parseGitHubRemote(url) : undefined;
  } catch {
    return undefined;
  }
}

export function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

export class GitHubClient {
  readonly base: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: { token?: string; timeoutMs: number; baseUrl?: string }) {
    this.base = (opts.baseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs;
  }

  get authenticated(): boolean {
    return !!this.token;
  }

  async request<T>(method: string, route: string, body?: unknown): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await httpFetch(this.base + route, {
      method,
      headers,
      timeoutMs: this.timeoutMs,
      maxBytes: 5 * 1024 * 1024,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && this.token && method === "GET") {
      // An invalid/expired token should not block reads of public data.
      return new GitHubClient({ timeoutMs: this.timeoutMs, baseUrl: this.base }).request<T>(method, route);
    }
    let data: unknown = undefined;
    if (res.text) {
      try {
        data = JSON.parse(res.text);
      } catch {
        data = res.text;
      }
    }
    return { status: res.status, data: data as T };
  }

  /** Like request, but turns non-2xx responses into readable errors. */
  async must<T>(method: string, route: string, body?: unknown, what = route): Promise<T> {
    const r = await this.request<T>(method, route, body);
    if (r.status >= 200 && r.status < 300) return r.data;
    const msg = (r.data as { message?: string } | undefined)?.message ?? "";
    if (r.status === 401) throw new RgError(ExitCode.REMOTE, `GitHub recusou a autenticação (${what}).`, { hint: "Defina GITHUB_TOKEN com um token válido." });
    if (r.status === 403 || r.status === 404) {
      throw new RgError(ExitCode.REMOTE, `GitHub negou acesso a ${what} (HTTP ${r.status}${msg ? `: ${msg}` : ""}).`, {
        hint: "Verifique as permissões do token. Veja docs/usage/github.md para as permissões necessárias.",
      });
    }
    throw new RgError(ExitCode.REMOTE, `GitHub respondeu HTTP ${r.status} em ${what}${msg ? `: ${msg}` : ""}.`);
  }
}

export function enc(s: string): string {
  return encodeURIComponent(s);
}

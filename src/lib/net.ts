import { ExitCode, RgError } from "./errors.js";

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

export interface FetchResult {
  status: number;
  url: string;
  text: string;
  headers: Headers;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Only HTTPS is allowed, except plain HTTP to loopback (local test servers). */
export function assertAllowedUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new RgError(ExitCode.USAGE, `URL inválida: ${raw}`);
  }
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return u;
  throw new RgError(ExitCode.USAGE, `URL recusada (use HTTPS): ${raw}`);
}

/** fetch with timeout, size limit and readable errors. Redirects are followed but re-validated. */
export async function httpFetch(rawUrl: string, opts: FetchOptions): Promise<FetchResult> {
  assertAllowedUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(rawUrl, {
        method: opts.method ?? "GET",
        headers: { "user-agent": "repoguide-cli", ...(opts.headers ?? {}) },
        signal: controller.signal,
        redirect: "follow",
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      if (err.name === "AbortError") {
        throw new RgError(ExitCode.REMOTE, `Tempo esgotado após ${opts.timeoutMs} ms ao acessar ${hostOf(rawUrl)}.`, {
          hint: "Verifique a conexão, aumente --timeout ou use --offline.",
        });
      }
      throw new RgError(ExitCode.REMOTE, `Falha de rede ao acessar ${hostOf(rawUrl)}: ${err.cause?.code ?? err.message}`, {
        hint: "Sem rede? Use --offline.",
      });
    }
    assertAllowedUrl(res.url || rawUrl);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > opts.maxBytes) {
      throw new RgError(ExitCode.REMOTE, `Resposta de ${hostOf(rawUrl)} excede o limite de ${opts.maxBytes} bytes.`);
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel();
          throw new RgError(ExitCode.REMOTE, `Resposta de ${hostOf(rawUrl)} excede o limite de ${opts.maxBytes} bytes.`);
        }
        chunks.push(value);
      }
    }
    return { status: res.status, url: res.url || rawUrl, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers };
  } catch (e) {
    if (e instanceof RgError) throw e;
    if ((e as Error).name === "AbortError") {
      throw new RgError(ExitCode.REMOTE, `Tempo esgotado após ${opts.timeoutMs} ms ao acessar ${hostOf(rawUrl)}.`, {
        hint: "Verifique a conexão, aumente --timeout ou use --offline.",
      });
    }
    throw new RgError(ExitCode.REMOTE, `Falha ao ler resposta de ${hostOf(rawUrl)}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

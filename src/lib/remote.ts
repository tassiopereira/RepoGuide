import { LocalCache, formatAge } from "./cache.js";
import { LIMITS, validateBundle, type ContentBundle } from "./content.js";
import { ExitCode, RgError } from "./errors.js";
import { sha256Raw } from "./fsx.js";
import { httpFetch } from "./net.js";
import { compareSemVer, isSemVer, isStable } from "./semver.js";

export interface ChannelRelease {
  version: string;
  /** Absolute URL or URL relative to the channel index. */
  url: string;
  /** sha256 of the raw bundle bytes. */
  sha256: string;
  highlights?: string;
}

export interface ChannelIndex {
  format: "repoguide-channel";
  channel: "stable";
  latest: string;
  releases: ChannelRelease[];
}

export function parseChannel(raw: unknown): ChannelIndex {
  const c = raw as Partial<ChannelIndex>;
  const bad = (m: string) => new RgError(ExitCode.REMOTE, `Índice de versões inválido: ${m}`);
  if (!c || c.format !== "repoguide-channel") throw bad("formato desconhecido");
  if (c.channel !== "stable") throw bad("canal não suportado");
  if (!isSemVer(c.latest) || !isStable(c.latest)) throw bad("latest inválida");
  if (!Array.isArray(c.releases) || c.releases.length === 0 || c.releases.length > 500) throw bad("releases inválidas");
  for (const r of c.releases) {
    if (!isSemVer(r?.version) || typeof r.url !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256 ?? "")) throw bad(`release malformada: ${JSON.stringify(r?.version)}`);
  }
  if (!c.releases.some((r) => r.version === c.latest)) throw bad("latest não está entre as releases");
  return c as ChannelIndex;
}

export interface RemoteStatus {
  checked: boolean;
  offline?: boolean;
  fromCache: boolean;
  ageMs?: number;
  latest?: string;
  highlights?: string;
  error?: string;
}

export async function fetchChannel(source: string, timeoutMs: number): Promise<{ index: ChannelIndex; url: string }> {
  const res = await httpFetch(source, { timeoutMs, maxBytes: LIMITS.indexBytes, headers: { accept: "application/json, application/octet-stream" } });
  if (res.status === 404) throw new RgError(ExitCode.REMOTE, "Nenhuma release estável publicada ainda (índice não encontrado).");
  if (res.status !== 200) throw new RgError(ExitCode.REMOTE, `Índice de versões respondeu HTTP ${res.status}.`);
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    throw new RgError(ExitCode.REMOTE, "Índice de versões não é JSON válido.");
  }
  return { index: parseChannel(raw), url: res.url };
}

/**
 * Returns the newest stable version, using the cache when fresh. Never throws: failures are
 * reported in the result so `check` keeps working offline.
 */
export async function remoteStatus(
  cache: LocalCache,
  source: string,
  opts: { offline: boolean; refresh: boolean; ttlHours: number; timeoutMs: number; now: Date },
): Promise<RemoteStatus> {
  const cached = cache.remote && cache.remote.source === source ? cache.remote : undefined;
  const ageMs = cached ? opts.now.getTime() - Date.parse(cached.checkedAt) : undefined;
  const fresh = !!cached?.ok && ageMs !== undefined && ageMs >= 0 && ageMs <= opts.ttlHours * 3600000;
  const fromCache = (): RemoteStatus => ({
    checked: !!cached?.ok,
    fromCache: !!cached,
    ...(ageMs !== undefined ? { ageMs } : {}),
    ...(cached?.latest ? { latest: cached.latest } : {}),
    ...(cached?.highlights ? { highlights: cached.highlights } : {}),
    ...(cached?.error ? { error: cached.error } : {}),
  });
  if (opts.offline) return { ...fromCache(), checked: false, offline: true };
  if (fresh && !opts.refresh) return fromCache();
  try {
    const { index } = await fetchChannel(source, opts.timeoutMs);
    const latest = index.releases.find((r) => r.version === index.latest)!;
    cache.setRemote({ checkedAt: opts.now.toISOString(), ok: true, latest: index.latest, source, ...(latest.highlights ? { highlights: latest.highlights } : {}) });
    return { checked: true, fromCache: false, latest: index.latest, ...(latest.highlights ? { highlights: latest.highlights } : {}) };
  } catch (e) {
    const msg = (e as Error).message;
    // Keep the last successful answer, but record that this attempt failed.
    if (cached?.ok) return { ...fromCache(), checked: false, error: msg };
    cache.setRemote({ checkedAt: opts.now.toISOString(), ok: false, error: msg, source });
    return { checked: false, fromCache: false, error: msg };
  }
}

export function describeRemote(r: RemoteStatus): string {
  if (r.checked && !r.fromCache) return r.latest ?? "?";
  if (r.checked && r.fromCache) return `${r.latest} (consultado há ${formatAge(r.ageMs ?? 0)})`;
  const why = r.offline ? "offline" : "sem acesso ao canal";
  if (r.latest) return `${r.latest}? (não verificado agora: ${why}; última consulta há ${formatAge(r.ageMs ?? 0)})`;
  return `não verificado (${why})`;
}

/** Downloads a specific version from the channel, verifying hash, schema and integrity. */
export async function fetchBundle(source: string, version: string | undefined, timeoutMs: number): Promise<{ bundle: ContentBundle; url: string; index: ChannelIndex }> {
  const { index, url: indexUrl } = await fetchChannel(source, timeoutMs);
  const target = version ?? index.latest;
  const rel = index.releases.find((r) => r.version === target);
  if (!rel) {
    throw new RgError(ExitCode.REMOTE, `Versão ${target} não encontrada no canal estável.`, {
      hint: `Versões disponíveis: ${index.releases.map((r) => r.version).sort(compareSemVer).slice(-10).join(", ")}`,
    });
  }
  const bundleUrl = new URL(rel.url, indexUrl).toString();
  const res = await httpFetch(bundleUrl, { timeoutMs, maxBytes: LIMITS.bundleBytes });
  if (res.status !== 200) throw new RgError(ExitCode.REMOTE, `Download do conteúdo ${target} respondeu HTTP ${res.status}.`);
  if (sha256Raw(res.text) !== rel.sha256) {
    throw new RgError(ExitCode.REMOTE, `Hash do conteúdo ${target} não confere com o índice. Nada foi alterado.`, {
      hint: "O download pode ter sido corrompido ou alterado. Tente novamente mais tarde.",
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    throw new RgError(ExitCode.REMOTE, `Conteúdo ${target} não é JSON válido.`);
  }
  const bundle = validateBundle(raw, `release ${target}`);
  if (bundle.version !== target) throw new RgError(ExitCode.REMOTE, `Conteúdo baixado declara versão ${bundle.version}, esperado ${target}.`);
  return { bundle, url: bundleUrl, index };
}

import path from "node:path";
import { atomicWrite, readJsonIfExists, toJson } from "./fsx.js";
import { PATHS } from "./project.js";
import type { GrepCache } from "./scan.js";

/**
 * Local, git-ignored cache. Losing it is always safe: it only avoids repeated work.
 */
export interface CacheData {
  version: 1;
  remote?: { checkedAt: string; ok: boolean; latest?: string; highlights?: string; error?: string; source: string };
  /** Operational evidence obtained remotely, by key. Valid only within the TTL. */
  evidence: Record<string, { checkedAt: string; value: unknown }>;
  grep: Record<string, string[]>;
}

export class LocalCache implements GrepCache {
  private data: CacheData;
  private dirty = false;
  private readonly file: string;
  private readonly enabled: boolean;
  private readonly usedGrep = new Set<string>();

  constructor(root: string, enabled = true) {
    this.file = path.join(root, ...PATHS.cacheDir.split("/"), "state.json");
    this.enabled = enabled;
    let loaded: CacheData | undefined;
    try {
      loaded = enabled ? readJsonIfExists<CacheData>(this.file, 8 * 1024 * 1024) : undefined;
    } catch {
      loaded = undefined; // a corrupted cache is discarded
    }
    this.data = loaded && loaded.version === 1 ? { ...loaded, evidence: loaded.evidence ?? {}, grep: loaded.grep ?? {} } : { version: 1, evidence: {}, grep: {} };
  }

  get remote(): CacheData["remote"] {
    return this.data.remote;
  }

  setRemote(r: NonNullable<CacheData["remote"]>): void {
    this.data.remote = r;
    this.dirty = true;
  }

  getEvidence<T>(key: string, ttlMs: number, now: Date): { value: T; ageMs: number } | { expired: true; ageMs: number } | undefined {
    const e = this.data.evidence[key];
    if (!e) return undefined;
    const ageMs = now.getTime() - Date.parse(e.checkedAt);
    if (!(ageMs >= 0) || ageMs > ttlMs) return { expired: true, ageMs };
    return { value: e.value as T, ageMs };
  }

  setEvidence(key: string, value: unknown, now: Date): void {
    this.data.evidence[key] = { checkedAt: now.toISOString(), value };
    this.dirty = true;
  }

  get(key: string): string[] | undefined {
    const v = this.data.grep[key];
    if (v) this.usedGrep.add(key);
    return v;
  }

  set(key: string, value: string[]): void {
    this.data.grep[key] = value;
    this.usedGrep.add(key);
    this.dirty = true;
  }

  save(): void {
    if (!this.enabled || !this.dirty) return;
    // Drop grep entries for files that no longer exist / changed.
    const grep: Record<string, string[]> = {};
    for (const k of this.usedGrep) if (this.data.grep[k]) grep[k] = this.data.grep[k]!;
    try {
      atomicWrite(this.file, toJson({ ...this.data, grep }));
    } catch {
      /* cache is best effort */
    }
  }
}

export function formatAge(ms: number): string {
  const h = ms / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} dias`;
}

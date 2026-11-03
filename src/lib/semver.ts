export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemVer(v: string): SemVer | undefined {
  const m = RE.exec(v.trim());
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

export function isSemVer(v: unknown): v is string {
  return typeof v === "string" && parseSemVer(v) !== undefined;
}

export function compareSemVer(a: string, b: string): number {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (!pa || !pb) throw new Error(`Versão inválida: ${!pa ? a : b}`);
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : undefined;
    const ny = /^\d+$/.test(y) ? Number(y) : undefined;
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (nx !== undefined) return -1;
    else if (ny !== undefined) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function isStable(v: string): boolean {
  const p = parseSemVer(v);
  return !!p && p.prerelease.length === 0;
}

export function majorOf(v: string): number {
  const p = parseSemVer(v);
  if (!p) throw new Error(`Versão inválida: ${v}`);
  return p.major;
}

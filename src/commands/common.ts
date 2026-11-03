import { createInterface } from "node:readline/promises";
import { cliVersion } from "../lib/content.js";
import { ExitCode, RgError, usageError, type ExitCodeValue } from "../lib/errors.js";

export const JSON_SCHEMA_VERSION = 1;

export interface Globals {
  cwd: string | undefined;
  json: boolean;
  noInput: boolean;
}

export interface CommandResult {
  exitCode: ExitCodeValue;
  /** Lines for human output. */
  lines: string[];
  /** Payload merged into the JSON envelope. */
  data: Record<string, unknown>;
}

export function envelope(command: string, result: CommandResult): Record<string, unknown> {
  return {
    repoguide: { cliVersion: cliVersion(), command, jsonSchema: JSON_SCHEMA_VERSION },
    ok: result.exitCode === ExitCode.OK,
    exitCode: result.exitCode,
    ...result.data,
  };
}

export function errorEnvelope(command: string, err: RgError): Record<string, unknown> {
  return {
    repoguide: { cliVersion: cliVersion(), command, jsonSchema: JSON_SCHEMA_VERSION },
    ok: false,
    exitCode: err.exitCode,
    error: { message: err.message, ...(err.hint ? { hint: err.hint } : {}), ...(err.details.length ? { details: err.details } : {}) },
  };
}

export function parseTimeout(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 100 || n > 120000) throw usageError(`--timeout inválido: ${v} (use milissegundos entre 100 e 120000)`);
  return n;
}

export function nowFromEnv(): Date {
  // Test hook for deterministic dates. Not documented for end users.
  const fake = process.env.REPOGUIDE_INTERNAL_NOW;
  if (fake) {
    const d = new Date(fake);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function canPrompt(g: Globals): boolean {
  return !g.noInput && !g.json && !process.env.CI && !!process.stdin.isTTY && !!process.stdout.isTTY;
}

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function result(exitCode: ExitCodeValue, lines: string[], data: Record<string, unknown> = {}): CommandResult {
  return { exitCode, lines, data };
}

export function sourceFrom(flag: string | undefined, configured: string | undefined, fallback: string): string {
  return flag ?? process.env.REPOGUIDE_SOURCE ?? configured ?? fallback;
}

export { ExitCode, RgError };

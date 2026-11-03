/**
 * Exit codes are part of the public contract (see docs/usage/exit-codes.md).
 * Keep them stable.
 */
export const ExitCode = {
  OK: 0,
  /** Blocking violations found (check) or the requested failure threshold was reached. */
  BLOCKING: 1,
  /** Invalid arguments or usage. */
  USAGE: 2,
  /** Execution failure: unreadable/invalid project files, invalid catalog, I/O errors. */
  EXECUTION: 3,
  /** Conflict: local changes in managed files or corrupted delimiters. Nothing was written. */
  CONFLICT: 4,
  /** Remote failure: network, timeout, invalid remote content or GitHub API refusal. */
  REMOTE: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class RgError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly hint: string | undefined;
  readonly details: string[];

  constructor(exitCode: ExitCodeValue, message: string, options: { hint?: string; details?: string[] } = {}) {
    super(message);
    this.name = "RgError";
    this.exitCode = exitCode;
    this.hint = options.hint;
    this.details = options.details ?? [];
  }
}

export function usageError(message: string, hint?: string): RgError {
  return new RgError(ExitCode.USAGE, message, hint ? { hint } : {});
}

export function execError(message: string, hint?: string, details?: string[]): RgError {
  return new RgError(ExitCode.EXECUTION, message, { ...(hint ? { hint } : {}), ...(details ? { details } : {}) });
}

/**
 * Error taxonomy for server actions (CLAUDE.md §4.6). Raw errors are never thrown to
 * the client; they are mapped to one of these codes.
 */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "VALIDATION",
  "NOT_FOUND",
  "CONFLICT",
  "ILLEGAL_TRANSITION",
  "INSUFFICIENT_STOCK",
  "SEPARATION_OF_DUTIES",
  "RULE_VIOLATION",
  "IDEMPOTENT_REPLAY_MISMATCH",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Expected, user-presentable domain error. Thrown inside a transaction to roll it back. */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Postgres SQLSTATEs that justify a bounded retry (CLAUDE.md §4.3). */
export const RETRYABLE_PG_CODES = new Set(["55P03", "40001", "40P01"]);

/** Extract a Postgres SQLSTATE, walking `cause` (drizzle wraps driver errors in DrizzleQueryError). */
export function pgCode(err: unknown, depth = 0): string | undefined {
  if (typeof err !== "object" || err === null || depth > 4) return undefined;
  if ("code" in err) {
    const c = (err as { code: unknown }).code;
    if (typeof c === "string" && /^[0-9A-Z]{5}$/.test(c)) return c;
  }
  return "cause" in err ? pgCode((err as { cause: unknown }).cause, depth + 1) : undefined;
}

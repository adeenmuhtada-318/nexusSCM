/**
 * Minimal structured JSON logger (CLAUDE.md §9: no console.log in committed code).
 * Never pass PII, secrets or full address/payment data into `fields`.
 */
type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(line + "\n");
}

export const logger = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

import "server-only";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Tx } from "./index";
import { idempotencyKeys } from "./schema";
import { DomainError } from "@/lib/utils/errors";

/**
 * Idempotent execution of a double-submittable mutation (CLAUDE.md §4.6).
 *
 * Rule: the first call with (scope, key) runs `fn` and stores its JSON result IN THE SAME TRANSACTION as the
 * business effect; any replay returns that stored result without re-running `fn`.
 * Why correct: the unique index (scope,key) makes concurrent first-callers serialize on the INSERT; the loser
 * blocks until the winner commits, then sees ON CONFLICT DO NOTHING and reads the committed response.
 * Edge cases: same key + different payload → IDEMPOTENT_REPLAY_MISMATCH (never silently returns a stale result);
 * if `fn` throws, the key row rolls back with everything else so the client may retry with the same key.
 */
function canonicalJson(val: unknown): string {
  if (Array.isArray(val)) return `[${val.map(canonicalJson).join(",")}]`;
  if (val !== null && typeof val === "object") {
    const entries = Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(val);
}

export async function withIdempotency<T>(
  tx: Tx,
  scope: string,
  key: string,
  payload: unknown,
  fn: () => Promise<T>,
): Promise<{ replayed: boolean; result: T }> {
  const requestHash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({ scope, key, requestHash })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });

  const row = inserted[0];
  if (!row) {
    const existing = await tx
      .select({ requestHash: idempotencyKeys.requestHash, response: idempotencyKeys.response })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
      .limit(1);
    const prior = existing[0];
    if (!prior) throw new DomainError("CONFLICT", "Idempotency record vanished; retry");
    if (prior.requestHash !== requestHash) {
      throw new DomainError("IDEMPOTENT_REPLAY_MISMATCH", "Idempotency key was already used with a different request");
    }
    return { replayed: true, result: prior.response as T };
  }

  const result = await fn();
  await tx.update(idempotencyKeys).set({ response: result as never }).where(eq(idempotencyKeys.id, row.id));
  return { replayed: false, result };
}

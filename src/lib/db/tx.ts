import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Tx } from "./index";
import { pgCode, RETRYABLE_PG_CODES } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

const MAX_ATTEMPTS = 3;
/** Lock wait bound inside every transaction (CLAUDE.md §4.3). */
export const LOCK_TIMEOUT_MS = 2000;

/**
 * Runs `fn` in ONE ACID transaction with:
 *  - SET LOCAL lock_timeout = 2s (a blocked lock fails with 55P03 instead of hanging),
 *  - bounded retry (max 3 attempts, jittered back-off) on 55P03 / 40001 / 40P01.
 * `fn` must be free of non-DB side effects since it may be re-executed.
 * Errors thrown inside `fn` roll the transaction back and are rethrown (never swallowed).
 */
export async function runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = getDb();
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`));
        return fn(tx);
      });
    } catch (err) {
      const code = pgCode(err);
      if (code && RETRYABLE_PG_CODES.has(code) && attempt < MAX_ATTEMPTS) {
        const delay = 25 * 2 ** attempt + Math.floor(Math.random() * 50);
        logger.warn("retrying transaction", { code, attempt, delay });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { getEnv } from "@/lib/config/env";

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything that can run queries: the pooled db or an open transaction. */
export type DbOrTx = Database | Tx;

type Cache = { client?: ReturnType<typeof postgres>; db?: Database };
const globalCache = globalThis as unknown as { __nexusDb?: Cache };

/**
 * Single global pooled client (CLAUDE.md §4.4). Assumes a TRANSACTION-MODE pooler, therefore:
 *  - prepare:false (no server-side prepared statements across pooled connections)
 *  - no session state (we only use SET LOCAL inside transactions)
 *  - small `max` per serverless instance.
 * Cached on globalThis so Next dev HMR does not leak connections.
 */
export function getDb(): Database {
  const cache = (globalCache.__nexusDb ??= {});
  if (!cache.db) {
    const env = getEnv();
    cache.client = postgres(env.DATABASE_URL, {
      max: env.DB_POOL_MAX,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => undefined,
    });
    cache.db = drizzle(cache.client, { schema });
  }
  return cache.db;
}

/** Close the pool (tests / scripts). */
export async function closeDb(): Promise<void> {
  const cache = globalCache.__nexusDb;
  if (cache?.client) await cache.client.end({ timeout: 5 });
  delete globalCache.__nexusDb;
}

export { schema };

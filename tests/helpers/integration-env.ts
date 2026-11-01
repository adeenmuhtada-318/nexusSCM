import { afterAll, inject } from "vitest";

process.env.DATABASE_URL = inject("dbUrl");
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret-1234";
process.env.CRON_SECRET = "cron-secret-cron-secret-cron-secret-12";
process.env.DB_POOL_MAX = "10";
// NODE_ENV is already "test" under vitest.

afterAll(async () => {
  const { closeDb } = await import("@/lib/db");
  await closeDb();
});

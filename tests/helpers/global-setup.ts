import EmbeddedPostgres from "embedded-postgres";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { migrateAndSeedConfig } from "../../scripts/migrate";

/**
 * Boots a REAL PostgreSQL (embedded-postgres), applies all migrations, seeds config defaults and hands the URL
 * to the integration test workers via `provide`. Real server => real row locks and real parallel connections,
 * which the concurrency test (CLAUDE.md §6) needs. Set TEST_DATABASE_URL to use an existing server instead.
 */
declare module "vitest" {
  export interface ProvidedContext {
    dbUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (process.env.TEST_DATABASE_URL) {
    await migrateAndSeedConfig(process.env.TEST_DATABASE_URL);
    project.provide("dbUrl", process.env.TEST_DATABASE_URL);
    return async () => undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), "nexus-pg-"));
  const port = 55000 + Math.floor(Math.random() * 2000);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("nexus_test");
  const url = `postgres://postgres:postgres@localhost:${port}/nexus_test`;
  await migrateAndSeedConfig(url);
  project.provide("dbUrl", url);
  return async () => {
    const postgres = (await import("postgres")).default;
    const admin = postgres(`postgres://postgres:postgres@localhost:${port}/postgres`, { max: 1, onnotice: () => undefined });
    try {
      await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'nexus_test' AND pid <> pg_backend_pid()`;
    } catch {
      // ignore if already stopped
    } finally {
      await admin.end({ timeout: 2 });
    }
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}

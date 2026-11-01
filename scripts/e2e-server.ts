import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { migrateAndSeedConfig } from "./migrate";

/**
 * Self-contained E2E webServer launcher for Playwright: boots an ephemeral PostgreSQL (unless E2E_DATABASE_URL is set),
 * applies migrations, seeds RBAC users + domain data, and runs the Next.js server on port 3100.
 */
async function main() {
  let pg: EmbeddedPostgres | null = null;
  let dir: string | null = null;
  let dbUrl = process.env.E2E_DATABASE_URL;

  if (!dbUrl) {
    dir = mkdtempSync(join(tmpdir(), "nexus-e2e-pg-"));
    const port = 54339;
    pg = new EmbeddedPostgres({
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
    await pg.createDatabase("nexus_e2e");
    dbUrl = `postgres://postgres:postgres@localhost:${port}/nexus_e2e`;
  }

  process.env.DATABASE_URL = dbUrl;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "e2e-secret-e2e-secret-e2e-secret-123456";
  process.env.CRON_SECRET = process.env.CRON_SECRET ?? "e2e-cron-secret-e2e-cron-secret-123456";
  process.env.AUTH_TRUST_HOST = "true";
  process.env.AUTH_URL = "http://localhost:3100";

  await migrateAndSeedConfig(dbUrl);
  const { seedDatabase } = await import("../src/lib/db/seed");
  const { closeDb } = await import("../src/lib/db");
  await seedDatabase({ bulkBatches: 1_000 });
  await closeDb();

  const nextBin = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const mode = process.env.E2E_USE_BUILD === "1" ? "start" : "dev";
  const child = spawn(process.execPath, [nextBin, mode, "-p", "3100"], {
    stdio: "inherit",
    env: { ...process.env },
  });

  const cleanup = async () => {
    child.kill();
    if (pg) {
      try {
        await pg.stop();
      } catch {
        // ignore
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };

  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());
}

void main();

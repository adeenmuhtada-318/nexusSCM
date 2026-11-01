import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";

/**
 * Local developer database (no Docker / cloud needed): real PostgreSQL via `embedded-postgres`.
 *   pnpm db:local   → starts on postgres://postgres:postgres@localhost:54329/nexus and stays running (Ctrl+C to stop)
 * Then set DATABASE_URL/DIRECT_DATABASE_URL in .env to that URL, run `pnpm db:migrate && pnpm db:seed`.
 */
const dataDir = ".pgdata";
const port = 54329;
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: true,
  onLog: () => undefined,
  onError: (e) => process.stderr.write(String(e) + "\n"),
});

const fresh = !existsSync(`${dataDir}/PG_VERSION`);
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase("nexus");
process.stdout.write(`postgres://postgres:postgres@localhost:${port}/nexus\n`);
process.on("SIGINT", async () => {
  await pg.stop();
  process.exit(0);
});

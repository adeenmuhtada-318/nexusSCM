import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { businessRulesConfig } from "../src/lib/db/schema";
import { RULE_DEFAULTS, RULE_KEYS } from "../src/lib/config/business-rules.defaults";

/**
 * Applies migrations over the DIRECT url (non-pooled; CLAUDE.md §4.4) and seeds missing business-rule defaults.
 * Never edits applied migrations; drizzle tracks them in __drizzle_migrations.
 */
export async function migrateAndSeedConfig(url: string): Promise<void> {
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: "./src/lib/db/migrations" });
    const existing = await db.selectDistinct({ key: businessRulesConfig.key }).from(businessRulesConfig);
    const have = new Set(existing.map((r) => r.key));
    const missing = RULE_KEYS.filter((k) => !have.has(k));
    if (missing.length > 0) {
      await db
        .insert(businessRulesConfig)
        .values(missing.map((key) => ({ key, value: RULE_DEFAULTS[key] as never, effectiveFrom: new Date(0) })));
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

const isMain = process.argv[1]?.endsWith("migrate.ts");
if (isMain) {
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_DATABASE_URL or DATABASE_URL is required");
  migrateAndSeedConfig(url).then(
    () => process.stdout.write("migrations applied\n"),
    (e: unknown) => {
      process.stderr.write(`migration failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}

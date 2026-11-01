import { defineConfig } from "drizzle-kit";

// Migrations use the DIRECT (non-pooled) URL (CLAUDE.md §4.4).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema/index.ts",
  out: "./src/lib/db/migrations",
  dbCredentials: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});

import "server-only";
import { z } from "zod";

/**
 * Zod-validated environment (CLAUDE.md §4.4). Parsed once at first import so a
 * misconfigured deployment fails at startup, not mid-request.
 */
const schema = z.object({
  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(32),
  BUSINESS_TIMEZONE: z.string().default("America/New_York"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(10).default(3),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid environment: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }
    cached = parsed.data;
  }
  return cached;
}

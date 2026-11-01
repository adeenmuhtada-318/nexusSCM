import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { businessRulesConfig } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { runTransaction } from "@/lib/db/tx";
import { buildBusinessRules, RULE_DEFAULTS, RULE_KEYS, RULE_SCHEMAS, type BusinessRules, type RuleKey } from "./business-rules.defaults";
import { DomainError } from "@/lib/utils/errors";

/**
 * Loads the effective configuration: per key, the row with the greatest effective_from <= now.
 * Missing/invalid keys THROW — there are no silent defaults (CLAUDE.md §8). Run `pnpm db:migrate` to seed.
 */
export async function loadBusinessRules(dbOrTx: DbOrTx = getDb(), at: Date = new Date()): Promise<BusinessRules> {
  const rows = await dbOrTx
    .selectDistinctOn([businessRulesConfig.key], { key: businessRulesConfig.key, value: businessRulesConfig.value })
    .from(businessRulesConfig)
    .where(sql`${businessRulesConfig.effectiveFrom} <= ${at.toISOString()}::timestamptz`)
    .orderBy(businessRulesConfig.key, sql`${businessRulesConfig.effectiveFrom} DESC`);
  return buildBusinessRules(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

/** Inserts DEFAULTS for keys that have no row yet. Idempotent. Used by migrate script and test setup. */
export async function seedBusinessRuleDefaults(dbOrTx: DbOrTx = getDb()): Promise<number> {
  const existing = await dbOrTx.selectDistinct({ key: businessRulesConfig.key }).from(businessRulesConfig);
  const have = new Set(existing.map((r) => r.key));
  const missing = RULE_KEYS.filter((k) => !have.has(k));
  if (missing.length === 0) return 0;
  await dbOrTx
    .insert(businessRulesConfig)
    .values(missing.map((key) => ({ key, value: RULE_DEFAULTS[key] as never, effectiveFrom: new Date(0) })));
  return missing.length;
}

/** Writes a new versioned value for `key` and audits it (config changes are audited, CLAUDE.md §5). */
export async function setBusinessRule(args: {
  key: RuleKey;
  value: unknown;
  actorId: string;
  reasonCode: string;
  correlationId: string;
}): Promise<void> {
  const parsed = RULE_SCHEMAS[args.key].safeParse(args.value);
  if (!parsed.success) throw new DomainError("VALIDATION", `Invalid value for ${args.key}`);
  await runTransaction(async (tx) => {
    const before = await loadBusinessRules(tx);
    await tx.insert(businessRulesConfig).values({
      key: args.key,
      value: parsed.data as never,
      effectiveFrom: new Date(),
      changedBy: args.actorId,
    });
    await writeAudit(tx, {
      actor: { type: "USER", id: args.actorId },
      entityType: "business_rules_config",
      entityId: args.key,
      action: "CONFIG_CHANGED",
      before: { snapshot: before },
      after: { key: args.key, value: parsed.data },
      reasonCode: args.reasonCode,
      correlationId: args.correlationId,
    });
  });
}

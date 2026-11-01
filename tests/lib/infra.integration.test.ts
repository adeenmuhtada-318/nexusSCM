import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/lib/db";
import { loadBusinessRules } from "@/lib/config/business-rules";
import { RULE_DEFAULTS } from "@/lib/config/business-rules.defaults";

afterAll(async () => {
  await closeDb();
});

describe("infrastructure", () => {
  it("applies migrations and seeds business-rule defaults", async () => {
    const rules = await loadBusinessRules();
    expect(rules.procurementApprovalThresholdCents).toBe(RULE_DEFAULTS["procurement.approval_threshold_cents"]);
    expect(rules.serviceLevelZ).toBe(1.65);
  });

  it("audit_logs is append-only (UPDATE/DELETE/TRUNCATE rejected)", async () => {
    const db = getDb();
    await db.execute(
      sql`INSERT INTO audit_logs (actor_type, entity_type, entity_id, action, correlation_id) VALUES ('SYSTEM','t','1','A','c')`,
    );
    await expect(db.execute(sql`UPDATE audit_logs SET action = 'B'`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM audit_logs`)).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE audit_logs`)).rejects.toThrow();
  });
});

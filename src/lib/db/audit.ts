import "server-only";
import type { Tx } from "./index";
import { auditLogs } from "./schema";

export type Actor = { type: "USER"; id: string } | { type: "SYSTEM" };

export interface AuditEntry {
  actor: Actor;
  entityType: string;
  entityId: string | number;
  action: string;
  before?: unknown;
  after?: unknown;
  reasonCode?: string;
  correlationId: string;
}

/**
 * Appends one audit row inside the caller's transaction (so the audit trail commits/rolls back with the change).
 * Never put PII, secrets or full address/payment data into before/after — ids, statuses and amounts only.
 */
export async function writeAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    actorId: e.actor.type === "USER" ? e.actor.id : null,
    actorType: e.actor.type,
    entityType: e.entityType,
    entityId: String(e.entityId),
    action: e.action,
    before: (e.before ?? null) as never,
    after: (e.after ?? null) as never,
    reasonCode: e.reasonCode ?? null,
    correlationId: e.correlationId,
  });
}

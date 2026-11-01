import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { exceptions, users } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/db/audit";
import { loadBusinessRules } from "@/lib/config/business-rules";
import { DomainError } from "@/lib/utils/errors";
import { checkExceptionTransition, checkResolve, computeDueAt, type ExceptionSeverity, type ExceptionType, type Role } from "./rules";

export interface RaiseExceptionInput {
  type: ExceptionType;
  entityType: string;
  entityId: string | number;
  severity: ExceptionSeverity;
  reasonCode: string;
  requestedBy?: string | null;
  actor: Actor;
  correlationId: string;
  now?: Date;
}

/**
 * Writes one exception-queue row (CLAUDE.md §4.8) inside the caller's transaction, with an audit row.
 * IDEMPOTENT: the partial unique index (entity_type, entity_id, type) WHERE live makes a repeat raise a no-op that
 * returns the existing id. SLA `due_at` comes from config by severity.
 */
export async function raiseException(tx: Tx, e: RaiseExceptionInput): Promise<{ id: number; created: boolean }> {
  const rules = await loadBusinessRules(tx);
  const now = e.now ?? new Date();
  const entityId = String(e.entityId);
  const inserted = await tx
    .insert(exceptions)
    .values({
      type: e.type,
      entityType: e.entityType,
      entityId,
      severity: e.severity,
      reasonCode: e.reasonCode,
      requestedBy: e.requestedBy ?? null,
      createdAt: now,
      dueAt: computeDueAt(now, e.severity, rules.exceptionSlaHours),
    })
    .onConflictDoNothing()
    .returning({ id: exceptions.id });
  const row = inserted[0];
  if (row) {
    await writeAudit(tx, {
      actor: e.actor,
      entityType: "exception",
      entityId: row.id,
      action: "EXCEPTION_RAISED",
      after: { type: e.type, entityType: e.entityType, entityId, severity: e.severity },
      reasonCode: e.reasonCode,
      correlationId: e.correlationId,
    });
    return { id: row.id, created: true };
  }
  const existing = await tx
    .select({ id: exceptions.id })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.entityType, e.entityType),
        eq(exceptions.entityId, entityId),
        eq(exceptions.type, e.type),
        inArray(exceptions.status, ["OPEN", "IN_REVIEW"]),
      ),
    )
    .limit(1);
  const found = existing[0];
  if (!found) throw new DomainError("CONFLICT", "Exception raced with its own resolution; retry");
  return { id: found.id, created: false };
}

/** Human resolution: locks the row, runs rules.checkResolve, updates, audits. Resolving is itself an audited action. */
export async function resolveException(
  tx: Tx,
  a: { id: number; to: "RESOLVED" | "DISMISSED"; note: string; actorId: string; actorRole: Role; correlationId: string },
): Promise<void> {
  const rows = await tx
    .select({
      id: exceptions.id,
      type: exceptions.type,
      status: exceptions.status,
      requestedBy: exceptions.requestedBy,
      entityType: exceptions.entityType,
      entityId: exceptions.entityId,
    })
    .from(exceptions)
    .where(eq(exceptions.id, a.id))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "Exception not found");
  const check = checkResolve({
    type: row.type,
    from: row.status,
    to: a.to,
    actorRole: a.actorRole,
    actorId: a.actorId,
    requesterId: row.requestedBy,
    note: a.note,
  });
  if (!check.ok) throw new DomainError(check.code, check.message);
  await tx
    .update(exceptions)
    .set({ status: a.to, resolvedBy: a.actorId, resolvedAt: new Date(), resolutionNote: a.note })
    .where(eq(exceptions.id, a.id));
  await writeAudit(tx, {
    actor: { type: "USER", id: a.actorId },
    entityType: "exception",
    entityId: a.id,
    action: a.to === "RESOLVED" ? "EXCEPTION_RESOLVED" : "EXCEPTION_DISMISSED",
    before: { status: row.status },
    after: { status: a.to, subject: `${row.entityType}:${row.entityId}` },
    reasonCode: row.type,
    correlationId: a.correlationId,
  });
}

/**
 * Domain-driven closure: when the subject is handled through its own action (PO approved, order hold released…),
 * every live exception of that entity is closed in the same transaction. Role/SoD were already enforced by the
 * domain action. Idempotent (no live rows → no-op). Returns the number of exceptions closed.
 */
export async function closeExceptionsForEntity(
  tx: Tx,
  a: { entityType: string; entityId: string | number; types?: readonly ExceptionType[]; note: string; actorId: string; correlationId: string },
): Promise<number> {
  const live = await tx
    .select({ id: exceptions.id, type: exceptions.type, status: exceptions.status })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.entityType, a.entityType),
        eq(exceptions.entityId, String(a.entityId)),
        inArray(exceptions.status, ["OPEN", "IN_REVIEW"]),
        a.types && a.types.length > 0 ? inArray(exceptions.type, [...a.types]) : sql`true`,
      ),
    )
    .orderBy(exceptions.id)
    .for("update");
  for (const row of live) {
    const t = checkExceptionTransition(row.status, "RESOLVED");
    if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
    await tx
      .update(exceptions)
      .set({ status: "RESOLVED", resolvedBy: a.actorId, resolvedAt: new Date(), resolutionNote: a.note })
      .where(eq(exceptions.id, row.id));
    await writeAudit(tx, {
      actor: { type: "USER", id: a.actorId },
      entityType: "exception",
      entityId: row.id,
      action: "EXCEPTION_RESOLVED",
      before: { status: row.status },
      after: { status: "RESOLVED", via: "DOMAIN_ACTION" },
      reasonCode: row.type,
      correlationId: a.correlationId,
    });
  }
  return live.length;
}

/** Assigns an exception to an active user and moves it to IN_REVIEW (audited). */
export async function assignException(
  tx: Tx,
  a: { id: number; assigneeId: string; actorId: string; correlationId: string },
): Promise<void> {
  const rows = await tx
    .select({ id: exceptions.id, status: exceptions.status })
    .from(exceptions)
    .where(eq(exceptions.id, a.id))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "Exception not found");
  const t = checkExceptionTransition(row.status, "IN_REVIEW");
  if (!t.ok && row.status !== "IN_REVIEW") throw new DomainError("ILLEGAL_TRANSITION", t.error);
  const assignee = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, a.assigneeId), eq(users.active, true)))
    .limit(1);
  if (!assignee[0]) throw new DomainError("NOT_FOUND", "Assignee not found or inactive");
  await tx.update(exceptions).set({ status: "IN_REVIEW", assignedTo: a.assigneeId }).where(eq(exceptions.id, a.id));
  await writeAudit(tx, {
    actor: { type: "USER", id: a.actorId },
    entityType: "exception",
    entityId: a.id,
    action: "EXCEPTION_ASSIGNED",
    before: { status: row.status },
    after: { status: "IN_REVIEW", assignedTo: a.assigneeId },
    correlationId: a.correlationId,
  });
}

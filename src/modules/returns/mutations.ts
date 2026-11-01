import "server-only";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { refunds, rmaLines, rmas } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/db/audit";
import { withIdempotency } from "@/lib/db/idempotency";
import { loadBusinessRules } from "@/lib/config/business-rules";
import { getEnv } from "@/lib/config/env";
import { DomainError } from "@/lib/utils/errors";
import { closeExceptionsForEntity, raiseException } from "@/modules/exceptions";
import { businessToday, getSkuInfos, receiveStock } from "@/modules/inventory";
import { claimReturnQty, creditAccount, getReturnableLine, unclaimReturnQty, type ReturnableLine } from "@/modules/orders";
import { getRefundedForOrderLine } from "./queries";
import { checkRmaTransition, decideDisposition, evaluateRma, lineRefundCents, type RmaDecision, type RmaStatus } from "./rules";

export interface RequestRmaResult {
  rmaId: number;
  rmaNumber: string;
  status: RmaStatus;
  decision: RmaDecision["decision"];
  reasonCode: string;
  exceptionId: number | null;
}

/**
 * REQUEST an RMA (idempotent). Per line: facts come from orders.getReturnableLine (days-since-delivery computed in SQL
 * in the business timezone) → rules.evaluateRma with the configured window/policy. Aggregate: any AUTO_DENY ⇒ RMA
 * DENIED; else any HUMAN_REVIEW ⇒ PENDING_REVIEW; else APPROVED (D-21). Denials and reviews write an RMA_REVIEW
 * exception (every automatic denial/gate does). Returned quantity is CLAIMED with a conditional UPDATE
 * (`qty_returned + n <= qty`) — the concurrency-safe double-return guard — only for non-denied RMAs.
 */
export async function requestRma(
  tx: Tx,
  a: {
    orderId: number;
    lines: { orderLineId: number; qty: number }[];
    reasonCode: string;
    idempotencyKey: string;
    actor: Extract<Actor, { type: "USER" }>;
    correlationId: string;
    now: Date;
  },
): Promise<{ replayed: boolean; result: RequestRmaResult }> {
  const lines = [...a.lines].sort((x, y) => x.orderLineId - y.orderLineId);
  return withIdempotency(tx, "returns.request", a.idempotencyKey, { orderId: a.orderId, lines, reasonCode: a.reasonCode }, async () => {
    const rules = await loadBusinessRules(tx, a.now);
    const today = businessToday(a.now);
    const tz = getEnv().BUSINESS_TIMEZONE;

    const facts: { req: { orderLineId: number; qty: number }; line: ReturnableLine; decision: RmaDecision }[] = [];
    for (const req of lines) {
      const line = await getReturnableLine(tx, req.orderLineId, today, tz);
      if (!line || line.orderId !== a.orderId) throw new DomainError("NOT_FOUND", `Order line ${req.orderLineId} not found on this order`);
      const decision = evaluateRma({
        delivered: line.deliveredAt !== null,
        daysSinceDelivery: line.daysSinceDelivery,
        windowDays: rules.returnsWindowDays,
        isCustomized: line.isCustomized,
        qtyRequested: req.qty,
        qtyOrdered: line.qty,
        qtyAlreadyReturned: line.qtyReturned,
        ineligiblePolicy: rules.returnsIneligiblePolicy,
      });
      facts.push({ req, line, decision });
    }

    const denied = facts.find((f) => f.decision.decision === "AUTO_DENY");
    const review = facts.find((f) => f.decision.decision === "HUMAN_REVIEW");
    const overall = denied ?? review ?? facts[0];
    if (!overall) throw new DomainError("VALIDATION", "At least one line is required");
    const status: RmaStatus = denied ? "DENIED" : review ? "PENDING_REVIEW" : "APPROVED";
    const reasonCode = denied || review ? overall.decision.reasonCode : "WITHIN_WINDOW";

    if (status !== "DENIED") for (const f of facts) await claimReturnQty(tx, f.req.orderLineId, f.req.qty);

    const inserted = await tx
      .insert(rmas)
      .values({
        rmaNumber: `RMA-${randomUUID().slice(0, 8).toUpperCase()}`,
        orderId: a.orderId,
        status,
        reasonCode,
        requestedBy: a.actor.id,
        requestedAt: a.now,
      })
      .returning({ id: rmas.id, rmaNumber: rmas.rmaNumber });
    const rma = inserted[0];
    if (!rma) throw new DomainError("INTERNAL", "RMA insert failed");
    await tx.insert(rmaLines).values(facts.map((f) => ({ rmaId: rma.id, orderLineId: f.req.orderLineId, qty: f.req.qty })));

    let exceptionId: number | null = null;
    if (status !== "APPROVED") {
      const ex = await raiseException(tx, {
        type: "RMA_REVIEW",
        entityType: "rma",
        entityId: rma.id,
        severity: status === "DENIED" ? "LOW" : "MEDIUM",
        reasonCode,
        requestedBy: a.actor.id,
        actor: a.actor,
        correlationId: a.correlationId,
        now: a.now,
      });
      exceptionId = ex.id;
    }
    await writeAudit(tx, {
      actor: a.actor,
      entityType: "rma",
      entityId: rma.id,
      action: "RMA_REQUESTED",
      after: { status, orderId: a.orderId, lines: lines.length },
      reasonCode,
      correlationId: a.correlationId,
    });
    return { rmaId: rma.id, rmaNumber: rma.rmaNumber, status, decision: denied ? "AUTO_DENY" : review ? "HUMAN_REVIEW" : "AUTO_APPROVE", reasonCode, exceptionId } as RequestRmaResult;
  });
}

async function lockRma(tx: Tx, rmaId: number) {
  const rows = await tx
    .select({ id: rmas.id, status: rmas.status, orderId: rmas.orderId, requestedBy: rmas.requestedBy })
    .from(rmas)
    .where(eq(rmas.id, rmaId))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "RMA not found");
  return row;
}

/** Human review of a PENDING_REVIEW RMA. Reviewer ≠ requester (separation of duties). DENY returns the claimed quantity. */
export async function reviewRma(
  tx: Tx,
  a: { rmaId: number; decision: "APPROVE" | "DENY"; note: string; reviewerId: string; correlationId: string },
): Promise<{ status: RmaStatus }> {
  const rma = await lockRma(tx, a.rmaId);
  if (rma.requestedBy === a.reviewerId) throw new DomainError("SEPARATION_OF_DUTIES", "Reviewer cannot be the requester");
  const to: RmaStatus = a.decision === "APPROVE" ? "APPROVED" : "DENIED";
  const t = checkRmaTransition(rma.status, to);
  if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
  if (to === "DENIED") {
    const lines = await tx.select({ orderLineId: rmaLines.orderLineId, qty: rmaLines.qty }).from(rmaLines).where(eq(rmaLines.rmaId, rma.id));
    for (const l of lines) await unclaimReturnQty(tx, l.orderLineId, l.qty);
  }
  await tx.update(rmas).set({ status: to }).where(eq(rmas.id, rma.id));
  await closeExceptionsForEntity(tx, { entityType: "rma", entityId: rma.id, types: ["RMA_REVIEW"], note: a.note, actorId: a.reviewerId, correlationId: a.correlationId });
  await writeAudit(tx, {
    actor: { type: "USER", id: a.reviewerId },
    entityType: "rma",
    entityId: rma.id,
    action: a.decision === "APPROVE" ? "RMA_APPROVED" : "RMA_DENIED",
    before: { status: rma.status },
    after: { status: to },
    reasonCode: "HUMAN_REVIEW",
    correlationId: a.correlationId,
  });
  return { status: to };
}

/**
 * DOCK RECEIPT + INSPECTION (APPROVED → RECEIVED → INSPECTED, each checked against the transition map). Per line,
 * rules.decideDisposition: unopened AND VERIFIED_NEW → restock to PRIME (+returned qty, RETURN_RESTOCK ledger row);
 * otherwise → QUARANTINE_REFURBISHMENT batch (RETURN_QUARANTINE ledger row) plus a RETURN_GRADING exception for the
 * technician. Quantity = the RMA line's returned quantity (never hard-coded 1). Every line must be inspected.
 */
export async function receiveAndInspectRma(
  tx: Tx,
  a: {
    rmaId: number;
    warehouseId: number;
    lines: { rmaLineId: number; isOpened: boolean; condition: "VERIFIED_NEW" | "OPENED_GOOD" | "DAMAGED"; expiryDate?: string | null | undefined }[];
    actor: Extract<Actor, { type: "USER" }>;
    correlationId: string;
    now: Date;
  },
): Promise<{ restocked: number; quarantined: number; exceptionIds: number[] }> {
  const rma = await lockRma(tx, a.rmaId);
  for (const to of ["RECEIVED", "INSPECTED"] as const) {
    const t = checkRmaTransition(to === "RECEIVED" ? rma.status : "RECEIVED", to);
    if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
  }
  const lines = await tx
    .select({ id: rmaLines.id, orderLineId: rmaLines.orderLineId, qty: rmaLines.qty })
    .from(rmaLines)
    .where(eq(rmaLines.rmaId, rma.id))
    .orderBy(asc(rmaLines.id));
  const byId = new Map(a.lines.map((l) => [l.rmaLineId, l]));
  if (lines.length !== a.lines.length || lines.some((l) => !byId.has(l.id))) {
    throw new DomainError("VALIDATION", "Every RMA line must be inspected exactly once");
  }

  const today = businessToday(a.now);
  const tz = getEnv().BUSINESS_TIMEZONE;
  let restocked = 0;
  let quarantined = 0;
  const exceptionIds: number[] = [];
  for (const l of lines) {
    const insp = byId.get(l.id);
    const facts = await getReturnableLine(tx, l.orderLineId, today, tz);
    if (!insp || !facts) throw new DomainError("NOT_FOUND", "Order line not found");
    const d = decideDisposition({ isOpened: insp.isOpened, condition: insp.condition });
    const restock = d.disposition === "RESTOCK_PRIME";
    const sku = (await getSkuInfos(tx, [facts.skuId]))[0];
    if (!sku) throw new DomainError("NOT_FOUND", "SKU not found");
    if (restock && sku.isPerishable && !insp.expiryDate) throw new DomainError("VALIDATION", `Line ${l.id}: expiry date required to restock a perishable SKU`);
    await receiveStock(tx, {
      skuId: facts.skuId,
      warehouseId: a.warehouseId,
      qty: l.qty,
      zone: restock ? "PRIME" : "QUARANTINE_REFURBISHMENT",
      entryType: restock ? "RETURN_RESTOCK" : "RETURN_QUARANTINE",
      expiryDate: insp.expiryDate ?? null,
      lotCode: `RMA-${rma.id}-${l.id}`,
      reasonCode: restock ? "RETURN_VERIFIED_NEW" : "RETURN_NEEDS_GRADING",
      referenceType: "rma",
      referenceId: String(rma.id),
      actor: a.actor,
      correlationId: a.correlationId,
    });
    await tx
      .update(rmaLines)
      .set({ isOpened: insp.isOpened, condition: insp.condition, disposition: d.disposition })
      .where(eq(rmaLines.id, l.id));
    if (restock) restocked += l.qty;
    else quarantined += l.qty;
    if (d.needsGradingException) {
      const ex = await raiseException(tx, {
        type: "RETURN_GRADING",
        entityType: "rma_line",
        entityId: l.id,
        severity: "MEDIUM",
        reasonCode: insp.condition === "DAMAGED" ? "DAMAGED_ON_RETURN" : "OPENED_ON_RETURN",
        actor: a.actor,
        correlationId: a.correlationId,
        now: a.now,
      });
      exceptionIds.push(ex.id);
    }
  }
  await tx.update(rmas).set({ status: "INSPECTED" }).where(eq(rmas.id, rma.id));
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "rma",
    entityId: rma.id,
    action: "RMA_INSPECTED",
    before: { status: rma.status },
    after: { status: "INSPECTED", restocked, quarantined },
    correlationId: a.correlationId,
  });
  return { restocked, quarantined, exceptionIds };
}

/**
 * REFUND an INSPECTED RMA (idempotent; at most one refund per RMA via unique index). Per line:
 * rules.lineRefundCents = unit price × returned qty, capped by (paid line total − refunds already issued by other RMAs).
 * Credits the account balance (D-15/D-18) and audits in the same transaction. Zero refundable amount → RULE_VIOLATION.
 */
export async function refundRma(
  tx: Tx,
  a: { rmaId: number; idempotencyKey: string; actor: Extract<Actor, { type: "USER" }>; correlationId: string; now: Date },
): Promise<{ replayed: boolean; result: { rmaId: number; amountCents: number } }> {
  return withIdempotency(tx, "returns.refund", a.idempotencyKey, { rmaId: a.rmaId }, async () => {
    const rma = await lockRma(tx, a.rmaId);
    const t = checkRmaTransition(rma.status, "REFUNDED");
    if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
    const lines = await tx.select({ id: rmaLines.id, orderLineId: rmaLines.orderLineId, qty: rmaLines.qty }).from(rmaLines).where(eq(rmaLines.rmaId, rma.id)).orderBy(asc(rmaLines.id));
    const today = businessToday(a.now);
    const tz = getEnv().BUSINESS_TIMEZONE;
    let total = 0;
    let accountId: number | null = null;
    for (const l of lines) {
      const facts = await getReturnableLine(tx, l.orderLineId, today, tz);
      if (!facts) throw new DomainError("NOT_FOUND", "Order line not found");
      accountId = facts.accountId;
      const already = await getRefundedForOrderLine(tx, l.orderLineId, rma.id);
      const cents = lineRefundCents({ unitPriceCents: facts.unitPriceCents, qty: l.qty, lineQty: facts.qty, lineTotalCents: facts.lineTotalCents, alreadyRefundedCents: already });
      await tx.update(rmaLines).set({ refundCents: cents }).where(eq(rmaLines.id, l.id));
      total += cents;
    }
    if (total <= 0 || accountId === null) throw new DomainError("RULE_VIOLATION", "Nothing refundable on this RMA");
    await tx.insert(refunds).values({ rmaId: rma.id, amountCents: total, issuedBy: a.actor.id, issuedAt: a.now });
    await creditAccount(tx, accountId, total);
    await tx.update(rmas).set({ status: "REFUNDED" }).where(eq(rmas.id, rma.id));
    await writeAudit(tx, {
      actor: a.actor,
      entityType: "rma",
      entityId: rma.id,
      action: "RMA_REFUNDED",
      before: { status: rma.status },
      after: { status: "REFUNDED", amountCents: total },
      correlationId: a.correlationId,
    });
    return { rmaId: rma.id, amountCents: total };
  });
}

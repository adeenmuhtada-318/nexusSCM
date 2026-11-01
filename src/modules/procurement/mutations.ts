import "server-only";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db";
import { purchaseOrderLines, purchaseOrders } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/db/audit";
import { withIdempotency } from "@/lib/db/idempotency";
import { runTransaction } from "@/lib/db/tx";
import { loadBusinessRules } from "@/lib/config/business-rules";
import { getEnv } from "@/lib/config/env";
import { DomainError } from "@/lib/utils/errors";
import { mulCents } from "@/lib/utils/money";
import { closeExceptionsForEntity, raiseException } from "@/modules/exceptions";
import { businessToday, getOpenRequisition, listOpenRequisitions, markRequisitionConverted, receiveStock } from "@/modules/inventory";
import { getSameDayOpenCost, getVendorOptions } from "./queries";
import { checkApproval, checkPoTransition, decideApproval, selectVendor, type PoStatus, type Role } from "./rules";

export interface CreatePoResult {
  outcome: "CREATED" | "NO_VENDOR";
  poId: number | null;
  poNumber: string | null;
  status: PoStatus | null;
  requiredRole: "BUYER" | "MANAGER" | null;
  effectiveCostCents: number;
  exceptionId: number | null;
}

/**
 * CREATE PO from an OPEN requisition (idempotent). Pipeline: vendor cascade (SQL order by tier + rules.selectVendor) →
 * total in integer cents → split-PO guard (same vendor/SKU/day open cost added in SQL) → rules.decideApproval:
 *   effective < threshold & tier ≤ 2 → APPROVED_AND_DISPATCHED (auto);  Tier 3 → PENDING_BUYER_APPROVAL;
 *   effective >= threshold → PENDING_MANAGER_APPROVAL (one queue item even for Tier 3).
 * Pending POs raise ONE PO_APPROVAL_REQUIRED exception. No vendor → NO_VENDOR_AVAILABLE exception, requisition stays OPEN.
 * Requester = actor (NULL for system) — used for separation of duties at approval time.
 */
export async function createPoFromRequisition(
  tx: Tx,
  a: { requisitionId: number; idempotencyKey: string; actor: Actor; correlationId: string; now: Date },
): Promise<{ replayed: boolean; result: CreatePoResult }> {
  return withIdempotency(tx, "procurement.createPo", a.idempotencyKey, { requisitionId: a.requisitionId }, async () => {
    const req = await getOpenRequisition(tx, a.requisitionId);
    if (!req) throw new DomainError("NOT_FOUND", "Open requisition not found");
    const requesterId = a.actor.type === "USER" ? a.actor.id : null;

    const sel = selectVendor(await getVendorOptions(tx, req.skuId), req.qty);
    if (!sel.ok) {
      const ex = await raiseException(tx, {
        type: "NO_VENDOR_AVAILABLE",
        entityType: "purchase_requisition",
        entityId: req.id,
        severity: "HIGH",
        reasonCode: "NO_ELIGIBLE_CONTRACT",
        requestedBy: requesterId,
        actor: a.actor,
        correlationId: a.correlationId,
        now: a.now,
      });
      return { outcome: "NO_VENDOR" as const, poId: null, poNumber: null, status: null, requiredRole: null, effectiveCostCents: 0, exceptionId: ex.id };
    }

    const rules = await loadBusinessRules(tx, a.now);
    const totalCents = mulCents(sel.vendor.unitCostCents, req.qty);
    const prior = await getSameDayOpenCost(tx, {
      vendorId: sel.vendor.vendorId,
      skuIds: [req.skuId],
      dayISO: businessToday(a.now),
      tz: getEnv().BUSINESS_TIMEZONE,
    });
    const effective = totalCents + prior;
    const decision = decideApproval({ effectiveCostCents: effective, tier: sel.vendor.hierarchyTier, thresholdCents: rules.procurementApprovalThresholdCents });
    const auto = decision.status === "APPROVED_AND_DISPATCHED";

    const po = await tx
      .insert(purchaseOrders)
      .values({
        poNumber: `PO-${randomUUID().slice(0, 8).toUpperCase()}`,
        vendorId: sel.vendor.vendorId,
        requisitionId: req.id,
        status: decision.status,
        hierarchyTier: sel.vendor.hierarchyTier,
        totalCostCents: totalCents,
        requestedBy: requesterId,
        approvalReasonCode: auto ? decision.reasonCode : null,
        createdAt: a.now,
      })
      .returning({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber });
    const row = po[0];
    if (!row) throw new DomainError("INTERNAL", "PO insert failed");
    await tx.insert(purchaseOrderLines).values({
      purchaseOrderId: row.id,
      skuId: req.skuId,
      qty: req.qty,
      unitCostCents: sel.vendor.unitCostCents,
      lineTotalCents: totalCents,
    });
    await markRequisitionConverted(tx, { requisitionId: req.id, actor: a.actor, correlationId: a.correlationId });

    let exceptionId: number | null = null;
    if (!auto) {
      const ex = await raiseException(tx, {
        type: "PO_APPROVAL_REQUIRED",
        entityType: "purchase_order",
        entityId: row.id,
        severity: decision.requiredRole === "MANAGER" ? "HIGH" : "MEDIUM",
        reasonCode: decision.reasonCode,
        requestedBy: requesterId,
        actor: a.actor,
        correlationId: a.correlationId,
        now: a.now,
      });
      exceptionId = ex.id;
    }
    await writeAudit(tx, {
      actor: a.actor,
      entityType: "purchase_order",
      entityId: row.id,
      action: "PO_CREATED",
      after: { status: decision.status, tier: sel.vendor.hierarchyTier, totalCostCents: totalCents, effectiveCostCents: effective, cascaded: sel.cascaded },
      reasonCode: decision.reasonCode,
      correlationId: a.correlationId,
    });
    return {
      outcome: "CREATED" as const,
      poId: row.id,
      poNumber: row.poNumber,
      status: decision.status,
      requiredRole: decision.requiredRole,
      effectiveCostCents: effective,
      exceptionId,
    };
  });
}

async function lockPo(tx: Tx, poId: number) {
  const rows = await tx
    .select({
      id: purchaseOrders.id,
      status: purchaseOrders.status,
      requestedBy: purchaseOrders.requestedBy,
      totalCostCents: purchaseOrders.totalCostCents,
    })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "Purchase order not found");
  return row;
}

/**
 * APPROVE a pending PO (idempotent on key). rules.checkApproval enforces: role for the queue level, approver ≠ requester
 * (also a DB CHECK), mandatory reason_code. Sets approved_by/approved_at/approval_reason_code, dispatches, closes the
 * PO_APPROVAL_REQUIRED exception and audits — all in one transaction.
 */
export async function approvePo(
  tx: Tx,
  a: { poId: number; approver: { id: string; role: Role }; reasonCode: string; idempotencyKey: string; correlationId: string; now: Date },
): Promise<{ replayed: boolean; result: { poId: number; status: PoStatus } }> {
  return withIdempotency(tx, "procurement.approvePo", a.idempotencyKey, { poId: a.poId, reasonCode: a.reasonCode }, async () => {
    const po = await lockPo(tx, a.poId);
    const check = checkApproval({
      status: po.status,
      requiredRole: null,
      approverRole: a.approver.role,
      approverId: a.approver.id,
      requesterId: po.requestedBy,
      reasonCode: a.reasonCode,
    });
    if (!check.ok) throw new DomainError(check.code, check.message);
    const t = checkPoTransition(po.status, "APPROVED_AND_DISPATCHED");
    if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
    await tx
      .update(purchaseOrders)
      .set({ status: "APPROVED_AND_DISPATCHED", approvedBy: a.approver.id, approvedAt: a.now, approvalReasonCode: a.reasonCode })
      .where(eq(purchaseOrders.id, po.id));
    await closeExceptionsForEntity(tx, {
      entityType: "purchase_order",
      entityId: po.id,
      types: ["PO_APPROVAL_REQUIRED"],
      note: `Approved: ${a.reasonCode}`,
      actorId: a.approver.id,
      correlationId: a.correlationId,
    });
    await writeAudit(tx, {
      actor: { type: "USER", id: a.approver.id },
      entityType: "purchase_order",
      entityId: po.id,
      action: "PO_APPROVED",
      before: { status: po.status },
      after: { status: "APPROVED_AND_DISPATCHED", approvedBy: a.approver.id },
      reasonCode: a.reasonCode,
      correlationId: a.correlationId,
    });
    return { poId: po.id, status: "APPROVED_AND_DISPATCHED" as const };
  });
}

/** REJECT a pending PO. Same role + separation-of-duties checks as approval; the requisition is not reopened (new one will be raised by the job). */
export async function rejectPo(
  tx: Tx,
  a: { poId: number; approver: { id: string; role: Role }; reasonCode: string; correlationId: string },
): Promise<void> {
  const po = await lockPo(tx, a.poId);
  const check = checkApproval({
    status: po.status,
    requiredRole: null,
    approverRole: a.approver.role,
    approverId: a.approver.id,
    requesterId: po.requestedBy,
    reasonCode: a.reasonCode,
  });
  if (!check.ok) throw new DomainError(check.code, check.message);
  const t = checkPoTransition(po.status, "REJECTED");
  if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
  await tx.update(purchaseOrders).set({ status: "REJECTED", approvalReasonCode: a.reasonCode }).where(eq(purchaseOrders.id, po.id));
  await closeExceptionsForEntity(tx, {
    entityType: "purchase_order",
    entityId: po.id,
    types: ["PO_APPROVAL_REQUIRED"],
    note: `Rejected: ${a.reasonCode}`,
    actorId: a.approver.id,
    correlationId: a.correlationId,
  });
  await writeAudit(tx, {
    actor: { type: "USER", id: a.approver.id },
    entityType: "purchase_order",
    entityId: po.id,
    action: "PO_REJECTED",
    before: { status: po.status },
    after: { status: "REJECTED" },
    reasonCode: a.reasonCode,
    correlationId: a.correlationId,
  });
}

/** RECEIVE goods for a dispatched PO into a warehouse: new batch + RECEIPT ledger row per line; PO → RECEIVED. */
export async function receivePo(
  tx: Tx,
  a: { poId: number; warehouseId: number; lotCode: string; expiryDate: string | null; actor: Actor; correlationId: string },
): Promise<{ poId: number; batches: number[] }> {
  const po = await lockPo(tx, a.poId);
  const t = checkPoTransition(po.status, "RECEIVED");
  if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
  const lines = await tx
    .select({ id: purchaseOrderLines.id, skuId: purchaseOrderLines.skuId, qty: purchaseOrderLines.qty })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
    .orderBy(asc(purchaseOrderLines.id));
  const batches: number[] = [];
  for (const l of lines) {
    const { batchId } = await receiveStock(tx, {
      skuId: l.skuId,
      warehouseId: a.warehouseId,
      qty: l.qty,
      zone: "PRIME",
      entryType: "RECEIPT",
      expiryDate: a.expiryDate,
      lotCode: `${a.lotCode}-${l.id}`,
      reasonCode: "PO_RECEIPT",
      referenceType: "purchase_order",
      referenceId: String(po.id),
      actor: a.actor,
      correlationId: a.correlationId,
    });
    await tx.update(purchaseOrderLines).set({ qtyReceived: l.qty }).where(eq(purchaseOrderLines.id, l.id));
    batches.push(batchId);
  }
  await tx.update(purchaseOrders).set({ status: "RECEIVED" }).where(eq(purchaseOrders.id, po.id));
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "purchase_order",
    entityId: po.id,
    action: "PO_RECEIVED",
    before: { status: po.status },
    after: { status: "RECEIVED", batches },
    correlationId: a.correlationId,
  });
  return { poId: po.id, batches };
}

/**
 * SCHEDULED JOB: converts OPEN requisitions into POs automatically (SYSTEM requester) so routine buys run without
 * humans; anything over the threshold / Tier 3 / without a vendor lands in the Exception Queue. Idempotent via the key
 * `auto-req-<id>-<business day>`: a same-day replay returns the stored result (safe under retried cron invocations),
 * while a NO_VENDOR requisition is retried the next day once a contract exists.
 */
export async function convertOpenRequisitions(opts: { now?: Date; limit?: number } = {}): Promise<{ converted: number; noVendor: number }> {
  const now = opts.now ?? new Date();
  const open = await listOpenRequisitions(getDb(), { afterId: 0, limit: opts.limit ?? 50 });
  let converted = 0;
  let noVendor = 0;
  for (const r of open) {
    const out = await runTransaction((tx) =>
      createPoFromRequisition(tx, { requisitionId: r.id, idempotencyKey: `auto-req-${r.id}-${businessToday(now)}`, actor: { type: "SYSTEM" }, correlationId: `auto-po-${now.toISOString()}`, now }),
    );
    if (out.result.outcome === "CREATED") converted++;
    else noVendor++;
  }
  return { converted, noVendor };
}


import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { inventoryBatches, inventoryLedger, purchaseRequisitions, reservations, skus } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/db/audit";
import { DomainError } from "@/lib/utils/errors";
import { businessToday, expiryCutoffs, getSkuInfos } from "./queries";
import { checkReservationTransition, pickingStrategy, planAllocation } from "./rules";

/** Max batches locked per allocation attempt (technical bound, not a business threshold). */
const CANDIDATE_BATCH_LIMIT = 200;

export interface ReserveStockArgs {
  skuId: number;
  warehouseId: number;
  qty: number;
  /** Opaque owner, e.g. ("fulfillment_line", "42"). Inventory never reads the owner's tables. */
  ownerType: string;
  ownerId: string;
  expiresAt: Date | null;
  minShelfLifePct: number;
  now: Date;
  actor: Actor;
  correlationId: string;
}
export interface ReservationResult {
  reservationId: number;
  batchId: number;
  qty: number;
}

/**
 * RESERVE stock for one SKU in one warehouse — PESSIMISTIC multi-batch allocation (CLAUDE.md §4.3).
 * Rule: candidate batches are PRIME-only (QUARANTINE_* never), qty_available > 0, and for perishables not expired and
 * with ≥ min shelf life left; ordered FEFO (expiry, received_at, id) for perishables, FIFO (received_at, id) otherwise.
 * Locking: `SELECT … ORDER BY <fefo|fifo> … FOR UPDATE` locks candidates in deterministic order; READ COMMITTED
 * re-evaluates `qty_available > 0` after a lock wait, so N concurrent reservers can never over-allocate. Each batch
 * is then decremented with a conditional UPDATE (`WHERE qty_available >= n`) whose row count is verified (defence in
 * depth). Callers reserving several SKUs must call this in ASCENDING skuId order to avoid deadlocks.
 * All-or-nothing: insufficient stock throws INSUFFICIENT_STOCK and the surrounding transaction rolls back.
 * Writes: ledger RESERVE rows (Δavailable −n, Δreserved +n) and reservations rows with expires_at.
 */
export async function reserveStock(tx: Tx, a: ReserveStockArgs): Promise<ReservationResult[]> {
  if (!Number.isInteger(a.qty) || a.qty <= 0) throw new DomainError("VALIDATION", "qty must be a positive integer");
  const infos = await getSkuInfos(tx, [a.skuId]);
  const info = infos[0];
  if (!info) throw new DomainError("NOT_FOUND", `SKU ${a.skuId} not found`);
  if (!info.active) throw new DomainError("RULE_VIOLATION", `SKU ${info.code} is inactive`);

  const cutoff = expiryCutoffs([info], businessToday(a.now), a.minShelfLifePct).get(a.skuId) ?? null;
  const fefo = pickingStrategy(info.isPerishable) === "FEFO";

  const candidates = await tx
    .select({ id: inventoryBatches.id, qtyAvailable: inventoryBatches.qtyAvailable })
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.skuId, a.skuId),
        eq(inventoryBatches.warehouseId, a.warehouseId),
        eq(inventoryBatches.zoneStatus, "PRIME"),
        sql`${inventoryBatches.qtyAvailable} > 0`,
        cutoff ? sql`${inventoryBatches.expiryDate} >= ${cutoff}::date` : sql`true`,
      ),
    )
    .orderBy(
      ...(fefo
        ? [asc(inventoryBatches.expiryDate), asc(inventoryBatches.receivedAt), asc(inventoryBatches.id)]
        : [asc(inventoryBatches.receivedAt), asc(inventoryBatches.id)]),
    )
    .limit(CANDIDATE_BATCH_LIMIT)
    .for("update");

  const plan = planAllocation(candidates, a.qty);
  if (plan.shortfall > 0) {
    throw new DomainError("INSUFFICIENT_STOCK", `Only ${a.qty - plan.shortfall} of ${a.qty} units of ${info.code} available`);
  }

  const results: ReservationResult[] = [];
  for (const alloc of plan.allocations) {
    const updated = await tx
      .update(inventoryBatches)
      .set({
        qtyAvailable: sql`${inventoryBatches.qtyAvailable} - ${alloc.qty}`,
        qtyReserved: sql`${inventoryBatches.qtyReserved} + ${alloc.qty}`,
      })
      .where(and(eq(inventoryBatches.id, alloc.batchId), sql`${inventoryBatches.qtyAvailable} >= ${alloc.qty}`))
      .returning({ id: inventoryBatches.id });
    if (updated.length !== 1) throw new DomainError("CONFLICT", "Stock changed concurrently; retry");

    const res = await tx
      .insert(reservations)
      .values({
        batchId: alloc.batchId,
        skuId: a.skuId,
        qty: alloc.qty,
        ownerType: a.ownerType,
        ownerId: a.ownerId,
        expiresAt: a.expiresAt,
      })
      .returning({ id: reservations.id });
    const reservationId = res[0]?.id;
    if (reservationId === undefined) throw new DomainError("INTERNAL", "Reservation insert returned no row");

    await tx.insert(inventoryLedger).values({
      batchId: alloc.batchId,
      skuId: a.skuId,
      warehouseId: a.warehouseId,
      entryType: "RESERVE",
      deltaAvailable: -alloc.qty,
      deltaReserved: alloc.qty,
      referenceType: a.ownerType,
      referenceId: a.ownerId,
      reasonCode: "ORDER_RESERVATION",
      actorId: a.actor.type === "USER" ? a.actor.id : null,
      correlationId: a.correlationId,
    });
    results.push({ reservationId, batchId: alloc.batchId, qty: alloc.qty });
  }
  return results;
}

/**
 * RELEASE all ACTIVE reservations of an owner back to available (cancel / expiry / failed order).
 * Locks reservation rows in (batch_id, id) order, then moves qty reserved → available with a guarded UPDATE and writes
 * a RELEASE ledger row per reservation (release is a ledger entry, CLAUDE.md §5.1). Idempotent: no ACTIVE rows → 0.
 */
export async function releaseReservations(
  tx: Tx,
  a: { ownerType: string; ownerIds: readonly string[]; reasonCode: string; actor: Actor; correlationId: string },
): Promise<number> {
  return settleReservations(tx, a, "RELEASED");
}

/** FULFIL (ship) reservations: reserved stock leaves the building. Ledger SHIP rows (Δreserved −n). Idempotent. */
export async function fulfillReservations(
  tx: Tx,
  a: { ownerType: string; ownerIds: readonly string[]; reasonCode: string; actor: Actor; correlationId: string },
): Promise<number> {
  return settleReservations(tx, a, "FULFILLED");
}

async function settleReservations(
  tx: Tx,
  a: { ownerType: string; ownerIds: readonly string[]; reasonCode: string; actor: Actor; correlationId: string },
  to: "RELEASED" | "FULFILLED",
): Promise<number> {
  if (a.ownerIds.length === 0) return 0;
  const active = await tx
    .select({
      id: reservations.id,
      batchId: reservations.batchId,
      skuId: reservations.skuId,
      qty: reservations.qty,
      status: reservations.status,
      ownerId: reservations.ownerId,
    })
    .from(reservations)
    .where(and(eq(reservations.ownerType, a.ownerType), inArray(reservations.ownerId, [...a.ownerIds]), eq(reservations.status, "ACTIVE")))
    .orderBy(asc(reservations.batchId), asc(reservations.id))
    .for("update");

  for (const r of active) {
    const t = checkReservationTransition(r.status, to);
    if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
    const batchSet =
      to === "RELEASED"
        ? { qtyAvailable: sql`${inventoryBatches.qtyAvailable} + ${r.qty}`, qtyReserved: sql`${inventoryBatches.qtyReserved} - ${r.qty}` }
        : { qtyReserved: sql`${inventoryBatches.qtyReserved} - ${r.qty}` };
    const updated = await tx
      .update(inventoryBatches)
      .set(batchSet)
      .where(and(eq(inventoryBatches.id, r.batchId), sql`${inventoryBatches.qtyReserved} >= ${r.qty}`))
      .returning({ warehouseId: inventoryBatches.warehouseId });
    const wh = updated[0]?.warehouseId;
    if (wh === undefined) throw new DomainError("CONFLICT", "Reserved quantity out of sync with reservation; run reconciliation");
    await tx.update(reservations).set({ status: to }).where(eq(reservations.id, r.id));
    await tx.insert(inventoryLedger).values({
      batchId: r.batchId,
      skuId: r.skuId,
      warehouseId: wh,
      entryType: to === "RELEASED" ? "RELEASE" : "SHIP",
      deltaAvailable: to === "RELEASED" ? r.qty : 0,
      deltaReserved: -r.qty,
      referenceType: a.ownerType,
      referenceId: r.ownerId,
      reasonCode: a.reasonCode,
      actorId: a.actor.type === "USER" ? a.actor.id : null,
      correlationId: a.correlationId,
    });
  }
  return active.length;
}

/**
 * Release every ACTIVE reservation whose `expires_at` passed (used by the cron-driven expiry job and, for orders,
 * by orders.expireReservations which owns the owner→order mapping). Returns owners affected.
 */
export async function findExpiredReservationOwners(tx: Tx, ownerType: string, now: Date, limit: number): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ ownerId: reservations.ownerId })
    .from(reservations)
    .where(and(eq(reservations.ownerType, ownerType), eq(reservations.status, "ACTIVE"), sql`${reservations.expiresAt} <= ${now.toISOString()}::timestamptz`))
    .limit(limit);
  return rows.map((r) => r.ownerId);
}

/** Clears expires_at on ACTIVE reservations of the given owners (order confirmation stops the TTL). */
export async function clearReservationExpiry(tx: Tx, ownerType: string, ownerIds: readonly string[]): Promise<void> {
  if (ownerIds.length === 0) return;
  await tx
    .update(reservations)
    .set({ expiresAt: null })
    .where(and(eq(reservations.ownerType, ownerType), inArray(reservations.ownerId, [...ownerIds]), eq(reservations.status, "ACTIVE")));
}

export interface ReceiveStockArgs {
  skuId: number;
  warehouseId: number;
  qty: number;
  zone: "PRIME" | "QUARANTINE_REFURBISHMENT" | "QUARANTINE_QUALITY";
  entryType: "RECEIPT" | "RETURN_RESTOCK" | "RETURN_QUARANTINE";
  expiryDate: string | null;
  lotCode: string;
  reasonCode: string;
  referenceType?: string;
  referenceId?: string;
  receivedAt?: Date;
  actor: Actor;
  correlationId: string;
}

/**
 * RECEIVE stock into a NEW batch (one batch = one zone, D-17) and write the matching RECEIPT-type ledger row, so
 * qty_available always equals the ledger-derived value. Perishables must carry an expiry_date.
 */
export async function receiveStock(tx: Tx, a: ReceiveStockArgs): Promise<{ batchId: number }> {
  if (!Number.isInteger(a.qty) || a.qty <= 0) throw new DomainError("VALIDATION", "qty must be a positive integer");
  const sku = await tx.select({ isPerishable: skus.isPerishable, active: skus.active }).from(skus).where(eq(skus.id, a.skuId)).limit(1);
  const s = sku[0];
  if (!s) throw new DomainError("NOT_FOUND", `SKU ${a.skuId} not found`);
  if (s.isPerishable && !a.expiryDate) throw new DomainError("VALIDATION", "Perishable stock requires an expiry date");

  const batch = await tx
    .insert(inventoryBatches)
    .values({
      skuId: a.skuId,
      warehouseId: a.warehouseId,
      zoneStatus: a.zone,
      qtyAvailable: a.qty,
      qtyReserved: 0,
      expiryDate: a.expiryDate,
      lotCode: a.lotCode,
      receivedAt: a.receivedAt ?? new Date(),
    })
    .returning({ id: inventoryBatches.id });
  const batchId = batch[0]?.id;
  if (batchId === undefined) throw new DomainError("INTERNAL", "Batch insert returned no row");
  await tx.insert(inventoryLedger).values({
    batchId,
    skuId: a.skuId,
    warehouseId: a.warehouseId,
    entryType: a.entryType,
    deltaAvailable: a.qty,
    deltaReserved: 0,
    referenceType: a.referenceType ?? null,
    referenceId: a.referenceId ?? null,
    reasonCode: a.reasonCode,
    actorId: a.actor.type === "USER" ? a.actor.id : null,
    correlationId: a.correlationId,
  });
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "inventory_batch",
    entityId: batchId,
    action: a.entryType,
    after: { skuId: a.skuId, warehouseId: a.warehouseId, qty: a.qty, zone: a.zone },
    reasonCode: a.reasonCode,
    correlationId: a.correlationId,
  });
  return { batchId };
}

/**
 * Manual stock adjustment (cycle-count correction): conditional atomic update guarded so qty_available can never go
 * negative, plus a compensating ADJUSTMENT ledger row and audit row. Corrections are new rows, never edits.
 */
export async function adjustBatch(
  tx: Tx,
  a: { batchId: number; delta: number; reasonCode: string; actor: Actor; correlationId: string },
): Promise<void> {
  if (!Number.isInteger(a.delta) || a.delta === 0) throw new DomainError("VALIDATION", "delta must be a non-zero integer");
  const updated = await tx
    .update(inventoryBatches)
    .set({ qtyAvailable: sql`${inventoryBatches.qtyAvailable} + ${a.delta}` })
    .where(and(eq(inventoryBatches.id, a.batchId), sql`${inventoryBatches.qtyAvailable} + ${a.delta} >= 0`))
    .returning({ skuId: inventoryBatches.skuId, warehouseId: inventoryBatches.warehouseId });
  const row = updated[0];
  if (!row) throw new DomainError("CONFLICT", "Batch not found or adjustment would make stock negative");
  await tx.insert(inventoryLedger).values({
    batchId: a.batchId,
    skuId: row.skuId,
    warehouseId: row.warehouseId,
    entryType: "ADJUSTMENT",
    deltaAvailable: a.delta,
    deltaReserved: 0,
    reasonCode: a.reasonCode,
    actorId: a.actor.type === "USER" ? a.actor.id : null,
    correlationId: a.correlationId,
  });
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "inventory_batch",
    entityId: a.batchId,
    action: "ADJUSTMENT",
    after: { delta: a.delta },
    reasonCode: a.reasonCode,
    correlationId: a.correlationId,
  });
}

/**
 * Idempotent requisition insert: the partial unique index (sku_id) WHERE status='OPEN' turns a duplicate into a
 * no-op (ON CONFLICT DO NOTHING). Returns the new id, or null when an OPEN requisition already existed.
 */
export async function createRequisition(
  tx: Tx,
  a: { skuId: number; qty: number; rop: number; actor: Actor; correlationId: string },
): Promise<number | null> {
  const rows = await tx.execute<{ id: number }>(sql`
    INSERT INTO purchase_requisitions (sku_id, qty, status, rop_at_creation)
    VALUES (${a.skuId}::int, ${a.qty}::int, 'OPEN', ${a.rop.toFixed(2)}::numeric)
    ON CONFLICT (sku_id) WHERE status = 'OPEN' DO NOTHING
    RETURNING id`);
  const id = rows[0]?.id;
  if (id === undefined) return null;
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "purchase_requisition",
    entityId: id,
    action: "REQUISITION_CREATED",
    after: { skuId: a.skuId, qty: a.qty, rop: Number(a.rop.toFixed(2)) },
    reasonCode: "AT_OR_BELOW_ROP",
    correlationId: a.correlationId,
  });
  return id;
}

/** OPEN → CONVERTED (when a PO is created from it). Illegal transitions throw. */
export async function markRequisitionConverted(tx: Tx, a: { requisitionId: number; actor: Actor; correlationId: string }): Promise<void> {
  const updated = await tx
    .update(purchaseRequisitions)
    .set({ status: "CONVERTED" })
    .where(and(eq(purchaseRequisitions.id, a.requisitionId), eq(purchaseRequisitions.status, "OPEN")))
    .returning({ id: purchaseRequisitions.id });
  if (updated.length !== 1) throw new DomainError("ILLEGAL_TRANSITION", "Requisition is not OPEN");
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "purchase_requisition",
    entityId: a.requisitionId,
    action: "REQUISITION_CONVERTED",
    before: { status: "OPEN" },
    after: { status: "CONVERTED" },
    correlationId: a.correlationId,
  });
}

export async function getOpenRequisition(tx: Tx, requisitionId: number): Promise<{ id: number; skuId: number; qty: number } | null> {
  const rows = await tx
    .select({ id: purchaseRequisitions.id, skuId: purchaseRequisitions.skuId, qty: purchaseRequisitions.qty })
    .from(purchaseRequisitions)
    .where(and(eq(purchaseRequisitions.id, requisitionId), eq(purchaseRequisitions.status, "OPEN")))
    .for("update")
    .limit(1);
  return rows[0] ?? null;
}

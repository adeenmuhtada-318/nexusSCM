import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db";
import { fulfillmentOrders, orderLines, orders } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/db/audit";
import { withIdempotency } from "@/lib/db/idempotency";
import { runTransaction } from "@/lib/db/tx";
import { DomainError } from "@/lib/utils/errors";
import { closeExceptionsForEntity } from "@/modules/exceptions";
import { clearReservationExpiry, releaseReservations } from "@/modules/inventory";
import { evaluateOrder, finalizeOrder, insertOrderRows, releaseCredit, type OrderRequestLine } from "./placement";
import { getFulfillmentLineIds } from "./queries";
import { checkOrderTransition, consumesCredit, type OrderStatus } from "./rules";

export interface CreateOrderArgs {
  customerId: number;
  addressId: number;
  lines: { skuId: number; qty: number; isCustomized: boolean }[];
  priority: "STANDARD" | "URGENT";
  deliveryWindowDays: number;
  idempotencyKey: string;
  actor: Extract<Actor, { type: "USER" }>;
  correlationId: string;
  now: Date;
}

export interface PlaceOrderResult {
  orderId: number;
  orderNumber: string;
  status: OrderStatus;
  reasonCodes: string[];
  totalCents: number;
  exceptionIds: number[];
}

/**
 * CREATE ORDER (idempotent; CLAUDE.md §4.6). One transaction does: idempotency claim → Seven Rights + fulfillment plan
 * (pure rules over SQL-sourced data; prices recomputed server-side, never client-supplied) → order rows → atomic credit
 * claim → stock reservation (ONLY after all checks pass) → exceptions → audit. A replay with the same key returns the
 * original result; the same key with a different payload is rejected.
 */
export async function createOrder(tx: Tx, a: CreateOrderArgs): Promise<{ replayed: boolean; result: PlaceOrderResult }> {
  const lines = [...a.lines].sort((x, y) => x.skuId - y.skuId);
  const payload = { customerId: a.customerId, addressId: a.addressId, lines, priority: a.priority, window: a.deliveryWindowDays };
  return withIdempotency(tx, "orders.create", a.idempotencyKey, payload, async () => {
    const reqLines: OrderRequestLine[] = lines.map((l) => ({ skuId: l.skuId, qty: l.qty }));
    const evaluated = await evaluateOrder(tx, { customerId: a.customerId, addressId: a.addressId, lines: reqLines, now: a.now });
    const { evaluation, prices } = evaluated;
    const { orderId, lineIdBySku } = await insertOrderRows(tx, {
      orderNumber: `SO-${randomUUID().slice(0, 8).toUpperCase()}`,
      customerId: a.customerId,
      accountId: evaluation.accountId,
      addressId: a.addressId,
      totalCents: evaluation.totalCents,
      priority: a.priority,
      deliveryWindowDays: a.deliveryWindowDays,
      createdBy: a.actor.id,
      lines: lines.map((l) => ({ skuId: l.skuId, qty: l.qty, unitPriceCents: prices.get(l.skuId) ?? 0, isCustomized: l.isCustomized })),
    });
    const fin = await finalizeOrder(tx, {
      orderId,
      from: "BACKORDERED",
      evaluated,
      lineIdBySku,
      now: a.now,
      actor: a.actor,
      requestedBy: a.actor.id,
      correlationId: a.correlationId,
    });
    const head = await tx.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, orderId)).limit(1);
    return {
      orderId,
      orderNumber: head[0]?.orderNumber ?? "",
      status: fin.status,
      reasonCodes: fin.reasonCodes,
      totalCents: evaluation.totalCents,
      exceptionIds: fin.exceptionIds,
    };
  });
}

async function lockOrder(tx: Tx, orderId: number) {
  const rows = await tx
    .select({
      id: orders.id,
      status: orders.status,
      accountId: orders.accountId,
      customerId: orders.customerId,
      addressId: orders.addressId,
      totalCents: orders.totalCents,
      createdBy: orders.createdBy,
      reservationExpiresAt: orders.reservationExpiresAt,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "Order not found");
  return row;
}

/**
 * RE-EVALUATE a held or backordered order (after the exception was fixed or stock arrived): re-runs the Seven Rights on
 * the persisted lines at CURRENT prices/availability. ON_HOLD/BACKORDERED → RESERVED when everything passes; otherwise it
 * stays held/backordered (exceptions are idempotent). Only those two statuses are eligible.
 */
export async function reevaluateOrder(
  tx: Tx,
  a: { orderId: number; actor: Extract<Actor, { type: "USER" }>; correlationId: string; now: Date },
): Promise<PlaceOrderResult> {
  const order = await lockOrder(tx, a.orderId);
  if (order.status !== "ON_HOLD_EXCEPTION" && order.status !== "BACKORDERED") {
    throw new DomainError("ILLEGAL_TRANSITION", `Order is ${order.status}; only held or backordered orders can be re-evaluated`);
  }
  const rows = await tx
    .select({ id: orderLines.id, skuId: orderLines.skuId, qty: orderLines.qty })
    .from(orderLines)
    .where(eq(orderLines.orderId, a.orderId))
    .orderBy(asc(orderLines.skuId));
  const evaluated = await evaluateOrder(tx, {
    customerId: order.customerId,
    addressId: order.addressId,
    lines: rows.map((r) => ({ skuId: r.skuId, qty: r.qty })),
    now: a.now,
  });
  const fin = await finalizeOrder(tx, {
    orderId: a.orderId,
    from: order.status,
    evaluated,
    lineIdBySku: new Map(rows.map((r) => [r.skuId, r.id])),
    now: a.now,
    actor: a.actor,
    requestedBy: order.createdBy,
    correlationId: a.correlationId,
  });
  return { orderId: a.orderId, orderNumber: "", status: fin.status, reasonCodes: fin.reasonCodes, totalCents: order.totalCents, exceptionIds: fin.exceptionIds };
}

/** RESERVED → CONFIRMED (payment/confirmation received): stops the reservation TTL. An expired reservation cannot be confirmed. */
export async function confirmOrder(tx: Tx, a: { orderId: number; actor: Actor; correlationId: string; now: Date }): Promise<void> {
  const order = await lockOrder(tx, a.orderId);
  const t = checkOrderTransition(order.status, "CONFIRMED");
  if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
  if (order.reservationExpiresAt && order.reservationExpiresAt <= a.now) {
    throw new DomainError("CONFLICT", "The reservation has expired; re-order or re-evaluate");
  }
  const ownerIds = (await getFulfillmentLineIds(tx, a.orderId)).map(String);
  await clearReservationExpiry(tx, "fulfillment_line", ownerIds);
  await tx.update(orders).set({ status: "CONFIRMED", reservationExpiresAt: null }).where(eq(orders.id, a.orderId));
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "order",
    entityId: a.orderId,
    action: "ORDER_CONFIRMED",
    before: { status: order.status },
    after: { status: "CONFIRMED" },
    correlationId: a.correlationId,
  });
}

/**
 * Shared teardown for cancel and expiry — in ONE transaction: reservations released (ledger RELEASE rows), child
 * fulfillments cancelled, credit exposure returned, live exceptions closed, status moved via the transition map.
 */
async function tearDownOrder(
  tx: Tx,
  a: { order: Awaited<ReturnType<typeof lockOrder>>; to: "CANCELLED" | "EXPIRED"; reasonCode: string; actor: Actor; correlationId: string },
): Promise<void> {
  const t = checkOrderTransition(a.order.status, a.to);
  if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
  const ownerIds = (await getFulfillmentLineIds(tx, a.order.id)).map(String);
  await releaseReservations(tx, { ownerType: "fulfillment_line", ownerIds, reasonCode: a.reasonCode, actor: a.actor, correlationId: a.correlationId });
  await tx
    .update(fulfillmentOrders)
    .set({ status: "CANCELLED" })
    .where(and(eq(fulfillmentOrders.orderId, a.order.id), eq(fulfillmentOrders.status, "RESERVED")));
  if (consumesCredit(a.order.status)) await releaseCredit(tx, a.order.accountId, a.order.totalCents);
  await tx.update(orders).set({ status: a.to, reservationExpiresAt: null }).where(eq(orders.id, a.order.id));
  if (a.actor.type === "USER") {
    await closeExceptionsForEntity(tx, {
      entityType: "order",
      entityId: a.order.id,
      note: `Order ${a.to.toLowerCase()}`,
      actorId: a.actor.id,
      correlationId: a.correlationId,
    });
  }
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "order",
    entityId: a.order.id,
    action: a.to === "CANCELLED" ? "ORDER_CANCELLED" : "ORDER_EXPIRED",
    before: { status: a.order.status },
    after: { status: a.to },
    reasonCode: a.reasonCode,
    correlationId: a.correlationId,
  });
}

/** Cancel an order (allowed from held/backordered/reserved/confirmed). Releases its reservations in the same transaction. */
export async function cancelOrder(tx: Tx, a: { orderId: number; reasonCode: string; actor: Actor; correlationId: string }): Promise<void> {
  const order = await lockOrder(tx, a.orderId);
  await tearDownOrder(tx, { order, to: "CANCELLED", reasonCode: a.reasonCode, actor: a.actor, correlationId: a.correlationId });
}

/**
 * EXPIRY JOB (scheduled; CLAUDE.md §4.3): RESERVED orders whose TTL elapsed are EXPIRED and their stock released.
 * IDEMPOTENT: each order is handled in its own transaction under a row lock and re-checked (status + deadline), so a
 * duplicate or overlapping cron run finds nothing left to do. Returns how many orders were expired.
 */
export async function expireReservations(opts: { now?: Date; limit?: number } = {}): Promise<{ expired: number }> {
  const now = opts.now ?? new Date();
  const due = await getDb()
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "RESERVED"), sql`${orders.reservationExpiresAt} <= ${now.toISOString()}::timestamptz`))
    .orderBy(asc(orders.id))
    .limit(opts.limit ?? 100);
  let expired = 0;
  for (const { id } of due) {
    const did = await runTransaction(async (tx) => {
      const order = await lockOrder(tx, id);
      if (order.status !== "RESERVED" || !order.reservationExpiresAt || order.reservationExpiresAt > now) return false;
      await tearDownOrder(tx, { order, to: "EXPIRED", reasonCode: "RESERVATION_TTL_ELAPSED", actor: { type: "SYSTEM" }, correlationId: `expire-${now.toISOString()}` });
      return true;
    });
    if (did) expired++;
  }
  return { expired };
}

// ───────── helpers exposed (via index.ts) to the returns module ─────────

/**
 * Claims `qty` units of an order line for a return with a conditional update (`qty_returned + n <= qty`), which is the
 * concurrency-safe anti-double-return constraint (CLAUDE.md §5.5). Throws CONFLICT if the line cannot cover it.
 */
export async function claimReturnQty(tx: Tx, orderLineId: number, qty: number): Promise<void> {
  const rows = await tx
    .update(orderLines)
    .set({ qtyReturned: sql`${orderLines.qtyReturned} + ${qty}` })
    .where(and(eq(orderLines.id, orderLineId), sql`${orderLines.qtyReturned} + ${qty} <= ${orderLines.qty}`))
    .returning({ id: orderLines.id });
  if (rows.length !== 1) throw new DomainError("CONFLICT", "Line has already been (fully) returned");
}

/** Gives returned quantity back when an RMA is denied after review. */
export async function unclaimReturnQty(tx: Tx, orderLineId: number, qty: number): Promise<void> {
  await tx
    .update(orderLines)
    .set({ qtyReturned: sql`GREATEST(${orderLines.qtyReturned} - ${qty}, 0)` })
    .where(inArray(orderLines.id, [orderLineId]));
}

/** Credits an account (refund): reduces balance, floored at 0. */
export const creditAccount = releaseCredit;

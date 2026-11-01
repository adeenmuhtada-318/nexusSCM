import "server-only";
import { asc, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { fulfillmentLines, fulfillmentOrders, orderLines, orders } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/db/audit";
import { DomainError } from "@/lib/utils/errors";
import { fulfillReservations, getSkuInfos } from "@/modules/inventory";
import { bookShipment, markShipmentDelivered, type BookShipmentResult } from "@/modules/logistics";
import { checkFulfillmentTransition, checkOrderTransition, deriveOrderStatus } from "./rules";

/** Re-derives the parent order status from its children (CLAUDE.md §5.2) and persists it through the transition map. */
async function syncOrderStatus(tx: Tx, orderId: number, actor: Actor, correlationId: string): Promise<void> {
  const head = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).limit(1);
  const current = head[0]?.status;
  if (!current) throw new DomainError("NOT_FOUND", "Order not found");
  const kids = await tx.select({ status: fulfillmentOrders.status }).from(fulfillmentOrders).where(eq(fulfillmentOrders.orderId, orderId));
  const next = deriveOrderStatus(kids.map((k) => k.status), current);
  if (next === current) return;
  const t = checkOrderTransition(current, next);
  if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
  await tx.update(orders).set({ status: next }).where(eq(orders.id, orderId));
  await writeAudit(tx, {
    actor,
    entityType: "order",
    entityId: orderId,
    action: "ORDER_STATUS_DERIVED",
    before: { status: current },
    after: { status: next },
    correlationId,
  });
}

export type ShipResult = ({ shipped: true } & Extract<BookShipmentResult, { booked: true }>) | { shipped: false; exceptionId: number; reason: string };

/**
 * SHIP one child fulfillment. Requires the parent order CONFIRMED (or PARTIALLY_SHIPPED). Steps in one transaction:
 * lock fulfillment + order → transition check → parcel facts (weight/hazmat/longest side from SKU master data) →
 * logistics.bookShipment (SQL compliance filter + rules). If NO carrier is eligible a NO_ELIGIBLE_CARRIER exception is
 * written and nothing ships (never a silent default). On success reserved stock leaves (ledger SHIP rows) and the
 * parent order status is re-derived.
 */
export async function shipFulfillment(
  tx: Tx,
  a: { fulfillmentId: number; actor: Actor; correlationId: string; now: Date; requestedBy: string | null },
): Promise<ShipResult> {
  const fo = await tx
    .select({ id: fulfillmentOrders.id, orderId: fulfillmentOrders.orderId, status: fulfillmentOrders.status })
    .from(fulfillmentOrders)
    .where(eq(fulfillmentOrders.id, a.fulfillmentId))
    .for("update")
    .limit(1);
  const f = fo[0];
  if (!f) throw new DomainError("NOT_FOUND", "Fulfillment not found");
  const ord = await tx
    .select({ status: orders.status, priority: orders.priority, window: orders.deliveryWindowDays })
    .from(orders)
    .where(eq(orders.id, f.orderId))
    .for("update")
    .limit(1);
  const o = ord[0];
  if (!o) throw new DomainError("NOT_FOUND", "Order not found");
  if (o.status !== "CONFIRMED" && o.status !== "PARTIALLY_SHIPPED") {
    throw new DomainError("ILLEGAL_TRANSITION", `Order is ${o.status}; only confirmed orders can ship`);
  }
  const t = checkFulfillmentTransition(f.status, "SHIPPED");
  if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);

  const lines = await tx
    .select({ flId: fulfillmentLines.id, qty: fulfillmentLines.qty, skuId: orderLines.skuId })
    .from(fulfillmentLines)
    .innerJoin(orderLines, eq(orderLines.id, fulfillmentLines.orderLineId))
    .where(eq(fulfillmentLines.fulfillmentOrderId, f.id))
    .orderBy(asc(fulfillmentLines.id));
  const infos = new Map((await getSkuInfos(tx, lines.map((l) => l.skuId))).map((s) => [s.id, s]));
  let hundredthsLb = 0;
  let maxDim = 0;
  let hazmat = false;
  for (const l of lines) {
    const s = infos.get(l.skuId);
    if (!s) throw new DomainError("NOT_FOUND", `SKU ${l.skuId} not found`);
    hundredthsLb += Math.round(s.weightLbs * 100) * l.qty;
    maxDim = Math.max(maxDim, s.maxDimensionIn);
    hazmat ||= s.isHazmat;
  }

  const booked = await bookShipment(tx, {
    fulfillmentOrderId: f.id,
    weightLbs: hundredthsLb / 100,
    maxDimensionIn: maxDim,
    hazmat,
    priority: o.priority === "URGENT" ? "URGENT" : "STANDARD",
    deliveryWindowDays: o.window,
    requestedBy: a.requestedBy,
    actor: a.actor,
    correlationId: a.correlationId,
  });
  if (!booked.booked) return { shipped: false, exceptionId: booked.exceptionId, reason: booked.reason };

  await fulfillReservations(tx, {
    ownerType: "fulfillment_line",
    ownerIds: lines.map((l) => String(l.flId)),
    reasonCode: "SHIPPED",
    actor: a.actor,
    correlationId: a.correlationId,
  });
  await tx.update(fulfillmentOrders).set({ status: "SHIPPED", shippedAt: a.now }).where(eq(fulfillmentOrders.id, f.id));
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "fulfillment_order",
    entityId: f.id,
    action: "FULFILLMENT_SHIPPED",
    before: { status: f.status },
    after: { status: "SHIPPED", carrier: booked.carrierCode, rule: booked.rule },
    reasonCode: booked.rule,
    correlationId: a.correlationId,
  });
  await syncOrderStatus(tx, f.orderId, a.actor, a.correlationId);
  return { shipped: true, ...booked };
}

/** SHIPPED → DELIVERED: stamps delivered_at (drives the return window), closes the shipment, re-derives the order. */
export async function markFulfillmentDelivered(
  tx: Tx,
  a: { fulfillmentId: number; actor: Actor; correlationId: string; now: Date },
): Promise<{ orderId: number }> {
  const fo = await tx
    .select({ id: fulfillmentOrders.id, orderId: fulfillmentOrders.orderId, status: fulfillmentOrders.status })
    .from(fulfillmentOrders)
    .where(eq(fulfillmentOrders.id, a.fulfillmentId))
    .for("update")
    .limit(1);
  const f = fo[0];
  if (!f) throw new DomainError("NOT_FOUND", "Fulfillment not found");
  const t = checkFulfillmentTransition(f.status, "DELIVERED");
  if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
  await markShipmentDelivered(tx, { fulfillmentOrderId: f.id, actor: a.actor, correlationId: a.correlationId });
  await tx.update(fulfillmentOrders).set({ status: "DELIVERED", deliveredAt: a.now }).where(eq(fulfillmentOrders.id, f.id));
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "fulfillment_order",
    entityId: f.id,
    action: "FULFILLMENT_DELIVERED",
    before: { status: f.status },
    after: { status: "DELIVERED" },
    correlationId: a.correlationId,
  });
  await syncOrderStatus(tx, f.orderId, a.actor, a.correlationId);
  return { orderId: f.orderId };
}

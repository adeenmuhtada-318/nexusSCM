"use server";

import { PERMISSIONS } from "@/lib/auth/roles";
import { runTransaction } from "@/lib/db/tx";
import { runAction } from "@/lib/utils/action-runner";
import { invalidate, tags } from "@/lib/utils/cache";
import type { ActionResult } from "@/lib/utils/action-response";
import { markFulfillmentDelivered, shipFulfillment, type ShipResult } from "./fulfillment";
import { cancelOrder, confirmOrder, createOrder, reevaluateOrder, type PlaceOrderResult } from "./mutations";
import { cancelOrderSchema, confirmOrderSchema, createOrderSchema, fulfillmentIdSchema, releaseHoldSchema } from "./schemas";

const ORDER_TAGS = [tags.ordersList, tags.inventoryList, tags.exceptionsOpen];
const ORDER_PATHS = ["/orders", "/inventory", "/exceptions", "/"];

/**
 * Create an order. Pipeline (CLAUDE.md §4.6): requireRole → Zod → rules (inside createOrder) → one transaction with
 * audit/ledger rows → invalidate tags. Idempotent on `idempotencyKey`.
 */
export async function createOrderAction(input: unknown): Promise<ActionResult<PlaceOrderResult & { replayed: boolean }>> {
  return runAction({
    name: "orders.create",
    roles: PERMISSIONS["orders.create"],
    schema: createOrderSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) =>
        createOrder(tx, {
          customerId: d.customerId,
          addressId: d.addressId,
          lines: d.lines,
          priority: d.priority,
          deliveryWindowDays: d.deliveryWindowDays,
          idempotencyKey: d.idempotencyKey,
          actor: ctx.actor,
          correlationId: ctx.correlationId,
          now: new Date(),
        }),
      );
      invalidate(ORDER_TAGS, ORDER_PATHS);
      return { ...out.result, replayed: out.replayed };
    },
  });
}

export async function confirmOrderAction(input: unknown): Promise<ActionResult<{ orderId: number }>> {
  return runAction({
    name: "orders.confirm",
    roles: PERMISSIONS["orders.confirm"],
    schema: confirmOrderSchema,
    input,
    handler: async (ctx, d) => {
      await runTransaction((tx) => confirmOrder(tx, { orderId: d.orderId, actor: ctx.actor, correlationId: ctx.correlationId, now: new Date() }));
      invalidate([tags.ordersList, tags.order(d.orderId)], ORDER_PATHS);
      return { orderId: d.orderId };
    },
  });
}

export async function cancelOrderAction(input: unknown): Promise<ActionResult<{ orderId: number }>> {
  return runAction({
    name: "orders.cancel",
    roles: PERMISSIONS["orders.cancel"],
    schema: cancelOrderSchema,
    input,
    handler: async (ctx, d) => {
      await runTransaction((tx) => cancelOrder(tx, { orderId: d.orderId, reasonCode: d.reason, actor: ctx.actor, correlationId: ctx.correlationId }));
      invalidate(ORDER_TAGS, ORDER_PATHS);
      return { orderId: d.orderId };
    },
  });
}

/** Re-run the Seven Rights for a held/backordered order after the underlying problem was fixed. */
export async function releaseHoldAction(input: unknown): Promise<ActionResult<PlaceOrderResult>> {
  return runAction({
    name: "orders.releaseHold",
    roles: PERMISSIONS["orders.releaseHold"],
    schema: releaseHoldSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) => reevaluateOrder(tx, { orderId: d.orderId, actor: ctx.actor, correlationId: ctx.correlationId, now: new Date() }));
      invalidate(ORDER_TAGS, ORDER_PATHS);
      return out;
    },
  });
}

export async function shipFulfillmentAction(input: unknown): Promise<ActionResult<ShipResult>> {
  return runAction({
    name: "orders.ship",
    roles: PERMISSIONS["orders.ship"],
    schema: fulfillmentIdSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) =>
        shipFulfillment(tx, { fulfillmentId: d.fulfillmentId, actor: ctx.actor, correlationId: ctx.correlationId, now: new Date(), requestedBy: ctx.actor.id }),
      );
      invalidate([...ORDER_TAGS, tags.logisticsList], [...ORDER_PATHS, "/logistics"]);
      return out;
    },
  });
}

export async function markDeliveredAction(input: unknown): Promise<ActionResult<{ orderId: number }>> {
  return runAction({
    name: "orders.markDelivered",
    roles: PERMISSIONS["orders.markDelivered"],
    schema: fulfillmentIdSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) => markFulfillmentDelivered(tx, { fulfillmentId: d.fulfillmentId, actor: ctx.actor, correlationId: ctx.correlationId, now: new Date() }));
      invalidate([tags.ordersList, tags.logisticsList], [...ORDER_PATHS, "/logistics"]);
      return out;
    },
  });
}

import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { customerAccounts, fulfillmentLines, fulfillmentOrders, orderLines, orders } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/db/audit";
import { loadBusinessRules } from "@/lib/config/business-rules";
import type { BusinessRules } from "@/lib/config/business-rules.defaults";
import { DomainError } from "@/lib/utils/errors";
import { closeExceptionsForEntity, raiseException } from "@/modules/exceptions";
import { getAvailabilityContext, getSkuInfos, reserveStock, type SkuInfo } from "@/modules/inventory";
import { getContractPrices, loadPlacementContext } from "./queries";
import {
  checkOrderTransition,
  evaluateSevenRights,
  isValidCoordinate,
  planFulfillment,
  reservationExpiry,
  type FulfillmentPlan,
  type Hold,
  type OrderStatus,
  type RightsLine,
} from "./rules";

export interface OrderRequestLine {
  skuId: number;
  qty: number;
}

/** Result of the pure decision + the data it was based on. No writes happen while evaluating. */
export type Evaluation =
  | { kind: "HOLD"; totalCents: number; holds: Hold[]; reasonCodes: string[]; accountId: number }
  | { kind: "BACKORDER"; totalCents: number; reasonCodes: string[]; accountId: number }
  | { kind: "RESERVE"; totalCents: number; plan: Extract<FulfillmentPlan, { kind: "PLAN" }>; accountId: number };

export interface EvaluatedOrder {
  evaluation: Evaluation;
  prices: Map<number, number>;
  infos: Map<number, SkuInfo>;
  rules: BusinessRules;
}

/**
 * Seven Rights + fulfillment planning. READ-ONLY: gathers context (customer/account/address, SKU master data with
 * contract prices recomputed server-side, per-warehouse availability + Haversine ranking from SQL) then asks rules.ts
 * to decide. Lines must be sorted by skuId ascending.
 */
export async function evaluateOrder(
  tx: Tx,
  a: { customerId: number; addressId: number; lines: readonly OrderRequestLine[]; now: Date },
): Promise<EvaluatedOrder & { ctxAccountId: number }> {
  const ctx = await loadPlacementContext(tx, a.customerId, a.addressId);
  // Row-level authorization: the address must belong to the customer, otherwise it "does not exist" for this caller.
  if (!ctx || ctx.address.customerId !== a.customerId) throw new DomainError("NOT_FOUND", "Customer or address not found");

  const infoList = await getSkuInfos(tx, a.lines.map((l) => l.skuId));
  const infos = new Map(infoList.map((s) => [s.id, s]));
  for (const l of a.lines) if (!infos.has(l.skuId)) throw new DomainError("NOT_FOUND", `SKU ${l.skuId} not found`);

  const rules = await loadBusinessRules(tx, a.now);
  const contract = await getContractPrices(tx, ctx.account.id, a.lines.map((l) => l.skuId));
  const prices = new Map<number, number>();
  for (const l of a.lines) {
    const info = infos.get(l.skuId);
    if (info) prices.set(l.skuId, contract.get(l.skuId) ?? info.listPriceCents);
  }

  const dest = isValidCoordinate(ctx.address.lat, ctx.address.lng) && ctx.address.lat !== null && ctx.address.lng !== null
    ? { lat: ctx.address.lat, lng: ctx.address.lng }
    : null;
  const avail = await getAvailabilityContext(tx, { infos: infoList, dest, now: a.now, minShelfLifePct: rules.minShelfLifePct });

  const rightsLines: RightsLine[] = a.lines.map((l) => {
    const info = infos.get(l.skuId);
    return {
      skuId: l.skuId,
      qty: l.qty,
      skuActive: info?.active ?? false,
      isHazmat: info?.isHazmat ?? false,
      unitPriceCents: prices.get(l.skuId) ?? 0,
      networkAvailable: avail.warehouses.reduce((s, w) => s + (w.available[l.skuId] ?? 0), 0),
      quarantinedQty: avail.quarantinedBySku[l.skuId] ?? 0,
    };
  });

  const rights = evaluateSevenRights({
    customerActive: ctx.customer.active,
    accountActive: ctx.account.active,
    creditLimitCents: ctx.account.creditLimitCents,
    currentBalanceCents: ctx.account.currentBalanceCents,
    address: { lat: ctx.address.lat, lng: ctx.address.lng, region: ctx.address.region, country: ctx.address.country },
    destinationHazmatRestricted: ctx.destinationHazmatRestricted,
    lines: rightsLines,
  });
  const accountId = ctx.account.id;
  const reasonCodes = rights.failures.map((f) => f.reasonCode);

  let evaluation: Evaluation;
  if (rights.outcome === "HOLD") {
    evaluation = { kind: "HOLD", totalCents: rights.totalCents, holds: rights.holds, reasonCodes, accountId };
  } else if (rights.outcome === "BACKORDER") {
    evaluation = { kind: "BACKORDER", totalCents: rights.totalCents, reasonCodes, accountId };
  } else {
    const plan = planFulfillment(
      a.lines,
      avail.warehouses.map((w) => ({ id: w.id, distanceKm: w.distanceKm ?? 0, available: w.available })),
    );
    evaluation =
      plan.kind === "PLAN"
        ? { kind: "RESERVE", totalCents: rights.totalCents, plan, accountId }
        : { kind: "BACKORDER", totalCents: rights.totalCents, reasonCodes: ["INSUFFICIENT_STOCK"], accountId };
  }
  return { evaluation, prices, infos, rules, ctxAccountId: accountId };
}

/**
 * Atomic credit claim: `UPDATE … SET balance = balance + total WHERE balance + total <= limit` (exact integer cents).
 * Repeats the credit rule at write time so two concurrent orders cannot both squeeze under the limit (D-15).
 */
async function claimCredit(tx: Tx, accountId: number, totalCents: number): Promise<boolean> {
  const rows = await tx
    .update(customerAccounts)
    .set({ currentBalanceCents: sql`${customerAccounts.currentBalanceCents} + ${totalCents}` })
    .where(
      and(
        eq(customerAccounts.id, accountId),
        eq(customerAccounts.active, true),
        sql`${customerAccounts.currentBalanceCents} + ${totalCents} <= ${customerAccounts.creditLimitCents}`,
      ),
    )
    .returning({ id: customerAccounts.id });
  return rows.length === 1;
}

/** Gives exposure back (cancel / expiry / failed reservation). Floors at 0 so drift can never violate the CHECK. */
export async function releaseCredit(tx: Tx, accountId: number, amountCents: number): Promise<void> {
  await tx
    .update(customerAccounts)
    .set({ currentBalanceCents: sql`GREATEST(${customerAccounts.currentBalanceCents} - ${amountCents}, 0)` })
    .where(eq(customerAccounts.id, accountId));
}

/**
 * Materialise a plan: child fulfillment_orders + lines, then reserve stock with ONE ordering discipline —
 * allocations sorted by (skuId, warehouseId) ascending — so concurrent multi-line orders never deadlock (§4.3).
 * Runs inside a SAVEPOINT: an INSUFFICIENT_STOCK race (stock vanished after the availability read) rolls back only
 * this block and returns false so the caller can backorder instead of failing the whole request.
 */
async function reservePlan(
  tx: Tx,
  a: {
    orderId: number;
    lineIdBySku: Map<number, number>;
    plan: Extract<FulfillmentPlan, { kind: "PLAN" }>;
    rules: BusinessRules;
    now: Date;
    actor: Actor;
    correlationId: string;
  },
): Promise<boolean> {
  const expiresAt = reservationExpiry(a.now, a.rules.reservationTtlMinutes);
  try {
    await tx.transaction(async (sp) => {
      const allocs: { skuId: number; warehouseId: number; qty: number; flId: number }[] = [];
      for (const s of a.plan.shipments) {
        const fo = await sp.insert(fulfillmentOrders).values({ orderId: a.orderId, warehouseId: s.warehouseId }).returning({ id: fulfillmentOrders.id });
        const foId = fo[0]?.id;
        if (foId === undefined) throw new DomainError("INTERNAL", "fulfillment insert failed");
        for (const l of s.lines) {
          const orderLineId = a.lineIdBySku.get(l.skuId);
          if (orderLineId === undefined) throw new DomainError("INTERNAL", "order line missing for plan");
          const fl = await sp
            .insert(fulfillmentLines)
            .values({ fulfillmentOrderId: foId, orderLineId, qty: l.qty })
            .returning({ id: fulfillmentLines.id });
          const flId = fl[0]?.id;
          if (flId === undefined) throw new DomainError("INTERNAL", "fulfillment line insert failed");
          allocs.push({ skuId: l.skuId, warehouseId: s.warehouseId, qty: l.qty, flId });
        }
      }
      allocs.sort((x, y) => x.skuId - y.skuId || x.warehouseId - y.warehouseId);
      for (const al of allocs) {
        await reserveStock(sp, {
          skuId: al.skuId,
          warehouseId: al.warehouseId,
          qty: al.qty,
          ownerType: "fulfillment_line",
          ownerId: String(al.flId),
          expiresAt,
          minShelfLifePct: a.rules.minShelfLifePct,
          now: a.now,
          actor: a.actor,
          correlationId: a.correlationId,
        });
      }
    });
    return true;
  } catch (err) {
    if (err instanceof DomainError && err.code === "INSUFFICIENT_STOCK") return false;
    throw err;
  }
}

export interface FinalizeArgs {
  orderId: number;
  /** Current persisted status (provisional BACKORDERED for brand-new rows). */
  from: OrderStatus;
  evaluated: EvaluatedOrder;
  lineIdBySku: Map<number, number>;
  now: Date;
  actor: Actor;
  requestedBy: string | null;
  correlationId: string;
}
export interface FinalizeResult {
  status: OrderStatus;
  reasonCodes: string[];
  exceptionIds: number[];
}

/**
 * Applies an Evaluation to an order: HOLD → ON_HOLD_EXCEPTION + one exceptions row per hold; BACKORDER → BACKORDERED +
 * NO_WAREHOUSE_CAN_FULFIL exception (D-11); RESERVE → claim credit atomically (fail ⇒ credit HOLD), reserve stock only
 * now — after every check passed — and set RESERVED with the TTL deadline. Status changes go through the transition
 * map (same-state is a no-op). A successful placement closes the order's previous exceptions.
 */
export async function finalizeOrder(tx: Tx, f: FinalizeArgs): Promise<FinalizeResult> {
  const { evaluation, rules } = f.evaluated;
  let status: OrderStatus;
  let reasonCodes: string[];
  let holds: Hold[] = [];

  if (evaluation.kind === "HOLD") {
    status = "ON_HOLD_EXCEPTION";
    reasonCodes = evaluation.reasonCodes;
    holds = evaluation.holds;
  } else if (evaluation.kind === "BACKORDER") {
    status = "BACKORDERED";
    reasonCodes = evaluation.reasonCodes;
  } else {
    const creditClaimed = await claimCredit(tx, evaluation.accountId, evaluation.totalCents);
    if (!creditClaimed) {
      status = "ON_HOLD_EXCEPTION";
      reasonCodes = ["CREDIT_LIMIT_EXCEEDED"];
      holds = [{ exceptionType: "ORDER_CREDIT_EXCEEDED", reasonCode: "CREDIT_LIMIT_EXCEEDED", severity: "HIGH" }];
    } else {
      const reserved = await reservePlan(tx, {
        orderId: f.orderId,
        lineIdBySku: f.lineIdBySku,
        plan: evaluation.plan,
        rules,
        now: f.now,
        actor: f.actor,
        correlationId: f.correlationId,
      });
      if (reserved) {
        status = "RESERVED";
        reasonCodes = [];
      } else {
        await releaseCredit(tx, evaluation.accountId, evaluation.totalCents);
        status = "BACKORDERED";
        reasonCodes = ["INSUFFICIENT_STOCK"];
      }
    }
  }

  if (status !== f.from) {
    const t = checkOrderTransition(f.from, status);
    if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
  }
  await tx
    .update(orders)
    .set({
      status,
      holdReasonCode: reasonCodes[0] ?? null,
      reservationExpiresAt: status === "RESERVED" ? reservationExpiry(f.now, rules.reservationTtlMinutes) : null,
    })
    .where(eq(orders.id, f.orderId));

  const exceptionIds: number[] = [];
  for (const h of holds) {
    const ex = await raiseException(tx, {
      type: h.exceptionType,
      entityType: "order",
      entityId: f.orderId,
      severity: h.severity,
      reasonCode: h.reasonCode,
      requestedBy: f.requestedBy,
      actor: f.actor,
      correlationId: f.correlationId,
      now: f.now,
    });
    exceptionIds.push(ex.id);
  }
  if (status === "BACKORDERED") {
    const ex = await raiseException(tx, {
      type: "NO_WAREHOUSE_CAN_FULFIL",
      entityType: "order",
      entityId: f.orderId,
      severity: "HIGH",
      reasonCode: reasonCodes[0] ?? "INSUFFICIENT_STOCK",
      requestedBy: f.requestedBy,
      actor: f.actor,
      correlationId: f.correlationId,
      now: f.now,
    });
    exceptionIds.push(ex.id);
  }
  if (status === "RESERVED" && f.actor.type === "USER") {
    await closeExceptionsForEntity(tx, {
      entityType: "order",
      entityId: f.orderId,
      note: "Order placed after re-evaluation",
      actorId: f.actor.id,
      correlationId: f.correlationId,
    });
  }
  await writeAudit(tx, {
    actor: f.actor,
    entityType: "order",
    entityId: f.orderId,
    action: f.from === status ? "ORDER_REEVALUATED" : "ORDER_STATUS_CHANGED",
    before: { status: f.from },
    after: { status, reasonCodes },
    reasonCode: reasonCodes[0] ?? "OK",
    correlationId: f.correlationId,
  });
  return { status, reasonCodes, exceptionIds };
}

/** Inserts the order header + lines with a PROVISIONAL status; `finalizeOrder` sets the real one in the same tx. */
export async function insertOrderRows(
  tx: Tx,
  a: {
    orderNumber: string;
    customerId: number;
    accountId: number;
    addressId: number;
    totalCents: number;
    priority: "STANDARD" | "URGENT";
    deliveryWindowDays: number;
    createdBy: string;
    lines: { skuId: number; qty: number; unitPriceCents: number; isCustomized: boolean }[];
  },
): Promise<{ orderId: number; lineIdBySku: Map<number, number> }> {
  const o = await tx
    .insert(orders)
    .values({
      orderNumber: a.orderNumber,
      customerId: a.customerId,
      accountId: a.accountId,
      addressId: a.addressId,
      status: "BACKORDERED",
      totalCents: a.totalCents,
      priority: a.priority,
      deliveryWindowDays: a.deliveryWindowDays,
      createdBy: a.createdBy,
    })
    .returning({ id: orders.id });
  const orderId = o[0]?.id;
  if (orderId === undefined) throw new DomainError("INTERNAL", "order insert failed");
  const lineIdBySku = new Map<number, number>();
  for (const l of a.lines) {
    const r = await tx
      .insert(orderLines)
      .values({
        orderId,
        skuId: l.skuId,
        qty: l.qty,
        unitPriceCents: l.unitPriceCents,
        lineTotalCents: l.unitPriceCents * l.qty,
        isCustomized: l.isCustomized,
      })
      .returning({ id: orderLines.id });
    const id = r[0]?.id;
    if (id === undefined) throw new DomainError("INTERNAL", "order line insert failed");
    lineIdBySku.set(l.skuId, id);
  }
  return { orderId, lineIdBySku };
}

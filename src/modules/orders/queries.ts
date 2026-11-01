import "server-only";
import { cache } from "react";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import {
  addresses,
  contractPrices,
  customerAccounts,
  customers,
  fulfillmentLines,
  fulfillmentOrders,
  hazmatRestrictedRegions,
  orderLines,
  orders,
  skus,
  warehouses,
} from "@/lib/db/schema";
import type { OrderStatus } from "./rules";

export interface PlacementContext {
  customer: { id: number; active: boolean; accountId: number };
  account: { id: number; active: boolean; creditLimitCents: number; currentBalanceCents: number };
  address: { id: number; customerId: number; lat: number | null; lng: number | null; region: string; country: string };
  destinationHazmatRestricted: boolean;
}

/** Customer + account + address (+ hazmat destination flag) needed by the Seven Rights. Explicit columns only. */
export async function loadPlacementContext(db: DbOrTx, customerId: number, addressId: number): Promise<PlacementContext | null> {
  const rows = await db
    .select({
      customerId: customers.id,
      customerActive: customers.active,
      accountId: customerAccounts.id,
      accountActive: customerAccounts.active,
      creditLimitCents: customerAccounts.creditLimitCents,
      balanceCents: customerAccounts.currentBalanceCents,
      addressId: addresses.id,
      addressCustomerId: addresses.customerId,
      lat: addresses.lat,
      lng: addresses.lng,
      region: addresses.region,
      country: addresses.country,
    })
    .from(customers)
    .innerJoin(customerAccounts, eq(customerAccounts.id, customers.accountId))
    .innerJoin(addresses, eq(addresses.id, addressId))
    .where(eq(customers.id, customerId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const restricted = await db
    .select({ id: hazmatRestrictedRegions.id })
    .from(hazmatRestrictedRegions)
    .where(and(eq(hazmatRestrictedRegions.country, r.country), eq(hazmatRestrictedRegions.region, r.region)))
    .limit(1);
  return {
    customer: { id: r.customerId, active: r.customerActive, accountId: r.accountId },
    account: { id: r.accountId, active: r.accountActive, creditLimitCents: r.creditLimitCents, currentBalanceCents: r.balanceCents },
    address: { id: r.addressId, customerId: r.addressCustomerId, lat: r.lat, lng: r.lng, region: r.region, country: r.country },
    destinationHazmatRestricted: restricted.length > 0,
  };
}

/** Contract price per SKU for an account (CLAUDE.md §5.2: contract price applied). */
export async function getContractPrices(db: DbOrTx, accountId: number, skuIds: readonly number[]): Promise<Map<number, number>> {
  if (skuIds.length === 0) return new Map();
  const rows = await db
    .select({ skuId: contractPrices.skuId, priceCents: contractPrices.priceCents })
    .from(contractPrices)
    .where(and(eq(contractPrices.accountId, accountId), inArray(contractPrices.skuId, [...skuIds])));
  return new Map(rows.map((r) => [r.skuId, r.priceCents]));
}

export interface OrderListRow {
  id: number;
  orderNumber: string;
  status: OrderStatus;
  customerName: string;
  totalCents: number;
  holdReasonCode: string | null;
  reservationExpiresAt: Date | null;
  createdAt: Date;
}

/** Newest-first keyset page (created_at DESC, id DESC) served by orders_list_idx. */
export async function listOrders(db: DbOrTx, opts: { cursor?: string; limit: number }) {
  const [iso, idStr] = (opts.cursor ?? "").split("|");
  const id = Number(idStr);
  const hasCursor = !!iso && Number.isInteger(id) && !Number.isNaN(Date.parse(iso));
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      customerName: customers.name,
      totalCents: orders.totalCents,
      holdReasonCode: orders.holdReasonCode,
      reservationExpiresAt: orders.reservationExpiresAt,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(hasCursor ? sql`(${orders.createdAt}, ${orders.id}) < (${iso}::timestamptz, ${id}::int)` : sql`true`)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(opts.limit + 1);
  const page: OrderListRow[] = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > opts.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null };
}

export async function getOrderDetail(db: DbOrTx, orderId: number) {
  const head = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalCents: orders.totalCents,
      holdReasonCode: orders.holdReasonCode,
      reservationExpiresAt: orders.reservationExpiresAt,
      priority: orders.priority,
      deliveryWindowDays: orders.deliveryWindowDays,
      accountId: orders.accountId,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  const order = head[0];
  if (!order) return null;
  const lines = await db
    .select({
      id: orderLines.id,
      skuId: orderLines.skuId,
      qty: orderLines.qty,
      unitPriceCents: orderLines.unitPriceCents,
      lineTotalCents: orderLines.lineTotalCents,
      qtyReturned: orderLines.qtyReturned,
    })
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId))
    .orderBy(asc(orderLines.id));
  const fulfillments = await db
    .select({
      id: fulfillmentOrders.id,
      warehouseId: fulfillmentOrders.warehouseId,
      status: fulfillmentOrders.status,
      shippedAt: fulfillmentOrders.shippedAt,
      deliveredAt: fulfillmentOrders.deliveredAt,
    })
    .from(fulfillmentOrders)
    .where(eq(fulfillmentOrders.orderId, orderId))
    .orderBy(asc(fulfillmentOrders.id));
  return { order, lines, fulfillments };
}

export interface ReturnableLine {
  orderLineId: number;
  orderId: number;
  accountId: number;
  skuId: number;
  qty: number;
  unitPriceCents: number;
  lineTotalCents: number;
  isCustomized: boolean;
  qtyReturned: number;
  deliveredAt: Date | null;
  /** (today in business tz) − (delivered_at in business tz)::date, whole calendar days; NULL if not delivered. */
  daysSinceDelivery: number | null;
}

/**
 * Order-line facts the returns module needs. "Days since delivery" is computed IN SQL in the business timezone
 * (CLAUDE.md §4.2) from the latest DELIVERED fulfillment covering the line; `todayISO` is injected for determinism.
 */
export async function getReturnableLine(db: DbOrTx, orderLineId: number, todayISO: string, tz: string): Promise<ReturnableLine | null> {
  const rows = await db.execute<{
    id: number;
    order_id: number;
    account_id: number;
    sku_id: number;
    qty: number;
    unit_price_cents: string;
    line_total_cents: string;
    is_customized: boolean;
    qty_returned: number;
    delivered_at: Date | null;
    days_since: number | null;
  }>(sql`
    SELECT ol.id, ol.order_id, o.account_id, ol.sku_id, ol.qty, ol.unit_price_cents, ol.line_total_cents,
           ol.is_customized, ol.qty_returned, fd.delivered_at,
           CASE WHEN fd.delivered_at IS NULL THEN NULL
                ELSE (${todayISO}::date - (fd.delivered_at AT TIME ZONE ${tz})::date) END AS days_since
    FROM order_lines ol
    JOIN orders o ON o.id = ol.order_id
    LEFT JOIN LATERAL (
      SELECT MAX(fo.delivered_at) AS delivered_at
      FROM fulfillment_lines fl JOIN fulfillment_orders fo ON fo.id = fl.fulfillment_order_id
      WHERE fl.order_line_id = ol.id AND fo.status = 'DELIVERED'
    ) fd ON true
    WHERE ol.id = ${orderLineId}::int`);
  const r = rows[0];
  if (!r) return null;
  return {
    orderLineId: r.id,
    orderId: r.order_id,
    accountId: r.account_id,
    skuId: r.sku_id,
    qty: r.qty,
    unitPriceCents: Number(r.unit_price_cents),
    lineTotalCents: Number(r.line_total_cents),
    isCustomized: r.is_customized,
    qtyReturned: r.qty_returned,
    deliveredAt: r.delivered_at,
    daysSinceDelivery: r.days_since === null ? null : Number(r.days_since),
  };
}

/** Fulfillment-line ids of an order (owner ids of its reservations). */
export async function getFulfillmentLineIds(db: DbOrTx, orderId: number, fulfillmentId?: number): Promise<number[]> {
  const rows = await db
    .select({ id: fulfillmentLines.id })
    .from(fulfillmentLines)
    .innerJoin(fulfillmentOrders, eq(fulfillmentOrders.id, fulfillmentLines.fulfillmentOrderId))
    .where(and(eq(fulfillmentOrders.orderId, orderId), fulfillmentId === undefined ? sql`true` : eq(fulfillmentOrders.id, fulfillmentId)))
    .orderBy(asc(fulfillmentLines.id));
  return rows.map((r) => r.id);
}

export const getOrders = cache((cursor: string | undefined, limit: number) =>
  listOrders(getDb(), cursor === undefined ? { limit } : { cursor, limit }),
);
export const getOrder = cache((orderId: number) => getOrderDetail(getDb(), orderId));

/** Active customers with their default delivery address — for the "new order" form pickers (bounded). */
export async function listCustomerOptions(db: DbOrTx, limit = 100) {
  return db
    .select({ customerId: customers.id, name: customers.name, addressId: addresses.id, city: addresses.city, region: addresses.region })
    .from(customers)
    .innerJoin(addresses, eq(addresses.customerId, customers.id))
    .where(eq(customers.active, true))
    .orderBy(asc(customers.id), asc(addresses.id))
    .limit(limit);
}

export const getCustomerPickerOptions = cache(() => listCustomerOptions(getDb(), 100));

export const getRecentFulfillments = cache(async (limit = 35) =>
  getDb()
    .select({
      id: fulfillmentOrders.id,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      orderStatus: orders.status,
      warehouseCode: warehouses.code,
      status: fulfillmentOrders.status,
      shippedAt: fulfillmentOrders.shippedAt,
      deliveredAt: fulfillmentOrders.deliveredAt,
    })
    .from(fulfillmentOrders)
    .innerJoin(orders, eq(orders.id, fulfillmentOrders.orderId))
    .innerJoin(warehouses, eq(warehouses.id, fulfillmentOrders.warehouseId))
    .orderBy(desc(fulfillmentOrders.id))
    .limit(limit),
);

export const getDeliveredOrderLinesForRma = cache(async (limit = 50) =>
  getDb()
    .select({
      orderLineId: orderLines.id,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      skuCode: skus.code,
      qty: orderLines.qty,
      qtyReturned: orderLines.qtyReturned,
      isCustomized: orderLines.isCustomized,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(skus, eq(skus.id, orderLines.skuId))
    .where(eq(orders.status, "DELIVERED"))
    .orderBy(desc(orders.id), asc(orderLines.id))
    .limit(limit),
);

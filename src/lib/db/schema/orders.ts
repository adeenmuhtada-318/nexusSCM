import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { fulfillmentStatus, orderStatus } from "./enums";
import { skus, warehouses } from "./inventory";

/** Credit-limit scope = per ACCOUNT (docs/DECISIONS.md D-01). Money is integer cents. */
export const customerAccounts = pgTable(
  "customer_accounts",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    creditLimitCents: bigint("credit_limit_cents", { mode: "number" }).notNull(),
    currentBalanceCents: bigint("current_balance_cents", { mode: "number" }).notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    check("accounts_limit_ck", sql`${t.creditLimitCents} >= 0`),
    check("accounts_balance_ck", sql`${t.currentBalanceCents} >= 0`),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id").notNull().references(() => customerAccounts.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [index("customers_account_idx").on(t.accountId), uniqueIndex("customers_email_uq").on(t.email)],
);

export const contractPrices = pgTable(
  "contract_prices",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id").notNull().references(() => customerAccounts.id),
    skuId: integer("sku_id").notNull().references(() => skus.id),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("contract_prices_uq").on(t.accountId, t.skuId), check("contract_price_ck", sql`${t.priceCents} >= 0`)],
);

export const addresses = pgTable(
  "addresses",
  {
    id: serial("id").primaryKey(),
    customerId: integer("customer_id").notNull().references(() => customers.id),
    line1: text("line1").notNull(),
    city: text("city").notNull(),
    region: text("region").notNull(),
    postalCode: text("postal_code").notNull(),
    country: text("country").notNull().default("US"),
    /** NULL until geocoded. Order checks fail with ADDRESS_NOT_GEOCODED when NULL. */
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
  },
  (t) => [
    index("addresses_customer_idx").on(t.customerId),
    check("addresses_lat_ck", sql`${t.lat} IS NULL OR ${t.lat} BETWEEN -90 AND 90`),
    check("addresses_lng_ck", sql`${t.lng} IS NULL OR ${t.lng} BETWEEN -180 AND 180`),
    check("addresses_pair_ck", sql`(${t.lat} IS NULL) = (${t.lng} IS NULL)`),
  ],
);

/** Destinations where hazmat SKUs cannot be delivered (country, region). */
export const hazmatRestrictedRegions = pgTable(
  "hazmat_restricted_regions",
  {
    id: serial("id").primaryKey(),
    country: text("country").notNull(),
    region: text("region").notNull(),
  },
  (t) => [uniqueIndex("hazmat_region_uq").on(t.country, t.region)],
);

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    orderNumber: text("order_number").notNull(),
    customerId: integer("customer_id").notNull().references(() => customers.id),
    accountId: integer("account_id").notNull().references(() => customerAccounts.id),
    addressId: integer("address_id").notNull().references(() => addresses.id),
    status: orderStatus("status").notNull(),
    holdReasonCode: text("hold_reason_code"),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    /** Reserved stock is released automatically at this instant unless the order is confirmed. */
    reservationExpiresAt: timestamp("reservation_expires_at", { withTimezone: true }),
    priority: text("priority").notNull().default("STANDARD"),
    deliveryWindowDays: integer("delivery_window_days").notNull().default(7),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_number_uq").on(t.orderNumber),
    index("orders_list_idx").on(t.createdAt, t.id),
    index("orders_expiry_idx").on(t.reservationExpiresAt).where(sql`${t.status} = 'RESERVED'`),
    index("orders_customer_idx").on(t.customerId),
    check("orders_total_ck", sql`${t.totalCents} >= 0`),
    check("orders_priority_ck", sql`${t.priority} IN ('STANDARD','URGENT')`),
    check("orders_window_ck", sql`${t.deliveryWindowDays} > 0`),
  ],
);

export const orderLines = pgTable(
  "order_lines",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id").notNull().references(() => orders.id),
    skuId: integer("sku_id").notNull().references(() => skus.id),
    qty: integer("qty").notNull(),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
    isCustomized: boolean("is_customized").notNull().default(false),
    /** Units already covered by non-denied RMAs. Reconciled against rma_lines (returns module). */
    qtyReturned: integer("qty_returned").notNull().default(0),
  },
  (t) => [
    index("order_lines_order_idx").on(t.orderId),
    uniqueIndex("order_lines_order_sku_uq").on(t.orderId, t.skuId),
    check("order_lines_qty_ck", sql`${t.qty} > 0`),
    check("order_lines_total_ck", sql`${t.lineTotalCents} = ${t.unitPriceCents} * ${t.qty}`),
    check("order_lines_returned_ck", sql`${t.qtyReturned} BETWEEN 0 AND ${t.qty}`),
  ],
);

export const fulfillmentOrders = pgTable(
  "fulfillment_orders",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id").notNull().references(() => orders.id),
    warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
    status: fulfillmentStatus("status").notNull().default("RESERVED"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [index("fulfillment_order_idx").on(t.orderId)],
);

export const fulfillmentLines = pgTable(
  "fulfillment_lines",
  {
    id: serial("id").primaryKey(),
    fulfillmentOrderId: integer("fulfillment_order_id").notNull().references(() => fulfillmentOrders.id),
    orderLineId: integer("order_line_id").notNull().references(() => orderLines.id),
    qty: integer("qty").notNull(),
  },
  (t) => [
    index("fulfillment_lines_fo_idx").on(t.fulfillmentOrderId),
    index("fulfillment_lines_ol_idx").on(t.orderLineId),
    check("fulfillment_lines_qty_ck", sql`${t.qty} > 0`),
  ],
);

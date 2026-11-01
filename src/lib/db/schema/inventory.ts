import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { ledgerEntryType, requisitionStatus, reservationStatus, zoneStatus } from "./enums";

export const warehouses = pgTable(
  "warehouses",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** Degrees; validated at the DB (CLAUDE.md §4.2). Distances elsewhere are km. */
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    timezone: text("timezone").notNull().default("America/New_York"),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("warehouses_code_uq").on(t.code),
    check("warehouses_lat_ck", sql`${t.lat} BETWEEN -90 AND 90`),
    check("warehouses_lng_ck", sql`${t.lng} BETWEEN -180 AND 180`),
  ],
);

export const skus = pgTable(
  "skus",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    active: boolean("active").notNull().default(true),
    isPerishable: boolean("is_perishable").notNull().default(false),
    /** Total shelf life in days at receipt; required for perishables. */
    shelfLifeDays: integer("shelf_life_days"),
    isHazmat: boolean("is_hazmat").notNull().default(false),
    weightLbs: numeric("weight_lbs", { precision: 10, scale: 2 }).notNull(),
    /** Longest side in inches, used for carrier dimension compliance. */
    maxDimensionIn: numeric("max_dimension_in", { precision: 8, scale: 2 }).notNull(),
    listPriceCents: bigint("list_price_cents", { mode: "number" }).notNull(),
    /** L_avg in days for the ROP formula. */
    leadTimeDaysAvg: numeric("lead_time_days_avg", { precision: 6, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex("skus_code_uq").on(t.code),
    check("skus_perishable_ck", sql`NOT ${t.isPerishable} OR ${t.shelfLifeDays} > 0`),
    check("skus_price_ck", sql`${t.listPriceCents} >= 0`),
    check("skus_lead_ck", sql`${t.leadTimeDaysAvg} >= 0`),
  ],
);

export const inventoryBatches = pgTable(
  "inventory_batches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    skuId: integer("sku_id").notNull().references(() => skus.id),
    warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
    zoneStatus: zoneStatus("zone_status").notNull().default("PRIME"),
    qtyAvailable: integer("qty_available").notNull(),
    qtyReserved: integer("qty_reserved").notNull().default(0),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    expiryDate: date("expiry_date", { mode: "string" }),
    lotCode: text("lot_code").notNull(),
  },
  (t) => [
    check("batches_avail_ck", sql`${t.qtyAvailable} >= 0`),
    check("batches_reserved_ck", sql`${t.qtyReserved} >= 0`),
    // FEFO: perishables. FIFO: everything else. Different orderings => different partial indexes.
    index("batches_fefo_idx")
      .on(t.skuId, t.warehouseId, t.zoneStatus, t.expiryDate, t.receivedAt, t.id)
      .where(sql`${t.qtyAvailable} > 0`),
    index("batches_fifo_idx")
      .on(t.skuId, t.warehouseId, t.zoneStatus, t.receivedAt, t.id)
      .where(sql`${t.qtyAvailable} > 0`),
    index("batches_sku_wh_idx").on(t.skuId, t.warehouseId),
  ],
);

/** Append-only (trigger). Signed deltas; batch qty must equal SUM(delta) — see reconciliation query. */
export const inventoryLedger = pgTable(
  "inventory_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    batchId: bigint("batch_id", { mode: "number" }).notNull().references(() => inventoryBatches.id),
    skuId: integer("sku_id").notNull().references(() => skus.id),
    warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
    entryType: ledgerEntryType("entry_type").notNull(),
    deltaAvailable: integer("delta_available").notNull(),
    deltaReserved: integer("delta_reserved").notNull(),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    reasonCode: text("reason_code").notNull(),
    actorId: uuid("actor_id").references(() => users.id),
    correlationId: text("correlation_id").notNull(),
  },
  (t) => [
    index("ledger_batch_idx").on(t.batchId),
    // Demand statistics: SHIP rows per SKU over a trailing window.
    index("ledger_demand_idx").on(t.skuId, t.occurredAt).where(sql`${t.entryType} = 'SHIP'`),
    index("ledger_ref_idx").on(t.referenceType, t.referenceId),
    check("ledger_nonzero_ck", sql`${t.deltaAvailable} <> 0 OR ${t.deltaReserved} <> 0`),
  ],
);

/** A reservation of stock from one batch for one fulfillment line. Release is also a ledger entry. */
export const reservations = pgTable(
  "reservations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    batchId: bigint("batch_id", { mode: "number" }).notNull().references(() => inventoryBatches.id),
    skuId: integer("sku_id").notNull().references(() => skus.id),
    qty: integer("qty").notNull(),
    status: reservationStatus("status").notNull().default("ACTIVE"),
    /** Opaque owner reference, e.g. fulfillment_lines:<id>. Inventory does not know order tables. */
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("reservations_qty_ck", sql`${t.qty} > 0`),
    index("reservations_owner_idx").on(t.ownerType, t.ownerId).where(sql`${t.status} = 'ACTIVE'`),
    index("reservations_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'ACTIVE'`),
  ],
);

export const purchaseRequisitions = pgTable(
  "purchase_requisitions",
  {
    id: serial("id").primaryKey(),
    skuId: integer("sku_id").notNull().references(() => skus.id),
    qty: integer("qty").notNull(),
    status: requisitionStatus("status").notNull().default("OPEN"),
    ropAtCreation: numeric("rop_at_creation", { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Auto-requisition idempotency: at most one OPEN requisition per SKU (CLAUDE.md §5.1).
    uniqueIndex("requisitions_open_sku_uq").on(t.skuId).where(sql`${t.status} = 'OPEN'`),
    check("requisitions_qty_ck", sql`${t.qty} > 0`),
  ],
);

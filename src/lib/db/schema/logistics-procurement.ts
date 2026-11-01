import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { carrierMode, poStatus, selectionRule, shipmentPriority, shipmentStatus } from "./enums";
import { purchaseRequisitions, skus } from "./inventory";
import { fulfillmentOrders } from "./orders";

export const carriers = pgTable(
  "carriers",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    mode: carrierMode("mode").notNull(),
    active: boolean("active").notNull().default(true),
    hazmatCertified: boolean("hazmat_certified").notNull().default(false),
    maxWeightLbs: numeric("max_weight_lbs", { precision: 10, scale: 2 }).notNull(),
    maxDimensionIn: numeric("max_dimension_in", { precision: 8, scale: 2 }).notNull(),
    baseCostCents: bigint("base_cost_cents", { mode: "number" }).notNull(),
    costPerLbCents: bigint("cost_per_lb_cents", { mode: "number" }).notNull(),
    transitDays: integer("transit_days").notNull(),
    /** On-time probability in [0,1]. */
    reliability: numeric("reliability", { precision: 4, scale: 3 }).notNull(),
  },
  (t) => [
    uniqueIndex("carriers_code_uq").on(t.code),
    index("carriers_active_idx").on(t.mode).where(sql`${t.active}`),
    check("carriers_reliability_ck", sql`${t.reliability} BETWEEN 0 AND 1`),
    check("carriers_transit_ck", sql`${t.transitDays} > 0`),
  ],
);

export const shipments = pgTable(
  "shipments",
  {
    id: serial("id").primaryKey(),
    fulfillmentOrderId: integer("fulfillment_order_id").notNull().references(() => fulfillmentOrders.id),
    carrierId: integer("carrier_id").notNull().references(() => carriers.id),
    status: shipmentStatus("status").notNull().default("BOOKED"),
    priority: shipmentPriority("priority").notNull(),
    selectionRule: selectionRule("selection_rule").notNull(),
    weightLbs: numeric("weight_lbs", { precision: 10, scale: 2 }).notNull(),
    deliveryWindowDays: integer("delivery_window_days").notNull(),
    costCents: bigint("cost_cents", { mode: "number" }).notNull(),
    trackingNumber: text("tracking_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shipments_fulfillment_uq").on(t.fulfillmentOrderId),
    uniqueIndex("shipments_tracking_uq").on(t.trackingNumber),
    index("shipments_list_idx").on(t.createdAt, t.id),
    check("shipments_cost_ck", sql`${t.costCents} >= 0`),
  ],
);

export const vendors = pgTable("vendors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
});

export const vendorContracts = pgTable(
  "vendor_contracts",
  {
    id: serial("id").primaryKey(),
    vendorId: integer("vendor_id").notNull().references(() => vendors.id),
    skuId: integer("sku_id").notNull().references(() => skus.id),
    /** 1 Primary, 2 Secondary, 3 Spot. */
    hierarchyTier: smallint("hierarchy_tier").notNull(),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
    leadTimeDays: integer("lead_time_days").notNull(),
    /** Max units this vendor can supply on one PO. */
    maxQtyPerOrder: integer("max_qty_per_order").notNull(),
    /** Longest lead time the buyer tolerates for this contract; failing it cascades to the next tier. */
    maxAcceptableLeadDays: integer("max_acceptable_lead_days").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("vendor_contracts_uq").on(t.skuId, t.vendorId),
    // Cascade read path: ORDER BY hierarchy_tier for a SKU.
    index("vendor_contracts_tier_idx").on(t.skuId, t.hierarchyTier).where(sql`${t.active}`),
    check("vendor_contracts_tier_ck", sql`${t.hierarchyTier} IN (1,2,3)`),
    check("vendor_contracts_qty_ck", sql`${t.maxQtyPerOrder} > 0`),
  ],
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: serial("id").primaryKey(),
    poNumber: text("po_number").notNull(),
    vendorId: integer("vendor_id").notNull().references(() => vendors.id),
    requisitionId: integer("requisition_id").references(() => purchaseRequisitions.id),
    status: poStatus("status").notNull(),
    hierarchyTier: smallint("hierarchy_tier").notNull(),
    totalCostCents: bigint("total_cost_cents", { mode: "number" }).notNull(),
    /** NULL = system-generated (auto-requisition). */
    requestedBy: uuid("requested_by").references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvalReasonCode: text("approval_reason_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("po_number_uq").on(t.poNumber),
    index("po_list_idx").on(t.createdAt, t.id),
    index("po_vendor_day_idx").on(t.vendorId, t.createdAt),
    // One PO per requisition (idempotent conversion).
    uniqueIndex("po_requisition_uq").on(t.requisitionId).where(sql`${t.requisitionId} IS NOT NULL`),
    check("po_total_ck", sql`${t.totalCostCents} >= 0`),
    // Separation of duties enforced by the database too (CLAUDE.md §4.7).
    check("po_sod_ck", sql`${t.approvedBy} IS NULL OR ${t.requestedBy} IS NULL OR ${t.approvedBy} <> ${t.requestedBy}`),
    check("po_approval_pair_ck", sql`(${t.approvedBy} IS NULL) = (${t.approvedAt} IS NULL)`),
    check(
      "po_manual_approval_ck",
      sql`${t.status} NOT IN ('APPROVED_AND_DISPATCHED') OR ${t.approvedBy} IS NOT NULL OR (${t.hierarchyTier} < 3 AND ${t.approvalReasonCode} = 'AUTO_BELOW_THRESHOLD')`,
    ),
  ],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: serial("id").primaryKey(),
    purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id),
    skuId: integer("sku_id").notNull().references(() => skus.id),
    qty: integer("qty").notNull(),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
    lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
    qtyReceived: integer("qty_received").notNull().default(0),
  },
  (t) => [
    index("po_lines_po_idx").on(t.purchaseOrderId),
    index("po_lines_sku_idx").on(t.skuId),
    check("po_lines_qty_ck", sql`${t.qty} > 0`),
    check("po_lines_received_ck", sql`${t.qtyReceived} BETWEEN 0 AND ${t.qty}`),
    check("po_lines_total_ck", sql`${t.lineTotalCents} = ${t.unitCostCents} * ${t.qty}`),
  ],
);

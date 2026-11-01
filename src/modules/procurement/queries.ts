import "server-only";
import { cache } from "react";
import { desc, eq, sql } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { purchaseOrders, vendors } from "@/lib/db/schema";
import type { VendorOption } from "./rules";

/**
 * Units already on order per SKU: Σ(qty − qty_received) over open POs (pending approval or dispatched).
 * Matches inventory's `OnOrderLookup` port, which lets inventory stay independent of this module's tables.
 */
export async function getOnOrderQty(db: DbOrTx, skuIds: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (skuIds.length === 0) return out;
  const rows = await db.execute<{ sku_id: number; qty: number }>(sql`
    SELECT l.sku_id, SUM(l.qty - l.qty_received)::int AS qty
    FROM purchase_order_lines l
    JOIN purchase_orders p ON p.id = l.purchase_order_id
    WHERE p.status IN ('PENDING_BUYER_APPROVAL', 'PENDING_MANAGER_APPROVAL', 'APPROVED_AND_DISPATCHED')
      AND l.sku_id IN (${sql.join(skuIds.map((n) => sql`${n}::int`), sql`, `)})
    GROUP BY l.sku_id`);
  for (const r of rows) out.set(r.sku_id, r.qty);
  return out;
}

/** Vendor contracts for a SKU in cascade order: `ORDER BY hierarchy_tier ASC` (1 Primary, 2 Secondary, 3 Spot). */
export async function getVendorOptions(db: DbOrTx, skuId: number): Promise<VendorOption[]> {
  const rows = await db.execute<{
    contract_id: number;
    vendor_id: number;
    hierarchy_tier: number;
    unit_cost_cents: string;
    lead_time_days: number;
    max_qty_per_order: number;
    max_acceptable_lead_days: number;
  }>(sql`
    SELECT c.id AS contract_id, c.vendor_id, c.hierarchy_tier, c.unit_cost_cents, c.lead_time_days,
           c.max_qty_per_order, c.max_acceptable_lead_days
    FROM vendor_contracts c JOIN vendors v ON v.id = c.vendor_id AND v.active
    WHERE c.sku_id = ${skuId}::int AND c.active
    ORDER BY c.hierarchy_tier ASC, c.id ASC`);
  return rows.map((r) => ({
    contractId: r.contract_id,
    vendorId: r.vendor_id,
    hierarchyTier: r.hierarchy_tier as 1 | 2 | 3,
    unitCostCents: Number(r.unit_cost_cents),
    leadTimeDays: r.lead_time_days,
    maxQtyPerOrder: r.max_qty_per_order,
    maxAcceptableLeadDays: r.max_acceptable_lead_days,
  }));
}

/**
 * SPLIT-PO GUARD (CLAUDE.md §5.4, D-14): Σ line totals of OPEN (not rejected/cancelled) POs for the same vendor,
 * touching the same SKUs, created on the same business-timezone calendar day. Computed in SQL; `dayISO` injected.
 * Served by po_vendor_day_idx + po_lines_sku_idx.
 */
export async function getSameDayOpenCost(
  db: DbOrTx,
  a: { vendorId: number; skuIds: readonly number[]; dayISO: string; tz: string },
): Promise<number> {
  if (a.skuIds.length === 0) return 0;
  const rows = await db.execute<{ total: string | null }>(sql`
    SELECT COALESCE(SUM(l.line_total_cents), 0) AS total
    FROM purchase_orders p
    JOIN purchase_order_lines l ON l.purchase_order_id = p.id
    WHERE p.vendor_id = ${a.vendorId}::int
      AND p.status NOT IN ('REJECTED', 'CANCELLED')
      AND (p.created_at AT TIME ZONE ${a.tz})::date = ${a.dayISO}::date
      AND l.sku_id IN (${sql.join(a.skuIds.map((n) => sql`${n}::int`), sql`, `)})`);
  return Number(rows[0]?.total ?? 0);
}

export interface PoRow {
  id: number;
  poNumber: string;
  vendorName: string;
  status: string;
  hierarchyTier: number;
  totalCostCents: number;
  requestedBy: string | null;
  approvedBy: string | null;
  createdAt: Date;
}

export async function listPurchaseOrders(db: DbOrTx, opts: { cursor?: string; limit: number }) {
  const [iso, idStr] = (opts.cursor ?? "").split("|");
  const id = Number(idStr);
  const hasCursor = !!iso && Number.isInteger(id) && !Number.isNaN(Date.parse(iso));
  const rows = await db
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      vendorName: vendors.name,
      status: purchaseOrders.status,
      hierarchyTier: purchaseOrders.hierarchyTier,
      totalCostCents: purchaseOrders.totalCostCents,
      requestedBy: purchaseOrders.requestedBy,
      approvedBy: purchaseOrders.approvedBy,
      createdAt: purchaseOrders.createdAt,
    })
    .from(purchaseOrders)
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(hasCursor ? sql`(${purchaseOrders.createdAt}, ${purchaseOrders.id}) < (${iso}::timestamptz, ${id}::int)` : sql`true`)
    .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id))
    .limit(opts.limit + 1);
  const page: PoRow[] = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > opts.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null };
}

export const getPurchaseOrders = cache((cursor: string | undefined, limit: number) =>
  listPurchaseOrders(getDb(), cursor === undefined ? { limit } : { cursor, limit }),
);


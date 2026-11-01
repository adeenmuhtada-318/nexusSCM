import "server-only";
import { cache } from "react";
import { asc, desc, eq, sql } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { carriers, shipments } from "@/lib/db/schema";
import type { CarrierRecord } from "./adapter";

export interface ShipmentCriteria {
  weightLbs: number;
  maxDimensionIn: number;
  hazmat: boolean;
  deliveryWindowDays: number;
}

/**
 * COMPLIANCE FILTER — runs FIRST, in SQL (CLAUDE.md §5.3): drops carriers that are inactive, lack hazmat
 * certification when needed, cannot carry the weight / longest dimension, or cannot deliver inside the window
 * (transit_days <= window). Parameterised; served by carriers_active_idx.
 */
export async function getEligibleCarriers(db: DbOrTx, c: ShipmentCriteria): Promise<CarrierRecord[]> {
  const rows = await db.execute<{
    id: number;
    code: string;
    mode: CarrierRecord["mode"];
    base_cost_cents: string;
    cost_per_lb_cents: string;
    transit_days: number;
    reliability: string;
  }>(sql`
    SELECT id, code, mode, base_cost_cents, cost_per_lb_cents, transit_days, reliability
    FROM carriers
    WHERE active
      AND (NOT ${c.hazmat}::boolean OR hazmat_certified)
      AND max_weight_lbs >= ${c.weightLbs.toFixed(2)}::numeric
      AND max_dimension_in >= ${c.maxDimensionIn.toFixed(2)}::numeric
      AND transit_days <= ${c.deliveryWindowDays}::int
    ORDER BY id`);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    mode: r.mode,
    baseCostCents: Number(r.base_cost_cents),
    costPerLbCents: Number(r.cost_per_lb_cents),
    transitDays: r.transit_days,
    reliability: Number(r.reliability),
  }));
}

export interface ShipmentRow {
  id: number;
  fulfillmentOrderId: number;
  carrierCode: string;
  status: string;
  priority: string;
  selectionRule: string;
  weightLbs: string;
  costCents: number;
  trackingNumber: string;
  createdAt: Date;
}

/** Newest-first keyset page: cursor = `<iso>|<id>`. */
export async function listShipments(db: DbOrTx, opts: { cursor?: string; limit: number }) {
  const [iso, idStr] = (opts.cursor ?? "").split("|");
  const id = Number(idStr);
  const hasCursor = !!iso && Number.isInteger(id) && !Number.isNaN(Date.parse(iso));
  const rows = await db
    .select({
      id: shipments.id,
      fulfillmentOrderId: shipments.fulfillmentOrderId,
      carrierCode: carriers.code,
      status: shipments.status,
      priority: shipments.priority,
      selectionRule: shipments.selectionRule,
      weightLbs: shipments.weightLbs,
      costCents: shipments.costCents,
      trackingNumber: shipments.trackingNumber,
      createdAt: shipments.createdAt,
    })
    .from(shipments)
    .innerJoin(carriers, sql`${carriers.id} = ${shipments.carrierId}`)
    .where(hasCursor ? sql`(${shipments.createdAt}, ${shipments.id}) < (${iso}::timestamptz, ${id}::int)` : sql`true`)
    .orderBy(desc(shipments.createdAt), desc(shipments.id))
    .limit(opts.limit + 1);
  const page: ShipmentRow[] = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > opts.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null };
}

export const getShipments = cache((cursor: string | undefined, limit: number) =>
  listShipments(getDb(), cursor === undefined ? { limit } : { cursor, limit }),
);

export const getActiveCarriers = cache(async () =>
  getDb()
    .select({
      id: carriers.id,
      code: carriers.code,
      name: carriers.name,
      mode: carriers.mode,
      hazmatCertified: carriers.hazmatCertified,
      maxWeightLbs: carriers.maxWeightLbs,
      maxDimensionIn: carriers.maxDimensionIn,
      baseCostCents: carriers.baseCostCents,
      costPerLbCents: carriers.costPerLbCents,
      transitDays: carriers.transitDays,
      reliability: carriers.reliability,
    })
    .from(carriers)
    .where(eq(carriers.active, true))
    .orderBy(asc(carriers.mode), asc(carriers.code))
    .limit(50),
);

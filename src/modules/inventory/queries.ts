import "server-only";
import { cache } from "react";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { inventoryBatches, purchaseRequisitions, skus, warehouses } from "@/lib/db/schema";
import { loadBusinessRules } from "@/lib/config/business-rules";
import { BUSINESS_TZ_DEFAULT, localDate } from "@/lib/utils/dates";
import { getEnv } from "@/lib/config/env";
import { minAcceptableExpiry } from "./rules";

export interface SkuInfo {
  id: number;
  code: string;
  name: string;
  category: string;
  active: boolean;
  isPerishable: boolean;
  shelfLifeDays: number | null;
  isHazmat: boolean;
  weightLbs: number;
  maxDimensionIn: number;
  listPriceCents: number;
}

/** SKU master data for other modules (orders needs price/hazmat/weight; it must not read `skus` itself). */
export async function getSkuInfos(db: DbOrTx, ids: readonly number[]): Promise<SkuInfo[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: skus.id,
      code: skus.code,
      name: skus.name,
      category: skus.category,
      active: skus.active,
      isPerishable: skus.isPerishable,
      shelfLifeDays: skus.shelfLifeDays,
      isHazmat: skus.isHazmat,
      weightLbs: skus.weightLbs,
      maxDimensionIn: skus.maxDimensionIn,
      listPriceCents: skus.listPriceCents,
    })
    .from(skus)
    .where(inArray(skus.id, [...ids]))
    .orderBy(asc(skus.id));
  return rows.map((r) => ({ ...r, weightLbs: Number(r.weightLbs), maxDimensionIn: Number(r.maxDimensionIn) }));
}

/** Business-timezone calendar date for `now` (the warehouse/business's declared tz, CLAUDE.md §4.2). */
export function businessToday(now: Date): string {
  return localDate(now, getEnv().BUSINESS_TIMEZONE ?? BUSINESS_TZ_DEFAULT);
}

/**
 * Earliest acceptable expiry per perishable SKU (rules.minAcceptableExpiry, single source of truth).
 * Non-perishables are absent from the map ⇒ no expiry filter.
 */
export function expiryCutoffs(infos: readonly SkuInfo[], todayISO: string, minShelfLifePct: number): Map<number, string> {
  const m = new Map<number, string>();
  for (const s of infos) {
    if (s.isPerishable && s.shelfLifeDays !== null) m.set(s.id, minAcceptableExpiry(todayISO, s.shelfLifeDays, minShelfLifePct));
  }
  return m;
}

export interface WarehouseAvailability {
  id: number;
  code: string;
  name: string;
  distanceKm: number | null;
  /** skuId → allocatable PRIME units (non-expired, shelf-life ok). */
  available: Record<number, number>;
}

export interface AvailabilityContext {
  warehouses: WarehouseAvailability[];
  /** skuId → units in QUARANTINE_* zones. */
  quarantinedBySku: Record<number, number>;
}

/**
 * Haversine great-circle distance in KILOMETRES, in SQL (mean Earth radius 6371.0088 km). LEAST(1, …) guards
 * asin() against floating-point overshoot at antipodal points. Result ordered nearest-first, id as tie-break.
 */
export async function rankWarehousesByDistance(
  db: DbOrTx,
  dest: { lat: number; lng: number },
): Promise<{ id: number; code: string; name: string; distanceKm: number }[]> {
  const rows = await db.execute<{ id: number; code: string; name: string; distance_km: number }>(sql`
    SELECT w.id, w.code, w.name,
           (2 * 6371.0088 * asin(LEAST(1.0, sqrt(
              power(sin(radians(w.lat - ${dest.lat}::float8) / 2), 2) +
              cos(radians(${dest.lat}::float8)) * cos(radians(w.lat)) *
              power(sin(radians(w.lng - ${dest.lng}::float8) / 2), 2)
           ))))::float8 AS distance_km
    FROM warehouses w
    WHERE w.active
    ORDER BY distance_km ASC, w.id ASC`);
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, distanceKm: r.distance_km }));
}

/**
 * Allocatable availability per active warehouse for the given SKUs, plus quarantined quantities, with set-based SQL.
 * Only PRIME stock counts; perishables additionally need expiry_date >= cutoff (expired / short-dated excluded).
 * Served by batches_fifo_idx / batches_fefo_idx (partial, qty_available > 0).
 */
export async function getAvailabilityContext(
  db: DbOrTx,
  args: { infos: readonly SkuInfo[]; dest: { lat: number; lng: number } | null; now: Date; minShelfLifePct: number },
): Promise<AvailabilityContext> {
  const ids = args.infos.map((s) => s.id);
  const ranked = args.dest
    ? await rankWarehousesByDistance(db, args.dest)
    : (
        await db
          .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
          .from(warehouses)
          .where(eq(warehouses.active, true))
          .orderBy(asc(warehouses.id))
      ).map((w) => ({ ...w, distanceKm: null as number | null }));
  const out = new Map<number, WarehouseAvailability>(
    ranked.map((w) => [w.id, { id: w.id, code: w.code, name: w.name, distanceKm: w.distanceKm, available: {} }]),
  );
  const quarantinedBySku: Record<number, number> = {};
  if (ids.length === 0) return { warehouses: [...out.values()], quarantinedBySku };

  const cutoffs = expiryCutoffs(args.infos, businessToday(args.now), args.minShelfLifePct);
  const values = sql.join(ids.map((id) => sql`(${id}::int, ${cutoffs.get(id) ?? null}::date)`), sql`, `);

  const prime = await db.execute<{ warehouse_id: number; sku_id: number; qty: number }>(sql`
    WITH c(sku_id, cutoff) AS (VALUES ${values})
    SELECT b.warehouse_id, b.sku_id, SUM(b.qty_available)::int AS qty
    FROM inventory_batches b
    JOIN c ON c.sku_id = b.sku_id AND (c.cutoff IS NULL OR b.expiry_date >= c.cutoff)
    JOIN warehouses w ON w.id = b.warehouse_id AND w.active
    WHERE b.zone_status = 'PRIME' AND b.qty_available > 0
    GROUP BY b.warehouse_id, b.sku_id`);
  for (const r of prime) {
    const w = out.get(r.warehouse_id);
    if (w) w.available[r.sku_id] = r.qty;
  }

  const quarantined = await db
    .select({ skuId: inventoryBatches.skuId, qty: sql<number>`SUM(${inventoryBatches.qtyAvailable})::int` })
    .from(inventoryBatches)
    .where(and(inArray(inventoryBatches.skuId, ids), sql`${inventoryBatches.zoneStatus} <> 'PRIME'`, gt(inventoryBatches.qtyAvailable, 0)))
    .groupBy(inventoryBatches.skuId);
  for (const q of quarantined) quarantinedBySku[q.skuId] = q.qty;

  return { warehouses: [...out.values()], quarantinedBySku };
}

export interface ReplenishmentSignal {
  skuId: number;
  code: string;
  name: string;
  isPerishable: boolean;
  /** L_avg in days. */
  leadTimeDays: number;
  /** D_avg in units/day over the trailing window (zero-demand days included). */
  dAvg: number;
  /** σ_d in units/day (sample standard deviation). */
  sigmaD: number;
  qtyAvailable: number;
  qtyReserved: number;
  qtyQuarantined: number;
  hasOpenRequisition: boolean;
}

/**
 * Per-SKU stock + demand statistics for ROP, computed ENTIRELY in SQL over the ledger (CLAUDE.md §5.1/§3.3):
 * D_avg = mean and σ_d = sample stddev of daily SHIP quantity (units/day) across every calendar day of the trailing
 * window in the business timezone (zero days included via generate_series). Keyset-paginated by sku id (`afterSkuId`).
 * `todayISO` is injected, so the result is deterministic for a given ledger.
 */
export async function getReplenishmentSignals(
  db: DbOrTx,
  args: { afterSkuId: number; limit: number; todayISO: string; windowDays: number; tz: string },
): Promise<ReplenishmentSignal[]> {
  const rows = await db.execute<{
    sku_id: number;
    code: string;
    name: string;
    is_perishable: boolean;
    l_avg: number;
    d_avg: number;
    sigma_d: number;
    qty_available: number;
    qty_reserved: number;
    qty_quarantined: number;
    has_open_requisition: boolean;
  }>(sql`
    WITH cfg AS (
      SELECT ${args.todayISO}::date AS today, ${args.windowDays}::int AS win, ${args.tz}::text AS tz
    ),
    page AS (
      SELECT id, code, name, is_perishable, lead_time_days_avg
      FROM skus WHERE active AND id > ${args.afterSkuId}::int ORDER BY id LIMIT ${args.limit}::int
    ),
    days AS (
      SELECT generate_series(cfg.today - (cfg.win - 1), cfg.today, interval '1 day')::date AS d FROM cfg
    ),
    daily AS (
      SELECT l.sku_id, (l.occurred_at AT TIME ZONE cfg.tz)::date AS d, SUM(-l.delta_reserved)::int AS qty
      FROM inventory_ledger l
      JOIN page p ON p.id = l.sku_id
      CROSS JOIN cfg
      WHERE l.entry_type = 'SHIP'
        AND l.occurred_at >= ((cfg.today - (cfg.win - 1))::timestamp AT TIME ZONE cfg.tz)
      GROUP BY 1, 2
    ),
    stats AS (
      SELECT p.id AS sku_id,
             AVG(COALESCE(dl.qty, 0))::float8 AS d_avg,
             COALESCE(STDDEV_SAMP(COALESCE(dl.qty, 0)), 0)::float8 AS sigma_d
      FROM page p CROSS JOIN days dd LEFT JOIN daily dl ON dl.sku_id = p.id AND dl.d = dd.d
      GROUP BY p.id
    ),
    stock AS (
      SELECT b.sku_id,
             COALESCE(SUM(b.qty_available) FILTER (WHERE b.zone_status = 'PRIME'), 0)::int AS avail,
             COALESCE(SUM(b.qty_reserved), 0)::int AS reserved,
             COALESCE(SUM(b.qty_available) FILTER (WHERE b.zone_status <> 'PRIME'), 0)::int AS quarantined
      FROM inventory_batches b JOIN page p ON p.id = b.sku_id
      GROUP BY b.sku_id
    )
    SELECT p.id AS sku_id, p.code, p.name, p.is_perishable, p.lead_time_days_avg::float8 AS l_avg,
           st.d_avg, st.sigma_d,
           COALESCE(sk.avail, 0) AS qty_available, COALESCE(sk.reserved, 0) AS qty_reserved,
           COALESCE(sk.quarantined, 0) AS qty_quarantined,
           EXISTS (SELECT 1 FROM purchase_requisitions r WHERE r.sku_id = p.id AND r.status = 'OPEN') AS has_open_requisition
    FROM page p JOIN stats st ON st.sku_id = p.id LEFT JOIN stock sk ON sk.sku_id = p.id
    ORDER BY p.id`);
  return rows.map((r) => ({
    skuId: r.sku_id,
    code: r.code,
    name: r.name,
    isPerishable: r.is_perishable,
    leadTimeDays: r.l_avg,
    dAvg: r.d_avg,
    sigmaD: r.sigma_d,
    qtyAvailable: r.qty_available,
    qtyReserved: r.qty_reserved,
    qtyQuarantined: r.qty_quarantined,
    hasOpenRequisition: r.has_open_requisition,
  }));
}

export interface LedgerMismatch {
  batchId: number;
  qtyAvailable: number;
  qtyReserved: number;
  ledgerAvailable: number;
  ledgerReserved: number;
  activeReservations: number;
}

/**
 * RECONCILIATION (CLAUDE.md §4.8): batch qty_available / qty_reserved must equal the signed-ledger sums, and
 * qty_reserved must equal the sum of ACTIVE reservations. Returns offending batches (empty ⇒ consistent).
 */
export async function reconcileLedger(db: DbOrTx, limit = 100): Promise<LedgerMismatch[]> {
  const rows = await db.execute<{
    batch_id: string | number;
    qty_available: number;
    qty_reserved: number;
    led_avail: number;
    led_res: number;
    active_res: number;
  }>(sql`
    SELECT b.id AS batch_id, b.qty_available, b.qty_reserved,
           COALESCE(l.avail, 0)::int AS led_avail, COALESCE(l.res, 0)::int AS led_res,
           COALESCE(r.active, 0)::int AS active_res
    FROM inventory_batches b
    LEFT JOIN (SELECT batch_id, SUM(delta_available) AS avail, SUM(delta_reserved) AS res
               FROM inventory_ledger GROUP BY batch_id) l ON l.batch_id = b.id
    LEFT JOIN (SELECT batch_id, SUM(qty) AS active FROM reservations WHERE status = 'ACTIVE' GROUP BY batch_id) r ON r.batch_id = b.id
    WHERE b.qty_available <> COALESCE(l.avail, 0) OR b.qty_reserved <> COALESCE(l.res, 0)
       OR b.qty_reserved <> COALESCE(r.active, 0)
    ORDER BY b.id
    LIMIT ${limit}::int`);
  return rows.map((r) => ({
    batchId: Number(r.batch_id), // bigint comes back as string from postgres-js
    qtyAvailable: r.qty_available,
    qtyReserved: r.qty_reserved,
    ledgerAvailable: r.led_avail,
    ledgerReserved: r.led_res,
    activeReservations: r.active_res,
  }));
}

export interface OpenRequisitionRow {
  id: number;
  skuId: number;
  skuCode: string;
  qty: number;
  createdAt: Date;
}

/** OPEN purchase requisitions, oldest first, keyset-paginated by id. */
export async function listOpenRequisitions(db: DbOrTx, opts: { afterId: number; limit: number }): Promise<OpenRequisitionRow[]> {
  return db
    .select({ id: purchaseRequisitions.id, skuId: purchaseRequisitions.skuId, skuCode: skus.code, qty: purchaseRequisitions.qty, createdAt: purchaseRequisitions.createdAt })
    .from(purchaseRequisitions)
    .innerJoin(skus, eq(skus.id, purchaseRequisitions.skuId))
    .where(and(eq(purchaseRequisitions.status, "OPEN"), gt(purchaseRequisitions.id, opts.afterId)))
    .orderBy(asc(purchaseRequisitions.id))
    .limit(opts.limit);
}

export async function listWarehouses(db: DbOrTx) {
  return db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name, active: warehouses.active })
    .from(warehouses)
    .orderBy(asc(warehouses.id));
}

export async function getStockPage(db: DbOrTx, opts: { afterSkuId: number; limit: number; now: Date }) {
  const rules = await loadBusinessRules(db, opts.now);
  const signals = await getReplenishmentSignals(db, {
    afterSkuId: opts.afterSkuId,
    limit: opts.limit + 1,
    todayISO: businessToday(opts.now),
    windowDays: rules.demandWindowDays,
    tz: getEnv().BUSINESS_TIMEZONE,
  });
  const rows = signals.slice(0, opts.limit);
  const last = rows[rows.length - 1];
  return { rows, nextCursor: signals.length > opts.limit && last ? last.skuId : null, rules };
}

export const getStockOverview = cache((afterSkuId: number, limit: number) => getStockPage(getDb(), { afterSkuId, limit, now: new Date() }));

export const getWarehouseOptions = cache(() => listWarehouses(getDb()));
export const getOpenRequisitionList = cache((limit = 50) => listOpenRequisitions(getDb(), { afterId: 0, limit }));
export const getActiveSkus = cache(async () =>
  getDb()
    .select({
      id: skus.id,
      code: skus.code,
      name: skus.name,
      isPerishable: skus.isPerishable,
      isHazmat: skus.isHazmat,
      listPriceCents: skus.listPriceCents,
    })
    .from(skus)
    .where(eq(skus.active, true))
    .orderBy(asc(skus.code))
    .limit(200),
);
export const getRecentBatches = cache(async (limit = 30) =>
  getDb()
    .select({
      id: inventoryBatches.id,
      skuCode: skus.code,
      warehouseCode: warehouses.code,
      zoneStatus: inventoryBatches.zoneStatus,
      qtyAvailable: inventoryBatches.qtyAvailable,
      qtyReserved: inventoryBatches.qtyReserved,
      expiryDate: inventoryBatches.expiryDate,
      lotCode: inventoryBatches.lotCode,
      receivedAt: inventoryBatches.receivedAt,
    })
    .from(inventoryBatches)
    .innerJoin(skus, eq(skus.id, inventoryBatches.skuId))
    .innerJoin(warehouses, eq(warehouses.id, inventoryBatches.warehouseId))
    .orderBy(desc(inventoryBatches.id))
    .limit(limit),
);


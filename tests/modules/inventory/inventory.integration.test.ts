import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/lib/db";
import { runTransaction } from "@/lib/db/tx";
import {
  adjustBatch,
  getAvailabilityContext,
  getSkuInfos,
  receiveStock,
  reconcileLedger,
  releaseReservations,
  fulfillReservations,
  reserveStock,
  createRequisition,
  rankWarehousesByDistance,
} from "@/modules/inventory";
import { DomainError } from "@/lib/utils/errors";
import { makeSku, makeWarehouse, uid } from "../../helpers/fixtures";

afterAll(async () => {
  await closeDb();
});

const SYSTEM = { type: "SYSTEM" } as const;
const NOW = new Date("2026-06-15T12:00:00Z");

async function receive(skuId: number, warehouseId: number, qty: number, o: { zone?: "PRIME" | "QUARANTINE_QUALITY"; expiry?: string | null; receivedAt?: Date } = {}) {
  return runTransaction((tx) =>
    receiveStock(tx, {
      skuId, warehouseId, qty, zone: o.zone ?? "PRIME", entryType: "RECEIPT",
      expiryDate: o.expiry ?? null, lotCode: `L-${uid()}`, reasonCode: "TEST",
      ...(o.receivedAt ? { receivedAt: o.receivedAt } : {}),
      actor: SYSTEM, correlationId: "t",
    }),
  );
}

const reserve = (skuId: number, warehouseId: number, qty: number, ownerId: string) =>
  runTransaction((tx) =>
    reserveStock(tx, { skuId, warehouseId, qty, ownerType: "test", ownerId, expiresAt: null, minShelfLifePct: 20, now: NOW, actor: SYSTEM, correlationId: "t" }),
  );

async function batchRow(batchId: number) {
  const r = await getDb().execute<{ qty_available: number; qty_reserved: number }>(sql`SELECT qty_available, qty_reserved FROM inventory_batches WHERE id = ${batchId}`);
  return r[0];
}

describe("concurrency: parallel reservations (CLAUDE.md §6)", () => {
  it("N parallel reservers vs stock M<N: no negative stock, exactly M reserved, ledger reconciles", async () => {
    const M = 7;
    const N = 25;
    const wh = await makeWarehouse(40, -74);
    const sku = await makeSku();
    // Spread stock across several batches to exercise multi-batch locking.
    for (const q of [3, 2, 2]) await receive(sku, wh, q);

    const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => reserve(sku, wh, 1, `conc-${sku}-${i}`)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(ok).toBe(M);
    expect(failed).toHaveLength(N - M);
    for (const f of failed) expect(f.reason).toBeInstanceOf(DomainError);
    for (const f of failed) expect((f.reason as DomainError).code).toBe("INSUFFICIENT_STOCK");

    const agg = await getDb().execute<{ avail: number; reserved: number; neg: number }>(sql`
      SELECT SUM(qty_available)::int AS avail, SUM(qty_reserved)::int AS reserved,
             COUNT(*) FILTER (WHERE qty_available < 0 OR qty_reserved < 0)::int AS neg
      FROM inventory_batches WHERE sku_id = ${sku}`);
    expect(agg[0]).toEqual({ avail: 0, reserved: M, neg: 0 });

    const ledger = await getDb().execute<{ d_avail: number; d_res: number }>(sql`
      SELECT SUM(delta_available)::int AS d_avail, SUM(delta_reserved)::int AS d_res FROM inventory_ledger WHERE sku_id = ${sku}`);
    expect(ledger[0]).toEqual({ d_avail: 0, d_res: M });

    const mismatches = await reconcileLedger(getDb(), 5000);
    const skuBatches = await getDb().execute<{ id: number }>(sql`SELECT id FROM inventory_batches WHERE sku_id = ${sku}`);
    const bad = new Set(mismatches.map((m) => m.batchId));
    for (const b of skuBatches) expect(bad.has(b.id)).toBe(false);
  });

  it("multi-line style: parallel reservers over two SKUs in ascending order never deadlock", async () => {
    const wh = await makeWarehouse(41, -73);
    const [a, b] = [await makeSku(), await makeSku()].sort((x, y) => x - y) as [number, number];
    await receive(a, wh, 10);
    await receive(b, wh, 10);
    const place = (i: number) =>
      runTransaction(async (tx) => {
        for (const s of [a, b]) {
          await reserveStock(tx, { skuId: s, warehouseId: wh, qty: 1, ownerType: "test", ownerId: `ml-${i}-${s}`, expiresAt: null, minShelfLifePct: 20, now: NOW, actor: SYSTEM, correlationId: "t" });
        }
      });
    const res = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => place(i)));
    expect(res.every((r) => r.status === "fulfilled")).toBe(true);
  });
});

describe("picking rules", () => {
  it("FIFO for non-perishables: oldest received batch first", async () => {
    const wh = await makeWarehouse(40, -74);
    const sku = await makeSku();
    const newer = await receive(sku, wh, 5, { receivedAt: new Date("2026-02-01T00:00:00Z") });
    const older = await receive(sku, wh, 5, { receivedAt: new Date("2026-01-01T00:00:00Z") });
    const r = await reserve(sku, wh, 6, `fifo-${sku}`);
    expect(r.map((x) => [x.batchId, x.qty])).toEqual([[older.batchId, 5], [newer.batchId, 1]]);
  });

  it("FEFO for perishables: earliest expiry first; expired and short-dated (<20% shelf life) excluded", async () => {
    const wh = await makeWarehouse(40, -74);
    const sku = await makeSku({ perishable: true, shelfLifeDays: 100 }); // min 20 days left; today = 2026-06-15
    await receive(sku, wh, 50, { expiry: "2026-06-10" }); // expired
    await receive(sku, wh, 50, { expiry: "2026-06-30" }); // 15 days left (<20) → excluded
    const late = await receive(sku, wh, 5, { expiry: "2026-09-01" });
    const soon = await receive(sku, wh, 5, { expiry: "2026-07-05" }); // exactly 20 days → allowed
    const r = await reserve(sku, wh, 7, `fefo-${sku}`);
    expect(r.map((x) => [x.batchId, x.qty])).toEqual([[soon.batchId, 5], [late.batchId, 2]]);
    await expect(reserve(sku, wh, 50, `fefo2-${sku}`)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  });

  it("QUARANTINE stock is never allocatable", async () => {
    const wh = await makeWarehouse(40, -74);
    const sku = await makeSku();
    await receive(sku, wh, 100, { zone: "QUARANTINE_QUALITY" });
    await expect(reserve(sku, wh, 1, `q-${sku}`)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    const infos = await getSkuInfos(getDb(), [sku]);
    const ctx = await getAvailabilityContext(getDb(), { infos, dest: null, now: NOW, minShelfLifePct: 20 });
    expect(ctx.quarantinedBySku[sku]).toBe(100);
    expect(ctx.warehouses.find((w) => w.id === wh)?.available[sku]).toBeUndefined();
  });

  it("availability honours the shelf-life rule too", async () => {
    const wh = await makeWarehouse(40, -74);
    const sku = await makeSku({ perishable: true, shelfLifeDays: 100 });
    await receive(sku, wh, 9, { expiry: "2026-06-20" }); // too short
    await receive(sku, wh, 4, { expiry: "2026-12-01" });
    const infos = await getSkuInfos(getDb(), [sku]);
    const ctx = await getAvailabilityContext(getDb(), { infos, dest: null, now: NOW, minShelfLifePct: 20 });
    expect(ctx.warehouses.find((w) => w.id === wh)?.available[sku]).toBe(4);
  });
});

describe("release / fulfil / adjust + reconciliation", () => {
  it("release returns stock, is idempotent, and is a ledger entry", async () => {
    const wh = await makeWarehouse(40, -74);
    const sku = await makeSku();
    const { batchId } = await receive(sku, wh, 10);
    const owner = `rel-${sku}`;
    await reserve(sku, wh, 4, owner);
    expect(await batchRow(batchId)).toEqual({ qty_available: 6, qty_reserved: 4 });
    const args = { ownerType: "test", ownerIds: [owner], reasonCode: "CANCEL", actor: SYSTEM, correlationId: "t" };
    expect(await runTransaction((tx) => releaseReservations(tx, args))).toBe(1);
    expect(await runTransaction((tx) => releaseReservations(tx, args))).toBe(0); // idempotent replay
    expect(await batchRow(batchId)).toEqual({ qty_available: 10, qty_reserved: 0 });
    const rel = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM inventory_ledger WHERE batch_id = ${batchId} AND entry_type = 'RELEASE'`);
    expect(rel[0]?.n).toBe(1);
  });

  it("fulfil removes reserved stock (SHIP) and reconciles", async () => {
    const wh = await makeWarehouse(40, -74);
    const sku = await makeSku();
    const { batchId } = await receive(sku, wh, 10);
    const owner = `ship-${sku}`;
    await reserve(sku, wh, 3, owner);
    await runTransaction((tx) => fulfillReservations(tx, { ownerType: "test", ownerIds: [owner], reasonCode: "SHIPPED", actor: SYSTEM, correlationId: "t" }));
    expect(await batchRow(batchId)).toEqual({ qty_available: 7, qty_reserved: 0 });
    expect((await reconcileLedger(getDb(), 5000)).some((m) => m.batchId === batchId)).toBe(false);
  });

  it("adjust cannot drive stock negative; valid adjustment reconciles", async () => {
    const wh = await makeWarehouse(40, -74);
    const sku = await makeSku();
    const { batchId } = await receive(sku, wh, 5);
    await expect(runTransaction((tx) => adjustBatch(tx, { batchId, delta: -6, reasonCode: "COUNT", actor: SYSTEM, correlationId: "t" }))).rejects.toMatchObject({ code: "CONFLICT" });
    await runTransaction((tx) => adjustBatch(tx, { batchId, delta: -2, reasonCode: "COUNT", actor: SYSTEM, correlationId: "t" }));
    expect(await batchRow(batchId)).toEqual({ qty_available: 3, qty_reserved: 0 });
    expect((await reconcileLedger(getDb(), 5000)).some((m) => m.batchId === batchId)).toBe(false);
  });

  it("reconciliation detects a drifted batch", async () => {
    const wh = await makeWarehouse(40, -74);
    const sku = await makeSku();
    const { batchId } = await receive(sku, wh, 5);
    await getDb().execute(sql`UPDATE inventory_batches SET qty_available = 6 WHERE id = ${batchId}`);
    const bad = await reconcileLedger(getDb(), 5000);
    expect(bad.find((m) => m.batchId === batchId)).toMatchObject({ qtyAvailable: 6, ledgerAvailable: 5 });
    await getDb().execute(sql`UPDATE inventory_batches SET qty_available = 5 WHERE id = ${batchId}`);
  });

  it("DB CHECK rejects negative stock even for raw writes", async () => {
    const wh = await makeWarehouse(40, -74);
    const sku = await makeSku();
    const { batchId } = await receive(sku, wh, 1);
    await expect(getDb().execute(sql`UPDATE inventory_batches SET qty_available = -1 WHERE id = ${batchId}`)).rejects.toThrow();
  });
});

describe("haversine + requisition idempotency", () => {
  it("ranks warehouses by great-circle km (NYC → Boston < Chicago < LA)", async () => {
    const tag = uid();
    const boston = await makeWarehouse(42.3601, -71.0589, `BOS-${tag}`);
    const chicago = await makeWarehouse(41.8781, -87.6298, `CHI-${tag}`);
    const la = await makeWarehouse(34.0522, -118.2437, `LAX-${tag}`);
    const ranked = (await rankWarehousesByDistance(getDb(), { lat: 40.7128, lng: -74.006 })).filter((w) => [boston, chicago, la].includes(w.id));
    expect(ranked.map((w) => w.id)).toEqual([boston, chicago, la]);
    const bos = ranked[0];
    expect(bos?.distanceKm).toBeGreaterThan(300);
    expect(bos?.distanceKm).toBeLessThan(310); // ≈ 306 km
  });

  it("createRequisition twice for one SKU creates exactly one OPEN requisition", async () => {
    const sku = await makeSku();
    const mk = () => runTransaction((tx) => createRequisition(tx, { skuId: sku, qty: 10, rop: 5, actor: SYSTEM, correlationId: "t" }));
    const [a, b] = await Promise.all([mk(), mk()]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
  });
});

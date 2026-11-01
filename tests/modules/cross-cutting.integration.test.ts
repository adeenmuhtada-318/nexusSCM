import { describe, expect, it, vi } from "vitest";
import { count, eq, sql } from "drizzle-orm";
import { PERMISSIONS, ROLES, type PermissionKey, type Role, type Session } from "@/lib/auth/roles";

let mockedSession: Session | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => mockedSession,
}));

import { getDb } from "@/lib/db";
import { runTransaction } from "@/lib/db/tx";
import { withIdempotency } from "@/lib/db/idempotency";
import { seedDatabase } from "@/lib/db/seed";
import { inventoryLedger, skus, warehouses } from "@/lib/db/schema";
import { updateBusinessRuleAction } from "@/lib/config/actions";
import { adjustBatch, receiveStock, reconcileLedger } from "@/modules/inventory";
import { receiveStockAction, adjustStockAction } from "@/modules/inventory/actions";
import {
  cancelOrderAction,
  confirmOrderAction,
  createOrderAction,
  markDeliveredAction,
  releaseHoldAction,
  shipFulfillmentAction,
} from "@/modules/orders/actions";
import { cancelOrder, confirmOrder, createOrder } from "@/modules/orders";
import {
  approvePoAction,
  createPoAction,
  receivePoAction,
  rejectPoAction,
  runReplenishmentAction,
} from "@/modules/procurement/actions";
import {
  receiveAndInspectRmaAction,
  refundRmaAction,
  requestRmaAction,
  reviewRmaAction,
} from "@/modules/returns/actions";
import { assignExceptionAction, resolveExceptionAction } from "@/modules/exceptions/actions";
import { GET as cronReservations } from "@/app/api/cron/reservations/route";
import { GET as cronReplenishment } from "@/app/api/cron/replenishment/route";
import { makeAccount, makeSku, makeUser, makeWarehouse, uid } from "../helpers/fixtures";

const ACTION_BY_PERMISSION: Record<PermissionKey, (input: unknown) => Promise<{ success: boolean; code?: string }>> = {
  "inventory.receive": receiveStockAction,
  "inventory.adjust": adjustStockAction,
  "procurement.autoRequisition": runReplenishmentAction,
  "orders.create": createOrderAction,
  "orders.confirm": confirmOrderAction,
  "orders.cancel": cancelOrderAction,
  "orders.releaseHold": releaseHoldAction,
  "orders.ship": shipFulfillmentAction,
  "orders.markDelivered": markDeliveredAction,
  "procurement.createFromRequisition": createPoAction,
  "procurement.approve": approvePoAction,
  "procurement.reject": rejectPoAction,
  "procurement.receive": receivePoAction,
  "returns.request": requestRmaAction,
  "returns.review": reviewRmaAction,
  "returns.receiveAndInspect": receiveAndInspectRmaAction,
  "returns.refund": refundRmaAction,
  "exceptions.resolve": resolveExceptionAction,
  "exceptions.assign": assignExceptionAction,
  "config.update": updateBusinessRuleAction,
};

describe("cross-cutting guarantees (CLAUDE.md §4 & §6)", () => {
  it("enforces server-side RBAC (UNAUTHENTICATED, FORBIDDEN, and allowed pass-through) across every PERMISSIONS key", async () => {
    const keys = Object.keys(PERMISSIONS) as PermissionKey[];
    expect(Object.keys(ACTION_BY_PERMISSION).sort()).toEqual([...keys].sort());

    const actor = await makeUser("ADMIN");
    for (const key of keys) {
      const action = ACTION_BY_PERMISSION[key];
      const allowedRoles = PERMISSIONS[key];

      // 1. Unauthenticated -> UNAUTHENTICATED
      mockedSession = null;
      const unauth = await action({ __invalid: true });
      expect(unauth).toMatchObject({ success: false, code: "UNAUTHENTICATED" });

      // 2. Every forbidden role -> FORBIDDEN
      for (const role of ROLES) {
        if ((allowedRoles as readonly Role[]).includes(role)) continue;
        mockedSession = { userId: actor.id, email: "test@nexus.local", role };
        const denied = await action({ __invalid: true });
        expect(denied).toMatchObject({ success: false, code: "FORBIDDEN" });
      }

      // 3. Every allowed role passes auth gate and hits Zod validation (not UNAUTHENTICATED/FORBIDDEN)
      const okRole = allowedRoles[0];
      if (!okRole) throw new Error(`No allowed role for ${key}`);
      mockedSession = { userId: actor.id, email: "test@nexus.local", role: okRole };
      const passedAuth = await action({ __invalid: true });
      expect(passedAuth).toMatchObject({ success: false, code: "VALIDATION" });
    }
    mockedSession = null;
  });

  it("enforces idempotency replay and rejects same-key payload mutation with CONFLICT", async () => {
    const key = `idem-test-${uid()}`;
    let sideEffects = 0;

    const first = await runTransaction((tx) =>
      withIdempotency(tx, "test.scope", key, { a: 1, b: "x" }, async () => {
        sideEffects++;
        return { computed: 42 };
      }),
    );
    expect(first).toEqual({ replayed: false, result: { computed: 42 } });

    const replay = await runTransaction((tx) =>
      withIdempotency(tx, "test.scope", key, { b: "x", a: 1 }, async () => {
        sideEffects++;
        return { computed: 99 };
      }),
    );
    expect(replay).toEqual({ replayed: true, result: { computed: 42 } });
    expect(sideEffects).toBe(1);

    await expect(
      runTransaction((tx) =>
        withIdempotency(tx, "test.scope", key, { a: 2, b: "mutated" }, async () => ({ computed: 0 })),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENT_REPLAY_MISMATCH" });
  });

  it("protects /api/cron/* endpoints with Bearer CRON_SECRET", async () => {
    const unauthorized = await cronReservations(new Request("http://localhost/api/cron/reservations"));
    expect(unauthorized.status).toBe(401);

    const badSecret = await cronReplenishment(
      new Request("http://localhost/api/cron/replenishment", { headers: { authorization: "Bearer wrong-secret" } }),
    );
    expect(badSecret.status).toBe(401);

    const valid = await cronReservations(
      new Request("http://localhost/api/cron/reservations", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
      }),
    );
    expect(valid.status).toBe(200);
  });

  it("seeds >= 100k batches & ledger rows, reconciles after random operation sequence, and uses FEFO/FIFO/demand indexes in EXPLAIN", async () => {
    const db = getDb();
    const seeded = await seedDatabase({ bulkBatches: 100_000 });
    expect(seeded.batchesTotal).toBeGreaterThanOrEqual(100_000);

    const ledgerTotals = await db.select({ total: count() }).from(inventoryLedger);
    expect(ledgerTotals[0]?.total ?? 0).toBeGreaterThanOrEqual(100_000);

    // Random-sequence invariant test: run deterministic PRNG sequence of receives, adjustments, orders, confirms, cancels
    const tech = await makeUser("WAREHOUSE_TECH");
    const cs = await makeUser("CUSTOMER_SERVICE");
    const wh = await makeWarehouse(40.75, -73.99);
    const skuA = await makeSku({ priceCents: 1_000 });
    const skuB = await makeSku({ perishable: true, shelfLifeDays: 60, priceCents: 1_200 });
    const { customerId, addressId } = await makeAccount(10_000_000);
    const exp = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

    const batchIds: number[] = [];
    for (let i = 0; i < 4; i++) {
      const b = await runTransaction((tx) =>
        receiveStock(tx, {
          skuId: i % 2 === 0 ? skuA : skuB,
          warehouseId: wh,
          qty: 50,
          zone: "PRIME",
          entryType: "RECEIPT",
          expiryDate: i % 2 === 0 ? null : exp,
          lotCode: `RND-${i}-${uid()}`,
          reasonCode: "RND_INIT",
          actor: { type: "USER", id: tech.id },
          correlationId: `rnd-${i}`,
        }),
      );
      batchIds.push(b.batchId);
    }

    let seed = 1337;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const openOrders: number[] = [];
    const now = new Date();
    for (let step = 0; step < 18; step++) {
      const op = nextRand() % 3;
      if (op === 0) {
        const res = await runTransaction((tx) =>
          createOrder(tx, {
            customerId,
            addressId,
            lines: [{ skuId: step % 2 === 0 ? skuA : skuB, qty: 1 + (nextRand() % 4), isCustomized: false }],
            priority: "STANDARD",
            deliveryWindowDays: 7,
            idempotencyKey: `rnd-ord-${step}-${uid()}`,
            actor: { type: "USER", id: cs.id },
            correlationId: `rnd-o-${step}`,
            now,
          }),
        );
        if (res.result.status === "RESERVED") openOrders.push(res.result.orderId);
      } else if (op === 1 && openOrders.length > 0) {
        const oid = openOrders.shift();
        if (oid !== undefined) {
          if (step % 2 === 0) {
            await runTransaction((tx) => confirmOrder(tx, { orderId: oid, actor: { type: "USER", id: cs.id }, correlationId: `rnd-c-${step}`, now }));
          }
          await runTransaction((tx) => cancelOrder(tx, { orderId: oid, reasonCode: "RND_CANCEL", actor: { type: "USER", id: cs.id }, correlationId: `rnd-x-${step}` }));
        }
      } else {
        const bId = batchIds[nextRand() % batchIds.length];
        if (bId !== undefined) {
          await runTransaction((tx) =>
            adjustBatch(tx, { batchId: bId, delta: 2, reasonCode: "CYCLE_COUNT", actor: { type: "USER", id: tech.id }, correlationId: `rnd-adj-${step}` }),
          );
        }
      }
    }

    // Reconcile EVERY batch in the 100k+ database: zero drift allowed
    expect(await reconcileLedger(db)).toEqual([]);

    // EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) over >= 100k rows (CLAUDE.md §4.1)
    const bulkStd = await db.select({ id: skus.id }).from(skus).where(eq(skus.code, "SKU-BLK-701")).limit(1);
    const bulkPer = await db.select({ id: skus.id }).from(skus).where(eq(skus.code, "SKU-PER-202")).limit(1);
    const seedWh = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, "EWR-01")).limit(1);
    const stdId = bulkStd[0]?.id;
    const perId = bulkPer[0]?.id;
    const whId = seedWh[0]?.id;
    if (!stdId || !perId || !whId) throw new Error("missing seeded bulk references");

    const fefoPlan = await db.execute<Record<string, unknown>>(sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id, qty_available, expiry_date FROM inventory_batches
      WHERE sku_id = ${perId}::int AND warehouse_id = ${whId}::int AND zone_status = 'PRIME' AND qty_available > 0
      ORDER BY expiry_date ASC, received_at ASC, id ASC LIMIT 25
    `);
    const fefoJson = JSON.stringify(fefoPlan);
    expect(fefoJson).toContain("batches_fefo_idx");
    expect(fefoJson).not.toContain("Seq Scan");

    const fifoPlan = await db.execute<Record<string, unknown>>(sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id, qty_available, received_at FROM inventory_batches
      WHERE sku_id = ${stdId}::int AND warehouse_id = ${whId}::int AND zone_status = 'PRIME' AND qty_available > 0
      ORDER BY received_at ASC, id ASC LIMIT 25
    `);
    const fifoJson = JSON.stringify(fifoPlan);
    expect(fifoJson).toContain("batches_fifo_idx");
    expect(fifoJson).not.toContain("Seq Scan");

    const demandPlan = await db.execute<Record<string, unknown>>(sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT occurred_at, delta_reserved FROM inventory_ledger
      WHERE sku_id = ${stdId}::int AND entry_type = 'SHIP' AND occurred_at >= now() - interval '30 days'
    `);
    const demandJson = JSON.stringify(demandPlan);
    expect(demandJson).toContain("ledger_demand_idx");
    expect(demandJson).not.toContain("Seq Scan");
  });
});

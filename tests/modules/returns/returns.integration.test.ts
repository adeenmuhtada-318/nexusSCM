import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { runTransaction } from "@/lib/db/tx";
import { customerAccounts, fulfillmentOrders, inventoryBatches, orderLines, rmaLines } from "@/lib/db/schema";
import { setBusinessRule } from "@/lib/config/business-rules";
import { receiveStock, reconcileLedger } from "@/modules/inventory";
import { confirmOrder, createOrder, markFulfillmentDelivered, shipFulfillment } from "@/modules/orders";
import { receiveAndInspectRma, refundRma, requestRma, reviewRma } from "@/modules/returns";
import { makeAccount, makeCarrier, makeSku, makeUser, makeWarehouse, uid } from "../../helpers/fixtures";

async function placeAndDeliverOrder(opts: {
  deliveredAt: Date;
  lines: { skuId: number; qty: number; isCustomized: boolean }[];
}) {
  const db = getDb();
  const cs = await makeUser("CUSTOMER_SERVICE");
  const tech = await makeUser("WAREHOUSE_TECH");
  const wh = await makeWarehouse(40.71, -74.0);
  await makeCarrier({ mode: "PARCEL", base: 800, perLb: 40, transit: 3, reliability: "0.970" });
  const { accountId, customerId, addressId } = await makeAccount(500_000);

  await runTransaction(async (tx) => {
    for (const l of opts.lines) {
      await receiveStock(tx, { skuId: l.skuId, warehouseId: wh, qty: l.qty + 10, zone: "PRIME", entryType: "RECEIPT", expiryDate: null, lotCode: `L-${uid()}`, reasonCode: "INIT", actor: { type: "USER", id: tech.id }, correlationId: "r-init" });
    }
  });

  const placed = await runTransaction((tx) =>
    createOrder(tx, {
      customerId,
      addressId,
      lines: opts.lines,
      priority: "STANDARD",
      deliveryWindowDays: 7,
      idempotencyKey: `ord-rma-${uid()}`,
      actor: { type: "USER", id: cs.id },
      correlationId: "r-ord",
      now: opts.deliveredAt,
    }),
  );
  await runTransaction((tx) => confirmOrder(tx, { orderId: placed.result.orderId, actor: { type: "USER", id: cs.id }, correlationId: "r-conf", now: opts.deliveredAt }));
  const fos = await db.select({ id: fulfillmentOrders.id }).from(fulfillmentOrders).where(eq(fulfillmentOrders.orderId, placed.result.orderId));
  for (const fo of fos) {
    await runTransaction((tx) => shipFulfillment(tx, { fulfillmentId: fo.id, actor: { type: "USER", id: tech.id }, correlationId: "r-ship", now: opts.deliveredAt, requestedBy: tech.id }));
    await runTransaction((tx) => markFulfillmentDelivered(tx, { fulfillmentId: fo.id, actor: { type: "USER", id: tech.id }, correlationId: "r-del", now: opts.deliveredAt }));
  }
  const oLines = await db.select({ id: orderLines.id, skuId: orderLines.skuId, qty: orderLines.qty }).from(orderLines).where(eq(orderLines.orderId, placed.result.orderId));
  return { orderId: placed.result.orderId, accountId, wh, cs, tech, oLines };
}

describe("returns integration", () => {
  it("auto-approves within 30d, restocks unopened VERIFIED_NEW qty>1 to PRIME, quarantines opened/damaged qty>1 with RETURN_GRADING, and refunds idempotently", async () => {
    const db = getDb();
    const skuNew = await makeSku({ priceCents: 2_500 });
    const skuOpen = await makeSku({ priceCents: 4_000 });
    const now = new Date();
    const deliveredAt = new Date(now.getTime() - 5 * 86_400_000);

    const ctx = await placeAndDeliverOrder({
      deliveredAt,
      lines: [
        { skuId: skuNew, qty: 4, isCustomized: false },
        { skuId: skuOpen, qty: 3, isCustomized: false },
      ],
    });
    const lineNew = ctx.oLines.find((l) => l.skuId === skuNew);
    const lineOpen = ctx.oLines.find((l) => l.skuId === skuOpen);
    if (!lineNew || !lineOpen) throw new Error("missing order lines");

    const rma = await runTransaction((tx) =>
      requestRma(tx, {
        orderId: ctx.orderId,
        lines: [
          { orderLineId: lineNew.id, qty: 3 },
          { orderLineId: lineOpen.id, qty: 2 },
        ],
        reasonCode: "WRONG_SPEC",
        idempotencyKey: `rma-ok-${uid()}`,
        actor: { type: "USER", id: ctx.cs.id },
        correlationId: "rma1",
        now,
      }),
    );
    expect(rma.result.status).toBe("APPROVED");

    // Double-return guard: only 1 unit left on lineNew (4 ordered - 3 claimed), so requesting 2 is denied
    const overReturn = await runTransaction((tx) =>
      requestRma(tx, {
        orderId: ctx.orderId,
        lines: [{ orderLineId: lineNew.id, qty: 2 }],
        reasonCode: "DUPLICATE_TRY",
        idempotencyKey: `rma-dup-${uid()}`,
        actor: { type: "USER", id: ctx.cs.id },
        correlationId: "rma-dup",
        now,
      }),
    );
    expect(overReturn.result.status).toBe("DENIED");

    const rLines = await db.select({ id: rmaLines.id, orderLineId: rmaLines.orderLineId }).from(rmaLines).where(eq(rmaLines.rmaId, rma.result.rmaId));
    const rlNew = rLines.find((r) => r.orderLineId === lineNew.id);
    const rlOpen = rLines.find((r) => r.orderLineId === lineOpen.id);
    if (!rlNew || !rlOpen) throw new Error("missing rma lines");

    const inspected = await runTransaction((tx) =>
      receiveAndInspectRma(tx, {
        rmaId: rma.result.rmaId,
        warehouseId: ctx.wh,
        lines: [
          { rmaLineId: rlNew.id, isOpened: false, condition: "VERIFIED_NEW" },
          { rmaLineId: rlOpen.id, isOpened: true, condition: "DAMAGED" },
        ],
        actor: { type: "USER", id: ctx.tech.id },
        correlationId: "rma-insp",
        now,
      }),
    );
    expect(inspected.restocked).toBe(3);
    expect(inspected.quarantined).toBe(2);
    expect(inspected.exceptionIds).toHaveLength(1);

    const qBatch = await db
      .select({ qty: inventoryBatches.qtyAvailable, zone: inventoryBatches.zoneStatus })
      .from(inventoryBatches)
      .where(eq(inventoryBatches.lotCode, `RMA-${rma.result.rmaId}-${rlOpen.id}`));
    expect(qBatch[0]).toEqual({ qty: 2, zone: "QUARANTINE_REFURBISHMENT" });

    // Refund (3 * 2500 + 2 * 4000 = 15_500) + idempotent replay check
    const refKey = `ref-${uid()}`;
    const ref1 = await runTransaction((tx) => refundRma(tx, { rmaId: rma.result.rmaId, idempotencyKey: refKey, actor: { type: "USER", id: ctx.cs.id }, correlationId: "ref1", now }));
    expect(ref1.replayed).toBe(false);
    expect(ref1.result.amountCents).toBe(15_500);

    const ref2 = await runTransaction((tx) => refundRma(tx, { rmaId: rma.result.rmaId, idempotencyKey: refKey, actor: { type: "USER", id: ctx.cs.id }, correlationId: "ref1", now }));
    expect(ref2.replayed).toBe(true);
    expect(ref2.result.amountCents).toBe(15_500);

    // Order total was 4*2500 + 3*4000 = 22_000; after 15_500 refund, balance is 6_500
    const acct = await db.select({ bal: customerAccounts.currentBalanceCents }).from(customerAccounts).where(eq(customerAccounts.id, ctx.accountId));
    expect(acct[0]?.bal).toBe(6_500);
    expect(await reconcileLedger(db)).toEqual([]);
  });

  it("denies customized items immediately and routes >30d returns to PENDING_REVIEW with separation of duties on review", async () => {
    const skuStd = await makeSku({ priceCents: 1_500 });
    const skuCus = await makeSku({ priceCents: 3_000 });
    const now = new Date();
    const delivered45dAgo = new Date(now.getTime() - 45 * 86_400_000);
    const manager = await makeUser("MANAGER");

    const ctx = await placeAndDeliverOrder({
      deliveredAt: delivered45dAgo,
      lines: [
        { skuId: skuStd, qty: 2, isCustomized: false },
        { skuId: skuCus, qty: 1, isCustomized: true },
      ],
    });
    const lineStd = ctx.oLines.find((l) => l.skuId === skuStd);
    const lineCus = ctx.oLines.find((l) => l.skuId === skuCus);
    if (!lineStd || !lineCus) throw new Error("missing lines");

    // Customized -> AUTO_DENY even if requested
    const deniedCus = await runTransaction((tx) =>
      requestRma(tx, {
        orderId: ctx.orderId,
        lines: [{ orderLineId: lineCus.id, qty: 1 }],
        reasonCode: "CHANGED_MIND",
        idempotencyKey: `rma-cus-${uid()}`,
        actor: { type: "USER", id: ctx.cs.id },
        correlationId: "cus",
        now,
      }),
    );
    expect(deniedCus.result.status).toBe("DENIED");
    expect(deniedCus.result.exceptionId).not.toBeNull();

    // 45 days since delivery (> 30d window): default AUTO_DENY denies; switching policy to HUMAN_REVIEW routes to PENDING_REVIEW
    const lateAutoDenied = await runTransaction((tx) =>
      requestRma(tx, {
        orderId: ctx.orderId,
        lines: [{ orderLineId: lineStd.id, qty: 1 }],
        reasonCode: "LATE_AUTO",
        idempotencyKey: `rma-late-auto-${uid()}`,
        actor: { type: "USER", id: ctx.cs.id },
        correlationId: "late-auto",
        now,
      }),
    );
    expect(lateAutoDenied.result.status).toBe("DENIED");

    await setBusinessRule({ key: "returns.ineligible_policy", value: "HUMAN_REVIEW", actorId: manager.id, reasonCode: "SEASONAL_LENIENCY", correlationId: "cfg-rma" });
    try {
      const lateRma = await runTransaction((tx) =>
        requestRma(tx, {
          orderId: ctx.orderId,
          lines: [{ orderLineId: lineStd.id, qty: 2 }],
          reasonCode: "LATE_DEFECT",
          idempotencyKey: `rma-late-${uid()}`,
          actor: { type: "USER", id: ctx.cs.id },
          correlationId: "late",
          now: new Date(),
        }),
      );
      expect(lateRma.result.status).toBe("PENDING_REVIEW");

      // Requester cannot review own RMA
      await expect(
        runTransaction((tx) => reviewRma(tx, { rmaId: lateRma.result.rmaId, decision: "APPROVE", note: "self approve", reviewerId: ctx.cs.id, correlationId: "sod" })),
      ).rejects.toMatchObject({ code: "SEPARATION_OF_DUTIES" });

      // Different user (manager) denies -> unclaims returned qty
      const rev = await runTransaction((tx) =>
        reviewRma(tx, { rmaId: lateRma.result.rmaId, decision: "DENY", note: "Outside 30-day policy", reviewerId: manager.id, correlationId: "rev-deny" }),
      );
      expect(rev.status).toBe("DENIED");
    } finally {
      await setBusinessRule({ key: "returns.ineligible_policy", value: "AUTO_DENY", actorId: manager.id, reasonCode: "RESTORE_DEFAULT", correlationId: "cfg-rma-2" });
    }
  });
});

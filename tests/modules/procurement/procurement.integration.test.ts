import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { runTransaction } from "@/lib/db/tx";
import { exceptions, purchaseOrders, vendorContracts } from "@/lib/db/schema";
import { createRequisition, reconcileLedger, runAutoRequisition } from "@/modules/inventory";
import { approvePo, convertOpenRequisitions, createPoFromRequisition, getOnOrderQty, receivePo } from "@/modules/procurement";
import { makeSku, makeUser, makeVendorContract, makeWarehouse, uid } from "../../helpers/fixtures";

describe("procurement integration", () => {
  it("cascades Tier 1 -> Tier 2 when Tier 1 capacity/lead fails, and enforces exact >= $10,000 gate + separation of duties + receipt", async () => {
    const db = getDb();
    const buyer = await makeUser("BUYER");
    const manager = await makeUser("MANAGER");
    const tech = await makeUser("WAREHOUSE_TECH");
    const wh = await makeWarehouse(41.88, -87.63);
    const sku = await makeSku({ priceCents: 20_000 });

    // Tier 1 capped at maxQty = 5; Tier 2 handles up to 100 at $1,000 each (100_000 cents)
    await makeVendorContract(sku, { tier: 1, unitCostCents: 80_000, maxQty: 5, lead: 4, maxLead: 10 });
    await makeVendorContract(sku, { tier: 2, unitCostCents: 100_000, maxQty: 100, lead: 5, maxLead: 10 });

    const now = new Date();
    // Request exactly 10 units -> cascades to Tier 2 -> 10 * $1,000 = $10,000 (1_000_000 cents) -> >= threshold -> PENDING_MANAGER_APPROVAL
    const reqId = await runTransaction((tx) => createRequisition(tx, { skuId: sku, qty: 10, rop: 8, actor: { type: "USER", id: buyer.id }, correlationId: "p1" }));
    if (reqId === null) throw new Error("expected requisition");

    const created = await runTransaction((tx) =>
      createPoFromRequisition(tx, { requisitionId: reqId, idempotencyKey: `po-10k-${uid()}`, actor: { type: "USER", id: buyer.id }, correlationId: "p1", now }),
    );
    expect(created.result.outcome).toBe("CREATED");
    expect(created.result.status).toBe("PENDING_MANAGER_APPROVAL");
    expect(created.result.exceptionId).not.toBeNull();
    const poId = created.result.poId;
    if (poId === null) throw new Error("expected poId");

    const poRow = await db.select({ tier: purchaseOrders.hierarchyTier }).from(purchaseOrders).where(eq(purchaseOrders.id, poId));
    expect(poRow[0]?.tier).toBe(2);

    // Buyer cannot approve a PENDING_MANAGER_APPROVAL PO
    await expect(
      runTransaction((tx) => approvePo(tx, { poId, approver: { id: buyer.id, role: "BUYER" }, reasonCode: "URGENT_STOCK", idempotencyKey: `ap-b-${uid()}`, correlationId: "ap1", now })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Separation of duties: if manager had requested a PO, that same manager cannot approve it
    const skuSod = await makeSku();
    await makeVendorContract(skuSod, { tier: 1, unitCostCents: 500_000, maxQty: 100 });
    const reqSod = await runTransaction((tx) => createRequisition(tx, { skuId: skuSod, qty: 3, rop: 2, actor: { type: "USER", id: manager.id }, correlationId: "sod" }));
    if (reqSod === null) throw new Error("expected reqSod");
    const poSod = await runTransaction((tx) =>
      createPoFromRequisition(tx, { requisitionId: reqSod, idempotencyKey: `po-sod-${uid()}`, actor: { type: "USER", id: manager.id }, correlationId: "sod", now }),
    );
    if (poSod.result.poId === null) throw new Error("expected poSod id");
    await expect(
      runTransaction((tx) => approvePo(tx, { poId: poSod.result.poId ?? 0, approver: { id: manager.id, role: "MANAGER" }, reasonCode: "SELF_APPROVE", idempotencyKey: `ap-sod-${uid()}`, correlationId: "sod", now })),
    ).rejects.toMatchObject({ code: "SEPARATION_OF_DUTIES" });

    // Different manager approves `poId` -> dispatches PO & closes live exception
    const approved = await runTransaction((tx) =>
      approvePo(tx, { poId, approver: { id: manager.id, role: "MANAGER" }, reasonCode: "APPROVED_Q4_BUDGET", idempotencyKey: `ap-ok-${uid()}`, correlationId: "ap2", now }),
    );
    expect(approved.result.status).toBe("APPROVED_AND_DISPATCHED");
    if (created.result.exceptionId !== null) {
      const ex = await db.select({ status: exceptions.status }).from(exceptions).where(eq(exceptions.id, created.result.exceptionId));
      expect(ex[0]?.status).toBe("RESOLVED");
    }

    // Receive PO into warehouse -> creates PRIME batch + RECEIPT ledger row
    const rec = await runTransaction((tx) => receivePo(tx, { poId, warehouseId: wh, lotCode: `LOT-${uid()}`, expiryDate: null, actor: { type: "USER", id: tech.id }, correlationId: "rec1" }));
    expect(rec.batches).toHaveLength(1);
    expect(await reconcileLedger(db)).toEqual([]);
  });

  it("blocks split-PO threshold evasion on the same business day and routes Tier-3 spot buys to BUYER", async () => {
    const db = getDb();
    const buyer = await makeUser("BUYER");
    const now = new Date();

    // Same vendor + SKU: two $6,000 POs on the same business day -> 1st auto-dispatches, 2nd hits $12,000 effective spend -> PENDING_MANAGER_APPROVAL
    const sku1 = await makeSku();
    const { vendorId } = await makeVendorContract(sku1, { tier: 1, unitCostCents: 600_000, maxQty: 50 });
    const sku2 = await makeSku();
    await db.insert(vendorContracts).values({ vendorId, skuId: sku2, hierarchyTier: 1, unitCostCents: 600_000, leadTimeDays: 5, maxQtyPerOrder: 50, maxAcceptableLeadDays: 14 });

    const r1 = await runTransaction((tx) => createRequisition(tx, { skuId: sku1, qty: 1, rop: 5, actor: { type: "USER", id: buyer.id }, correlationId: "sp1" }));
    if (r1 === null) throw new Error("expected r1");
    const p1 = await runTransaction((tx) => createPoFromRequisition(tx, { requisitionId: r1, idempotencyKey: `sp1-${uid()}`, actor: { type: "USER", id: buyer.id }, correlationId: "sp1", now }));
    expect(p1.result.status).toBe("APPROVED_AND_DISPATCHED");

    // Second requisition on SAME SKU after receiving/closing? Wait: getSameDayOpenCost checks same vendor + SKU!
    const r2 = await runTransaction((tx) => createRequisition(tx, { skuId: sku1, qty: 1, rop: 5, actor: { type: "USER", id: buyer.id }, correlationId: "sp2" }));
    if (r2 === null) throw new Error("expected r2");
    const p2 = await runTransaction((tx) => createPoFromRequisition(tx, { requisitionId: r2, idempotencyKey: `sp2-${uid()}`, actor: { type: "USER", id: buyer.id }, correlationId: "sp2", now }));
    expect(p2.result.effectiveCostCents).toBe(1_200_000);
    expect(p2.result.status).toBe("PENDING_MANAGER_APPROVAL");

    // Tier 3 Spot contract under $10,000 -> PENDING_BUYER_APPROVAL
    const skuSpot = await makeSku();
    await makeVendorContract(skuSpot, { tier: 3, unitCostCents: 50_000, maxQty: 50 });
    const rSpot = await runTransaction((tx) => createRequisition(tx, { skuId: skuSpot, qty: 2, rop: 4, actor: { type: "USER", id: buyer.id }, correlationId: "spt" }));
    if (rSpot === null) throw new Error("expected rSpot");
    const pSpot = await runTransaction((tx) => createPoFromRequisition(tx, { requisitionId: rSpot, idempotencyKey: `spt-${uid()}`, actor: { type: "USER", id: buyer.id }, correlationId: "spt", now }));
    expect(pSpot.result.status).toBe("PENDING_BUYER_APPROVAL");
  });

  it("runs auto-requisition + open-requisition conversion idempotently and raises NO_VENDOR_AVAILABLE when uncontracted", async () => {
    const db = getDb();
    const uncontractedSku = await makeSku();
    const reqId = await runTransaction((tx) => createRequisition(tx, { skuId: uncontractedSku, qty: 5, rop: 10, actor: { type: "SYSTEM" }, correlationId: "nv" }));
    expect(reqId).not.toBeNull();

    const conv1 = await convertOpenRequisitions();
    expect(conv1.noVendor).toBeGreaterThanOrEqual(1);
    // Re-running on same day replays idempotently
    const conv2 = await convertOpenRequisitions();
    expect(conv2.noVendor).toBeGreaterThanOrEqual(1);

    const ar1 = await runAutoRequisition({ getOnOrderQty: (ids) => getOnOrderQty(db, ids) });
    const ar2 = await runAutoRequisition({ getOnOrderQty: (ids) => getOnOrderQty(db, ids) });
    expect(ar2.created).toBe(0);
    expect(ar1.scanned).toBeGreaterThan(0);
  });
});

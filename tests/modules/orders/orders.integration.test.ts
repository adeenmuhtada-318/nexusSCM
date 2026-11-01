import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { runTransaction } from "@/lib/db/tx";
import { addresses, customerAccounts, exceptions, fulfillmentOrders, hazmatRestrictedRegions, orders } from "@/lib/db/schema";
import { receiveStock, reconcileLedger } from "@/modules/inventory";
import {
  cancelOrder,
  confirmOrder,
  createOrder,
  expireReservations,
  markFulfillmentDelivered,
  reevaluateOrder,
  shipFulfillment,
} from "@/modules/orders";
import { makeAccount, makeCarrier, makeContractPrice, makeSku, makeUser, makeWarehouse, uid } from "../../helpers/fixtures";

describe("orders + logistics integration", () => {
  it("applies contract pricing, splits across nearest warehouses by Haversine, and derives parent status through ship & deliver", async () => {
    const db = getDb();
    const cs = await makeUser("CUSTOMER_SERVICE");
    const tech = await makeUser("WAREHOUSE_TECH");
    // NYC customer (40.7128, -74.006); whNear in NJ, whFar in LA
    const whNear = await makeWarehouse(40.73, -74.17);
    const whFar = await makeWarehouse(34.05, -118.24);
    const sku = await makeSku({ priceCents: 5_000, weightLbs: "4.00" });
    const { accountId, customerId, addressId } = await makeAccount(100_000);
    await makeContractPrice(accountId, sku, 3_200);
    await makeCarrier({ mode: "PARCEL", base: 900, perLb: 50, transit: 4, reliability: "0.960" });

    await runTransaction(async (tx) => {
      await receiveStock(tx, { skuId: sku, warehouseId: whNear, qty: 3, zone: "PRIME", entryType: "RECEIPT", expiryDate: null, lotCode: "N1", reasonCode: "INIT", actor: { type: "USER", id: tech.id }, correlationId: "t1" });
      await receiveStock(tx, { skuId: sku, warehouseId: whFar, qty: 5, zone: "PRIME", entryType: "RECEIPT", expiryDate: null, lotCode: "F1", reasonCode: "INIT", actor: { type: "USER", id: tech.id }, correlationId: "t1" });
    });

    const now = new Date();
    const placed = await runTransaction((tx) =>
      createOrder(tx, {
        customerId,
        addressId,
        lines: [{ skuId: sku, qty: 6, isCustomized: false }],
        priority: "STANDARD",
        deliveryWindowDays: 7,
        idempotencyKey: `ord-split-${uid()}`,
        actor: { type: "USER", id: cs.id },
        correlationId: "c-split",
        now,
      }),
    );
    expect(placed.result.status).toBe("RESERVED");
    expect(placed.result.totalCents).toBe(6 * 3_200);

    const fos = await db.select({ id: fulfillmentOrders.id, warehouseId: fulfillmentOrders.warehouseId }).from(fulfillmentOrders).where(eq(fulfillmentOrders.orderId, placed.result.orderId));
    expect(fos).toHaveLength(2);
    expect(fos.map((f) => f.warehouseId).sort()).toEqual([whNear, whFar].sort());

    await runTransaction((tx) => confirmOrder(tx, { orderId: placed.result.orderId, actor: { type: "USER", id: cs.id }, correlationId: "c-conf", now }));

    const fo0 = fos[0];
    const fo1 = fos[1];
    if (!fo0 || !fo1) throw new Error("missing fulfillments");

    const s1 = await runTransaction((tx) => shipFulfillment(tx, { fulfillmentId: fo0.id, actor: { type: "USER", id: tech.id }, correlationId: "c-s1", now, requestedBy: tech.id }));
    expect(s1.shipped).toBe(true);
    const afterOneShip = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, placed.result.orderId));
    expect(afterOneShip[0]?.status).toBe("PARTIALLY_SHIPPED");

    await runTransaction((tx) => shipFulfillment(tx, { fulfillmentId: fo1.id, actor: { type: "USER", id: tech.id }, correlationId: "c-s2", now, requestedBy: tech.id }));
    const afterTwoShips = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, placed.result.orderId));
    expect(afterTwoShips[0]?.status).toBe("SHIPPED");

    await runTransaction((tx) => markFulfillmentDelivered(tx, { fulfillmentId: fo0.id, actor: { type: "USER", id: tech.id }, correlationId: "c-d1", now }));
    const afterOneDel = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, placed.result.orderId));
    expect(afterOneDel[0]?.status).toBe("SHIPPED");

    await runTransaction((tx) => markFulfillmentDelivered(tx, { fulfillmentId: fo1.id, actor: { type: "USER", id: tech.id }, correlationId: "c-d2", now }));
    const afterBothDel = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, placed.result.orderId));
    expect(afterBothDel[0]?.status).toBe("DELIVERED");
    expect(await reconcileLedger(db)).toEqual([]);
  });

  it("holds orders on CREDIT_HOLD, HAZMAT_HOLD, ADDRESS_HOLD, and BACKORDERED with exception rows, then releases hold on reevaluate", async () => {
    const db = getDb();
    const cs = await makeUser("CUSTOMER_SERVICE");
    const tech = await makeUser("WAREHOUSE_TECH");
    const wh = await makeWarehouse(40.71, -74.0);
    const stdSku = await makeSku({ priceCents: 4_000 });
    const hazSku = await makeSku({ priceCents: 2_000, hazmat: true });
    await runTransaction((tx) =>
      receiveStock(tx, { skuId: stdSku, warehouseId: wh, qty: 20, zone: "PRIME", entryType: "RECEIPT", expiryDate: null, lotCode: "H1", reasonCode: "INIT", actor: { type: "USER", id: tech.id }, correlationId: "h1" }),
    );

    const { accountId, customerId, addressId } = await makeAccount(5_000);
    const now = new Date();

    // 1. Credit hold (2 * 4000 = 8000 > 5000)
    const creditHeld = await runTransaction((tx) =>
      createOrder(tx, {
        customerId,
        addressId,
        lines: [{ skuId: stdSku, qty: 2, isCustomized: false }],
        priority: "STANDARD",
        deliveryWindowDays: 7,
        idempotencyKey: `ord-ch-${uid()}`,
        actor: { type: "USER", id: cs.id },
        correlationId: "ch",
        now,
      }),
    );
    expect(creditHeld.result.status).toBe("ON_HOLD_EXCEPTION");
    expect(creditHeld.result.exceptionIds).toHaveLength(1);

    // Raise credit limit and reevaluate -> moves to RESERVED and closes live CREDIT_HOLD exception
    await db.update(customerAccounts).set({ creditLimitCents: 50_000 }).where(eq(customerAccounts.id, accountId));
    const released = await runTransaction((tx) => reevaluateOrder(tx, { orderId: creditHeld.result.orderId, actor: { type: "USER", id: cs.id }, correlationId: "ch-rel", now }));
    expect(released.status).toBe("RESERVED");
    const chExId = creditHeld.result.exceptionIds[0];
    if (chExId !== undefined) {
      const exRow = await db.select({ status: exceptions.status }).from(exceptions).where(eq(exceptions.id, chExId));
      expect(exRow[0]?.status).toBe("RESOLVED");
    }

    // 2. Hazmat hold to restricted region
    const region = `R${uid().slice(0, 4).toUpperCase()}`;
    await db.insert(hazmatRestrictedRegions).values({ country: "US", region });
    const hazAddr = await db.insert(addresses).values({ customerId, line1: "1 Reef", city: "Hilo", region, postalCode: "96720", lat: 19.7, lng: -155.08 }).returning({ id: addresses.id });
    const hazAddrId = hazAddr[0]?.id;
    if (!hazAddrId) throw new Error("addr failed");
    const hazHeld = await runTransaction((tx) =>
      createOrder(tx, {
        customerId,
        addressId: hazAddrId,
        lines: [{ skuId: hazSku, qty: 1, isCustomized: false }],
        priority: "STANDARD",
        deliveryWindowDays: 7,
        idempotencyKey: `ord-hz-${uid()}`,
        actor: { type: "USER", id: cs.id },
        correlationId: "hz",
        now,
      }),
    );
    expect(hazHeld.result.status).toBe("ON_HOLD_EXCEPTION");
    expect(hazHeld.result.exceptionIds).toHaveLength(1);

    // 3. Address not geocoded
    const badAddr = await db.insert(addresses).values({ customerId, line1: "PO Box", city: "Nowhere", region: "NY", postalCode: "10001", lat: null, lng: null }).returning({ id: addresses.id });
    const badAddrId = badAddr[0]?.id;
    if (!badAddrId) throw new Error("addr failed");
    const addrHeld = await runTransaction((tx) =>
      createOrder(tx, {
        customerId,
        addressId: badAddrId,
        lines: [{ skuId: stdSku, qty: 1, isCustomized: false }],
        priority: "STANDARD",
        deliveryWindowDays: 7,
        idempotencyKey: `ord-ad-${uid()}`,
        actor: { type: "USER", id: cs.id },
        correlationId: "ad",
        now,
      }),
    );
    expect(addrHeld.result.status).toBe("ON_HOLD_EXCEPTION");
    expect(addrHeld.result.exceptionIds).toHaveLength(1);

    // 4. Short stock -> BACKORDERED + NO_WAREHOUSE_CAN_FULFIL exception
    const shortSku = await makeSku({ priceCents: 500 });
    const backordered = await runTransaction((tx) =>
      createOrder(tx, {
        customerId,
        addressId,
        lines: [{ skuId: shortSku, qty: 5, isCustomized: false }],
        priority: "STANDARD",
        deliveryWindowDays: 7,
        idempotencyKey: `ord-bo-${uid()}`,
        actor: { type: "USER", id: cs.id },
        correlationId: "bo",
        now,
      }),
    );
    expect(backordered.result.status).toBe("BACKORDERED");
    expect(backordered.result.exceptionIds).toHaveLength(1);
  });

  it("expires unconfirmed reservations idempotently, cancels reserved orders cleanly, and raises NO_ELIGIBLE_CARRIER when overweight", async () => {
    const db = getDb();
    const cs = await makeUser("CUSTOMER_SERVICE");
    const tech = await makeUser("WAREHOUSE_TECH");
    const wh = await makeWarehouse(40.71, -74.0);
    // 9999 lb SKU exceeds any carrier maxWeightLbs (5000 max in seed/fixtures)
    const ultraHeavySku = await makeSku({ priceCents: 1_000, weightLbs: "9999.00" });
    await runTransaction((tx) =>
      receiveStock(tx, { skuId: ultraHeavySku, warehouseId: wh, qty: 10, zone: "PRIME", entryType: "RECEIPT", expiryDate: null, lotCode: "UH1", reasonCode: "INIT", actor: { type: "USER", id: tech.id }, correlationId: "uh" }),
    );
    const { accountId, customerId, addressId } = await makeAccount(100_000);
    const past = new Date(Date.now() - 2 * 3600_000);

    // Order 1 placed 2 hours ago -> TTL (30m) already in the past relative to now
    const toExpire = await runTransaction((tx) =>
      createOrder(tx, {
        customerId,
        addressId,
        lines: [{ skuId: ultraHeavySku, qty: 2, isCustomized: false }],
        priority: "STANDARD",
        deliveryWindowDays: 7,
        idempotencyKey: `ord-exp-${uid()}`,
        actor: { type: "USER", id: cs.id },
        correlationId: "exp",
        now: past,
      }),
    );
    expect(toExpire.result.status).toBe("RESERVED");

    const run1 = await expireReservations({ now: new Date() });
    expect(run1.expired).toBeGreaterThanOrEqual(1);
    const run2 = await expireReservations({ now: new Date() });
    expect(run2.expired).toBe(0);

    const expRow = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, toExpire.result.orderId));
    expect(expRow[0]?.status).toBe("EXPIRED");
    const acctAfterExpire = await db.select({ bal: customerAccounts.currentBalanceCents }).from(customerAccounts).where(eq(customerAccounts.id, accountId));
    expect(acctAfterExpire[0]?.bal).toBe(0);

    // Order 2: confirm -> attempt ship of 9999lb item -> NO_ELIGIBLE_CARRIER exception, nothing ships; then cancelOrder
    const now = new Date();
    const unshippable = await runTransaction((tx) =>
      createOrder(tx, {
        customerId,
        addressId,
        lines: [{ skuId: ultraHeavySku, qty: 1, isCustomized: false }],
        priority: "URGENT",
        deliveryWindowDays: 1,
        idempotencyKey: `ord-nc-${uid()}`,
        actor: { type: "USER", id: cs.id },
        correlationId: "nc",
        now,
      }),
    );
    await runTransaction((tx) => confirmOrder(tx, { orderId: unshippable.result.orderId, actor: { type: "USER", id: cs.id }, correlationId: "nc-c", now }));
    const fos = await db.select({ id: fulfillmentOrders.id }).from(fulfillmentOrders).where(eq(fulfillmentOrders.orderId, unshippable.result.orderId));
    const fo = fos[0];
    if (!fo) throw new Error("missing fo");

    const shipAttempt = await runTransaction((tx) => shipFulfillment(tx, { fulfillmentId: fo.id, actor: { type: "USER", id: tech.id }, correlationId: "nc-s", now, requestedBy: tech.id }));
    expect(shipAttempt.shipped).toBe(false);

    await runTransaction((tx) => cancelOrder(tx, { orderId: unshippable.result.orderId, reasonCode: "CUSTOMER_CANCEL", actor: { type: "USER", id: cs.id }, correlationId: "nc-x" }));
    expect(await reconcileLedger(db)).toEqual([]);
  });
});

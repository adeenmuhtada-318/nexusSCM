import { describe, expect, it } from "vitest";
import { expectExactTransitions } from "../../helpers/transitions";
import {
  checkFulfillmentTransition,
  checkOrderTransition,
  creditAllows,
  deriveOrderStatus,
  evaluateSevenRights,
  isValidCoordinate,
  orderTotalCents,
  planFulfillment,
  reservationExpiry,
  type RightsInput,
  type RightsLine,
} from "@/modules/orders/rules";

const line = (o: Partial<RightsLine> = {}): RightsLine => ({
  skuId: 1,
  qty: 2,
  skuActive: true,
  isHazmat: false,
  unitPriceCents: 1000,
  networkAvailable: 10,
  quarantinedQty: 0,
  ...o,
});
const input = (o: Partial<RightsInput> = {}): RightsInput => ({
  customerActive: true,
  accountActive: true,
  creditLimitCents: 100_000,
  currentBalanceCents: 0,
  address: { lat: 40.7, lng: -74, region: "NY", country: "US" },
  destinationHazmatRestricted: false,
  lines: [line()],
  ...o,
});

describe("credit boundary (exact cents)", () => {
  it("exactly at limit passes; one cent over fails", () => {
    expect(creditAllows({ totalCents: 60_000, balanceCents: 40_000, limitCents: 100_000 })).toBe(true);
    expect(creditAllows({ totalCents: 60_001, balanceCents: 40_000, limitCents: 100_000 })).toBe(false);
    expect(creditAllows({ totalCents: 59_999, balanceCents: 40_000, limitCents: 100_000 })).toBe(true);
  });
  it("order total uses exact integer math", () => {
    expect(orderTotalCents([{ qty: 3, unitPriceCents: 1999 }, { qty: 1, unitPriceCents: 1 }])).toBe(5998);
  });
});

describe("coordinates", () => {
  it("validates ranges and nulls", () => {
    expect(isValidCoordinate(90, 180)).toBe(true);
    expect(isValidCoordinate(-90, -180)).toBe(true);
    expect(isValidCoordinate(90.0001, 0)).toBe(false);
    expect(isValidCoordinate(0, 180.0001)).toBe(false);
    expect(isValidCoordinate(null, 10)).toBe(false);
    expect(isValidCoordinate(Number.NaN, 10)).toBe(false);
  });
});

describe("evaluateSevenRights", () => {
  it("passes a clean order", () => {
    const r = evaluateSevenRights(input());
    expect(r.outcome).toBe("PASS");
    expect(r.totalCents).toBe(2000);
  });
  it("credit exactly at limit passes, one cent over holds with exception + reason", () => {
    expect(evaluateSevenRights(input({ creditLimitCents: 2000 })).outcome).toBe("PASS");
    const r = evaluateSevenRights(input({ creditLimitCents: 1999 }));
    expect(r.outcome).toBe("HOLD");
    if (r.outcome === "HOLD") {
      expect(r.holds[0]).toMatchObject({ exceptionType: "ORDER_CREDIT_EXCEEDED", reasonCode: "CREDIT_LIMIT_EXCEEDED" });
    }
  });
  it("existing balance counts toward the limit", () => {
    expect(evaluateSevenRights(input({ creditLimitCents: 5000, currentBalanceCents: 3001 })).outcome).toBe("HOLD");
    expect(evaluateSevenRights(input({ creditLimitCents: 5000, currentBalanceCents: 3000 })).outcome).toBe("PASS");
  });
  it("missing / invalid address holds with distinct reason codes", () => {
    const a = evaluateSevenRights(input({ address: { lat: null, lng: null, region: "NY", country: "US" } }));
    const b = evaluateSevenRights(input({ address: { lat: 95, lng: 0, region: "NY", country: "US" } }));
    const c = evaluateSevenRights(input({ address: null }));
    expect(a.outcome === "HOLD" && a.holds[0]?.reasonCode).toBe("ADDRESS_NOT_GEOCODED");
    expect(b.outcome === "HOLD" && b.holds[0]?.reasonCode).toBe("ADDRESS_INVALID");
    expect(c.outcome === "HOLD" && c.holds[0]?.reasonCode).toBe("ADDRESS_NOT_GEOCODED");
  });
  it("inactive product / customer / account hold", () => {
    expect(evaluateSevenRights(input({ lines: [line({ skuActive: false })] })).outcome).toBe("HOLD");
    expect(evaluateSevenRights(input({ customerActive: false })).outcome).toBe("HOLD");
    const acc = evaluateSevenRights(input({ accountActive: false }));
    expect(acc.outcome === "HOLD" && acc.holds[0]?.reasonCode).toBe("ACCOUNT_INACTIVE");
  });
  it("hazmat to a restricted destination holds; non-hazmat does not", () => {
    expect(evaluateSevenRights(input({ destinationHazmatRestricted: true, lines: [line({ isHazmat: true })] })).outcome).toBe("HOLD");
    expect(evaluateSevenRights(input({ destinationHazmatRestricted: true })).outcome).toBe("PASS");
  });
  it("stock shortage backorders (not a hold) with reason code", () => {
    const r = evaluateSevenRights(input({ lines: [line({ networkAvailable: 1 })] }));
    expect(r.outcome).toBe("BACKORDER");
    expect(r.failures[0]).toMatchObject({ reasonCode: "INSUFFICIENT_STOCK", right: "QUANTITY_AVAILABLE" });
  });
  it("zero PRIME with quarantined stock → ONLY_QUARANTINED_STOCK", () => {
    const r = evaluateSevenRights(input({ lines: [line({ networkAvailable: 0, quarantinedQty: 5 })] }));
    expect(r.failures[0]).toMatchObject({ reasonCode: "ONLY_QUARANTINED_STOCK", right: "CONDITION_NOT_QUARANTINED" });
  });
  it("HOLD takes precedence over BACKORDER (never reserve for a held order)", () => {
    const r = evaluateSevenRights(input({ creditLimitCents: 0, lines: [line({ networkAvailable: 0 })] }));
    expect(r.outcome).toBe("HOLD");
  });
  it("multiple distinct holds produce one exception each", () => {
    const r = evaluateSevenRights(input({ creditLimitCents: 0, address: null }));
    expect(r.outcome === "HOLD" && r.holds.map((h) => h.exceptionType).sort()).toEqual(["ORDER_ADDRESS_INVALID", "ORDER_CREDIT_EXCEEDED"]);
  });
});

describe("planFulfillment", () => {
  const wh = (id: number, distanceKm: number, available: Record<number, number>) => ({ id, distanceKm, available });
  it("nearest warehouse fully covers → single shipment", () => {
    const p = planFulfillment([{ skuId: 1, qty: 5 }], [wh(2, 50, { 1: 9 }), wh(1, 10, { 1: 9 })]);
    expect(p).toEqual({ kind: "PLAN", shipments: [{ warehouseId: 1, lines: [{ skuId: 1, qty: 5 }] }] });
  });
  it("prefers ONE farther warehouse that covers everything over splitting across nearer ones", () => {
    const p = planFulfillment(
      [{ skuId: 1, qty: 5 }, { skuId: 2, qty: 5 }],
      [wh(1, 10, { 1: 5 }), wh(2, 20, { 2: 5 }), wh(3, 300, { 1: 5, 2: 5 })],
    );
    expect(p.kind === "PLAN" && p.shipments).toEqual([{ warehouseId: 3, lines: [{ skuId: 1, qty: 5 }, { skuId: 2, qty: 5 }] }]);
  });
  it("splits greedily (max coverage, then nearest) when no single warehouse suffices", () => {
    const p = planFulfillment(
      [{ skuId: 1, qty: 10 }],
      [wh(1, 10, { 1: 4 }), wh(2, 20, { 1: 7 }), wh(3, 30, { 1: 7 })],
    );
    expect(p.kind).toBe("PLAN");
    if (p.kind === "PLAN") {
      expect(p.shipments).toEqual([
        { warehouseId: 2, lines: [{ skuId: 1, qty: 7 }] }, // 7 covered, tie with wh3 → nearest wins
        { warehouseId: 1, lines: [{ skuId: 1, qty: 3 }] }, // 3 covered by wh1 (nearest of remaining tie)
      ]);
    }
  });
  it("network shortage → NO_WAREHOUSE_CAN_FULFIL with shortfall", () => {
    const p = planFulfillment([{ skuId: 1, qty: 10 }], [wh(1, 10, { 1: 4 }), wh(2, 20, { 1: 3 })]);
    expect(p).toEqual({ kind: "NO_WAREHOUSE_CAN_FULFIL", shortfalls: [{ skuId: 1, short: 3 }] });
  });
  it("never allocates more than a warehouse holds and totals match demand", () => {
    const p = planFulfillment(
      [{ skuId: 1, qty: 9 }, { skuId: 2, qty: 4 }],
      [wh(1, 5, { 1: 3, 2: 4 }), wh(2, 6, { 1: 3 }), wh(3, 7, { 1: 3 })],
    );
    expect(p.kind).toBe("PLAN");
    if (p.kind === "PLAN") {
      const tot: Record<number, number> = {};
      for (const s of p.shipments) for (const l of s.lines) tot[l.skuId] = (tot[l.skuId] ?? 0) + l.qty;
      expect(tot).toEqual({ 1: 9, 2: 4 });
    }
  });
});

describe("deriveOrderStatus", () => {
  it("derives from children", () => {
    expect(deriveOrderStatus(["DELIVERED", "DELIVERED"], "SHIPPED")).toBe("DELIVERED");
    expect(deriveOrderStatus(["SHIPPED", "DELIVERED"], "CONFIRMED")).toBe("SHIPPED");
    expect(deriveOrderStatus(["SHIPPED", "RESERVED"], "CONFIRMED")).toBe("PARTIALLY_SHIPPED");
    expect(deriveOrderStatus(["RESERVED", "RESERVED"], "CONFIRMED")).toBe("CONFIRMED");
    expect(deriveOrderStatus(["CANCELLED", "CANCELLED"], "CONFIRMED")).toBe("CANCELLED");
    expect(deriveOrderStatus(["CANCELLED", "SHIPPED"], "CONFIRMED")).toBe("SHIPPED");
    expect(deriveOrderStatus([], "RESERVED")).toBe("RESERVED");
  });
});

describe("reservationExpiry", () => {
  it("adds TTL minutes to the injected now", () => {
    expect(reservationExpiry(new Date("2026-01-01T00:00:00Z"), 30).toISOString()).toBe("2026-01-01T00:30:00.000Z");
  });
});

describe("transition maps — every illegal transition is rejected", () => {
  it("order", () => {
    expectExactTransitions(
      ["ON_HOLD_EXCEPTION", "BACKORDERED", "RESERVED", "CONFIRMED", "PARTIALLY_SHIPPED", "SHIPPED", "DELIVERED", "CANCELLED", "EXPIRED"] as const,
      [
        ["ON_HOLD_EXCEPTION", "RESERVED"], ["ON_HOLD_EXCEPTION", "BACKORDERED"], ["ON_HOLD_EXCEPTION", "CANCELLED"],
        ["BACKORDERED", "RESERVED"], ["BACKORDERED", "ON_HOLD_EXCEPTION"], ["BACKORDERED", "CANCELLED"],
        ["RESERVED", "CONFIRMED"], ["RESERVED", "CANCELLED"], ["RESERVED", "EXPIRED"],
        ["CONFIRMED", "PARTIALLY_SHIPPED"], ["CONFIRMED", "SHIPPED"], ["CONFIRMED", "CANCELLED"],
        ["PARTIALLY_SHIPPED", "SHIPPED"],
        ["SHIPPED", "DELIVERED"],
      ],
      checkOrderTransition,
    );
  });
  it("fulfillment", () => {
    expectExactTransitions(
      ["RESERVED", "SHIPPED", "DELIVERED", "CANCELLED"] as const,
      [["RESERVED", "SHIPPED"], ["RESERVED", "CANCELLED"], ["SHIPPED", "DELIVERED"]],
      checkFulfillmentTransition,
    );
  });
});

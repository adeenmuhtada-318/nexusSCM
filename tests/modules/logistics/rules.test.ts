import { describe, expect, it } from "vitest";
import { expectExactTransitions } from "../../helpers/transitions";
import {
  checkShipmentTransition,
  selectCarrier,
  type CarrierQuote,
  type SelectionConfig,
} from "@/modules/logistics/rules";

const cfg: SelectionConfig = { heavyWeightLbs: 50, heavyWindowDays: 3, weights: { cost: 0.4, speed: 0.3, reliability: 0.3 } };
const q = (o: Partial<CarrierQuote> & { carrierId: number }): CarrierQuote => ({
  code: `C${o.carrierId}`,
  mode: "PARCEL",
  costCents: 1000,
  transitDays: 3,
  reliability: 0.9,
  ...o,
});

describe("selectCarrier precedence", () => {
  const quotes = [
    q({ carrierId: 1, mode: "AIR_EXPRESS", costCents: 9000, transitDays: 1 }),
    q({ carrierId: 2, mode: "AIR_EXPRESS", costCents: 7000, transitDays: 2 }),
    q({ carrierId: 3, mode: "GROUND_FREIGHT", costCents: 2000, transitDays: 6 }),
    q({ carrierId: 4, mode: "GROUND_FREIGHT", costCents: 1500, transitDays: 7 }),
    q({ carrierId: 5, mode: "PARCEL", costCents: 1200, transitDays: 4 }),
  ];

  it("1. URGENT → fastest Air Express, even if heavy & long window", () => {
    const r = selectCarrier({ priority: "URGENT", weightLbs: 500, deliveryWindowDays: 10, quotes }, cfg);
    expect(r).toMatchObject({ ok: true, rule: "URGENT_AIR", quote: { carrierId: 1 } });
  });
  it("URGENT with no eligible Air Express → NO_ELIGIBLE_CARRIER, no silent downgrade", () => {
    const r = selectCarrier({ priority: "URGENT", weightLbs: 5, deliveryWindowDays: 5, quotes: quotes.slice(2) }, cfg);
    expect(r).toEqual({ ok: false, code: "NO_ELIGIBLE_CARRIER", reason: "URGENT_NO_AIR_EXPRESS" });
  });
  it("2. weight > 50 AND window > 3 → cheapest Ground Freight", () => {
    const r = selectCarrier({ priority: "STANDARD", weightLbs: 50.01, deliveryWindowDays: 4, quotes }, cfg);
    expect(r).toMatchObject({ ok: true, rule: "HEAVY_GROUND", quote: { carrierId: 4 } });
  });
  it("boundary: weight exactly 50 does NOT trigger rule 2", () => {
    const r = selectCarrier({ priority: "STANDARD", weightLbs: 50, deliveryWindowDays: 4, quotes }, cfg);
    expect(r.ok && r.rule).toBe("WEIGHTED_SCORE");
  });
  it("boundary: window exactly 3 does NOT trigger rule 2", () => {
    const r = selectCarrier({ priority: "STANDARD", weightLbs: 80, deliveryWindowDays: 3, quotes }, cfg);
    expect(r.ok && r.rule).toBe("WEIGHTED_SCORE");
  });
  it("heavy but no ground freight eligible → falls through to weighted score", () => {
    const r = selectCarrier({ priority: "STANDARD", weightLbs: 80, deliveryWindowDays: 5, quotes: quotes.filter((x) => x.mode !== "GROUND_FREIGHT") }, cfg);
    expect(r.ok && r.rule).toBe("WEIGHTED_SCORE");
  });
  it("no quotes → NO_ELIGIBLE_CARRIER", () => {
    expect(selectCarrier({ priority: "STANDARD", weightLbs: 1, deliveryWindowDays: 5, quotes: [] }, cfg)).toEqual({
      ok: false,
      code: "NO_ELIGIBLE_CARRIER",
      reason: "NO_QUOTES",
    });
  });
});

describe("weighted score", () => {
  it("normalises each metric to 0–1 before weighting", () => {
    const cheapSlow = q({ carrierId: 1, costCents: 1000, transitDays: 10, reliability: 0.8 });
    const dearFast = q({ carrierId: 2, costCents: 5000, transitDays: 1, reliability: 0.99 });
    const costOnly = selectCarrier({ priority: "STANDARD", weightLbs: 1, deliveryWindowDays: 14, quotes: [cheapSlow, dearFast] },
      { ...cfg, weights: { cost: 1, speed: 0, reliability: 0 } });
    const speedOnly = selectCarrier({ priority: "STANDARD", weightLbs: 1, deliveryWindowDays: 14, quotes: [cheapSlow, dearFast] },
      { ...cfg, weights: { cost: 0, speed: 1, reliability: 0 } });
    expect(costOnly.ok && costOnly.quote.carrierId).toBe(1);
    expect(speedOnly.ok && speedOnly.quote.carrierId).toBe(2);
  });
  it("score lies in [0,1] and weights need not sum to 1", () => {
    const r = selectCarrier(
      { priority: "STANDARD", weightLbs: 1, deliveryWindowDays: 9, quotes: [q({ carrierId: 1, costCents: 100 }), q({ carrierId: 2, costCents: 900, transitDays: 1 })] },
      { ...cfg, weights: { cost: 4, speed: 3, reliability: 3 } },
    );
    expect(r.ok && r.score !== undefined && r.score >= 0 && r.score <= 1).toBe(true);
  });
  it("identical carriers resolve deterministically by lowest id", () => {
    const r = selectCarrier({ priority: "STANDARD", weightLbs: 1, deliveryWindowDays: 9, quotes: [q({ carrierId: 9 }), q({ carrierId: 3 })] }, cfg);
    expect(r.ok && r.quote.carrierId).toBe(3);
  });
  it("throws on all-zero weights", () => {
    expect(() =>
      selectCarrier({ priority: "STANDARD", weightLbs: 1, deliveryWindowDays: 9, quotes: [q({ carrierId: 1 })] }, { ...cfg, weights: { cost: 0, speed: 0, reliability: 0 } }),
    ).toThrow(RangeError);
  });
});

describe("shipment transitions", () => {
  it("every illegal transition is rejected", () => {
    expectExactTransitions(
      ["BOOKED", "IN_TRANSIT", "DELIVERED", "CANCELLED"] as const,
      [["BOOKED", "IN_TRANSIT"], ["BOOKED", "CANCELLED"], ["IN_TRANSIT", "DELIVERED"]],
      checkShipmentTransition,
    );
  });
});

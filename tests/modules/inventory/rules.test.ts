import { describe, expect, it } from "vitest";
import { expectExactTransitions } from "../../helpers/transitions";
import {
  computeRop,
  minAcceptableExpiry,
  pickingStrategy,
  planAllocation,
  requisitionQty,
  shouldRequisition,
  isAllocatableZone,
  checkReservationTransition,
  checkRequisitionTransition,
  addDaysISO,
} from "@/modules/inventory/rules";

describe("computeRop", () => {
  it("ROP = D×L + Z×σ×√L", () => {
    const r = computeRop({ dAvg: 10, sigmaD: 4, lAvg: 9, z: 1.65 });
    expect(r.safetyStock).toBeCloseTo(1.65 * 4 * 3, 10);
    expect(r.rop).toBeCloseTo(90 + 19.8, 10);
  });
  it("zero history gives ROP 0; zero lead time gives ROP 0", () => {
    expect(computeRop({ dAvg: 0, sigmaD: 0, lAvg: 7, z: 1.65 }).rop).toBe(0);
    expect(computeRop({ dAvg: 5, sigmaD: 2, lAvg: 0, z: 1.65 }).rop).toBe(0);
  });
  it("rejects negative / NaN inputs", () => {
    expect(() => computeRop({ dAvg: -1, sigmaD: 0, lAvg: 1, z: 1 })).toThrow(RangeError);
    expect(() => computeRop({ dAvg: NaN, sigmaD: 0, lAvg: 1, z: 1 })).toThrow(RangeError);
  });
});

describe("shouldRequisition (boundary: <=)", () => {
  const base = { qtyOnOrder: 0, rop: 100, hasOpenRequisition: false };
  it("triggers below and exactly at ROP, not above", () => {
    expect(shouldRequisition({ ...base, qtyAvailable: 99 })).toBe(true);
    expect(shouldRequisition({ ...base, qtyAvailable: 100 })).toBe(true);
    expect(shouldRequisition({ ...base, qtyAvailable: 101 })).toBe(false);
  });
  it("counts on-order stock as position", () => {
    expect(shouldRequisition({ ...base, qtyAvailable: 60, qtyOnOrder: 41 })).toBe(false);
    expect(shouldRequisition({ ...base, qtyAvailable: 60, qtyOnOrder: 40 })).toBe(true);
  });
  it("never when an open requisition exists (idempotent)", () => {
    expect(shouldRequisition({ ...base, qtyAvailable: 0, hasOpenRequisition: true })).toBe(false);
  });
});

describe("requisitionQty", () => {
  it("orders up to ROP + cover and rounds up; min 1", () => {
    expect(requisitionQty({ rop: 100, dAvg: 10, coverDays: 30, position: 50 })).toBe(350);
    expect(requisitionQty({ rop: 10.2, dAvg: 0, coverDays: 30, position: 10 })).toBe(1);
    expect(requisitionQty({ rop: 10.2, dAvg: 0, coverDays: 30, position: 0 })).toBe(11);
  });
});

describe("picking rules", () => {
  it("perishable → FEFO else FIFO", () => {
    expect(pickingStrategy(true)).toBe("FEFO");
    expect(pickingStrategy(false)).toBe("FIFO");
  });
  it("only PRIME is allocatable", () => {
    expect(isAllocatableZone("PRIME")).toBe(true);
    expect(isAllocatableZone("QUARANTINE_REFURBISHMENT")).toBe(false);
    expect(isAllocatableZone("QUARANTINE_QUALITY")).toBe(false);
  });
  it("min acceptable expiry: 20% of 100d → today+20; never earlier than tomorrow", () => {
    expect(minAcceptableExpiry("2026-01-01", 100, 20)).toBe("2026-01-21");
    expect(minAcceptableExpiry("2026-01-01", 7, 20)).toBe("2026-01-03"); // ceil(1.4)=2
    expect(minAcceptableExpiry("2026-01-01", 100, 0)).toBe("2026-01-02");
    expect(minAcceptableExpiry("2026-12-31", 10, 10)).toBe("2027-01-01");
  });
  it("rejects invalid shelf-life input", () => {
    expect(() => minAcceptableExpiry("2026-01-01", 0, 20)).toThrow(RangeError);
    expect(() => minAcceptableExpiry("2026-01-01", 10, 101)).toThrow(RangeError);
  });
  it("addDaysISO handles month/leap boundaries", () => {
    expect(addDaysISO("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysISO("2027-02-28", 1)).toBe("2027-03-01");
  });
});

describe("planAllocation", () => {
  const batches = [
    { id: 1, qtyAvailable: 5 },
    { id: 2, qtyAvailable: 0 },
    { id: 3, qtyAvailable: 10 },
  ];
  it("fills in the given (FEFO/FIFO) order and skips empty batches", () => {
    expect(planAllocation(batches, 8)).toEqual({
      allocations: [
        { batchId: 1, qty: 5 },
        { batchId: 3, qty: 3 },
      ],
      shortfall: 0,
    });
  });
  it("reports shortfall without over-allocating", () => {
    const r = planAllocation(batches, 20);
    expect(r.shortfall).toBe(5);
    expect(r.allocations.reduce((s, a) => s + a.qty, 0)).toBe(15);
  });
  it("exact fit and invalid qty", () => {
    expect(planAllocation(batches, 15).shortfall).toBe(0);
    expect(() => planAllocation(batches, 0)).toThrow(RangeError);
    expect(() => planAllocation(batches, 1.5)).toThrow(RangeError);
  });
});

describe("transition maps � every illegal transition is rejected", () => {
  it("reservation", () => {
    expectExactTransitions(
      ["ACTIVE", "RELEASED", "FULFILLED"] as const,
      [["ACTIVE", "RELEASED"], ["ACTIVE", "FULFILLED"]],
      checkReservationTransition,
    );
  });
  it("requisition", () => {
    expectExactTransitions(
      ["OPEN", "CONVERTED", "CANCELLED"] as const,
      [["OPEN", "CONVERTED"], ["OPEN", "CANCELLED"]],
      checkRequisitionTransition,
    );
  });
});

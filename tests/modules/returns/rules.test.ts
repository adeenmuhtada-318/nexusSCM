import { describe, expect, it } from "vitest";
import { expectExactTransitions } from "../../helpers/transitions";
import { checkRmaTransition, decideDisposition, evaluateRma, lineRefundCents } from "@/modules/returns/rules";

const base = {
  delivered: true,
  daysSinceDelivery: 10,
  windowDays: 30,
  isCustomized: false,
  qtyRequested: 1,
  qtyOrdered: 2,
  qtyAlreadyReturned: 0,
  ineligiblePolicy: "AUTO_DENY" as const,
};

describe("evaluateRma window boundary", () => {
  it("day 30 approved, day 31 denied", () => {
    expect(evaluateRma({ ...base, daysSinceDelivery: 30 })).toEqual({ decision: "AUTO_APPROVE", reasonCode: "WITHIN_WINDOW" });
    expect(evaluateRma({ ...base, daysSinceDelivery: 31 })).toEqual({ decision: "AUTO_DENY", reasonCode: "PAST_RETURN_WINDOW" });
  });
  it("day 0 (same-day) approved", () => {
    expect(evaluateRma({ ...base, daysSinceDelivery: 0 }).decision).toBe("AUTO_APPROVE");
  });
  it("window is a parameter", () => {
    expect(evaluateRma({ ...base, daysSinceDelivery: 15, windowDays: 14 }).decision).toBe("AUTO_DENY");
  });
  it("past window routes to human review when configured", () => {
    expect(evaluateRma({ ...base, daysSinceDelivery: 45, ineligiblePolicy: "HUMAN_REVIEW" })).toEqual({
      decision: "HUMAN_REVIEW",
      reasonCode: "PAST_RETURN_WINDOW",
    });
  });
});

describe("evaluateRma other gates", () => {
  it("customized items are never auto-approved", () => {
    expect(evaluateRma({ ...base, isCustomized: true })).toEqual({ decision: "AUTO_DENY", reasonCode: "CUSTOMIZED_ITEM" });
    expect(evaluateRma({ ...base, isCustomized: true, ineligiblePolicy: "HUMAN_REVIEW" }).decision).toBe("HUMAN_REVIEW");
  });
  it("not delivered → hard deny", () => {
    expect(evaluateRma({ ...base, delivered: false, daysSinceDelivery: null })).toEqual({ decision: "AUTO_DENY", reasonCode: "NOT_DELIVERED" });
  });
  it("fully returned line → hard deny even under HUMAN_REVIEW policy", () => {
    expect(evaluateRma({ ...base, qtyAlreadyReturned: 2, ineligiblePolicy: "HUMAN_REVIEW" })).toEqual({
      decision: "AUTO_DENY",
      reasonCode: "ALREADY_RETURNED",
    });
  });
  it("cannot return more than the remaining quantity", () => {
    expect(evaluateRma({ ...base, qtyAlreadyReturned: 1, qtyRequested: 2 })).toEqual({ decision: "AUTO_DENY", reasonCode: "INVALID_QUANTITY" });
    expect(evaluateRma({ ...base, qtyAlreadyReturned: 1, qtyRequested: 1 }).decision).toBe("AUTO_APPROVE");
  });
  it("zero / fractional quantity rejected", () => {
    expect(evaluateRma({ ...base, qtyRequested: 0 }).reasonCode).toBe("INVALID_QUANTITY");
    expect(evaluateRma({ ...base, qtyRequested: 1.5 }).reasonCode).toBe("INVALID_QUANTITY");
  });
});

describe("decideDisposition", () => {
  it("unopened + VERIFIED_NEW → restock PRIME, no exception", () => {
    expect(decideDisposition({ isOpened: false, condition: "VERIFIED_NEW" })).toEqual({ disposition: "RESTOCK_PRIME", needsGradingException: false });
  });
  it("everything else → quarantine + grading exception", () => {
    for (const [isOpened, condition] of [
      [true, "VERIFIED_NEW"], [true, "OPENED_GOOD"], [true, "DAMAGED"], [false, "OPENED_GOOD"], [false, "DAMAGED"],
    ] as const) {
      expect(decideDisposition({ isOpened, condition })).toEqual({ disposition: "QUARANTINE_REFURBISHMENT", needsGradingException: true });
    }
  });
});

describe("lineRefundCents", () => {
  const line = { unitPriceCents: 1999, lineQty: 3, lineTotalCents: 5997, alreadyRefundedCents: 0 };
  it("refunds unit price × returned qty (not hard-coded 1)", () => {
    expect(lineRefundCents({ ...line, qty: 2 })).toBe(3998);
  });
  it("never exceeds the unpaid-back headroom", () => {
    expect(lineRefundCents({ ...line, qty: 3, alreadyRefundedCents: 1999 })).toBe(3998);
    expect(lineRefundCents({ ...line, qty: 1, alreadyRefundedCents: 5997 })).toBe(0);
  });
  it("rejects quantities beyond the line", () => {
    expect(() => lineRefundCents({ ...line, qty: 4 })).toThrow(RangeError);
    expect(() => lineRefundCents({ ...line, qty: 0 })).toThrow(RangeError);
  });
});

describe("RMA transitions", () => {
  it("every illegal transition is rejected", () => {
    expectExactTransitions(
      ["PENDING_REVIEW", "APPROVED", "DENIED", "RECEIVED", "INSPECTED", "REFUNDED", "CLOSED"] as const,
      [
        ["PENDING_REVIEW", "APPROVED"], ["PENDING_REVIEW", "DENIED"],
        ["APPROVED", "RECEIVED"], ["APPROVED", "CLOSED"],
        ["RECEIVED", "INSPECTED"],
        ["INSPECTED", "REFUNDED"], ["INSPECTED", "CLOSED"],
        ["REFUNDED", "CLOSED"],
      ],
      checkRmaTransition,
    );
  });
});

import { describe, expect, it } from "vitest";
import { expectExactTransitions } from "../../helpers/transitions";
import { checkApproval, checkPoTransition, decideApproval, selectVendor, type VendorOption } from "@/modules/procurement/rules";

const T = 1_000_000; // $10,000.00 in cents (config value, passed in)

describe("decideApproval — $10,000 gate (>=)", () => {
  it("9999.99 → auto-dispatched", () => {
    expect(decideApproval({ effectiveCostCents: 999_999, tier: 1, thresholdCents: T })).toEqual({
      status: "APPROVED_AND_DISPATCHED",
      requiredRole: null,
      reasonCode: "AUTO_BELOW_THRESHOLD",
    });
  });
  it("10000.00 → manager approval (inclusive boundary)", () => {
    expect(decideApproval({ effectiveCostCents: 1_000_000, tier: 1, thresholdCents: T })).toMatchObject({
      status: "PENDING_MANAGER_APPROVAL",
      requiredRole: "MANAGER",
    });
  });
  it("10000.01 → manager approval", () => {
    expect(decideApproval({ effectiveCostCents: 1_000_001, tier: 2, thresholdCents: T }).status).toBe("PENDING_MANAGER_APPROVAL");
  });
  it("Tier 3 below threshold → buyer approval, never auto", () => {
    expect(decideApproval({ effectiveCostCents: 100, tier: 3, thresholdCents: T })).toMatchObject({
      status: "PENDING_BUYER_APPROVAL",
      requiredRole: "BUYER",
    });
  });
  it("Tier 3 AND ≥ threshold → ONE manager item (precedence)", () => {
    expect(decideApproval({ effectiveCostCents: 1_000_000, tier: 3, thresholdCents: T })).toEqual({
      status: "PENDING_MANAGER_APPROVAL",
      requiredRole: "MANAGER",
      reasonCode: "TIER3_OVER_THRESHOLD",
    });
  });
  it("split-PO abuse: caller adds same-day open cost, so two $6k POs hit the gate", () => {
    const prior = 600_000;
    expect(decideApproval({ effectiveCostCents: 600_000 + prior, tier: 1, thresholdCents: T }).status).toBe("PENDING_MANAGER_APPROVAL");
  });
  it("threshold is a parameter, not a constant", () => {
    expect(decideApproval({ effectiveCostCents: 5_000, tier: 1, thresholdCents: 5_000 }).status).toBe("PENDING_MANAGER_APPROVAL");
    expect(decideApproval({ effectiveCostCents: 4_999, tier: 1, thresholdCents: 5_000 }).status).toBe("APPROVED_AND_DISPATCHED");
  });
  it("rejects invalid costs", () => {
    expect(() => decideApproval({ effectiveCostCents: -1, tier: 1, thresholdCents: T })).toThrow(RangeError);
    expect(() => decideApproval({ effectiveCostCents: 1.5, tier: 1, thresholdCents: T })).toThrow(RangeError);
  });
});

describe("selectVendor cascade", () => {
  const v = (o: Partial<VendorOption> & { contractId: number; hierarchyTier: 1 | 2 | 3 }): VendorOption => ({
    vendorId: o.contractId,
    unitCostCents: 100,
    leadTimeDays: 5,
    maxQtyPerOrder: 1000,
    maxAcceptableLeadDays: 10,
    ...o,
  });
  it("Tier 1 wins when eligible", () => {
    const r = selectVendor([v({ contractId: 2, hierarchyTier: 2 }), v({ contractId: 1, hierarchyTier: 1 })], 100);
    expect(r).toMatchObject({ ok: true, cascaded: false, vendor: { contractId: 1 } });
  });
  it("cascades to Tier 2 when Tier 1 lacks capacity", () => {
    const r = selectVendor([v({ contractId: 1, hierarchyTier: 1, maxQtyPerOrder: 50 }), v({ contractId: 2, hierarchyTier: 2 })], 100);
    expect(r).toMatchObject({ ok: true, cascaded: true, vendor: { contractId: 2 } });
  });
  it("cascades when Tier 1 lead time is unacceptable", () => {
    const r = selectVendor([v({ contractId: 1, hierarchyTier: 1, leadTimeDays: 11 }), v({ contractId: 2, hierarchyTier: 2 })], 10);
    expect(r.ok && r.vendor.contractId).toBe(2);
  });
  it("lead time exactly at the max is acceptable", () => {
    const r = selectVendor([v({ contractId: 1, hierarchyTier: 1, leadTimeDays: 10 })], 10);
    expect(r.ok).toBe(true);
  });
  it("capacity exactly equal to qty is acceptable", () => {
    expect(selectVendor([v({ contractId: 1, hierarchyTier: 1, maxQtyPerOrder: 100 })], 100).ok).toBe(true);
  });
  it("nobody eligible → NO_VENDOR_AVAILABLE", () => {
    expect(selectVendor([v({ contractId: 1, hierarchyTier: 1, maxQtyPerOrder: 1 })], 100)).toEqual({ ok: false, code: "NO_VENDOR_AVAILABLE" });
    expect(selectVendor([], 5)).toEqual({ ok: false, code: "NO_VENDOR_AVAILABLE" });
  });
});

describe("checkApproval", () => {
  const base = { status: "PENDING_MANAGER_APPROVAL" as const, requiredRole: "MANAGER" as const, approverRole: "MANAGER" as const, approverId: "m1", requesterId: "b1", reasonCode: "WITHIN_BUDGET" };
  it("allows a different manager with a reason", () => expect(checkApproval(base)).toEqual({ ok: true }));
  it("blocks requester = approver (separation of duties)", () => {
    expect(checkApproval({ ...base, approverId: "b1" })).toMatchObject({ ok: false, code: "SEPARATION_OF_DUTIES" });
  });
  it("allows system-generated POs (null requester)", () => expect(checkApproval({ ...base, requesterId: null }).ok).toBe(true));
  it("manager items need MANAGER (BUYER and ADMIN forbidden)", () => {
    expect(checkApproval({ ...base, approverRole: "BUYER" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(checkApproval({ ...base, approverRole: "ADMIN" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
  it("buyer items accept BUYER or MANAGER, not warehouse/customer service", () => {
    const b = { ...base, status: "PENDING_BUYER_APPROVAL" as const, requiredRole: "BUYER" as const };
    expect(checkApproval({ ...b, approverRole: "BUYER" }).ok).toBe(true);
    expect(checkApproval({ ...b, approverRole: "MANAGER" }).ok).toBe(true);
    expect(checkApproval({ ...b, approverRole: "WAREHOUSE_TECH" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
  it("requires a reason code", () => {
    expect(checkApproval({ ...base, reasonCode: "  " })).toMatchObject({ ok: false, code: "VALIDATION" });
  });
  it("cannot approve a non-pending PO", () => {
    expect(checkApproval({ ...base, status: "RECEIVED" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });
});

describe("PO transitions", () => {
  it("every illegal transition is rejected", () => {
    expectExactTransitions(
      ["PENDING_BUYER_APPROVAL", "PENDING_MANAGER_APPROVAL", "APPROVED_AND_DISPATCHED", "RECEIVED", "REJECTED", "CANCELLED"] as const,
      [
        ["PENDING_BUYER_APPROVAL", "APPROVED_AND_DISPATCHED"], ["PENDING_BUYER_APPROVAL", "REJECTED"], ["PENDING_BUYER_APPROVAL", "CANCELLED"],
        ["PENDING_MANAGER_APPROVAL", "APPROVED_AND_DISPATCHED"], ["PENDING_MANAGER_APPROVAL", "REJECTED"], ["PENDING_MANAGER_APPROVAL", "CANCELLED"],
        ["APPROVED_AND_DISPATCHED", "RECEIVED"], ["APPROVED_AND_DISPATCHED", "CANCELLED"],
      ],
      checkPoTransition,
    );
  });
});

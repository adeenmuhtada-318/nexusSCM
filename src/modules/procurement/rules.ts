/**
 * Procurement decision logic — PURE. CLAUDE.md §5.4.
 * Money is integer cents; thresholds are parameters (never hard-coded here).
 */
import { checkTransition, type TransitionMap } from "@/lib/utils/state-machine";

export type PoStatus =
  | "PENDING_BUYER_APPROVAL"
  | "PENDING_MANAGER_APPROVAL"
  | "APPROVED_AND_DISPATCHED"
  | "RECEIVED"
  | "REJECTED"
  | "CANCELLED";
export type ApproverRole = "BUYER" | "MANAGER";
export type Role = "ADMIN" | "WAREHOUSE_TECH" | "CUSTOMER_SERVICE" | "BUYER" | "MANAGER";

export const PO_TRANSITIONS: TransitionMap<PoStatus> = {
  PENDING_BUYER_APPROVAL: ["APPROVED_AND_DISPATCHED", "REJECTED", "CANCELLED"],
  PENDING_MANAGER_APPROVAL: ["APPROVED_AND_DISPATCHED", "REJECTED", "CANCELLED"],
  APPROVED_AND_DISPATCHED: ["RECEIVED", "CANCELLED"],
  RECEIVED: [],
  REJECTED: [],
  CANCELLED: [],
};
export const checkPoTransition = (from: PoStatus, to: PoStatus) => checkTransition(PO_TRANSITIONS, from, to);

export interface VendorOption {
  contractId: number;
  vendorId: number;
  hierarchyTier: 1 | 2 | 3;
  unitCostCents: number;
  leadTimeDays: number;
  maxQtyPerOrder: number;
  maxAcceptableLeadDays: number;
}

export type VendorSelection =
  | { ok: true; vendor: VendorOption; cascaded: boolean }
  | { ok: false; code: "NO_VENDOR_AVAILABLE" };

/**
 * RULE: vendor hierarchy cascade. Contracts are read `ORDER BY hierarchy_tier ASC` (1 Primary, 2 Secondary,
 * 3 Spot) in SQL; the first one with enough capacity (maxQtyPerOrder ≥ qty) AND acceptable lead time wins.
 * EDGE: ties inside a tier → lowest unit cost, then lowest contractId (deterministic). `cascaded` is true when
 * the winner is not Tier 1. No eligible contract → NO_VENDOR_AVAILABLE (caller raises an exception row).
 */
export function selectVendor(options: readonly VendorOption[], qty: number): VendorSelection {
  if (!Number.isInteger(qty) || qty <= 0) throw new RangeError("qty must be a positive integer");
  const eligible = options
    .filter((o) => o.maxQtyPerOrder >= qty && o.leadTimeDays <= o.maxAcceptableLeadDays)
    .sort((a, b) => a.hierarchyTier - b.hierarchyTier || a.unitCostCents - b.unitCostCents || a.contractId - b.contractId);
  const best = eligible[0];
  if (!best) return { ok: false, code: "NO_VENDOR_AVAILABLE" };
  return { ok: true, vendor: best, cascaded: best.hierarchyTier !== 1 };
}

export interface ApprovalDecision {
  status: "APPROVED_AND_DISPATCHED" | "PENDING_BUYER_APPROVAL" | "PENDING_MANAGER_APPROVAL";
  /** Role required to approve; null when auto-approved. */
  requiredRole: ApproverRole | null;
  reasonCode: "AUTO_BELOW_THRESHOLD" | "OVER_THRESHOLD" | "TIER3_SPOT_BUY" | "TIER3_OVER_THRESHOLD";
}

/**
 * RULE: the approval gate.
 *  - effectiveCost = this PO's total + open same-vendor/same-SKU/same-day cost (split-PO abuse guard, computed by the
 *    caller in SQL) so a big PO cannot be split to dodge the gate.
 *  - effectiveCost >= threshold (inclusive!) → PENDING_MANAGER_APPROVAL, requires MANAGER.
 *  - else Tier 3 (Spot) → PENDING_BUYER_APPROVAL (always a human buyer).
 *  - else → APPROVED_AND_DISPATCHED automatically.
 * PRECEDENCE: Tier 3 AND ≥ threshold → ONE approval item, requiring the MANAGER role (TIER3_OVER_THRESHOLD).
 * EDGE: 9999.99 → auto; 10000.00 and 10000.01 → manager (with threshold = 1_000_000 cents). Negative cost throws.
 */
export function decideApproval(i: { effectiveCostCents: number; tier: 1 | 2 | 3; thresholdCents: number }): ApprovalDecision {
  if (!Number.isInteger(i.effectiveCostCents) || i.effectiveCostCents < 0) throw new RangeError("invalid cost");
  const over = i.effectiveCostCents >= i.thresholdCents;
  if (over) {
    return {
      status: "PENDING_MANAGER_APPROVAL",
      requiredRole: "MANAGER",
      reasonCode: i.tier === 3 ? "TIER3_OVER_THRESHOLD" : "OVER_THRESHOLD",
    };
  }
  if (i.tier === 3) return { status: "PENDING_BUYER_APPROVAL", requiredRole: "BUYER", reasonCode: "TIER3_SPOT_BUY" };
  return { status: "APPROVED_AND_DISPATCHED", requiredRole: null, reasonCode: "AUTO_BELOW_THRESHOLD" };
}

export type ApprovalCheck =
  | { ok: true }
  | { ok: false; code: "FORBIDDEN" | "SEPARATION_OF_DUTIES" | "VALIDATION" | "ILLEGAL_TRANSITION"; message: string };

/**
 * RULE: who may approve. Manager-level items need MANAGER; buyer-level items accept BUYER or MANAGER.
 * SEPARATION OF DUTIES: approver ≠ requester (requester may be null for system-generated POs). A reason_code
 * is mandatory (PENDING_MANAGER_APPROVAL requires approved_by, approved_at, reason_code). ADMIN cannot approve:
 * administration is not a procurement authority (D-13).
 */
export function checkApproval(i: {
  status: PoStatus;
  requiredRole: ApproverRole | null;
  approverRole: Role;
  approverId: string;
  requesterId: string | null;
  reasonCode: string;
}): ApprovalCheck {
  if (i.status !== "PENDING_BUYER_APPROVAL" && i.status !== "PENDING_MANAGER_APPROVAL") {
    return { ok: false, code: "ILLEGAL_TRANSITION", message: `PO is ${i.status}; nothing to approve` };
  }
  const required: ApproverRole = i.status === "PENDING_MANAGER_APPROVAL" ? "MANAGER" : "BUYER";
  const allowed = required === "MANAGER" ? i.approverRole === "MANAGER" : i.approverRole === "BUYER" || i.approverRole === "MANAGER";
  if (!allowed) return { ok: false, code: "FORBIDDEN", message: `Requires ${required} role` };
  if (i.requesterId !== null && i.requesterId === i.approverId) {
    return { ok: false, code: "SEPARATION_OF_DUTIES", message: "Approver cannot be the requester" };
  }
  if (i.reasonCode.trim().length === 0) return { ok: false, code: "VALIDATION", message: "reason_code is required" };
  return { ok: true };
}

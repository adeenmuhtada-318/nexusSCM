/**
 * Returns decision logic — PURE. CLAUDE.md §5.5.
 * `daysSinceDelivery` is computed in SQL as (CURRENT_DATE in business tz − delivered_at::date) and passed in.
 */
import { checkTransition, type TransitionMap } from "@/lib/utils/state-machine";

export type RmaStatus = "PENDING_REVIEW" | "APPROVED" | "DENIED" | "RECEIVED" | "INSPECTED" | "REFUNDED" | "CLOSED";
export type Condition = "VERIFIED_NEW" | "OPENED_GOOD" | "DAMAGED";
export type Disposition = "RESTOCK_PRIME" | "QUARANTINE_REFURBISHMENT";

export const RMA_TRANSITIONS: TransitionMap<RmaStatus> = {
  PENDING_REVIEW: ["APPROVED", "DENIED"],
  APPROVED: ["RECEIVED", "CLOSED"],
  RECEIVED: ["INSPECTED"],
  INSPECTED: ["REFUNDED", "CLOSED"],
  REFUNDED: ["CLOSED"],
  DENIED: [],
  CLOSED: [],
};
export const checkRmaTransition = (from: RmaStatus, to: RmaStatus) => checkTransition(RMA_TRANSITIONS, from, to);

export type RmaReason =
  | "WITHIN_WINDOW"
  | "NOT_DELIVERED"
  | "PAST_RETURN_WINDOW"
  | "CUSTOMIZED_ITEM"
  | "ALREADY_RETURNED"
  | "INVALID_QUANTITY";
export type RmaDecision =
  | { decision: "AUTO_APPROVE"; reasonCode: "WITHIN_WINDOW" }
  | { decision: "AUTO_DENY"; reasonCode: RmaReason }
  | { decision: "HUMAN_REVIEW"; reasonCode: RmaReason };

/**
 * RULE: RMA gatekeeper. Auto-approve only if ALL hold:
 *   daysSinceDelivery <= windowDays (day 30 passes, day 31 fails) AND is_customized = false AND the requested
 *   quantity fits in what has not already been returned (prevents double returns).
 * Hard denials regardless of config: not delivered, non-positive/over-quantity, already (fully) returned.
 * Soft failures (past window, customized) follow the configured policy: AUTO_DENY or HUMAN_REVIEW.
 * Check order (first failure reported): delivered → quantity → already-returned → customized → window.
 */
export function evaluateRma(i: {
  delivered: boolean;
  daysSinceDelivery: number | null;
  windowDays: number;
  isCustomized: boolean;
  qtyRequested: number;
  qtyOrdered: number;
  qtyAlreadyReturned: number;
  ineligiblePolicy: "AUTO_DENY" | "HUMAN_REVIEW";
}): RmaDecision {
  if (!i.delivered || i.daysSinceDelivery === null) return { decision: "AUTO_DENY", reasonCode: "NOT_DELIVERED" };
  if (!Number.isInteger(i.qtyRequested) || i.qtyRequested <= 0) return { decision: "AUTO_DENY", reasonCode: "INVALID_QUANTITY" };
  const remaining = i.qtyOrdered - i.qtyAlreadyReturned;
  if (remaining <= 0) return { decision: "AUTO_DENY", reasonCode: "ALREADY_RETURNED" };
  if (i.qtyRequested > remaining) return { decision: "AUTO_DENY", reasonCode: "INVALID_QUANTITY" };
  const soft = (reasonCode: RmaReason): RmaDecision =>
    i.ineligiblePolicy === "HUMAN_REVIEW" ? { decision: "HUMAN_REVIEW", reasonCode } : { decision: "AUTO_DENY", reasonCode };
  if (i.isCustomized) return soft("CUSTOMIZED_ITEM");
  if (i.daysSinceDelivery > i.windowDays) return soft("PAST_RETURN_WINDOW");
  return { decision: "AUTO_APPROVE", reasonCode: "WITHIN_WINDOW" };
}

/**
 * RULE: dock-inspection disposition. is_opened = false AND condition = VERIFIED_NEW → RESTOCK_PRIME (+qty, ledger row);
 * anything else (opened, or damaged, or opened-but-good) → QUARANTINE_REFURBISHMENT plus an exception for technician
 * grading. Quantity is the returned quantity, handled by the caller (never hard-coded to 1).
 */
export function decideDisposition(i: { isOpened: boolean; condition: Condition }): {
  disposition: Disposition;
  needsGradingException: boolean;
} {
  if (!i.isOpened && i.condition === "VERIFIED_NEW") return { disposition: "RESTOCK_PRIME", needsGradingException: false };
  return { disposition: "QUARANTINE_REFURBISHMENT", needsGradingException: true };
}

/**
 * RULE: refund for one returned line = unit price × returned qty, in integer cents, and NEVER more than what was paid
 * for that line minus what was already refunded for it. EDGE: qty > ordered qty throws; fully refunded line → 0.
 */
export function lineRefundCents(i: {
  unitPriceCents: number;
  qty: number;
  lineQty: number;
  lineTotalCents: number;
  alreadyRefundedCents: number;
}): number {
  if (!Number.isInteger(i.qty) || i.qty <= 0 || i.qty > i.lineQty) throw new RangeError("invalid return quantity");
  const wanted = i.unitPriceCents * i.qty;
  const headroom = Math.max(0, i.lineTotalCents - i.alreadyRefundedCents);
  return Math.min(wanted, headroom);
}

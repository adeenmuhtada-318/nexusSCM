/**
 * Orders decision logic — PURE. CLAUDE.md §5.2.
 * Money is integer cents (exact; no floats). Distances are km. No Date.now().
 */
import { checkTransition, type TransitionMap } from "@/lib/utils/state-machine";

export type OrderStatus =
  | "ON_HOLD_EXCEPTION"
  | "BACKORDERED"
  | "RESERVED"
  | "CONFIRMED"
  | "PARTIALLY_SHIPPED"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED"
  | "EXPIRED";
export type FulfillmentStatus = "RESERVED" | "SHIPPED" | "DELIVERED" | "CANCELLED";

export const ORDER_TRANSITIONS: TransitionMap<OrderStatus> = {
  ON_HOLD_EXCEPTION: ["RESERVED", "BACKORDERED", "CANCELLED"],
  BACKORDERED: ["RESERVED", "ON_HOLD_EXCEPTION", "CANCELLED"],
  RESERVED: ["CONFIRMED", "CANCELLED", "EXPIRED"],
  CONFIRMED: ["PARTIALLY_SHIPPED", "SHIPPED", "CANCELLED"],
  PARTIALLY_SHIPPED: ["SHIPPED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
  EXPIRED: [],
};
export const FULFILLMENT_TRANSITIONS: TransitionMap<FulfillmentStatus> = {
  RESERVED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};
export const checkOrderTransition = (from: OrderStatus, to: OrderStatus) => checkTransition(ORDER_TRANSITIONS, from, to);
export const checkFulfillmentTransition = (from: FulfillmentStatus, to: FulfillmentStatus) =>
  checkTransition(FULFILLMENT_TRANSITIONS, from, to);

// ───────────────────────────── Seven Rights ─────────────────────────────

export type Right =
  | "PRODUCT_ACTIVE"
  | "QUANTITY_AVAILABLE"
  | "CONDITION_NOT_QUARANTINED"
  | "CUSTOMER_ACTIVE_CONTRACT_PRICE"
  | "CREDIT"
  | "ADDRESS"
  | "DELIVERY_ELIGIBILITY";

export type ReasonCode =
  | "PRODUCT_INACTIVE"
  | "INSUFFICIENT_STOCK"
  | "ONLY_QUARANTINED_STOCK"
  | "CUSTOMER_INACTIVE"
  | "ACCOUNT_INACTIVE"
  | "CREDIT_LIMIT_EXCEEDED"
  | "ADDRESS_NOT_GEOCODED"
  | "ADDRESS_INVALID"
  | "HAZMAT_RESTRICTED_DESTINATION";

export type OrderExceptionType =
  | "ORDER_ADDRESS_INVALID"
  | "ORDER_CREDIT_EXCEEDED"
  | "ORDER_HAZMAT_RESTRICTED"
  | "ORDER_CUSTOMER_INACTIVE"
  | "ORDER_PRODUCT_INACTIVE"
  | "NO_WAREHOUSE_CAN_FULFIL";
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RightsLine {
  skuId: number;
  qty: number;
  skuActive: boolean;
  isHazmat: boolean;
  /** Server-recomputed unit price in cents (contract price when present, else list). */
  unitPriceCents: number;
  /** Total PRIME, allocatable (non-expired, shelf-life ok) units across ALL active warehouses. */
  networkAvailable: number;
  /** Units sitting in QUARANTINE_* zones (explains a zero PRIME balance). */
  quarantinedQty: number;
}

export interface RightsInput {
  customerActive: boolean;
  accountActive: boolean;
  creditLimitCents: number;
  currentBalanceCents: number;
  address: { lat: number | null; lng: number | null; region: string; country: string } | null;
  destinationHazmatRestricted: boolean;
  lines: readonly RightsLine[];
}

export interface Failure {
  right: Right;
  reasonCode: ReasonCode;
  skuId?: number;
}

export interface Hold {
  exceptionType: OrderExceptionType;
  reasonCode: ReasonCode;
  severity: Severity;
}

export type RightsOutcome =
  | { outcome: "PASS"; totalCents: number; failures: [] }
  | { outcome: "HOLD"; totalCents: number; failures: Failure[]; holds: Hold[] }
  | { outcome: "BACKORDER"; totalCents: number; failures: Failure[] };

/** Exact integer sum of qty × unit price. */
export function orderTotalCents(lines: readonly Pick<RightsLine, "qty" | "unitPriceCents">[]): number {
  return lines.reduce((sum, l) => sum + l.qty * l.unitPriceCents, 0);
}

/** True if a coordinate pair is present and within [-90,90] / [-180,180] (CLAUDE.md §4.2). */
export function isValidCoordinate(lat: number | null, lng: number | null): boolean {
  return (
    lat !== null &&
    lng !== null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * RULE: credit check `order_total + current_balance <= credit_limit` in exact integer cents.
 * WHY CORRECT: no float arithmetic, so 0.1+0.2 style drift cannot flip a boundary decision. EDGE: exactly AT the
 * limit passes (<=); one cent over fails. The DB repeats the check atomically at reservation time (race guard).
 */
export function creditAllows(i: { totalCents: number; balanceCents: number; limitCents: number }): boolean {
  return i.totalCents + i.balanceCents <= i.limitCents;
}

/**
 * RULE: the "Seven Rights" gate, evaluated BEFORE any stock is reserved (CLAUDE.md §5.2).
 *  1 product active · 2 quantity available · 3 condition not quarantined · 4 customer active (+ contract price,
 *  applied upstream) · 5 credit · 6 address geocoded & valid · 7 delivery/hazmat eligibility.
 * Every failure carries a reason code. HOLD-class failures (inactive product/customer, credit, address, hazmat
 * destination) → ON_HOLD_EXCEPTION (+ one exception row each; D-05). Pure stock failures → BACKORDER (no exception
 * here; the planner raises NO_WAREHOUSE_CAN_FULFIL). HOLD takes precedence over BACKORDER because we never reserve
 * for an order that is held. EDGE: empty order → HOLD-free PASS is prevented upstream by Zod (≥1 line).
 */
export function evaluateSevenRights(i: RightsInput): RightsOutcome {
  const totalCents = orderTotalCents(i.lines);
  const failures: Failure[] = [];
  const holds: Hold[] = [];
  const addHold = (h: Hold, f: Failure) => {
    failures.push(f);
    if (!holds.some((x) => x.exceptionType === h.exceptionType)) holds.push(h);
  };

  // 1. product active
  for (const l of i.lines) {
    if (!l.skuActive) {
      addHold(
        { exceptionType: "ORDER_PRODUCT_INACTIVE", reasonCode: "PRODUCT_INACTIVE", severity: "MEDIUM" },
        { right: "PRODUCT_ACTIVE", reasonCode: "PRODUCT_INACTIVE", skuId: l.skuId },
      );
    }
  }
  // 4. customer / account active
  if (!i.customerActive || !i.accountActive) {
    const reasonCode: ReasonCode = !i.customerActive ? "CUSTOMER_INACTIVE" : "ACCOUNT_INACTIVE";
    addHold(
      { exceptionType: "ORDER_CUSTOMER_INACTIVE", reasonCode, severity: "HIGH" },
      { right: "CUSTOMER_ACTIVE_CONTRACT_PRICE", reasonCode },
    );
  }
  // 5. credit
  if (!creditAllows({ totalCents, balanceCents: i.currentBalanceCents, limitCents: i.creditLimitCents })) {
    addHold(
      { exceptionType: "ORDER_CREDIT_EXCEEDED", reasonCode: "CREDIT_LIMIT_EXCEEDED", severity: "HIGH" },
      { right: "CREDIT", reasonCode: "CREDIT_LIMIT_EXCEEDED" },
    );
  }
  // 6. address geocoded & valid
  if (!i.address || i.address.lat === null || i.address.lng === null) {
    addHold(
      { exceptionType: "ORDER_ADDRESS_INVALID", reasonCode: "ADDRESS_NOT_GEOCODED", severity: "MEDIUM" },
      { right: "ADDRESS", reasonCode: "ADDRESS_NOT_GEOCODED" },
    );
  } else if (!isValidCoordinate(i.address.lat, i.address.lng) || !i.address.region || !i.address.country) {
    addHold(
      { exceptionType: "ORDER_ADDRESS_INVALID", reasonCode: "ADDRESS_INVALID", severity: "MEDIUM" },
      { right: "ADDRESS", reasonCode: "ADDRESS_INVALID" },
    );
  }
  // 7. delivery / hazmat eligibility
  if (i.destinationHazmatRestricted && i.lines.some((l) => l.isHazmat)) {
    addHold(
      { exceptionType: "ORDER_HAZMAT_RESTRICTED", reasonCode: "HAZMAT_RESTRICTED_DESTINATION", severity: "HIGH" },
      { right: "DELIVERY_ELIGIBILITY", reasonCode: "HAZMAT_RESTRICTED_DESTINATION" },
    );
  }

  if (holds.length > 0) return { outcome: "HOLD", totalCents, failures, holds };

  // 2 + 3. quantity available / not-quarantined
  for (const l of i.lines) {
    if (l.networkAvailable < l.qty) {
      const onlyQuarantined = l.networkAvailable === 0 && l.quarantinedQty > 0;
      failures.push({
        right: onlyQuarantined ? "CONDITION_NOT_QUARANTINED" : "QUANTITY_AVAILABLE",
        reasonCode: onlyQuarantined ? "ONLY_QUARANTINED_STOCK" : "INSUFFICIENT_STOCK",
        skuId: l.skuId,
      });
    }
  }
  if (failures.length > 0) return { outcome: "BACKORDER", totalCents, failures };
  return { outcome: "PASS", totalCents, failures: [] };
}

// ───────────────────────────── Fulfillment planning ─────────────────────────────

export interface PlanLine {
  skuId: number;
  qty: number;
}
export interface WarehouseStock {
  id: number;
  /** Haversine distance to the destination in km, computed in SQL. */
  distanceKm: number;
  /** skuId → allocatable PRIME units in this warehouse. */
  available: Readonly<Record<number, number>>;
}
export interface ShipmentPlan {
  warehouseId: number;
  lines: PlanLine[];
}
export type FulfillmentPlan =
  | { kind: "PLAN"; shipments: ShipmentPlan[] }
  | { kind: "NO_WAREHOUSE_CAN_FULFIL"; shortfalls: { skuId: number; short: number }[] };

const avail = (w: WarehouseStock, skuId: number): number => w.available[skuId] ?? 0;
const byDistance = (a: WarehouseStock, b: WarehouseStock) => a.distanceKm - b.distanceKm || a.id - b.id;

/**
 * RULE: choose the fewest shipments that fulfil 100% of the order, tie-broken by distance (D-06).
 *  1. Network can't cover a line even by splitting → NO_WAREHOUSE_CAN_FULFIL (caller backorders + raises exception).
 *  2. If ANY single warehouse covers everything, use the NEAREST such warehouse (fewer shipments beats nearest-only).
 *  3. Otherwise greedy set-cover: repeatedly pick the warehouse covering the most remaining units; ties → nearest,
 *     then lowest id (deterministic). Greedy is a documented heuristic (optimal set-cover is NP-hard; n is tiny).
 * EDGE: zero-qty lines are ignored; a warehouse is never asked for more than it holds; output is deterministic.
 */
export function planFulfillment(lines: readonly PlanLine[], warehouses: readonly WarehouseStock[]): FulfillmentPlan {
  const need = new Map<number, number>();
  for (const l of lines) if (l.qty > 0) need.set(l.skuId, (need.get(l.skuId) ?? 0) + l.qty);

  const shortfalls: { skuId: number; short: number }[] = [];
  for (const [skuId, qty] of need) {
    const total = warehouses.reduce((s, w) => s + avail(w, skuId), 0);
    if (total < qty) shortfalls.push({ skuId, short: qty - total });
  }
  if (shortfalls.length > 0) return { kind: "NO_WAREHOUSE_CAN_FULFIL", shortfalls };

  const sorted = [...warehouses].sort(byDistance);
  const single = sorted.find((w) => [...need].every(([skuId, qty]) => avail(w, skuId) >= qty));
  if (single) {
    return { kind: "PLAN", shipments: [{ warehouseId: single.id, lines: [...need].map(([skuId, qty]) => ({ skuId, qty })) }] };
  }

  const remaining = new Map(need);
  const shipments: ShipmentPlan[] = [];
  while ([...remaining.values()].some((q) => q > 0)) {
    let best: { w: WarehouseStock; covered: number } | undefined;
    for (const w of sorted) {
      let covered = 0;
      for (const [skuId, q] of remaining) covered += Math.min(q, avail(w, skuId));
      if (covered > 0 && (!best || covered > best.covered)) best = { w, covered };
    }
    if (!best) break; // unreachable: network totals were verified above
    const plan: PlanLine[] = [];
    for (const [skuId, q] of remaining) {
      const take = Math.min(q, avail(best.w, skuId));
      if (take > 0) {
        plan.push({ skuId, qty: take });
        remaining.set(skuId, q - take);
      }
    }
    shipments.push({ warehouseId: best.w.id, lines: plan });
    // A warehouse may only appear once; remove its stock from future rounds.
    sorted.splice(sorted.indexOf(best.w), 1);
  }
  return { kind: "PLAN", shipments };
}

/**
 * RULE: the parent order status is DERIVED from its child fulfillment orders (CLAUDE.md §5.2).
 * Cancelled children are ignored; no live children → CANCELLED. All DELIVERED → DELIVERED; all shipped-or-delivered
 * → SHIPPED; some shipped (others still RESERVED) → PARTIALLY_SHIPPED; none shipped → `current` is kept.
 */
export function deriveOrderStatus(children: readonly FulfillmentStatus[], current: OrderStatus): OrderStatus {
  const live = children.filter((c) => c !== "CANCELLED");
  if (children.length > 0 && live.length === 0) return "CANCELLED";
  if (live.length === 0) return current;
  if (live.every((c) => c === "DELIVERED")) return "DELIVERED";
  if (live.every((c) => c === "SHIPPED" || c === "DELIVERED")) return "SHIPPED";
  if (live.some((c) => c === "SHIPPED" || c === "DELIVERED")) return "PARTIALLY_SHIPPED";
  return current;
}

/** Reservation deadline for an unconfirmed order. `now` is injected (no Date.now()). */
export function reservationExpiry(now: Date, ttlMinutes: number): Date {
  return new Date(now.getTime() + ttlMinutes * 60_000);
}

/**
 * RULE: an order counts against the account's credit exposure from the moment stock is reserved until it is cancelled
 * or expires (D-15). Used to decide whether cancel/expiry must give the credit back.
 */
export function consumesCredit(status: OrderStatus): boolean {
  return status === "RESERVED" || status === "CONFIRMED" || status === "PARTIALLY_SHIPPED" || status === "SHIPPED" || status === "DELIVERED";
}

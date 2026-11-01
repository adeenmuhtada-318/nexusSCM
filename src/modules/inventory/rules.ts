/**
 * Inventory decision logic — PURE (no I/O, no db, no Date.now()). CLAUDE.md §3.2 / §5.1.
 * Units: demand = units/day, lead time = days, safety stock / ROP = units.
 */
import { checkTransition, type TransitionMap } from "@/lib/utils/state-machine";

export type ZoneStatus = "PRIME" | "QUARANTINE_REFURBISHMENT" | "QUARANTINE_QUALITY";
export type ReservationStatus = "ACTIVE" | "RELEASED" | "FULFILLED";
export type RequisitionStatus = "OPEN" | "CONVERTED" | "CANCELLED";

export const RESERVATION_TRANSITIONS: TransitionMap<ReservationStatus> = {
  ACTIVE: ["RELEASED", "FULFILLED"],
  RELEASED: [],
  FULFILLED: [],
};
export const REQUISITION_TRANSITIONS: TransitionMap<RequisitionStatus> = {
  OPEN: ["CONVERTED", "CANCELLED"],
  CONVERTED: [],
  CANCELLED: [],
};
export const checkReservationTransition = (from: ReservationStatus, to: ReservationStatus) =>
  checkTransition(RESERVATION_TRANSITIONS, from, to);
export const checkRequisitionTransition = (from: RequisitionStatus, to: RequisitionStatus) =>
  checkTransition(REQUISITION_TRANSITIONS, from, to);

export interface RopInput {
  /** Average demand, units/day, from the ledger over the trailing window. */
  dAvg: number;
  /** Standard deviation of daily demand, units/day (sample stddev incl. zero-demand days). */
  sigmaD: number;
  /** Average replenishment lead time, days. */
  lAvg: number;
  /** Z-score for the target service level (default 95% → 1.65). Passed in from config. */
  z: number;
}

/**
 * RULE: ROP = D_avg × L_avg + SafetyStock, SafetyStock = Z × σ_d × √L_avg.
 * WHY CORRECT: demand over the lead time has mean D·L and, assuming independent days, stddev σ_d·√L; adding
 * Z standard deviations of buffer gives the target cycle service level. EDGE CASES: zero history (D=σ=0) → ROP 0;
 * L=0 → ROP 0; negative / NaN inputs are rejected rather than producing a silent bogus reorder point.
 */
export function computeRop(i: RopInput): { safetyStock: number; rop: number } {
  for (const [k, v] of Object.entries(i)) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`computeRop: ${k} must be a finite number >= 0`);
  }
  const safetyStock = i.z * i.sigmaD * Math.sqrt(i.lAvg);
  return { safetyStock, rop: i.dAvg * i.lAvg + safetyStock };
}

/**
 * RULE: auto-requisition when qty_available + qty_on_order <= ROP and no OPEN requisition exists.
 * WHY: "<=" (not "<") so stock exactly at the reorder point triggers replenishment; on-order stock counts as
 * inventory position so we never double-order. EDGE: an existing open requisition blocks creation (idempotent);
 * the DB's partial unique index is the backstop for races.
 */
export function shouldRequisition(i: {
  qtyAvailable: number;
  qtyOnOrder: number;
  rop: number;
  hasOpenRequisition: boolean;
}): boolean {
  if (i.hasOpenRequisition) return false;
  return i.qtyAvailable + i.qtyOnOrder <= i.rop;
}

/**
 * RULE: requisition quantity = order-up-to level − inventory position, where order-up-to = ROP + D_avg × coverDays.
 * EDGE: always at least 1 unit (the trigger already fired); rounds UP so we never under-order. [ASSUMED, D-09]
 */
export function requisitionQty(i: { rop: number; dAvg: number; coverDays: number; position: number }): number {
  const target = i.rop + i.dAvg * i.coverDays;
  return Math.max(1, Math.ceil(target - i.position));
}

/** Perishables → FEFO, everything else → FIFO (CLAUDE.md §5.1). */
export function pickingStrategy(isPerishable: boolean): "FEFO" | "FIFO" {
  return isPerishable ? "FEFO" : "FIFO";
}

/** Only PRIME stock is allocatable; QUARANTINE_* never is. */
export function isAllocatableZone(zone: ZoneStatus): boolean {
  return zone === "PRIME";
}

/** Adds whole days to a YYYY-MM-DD date string (UTC arithmetic; no DST pitfalls). */
export function addDaysISO(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * RULE: a perishable batch is allocatable only if it is not expired and has at least
 * ceil(shelfLifeDays × minPct/100) days remaining (D-03: 20% of total shelf life).
 * Returns the EARLIEST acceptable expiry_date; SQL filters `expiry_date >= cutoff`.
 * WHY: remaining = expiry − today must be ≥ minDays AND > 0, so the cutoff is today + max(minDays, 1);
 * a batch expiring today (or earlier) is never allocated even when minPct = 0.
 * `todayISO` is the business-timezone calendar date, passed in (no Date.now()).
 */
export function minAcceptableExpiry(todayISO: string, shelfLifeDays: number, minPct: number): string {
  if (!Number.isFinite(shelfLifeDays) || shelfLifeDays <= 0) throw new RangeError("shelfLifeDays must be > 0");
  if (!Number.isFinite(minPct) || minPct < 0 || minPct > 100) throw new RangeError("minPct must be within [0,100]");
  const minDays = Math.ceil((shelfLifeDays * minPct) / 100);
  return addDaysISO(todayISO, Math.max(minDays, 1));
}

export interface CandidateBatch {
  id: number;
  qtyAvailable: number;
}
export interface Allocation {
  batchId: number;
  qty: number;
}

/**
 * RULE: greedy allocation over batches ALREADY ordered FEFO/FIFO and locked by the caller.
 * Takes as much as possible from each batch in order until `qty` is satisfied.
 * EDGE: qty must be a positive integer; batches with qtyAvailable <= 0 are skipped; if stock is insufficient
 * the result has `shortfall > 0` and the caller must NOT partially commit (all-or-nothing per line).
 */
export function planAllocation(batches: readonly CandidateBatch[], qty: number): { allocations: Allocation[]; shortfall: number } {
  if (!Number.isInteger(qty) || qty <= 0) throw new RangeError("qty must be a positive integer");
  const allocations: Allocation[] = [];
  let remaining = qty;
  for (const b of batches) {
    if (remaining === 0) break;
    if (b.qtyAvailable <= 0) continue;
    const take = Math.min(b.qtyAvailable, remaining);
    allocations.push({ batchId: b.id, qty: take });
    remaining -= take;
  }
  return { allocations, shortfall: remaining };
}

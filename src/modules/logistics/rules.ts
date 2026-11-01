/**
 * Logistics decision logic — PURE. CLAUDE.md §5.3.
 * The compliance filter (hazmat certification, max weight/dimensions, delivery window) runs FIRST, in SQL;
 * this module only ever sees already-eligible quotes.
 */
import { checkTransition, type TransitionMap } from "@/lib/utils/state-machine";

export type CarrierMode = "AIR_EXPRESS" | "GROUND_FREIGHT" | "PARCEL";
export type SelectionRule = "URGENT_AIR" | "HEAVY_GROUND" | "WEIGHTED_SCORE";
export type ShipmentStatus = "BOOKED" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";

export const SHIPMENT_TRANSITIONS: TransitionMap<ShipmentStatus> = {
  BOOKED: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};
export const checkShipmentTransition = (from: ShipmentStatus, to: ShipmentStatus) =>
  checkTransition(SHIPMENT_TRANSITIONS, from, to);

export interface CarrierQuote {
  carrierId: number;
  code: string;
  mode: CarrierMode;
  costCents: number;
  transitDays: number;
  /** On-time probability in [0,1]. */
  reliability: number;
}

export interface SelectionInput {
  priority: "STANDARD" | "URGENT";
  weightLbs: number;
  deliveryWindowDays: number;
  /** Already compliance-filtered quotes. */
  quotes: readonly CarrierQuote[];
}
export interface SelectionConfig {
  heavyWeightLbs: number;
  heavyWindowDays: number;
  weights: { cost: number; speed: number; reliability: number };
}

export type SelectionResult =
  | { ok: true; quote: CarrierQuote; rule: SelectionRule; score?: number }
  | { ok: false; code: "NO_ELIGIBLE_CARRIER"; reason: "NO_QUOTES" | "URGENT_NO_AIR_EXPRESS" };

/** Deterministic tie-break: cheaper, then faster, then lower id. */
const cmpTieBreak = (a: CarrierQuote, b: CarrierQuote) =>
  a.costCents - b.costCents || a.transitDays - b.transitDays || a.carrierId - b.carrierId;

/** Min-max normalisation to [0,1]; "higher is better" when `invert` is false. A flat metric is neutral (1). */
function normalise(value: number, min: number, max: number, invert: boolean): number {
  if (max === min) return 1;
  const x = (value - min) / (max - min);
  return invert ? 1 - x : x;
}

/**
 * RULE (evaluated top-down, first match wins):
 *  1. priority = URGENT → fastest eligible AIR_EXPRESS (ties: cheaper, then id). If no Air Express is eligible we do
 *     NOT silently downgrade an urgent shipment: result is NO_ELIGIBLE_CARRIER/URGENT_NO_AIR_EXPRESS (D-12).
 *  2. weight_lbs > heavyWeightLbs AND window > heavyWindowDays (both strict) → lowest-cost eligible GROUND_FREIGHT.
 *     If the rule matches but no ground freight is eligible, evaluation falls through to rule 3 (recorded honestly
 *     as WEIGHTED_SCORE).
 *  3. Otherwise composite score = w_cost·cost + w_speed·speed + w_reliability·reliability, each metric min-max
 *     normalised to 0–1 across the eligible set (cost & days inverted: lower is better). Weights are normalised to
 *     sum to 1 so config need not; all-zero weights throw. Highest score wins; ties use the deterministic tie-break.
 * EDGE: weight exactly 50 → rule 2 does NOT match; window exactly 3 → rule 2 does NOT match; single quote → that quote.
 * No eligible carrier → NO_ELIGIBLE_CARRIER (the caller raises an exception row; never a silent default).
 */
export function selectCarrier(input: SelectionInput, cfg: SelectionConfig): SelectionResult {
  const { quotes } = input;
  if (quotes.length === 0) return { ok: false, code: "NO_ELIGIBLE_CARRIER", reason: "NO_QUOTES" };

  if (input.priority === "URGENT") {
    const air = quotes
      .filter((q) => q.mode === "AIR_EXPRESS")
      .sort((a, b) => a.transitDays - b.transitDays || cmpTieBreak(a, b));
    const best = air[0];
    return best
      ? { ok: true, quote: best, rule: "URGENT_AIR" }
      : { ok: false, code: "NO_ELIGIBLE_CARRIER", reason: "URGENT_NO_AIR_EXPRESS" };
  }

  if (input.weightLbs > cfg.heavyWeightLbs && input.deliveryWindowDays > cfg.heavyWindowDays) {
    const ground = quotes.filter((q) => q.mode === "GROUND_FREIGHT").sort(cmpTieBreak);
    const best = ground[0];
    if (best) return { ok: true, quote: best, rule: "HEAVY_GROUND" };
  }

  const w = cfg.weights;
  const wSum = w.cost + w.speed + w.reliability;
  if (!(wSum > 0)) throw new RangeError("carrier weights must sum to > 0");
  const costs = quotes.map((q) => q.costCents);
  const days = quotes.map((q) => q.transitDays);
  const rels = quotes.map((q) => q.reliability);
  const [minC, maxC] = [Math.min(...costs), Math.max(...costs)];
  const [minD, maxD] = [Math.min(...days), Math.max(...days)];
  const [minR, maxR] = [Math.min(...rels), Math.max(...rels)];

  const scored = quotes.map((q) => ({
    q,
    score:
      (w.cost * normalise(q.costCents, minC, maxC, true) +
        w.speed * normalise(q.transitDays, minD, maxD, true) +
        w.reliability * normalise(q.reliability, minR, maxR, false)) /
      wSum,
  }));
  scored.sort((a, b) => b.score - a.score || cmpTieBreak(a.q, b.q));
  const top = scored[0];
  if (!top) return { ok: false, code: "NO_ELIGIBLE_CARRIER", reason: "NO_QUOTES" };
  return { ok: true, quote: top.q, rule: "WEIGHTED_SCORE", score: top.score };
}

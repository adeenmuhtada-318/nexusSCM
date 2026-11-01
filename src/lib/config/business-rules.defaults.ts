import { z } from "zod";

/**
 * Business-rule thresholds are CONFIGURATION, not constants (CLAUDE.md §5).
 * This file is the single source of (a) the key set, (b) validation, (c) the DEFAULTS that get seeded
 * into `business_rules_config`. rules.ts files never import this: they receive values as parameters.
 * Pure module (no I/O) so it can be imported anywhere.
 */
const pct = z.number().min(0).max(100);
const weight = z.number().min(0).max(1);

export const RULE_SCHEMAS = {
  "procurement.approval_threshold_cents": z.number().int().positive(),
  "returns.window_days": z.number().int().min(0),
  "returns.ineligible_policy": z.enum(["AUTO_DENY", "HUMAN_REVIEW"]),
  "logistics.heavy_weight_lbs": z.number().positive(),
  "logistics.heavy_window_days": z.number().int().min(0),
  "logistics.w_cost": weight,
  "logistics.w_speed": weight,
  "logistics.w_reliability": weight,
  "inventory.service_level_z": z.number().positive(),
  "inventory.demand_window_days": z.number().int().min(7),
  "inventory.reservation_ttl_minutes": z.number().int().positive(),
  "inventory.min_shelf_life_pct": pct,
  "inventory.requisition_cover_days": z.number().int().positive(),
  "exceptions.sla_hours.LOW": z.number().positive(),
  "exceptions.sla_hours.MEDIUM": z.number().positive(),
  "exceptions.sla_hours.HIGH": z.number().positive(),
  "exceptions.sla_hours.CRITICAL": z.number().positive(),
} as const;

export type RuleKey = keyof typeof RULE_SCHEMAS;
export const RULE_KEYS = Object.keys(RULE_SCHEMAS) as RuleKey[];

/**
 * Seeded defaults. Items marked [CLAUDE.md] come straight from the spec; items marked [ASSUMED] are
 * placeholders recorded in docs/DECISIONS.md and need business confirmation.
 */
export const RULE_DEFAULTS: Record<RuleKey, number | string> = {
  "procurement.approval_threshold_cents": 1_000_000, // [CLAUDE.md] $10,000.00 (>= gate)
  "returns.window_days": 30, // [CLAUDE.md]
  "returns.ineligible_policy": "AUTO_DENY", // [ASSUMED] D-07
  "logistics.heavy_weight_lbs": 50, // [CLAUDE.md]
  "logistics.heavy_window_days": 3, // [CLAUDE.md]
  "logistics.w_cost": 0.4, // [ASSUMED] D-08
  "logistics.w_speed": 0.3, // [ASSUMED] D-08
  "logistics.w_reliability": 0.3, // [ASSUMED] D-08
  "inventory.service_level_z": 1.65, // [CLAUDE.md] 95%
  "inventory.demand_window_days": 90, // [CLAUDE.md]
  "inventory.reservation_ttl_minutes": 30, // [user, §10]
  "inventory.min_shelf_life_pct": 20, // [user, §10]
  "inventory.requisition_cover_days": 30, // [ASSUMED] D-09
  "exceptions.sla_hours.LOW": 72, // [ASSUMED] D-10
  "exceptions.sla_hours.MEDIUM": 24, // [ASSUMED] D-10
  "exceptions.sla_hours.HIGH": 8, // [ASSUMED] D-10
  "exceptions.sla_hours.CRITICAL": 4, // [ASSUMED] D-10
};

/** Typed view of the effective configuration. */
export interface BusinessRules {
  procurementApprovalThresholdCents: number;
  returnsWindowDays: number;
  returnsIneligiblePolicy: "AUTO_DENY" | "HUMAN_REVIEW";
  logisticsHeavyWeightLbs: number;
  logisticsHeavyWindowDays: number;
  carrierWeights: { cost: number; speed: number; reliability: number };
  serviceLevelZ: number;
  demandWindowDays: number;
  reservationTtlMinutes: number;
  minShelfLifePct: number;
  requisitionCoverDays: number;
  exceptionSlaHours: { LOW: number; MEDIUM: number; HIGH: number; CRITICAL: number };
}

/** Validates a raw key→value map and builds the typed view. Throws listing every missing/invalid key. */
export function buildBusinessRules(raw: Partial<Record<string, unknown>>): BusinessRules {
  const problems: string[] = [];
  const v: Record<string, unknown> = {};
  for (const key of RULE_KEYS) {
    if (!(key in raw)) {
      problems.push(`${key}: missing`);
      continue;
    }
    const parsed = RULE_SCHEMAS[key].safeParse(raw[key]);
    if (parsed.success) v[key] = parsed.data;
    else problems.push(`${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  if (problems.length > 0) throw new Error(`Invalid business_rules_config → ${problems.join("; ")}`);
  const n = (k: RuleKey) => v[k] as number;
  return {
    procurementApprovalThresholdCents: n("procurement.approval_threshold_cents"),
    returnsWindowDays: n("returns.window_days"),
    returnsIneligiblePolicy: v["returns.ineligible_policy"] as "AUTO_DENY" | "HUMAN_REVIEW",
    logisticsHeavyWeightLbs: n("logistics.heavy_weight_lbs"),
    logisticsHeavyWindowDays: n("logistics.heavy_window_days"),
    carrierWeights: { cost: n("logistics.w_cost"), speed: n("logistics.w_speed"), reliability: n("logistics.w_reliability") },
    serviceLevelZ: n("inventory.service_level_z"),
    demandWindowDays: n("inventory.demand_window_days"),
    reservationTtlMinutes: n("inventory.reservation_ttl_minutes"),
    minShelfLifePct: n("inventory.min_shelf_life_pct"),
    requisitionCoverDays: n("inventory.requisition_cover_days"),
    exceptionSlaHours: {
      LOW: n("exceptions.sla_hours.LOW"),
      MEDIUM: n("exceptions.sla_hours.MEDIUM"),
      HIGH: n("exceptions.sla_hours.HIGH"),
      CRITICAL: n("exceptions.sla_hours.CRITICAL"),
    },
  };
}

export const BUSINESS_RULES_FOR_TESTS: BusinessRules = buildBusinessRules(RULE_DEFAULTS);

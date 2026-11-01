import { describe, expect, it } from "vitest";
import { calendarDaysBetween, localDate } from "@/lib/utils/dates";
import { formatMoney, mulCents, parseMoney } from "@/lib/utils/money";
import { buildBusinessRules, RULE_DEFAULTS } from "@/lib/config/business-rules.defaults";

describe("money", () => {
  it("parses and formats exactly", () => {
    expect(parseMoney("19.99")).toBe(1999);
    expect(parseMoney("1,234.5")).toBe(123450);
    expect(parseMoney("0.07")).toBe(7);
    expect(formatMoney(123456789)).toBe("$1,234,567.89");
    expect(formatMoney(-5)).toBe("-$0.05");
  });
  it("rejects >2 decimals and junk", () => {
    expect(() => parseMoney("1.999")).toThrow();
    expect(() => parseMoney("abc")).toThrow();
  });
  it("0.1 + 0.2 style drift cannot occur", () => {
    expect(parseMoney("0.10") + parseMoney("0.20")).toBe(30);
    expect(mulCents(1999, 3)).toBe(5997);
    expect(() => mulCents(100, 1.5)).toThrow();
  });
});

describe("business-timezone calendar days", () => {
  it("uses the business timezone, not UTC", () => {
    // 2026-03-01T03:00Z is still Feb 28 in New York
    expect(localDate(new Date("2026-03-01T03:00:00Z"), "America/New_York")).toBe("2026-02-28");
    expect(localDate(new Date("2026-03-01T03:00:00Z"), "UTC")).toBe("2026-03-01");
  });
  it("counts whole calendar days like (CURRENT_DATE - delivered_at::date)", () => {
    const delivered = new Date("2026-01-01T15:00:00Z");
    expect(calendarDaysBetween(delivered, new Date("2026-01-31T02:00:00Z"), "America/New_York")).toBe(29);
    expect(calendarDaysBetween(delivered, new Date("2026-01-31T12:00:00Z"), "America/New_York")).toBe(30);
    expect(calendarDaysBetween(delivered, new Date("2026-02-01T12:00:00Z"), "America/New_York")).toBe(31);
  });
});

describe("business rules config", () => {
  it("defaults validate and match spec values", () => {
    const r = buildBusinessRules(RULE_DEFAULTS);
    expect(r.procurementApprovalThresholdCents).toBe(1_000_000);
    expect(r.returnsWindowDays).toBe(30);
    expect(r.logisticsHeavyWeightLbs).toBe(50);
    expect(r.logisticsHeavyWindowDays).toBe(3);
    expect(r.serviceLevelZ).toBe(1.65);
    expect(r.reservationTtlMinutes).toBe(30);
  });
  it("missing or invalid keys throw (no silent defaults)", () => {
    const { "returns.window_days": _omit, ...partial } = RULE_DEFAULTS;
    expect(() => buildBusinessRules(partial)).toThrow(/returns\.window_days: missing/);
    expect(() => buildBusinessRules({ ...RULE_DEFAULTS, "logistics.w_cost": 2 })).toThrow(/logistics\.w_cost/);
  });
});

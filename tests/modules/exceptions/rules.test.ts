import { describe, expect, it } from "vitest";
import { expectExactTransitions } from "../../helpers/transitions";
import { checkExceptionTransition, checkResolve, computeDueAt, EXCEPTION_ROLES, type ExceptionType } from "@/modules/exceptions/rules";

const ok = {
  type: "ORDER_ADDRESS_INVALID" as ExceptionType,
  from: "OPEN" as const,
  to: "RESOLVED" as const,
  actorRole: "CUSTOMER_SERVICE" as const,
  actorId: "u2",
  requesterId: "u1",
  note: "Address corrected",
};

describe("checkResolve", () => {
  it("allows an authorised, different actor with a note", () => expect(checkResolve(ok)).toEqual({ ok: true }));
  it("forbidden role", () => {
    expect(checkResolve({ ...ok, actorRole: "WAREHOUSE_TECH" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
  it("separation of duties", () => {
    expect(checkResolve({ ...ok, actorId: "u1" })).toMatchObject({ ok: false, code: "SEPARATION_OF_DUTIES" });
  });
  it("system-created exceptions (null requester) have no SoD conflict", () => {
    expect(checkResolve({ ...ok, requesterId: null }).ok).toBe(true);
  });
  it("a note is mandatory", () => {
    expect(checkResolve({ ...ok, note: " " })).toMatchObject({ ok: false, code: "VALIDATION" });
  });
  it("cannot re-resolve a closed exception", () => {
    expect(checkResolve({ ...ok, from: "RESOLVED" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(checkResolve({ ...ok, from: "DISMISSED" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });
  it("PO approval exceptions only close via the PO action", () => {
    const po = { ...ok, type: "PO_APPROVAL_REQUIRED" as const, actorRole: "MANAGER" as const };
    expect(checkResolve(po)).toMatchObject({ ok: false, code: "RULE_VIOLATION" });
    expect(checkResolve({ ...po, viaDomainAction: true }).ok).toBe(true);
  });
  it("every exception type has at least one resolving role and ADMIN never resolves PO approvals", () => {
    for (const roles of Object.values(EXCEPTION_ROLES)) expect(roles.length).toBeGreaterThan(0);
    expect(EXCEPTION_ROLES.PO_APPROVAL_REQUIRED).not.toContain("ADMIN");
  });
});

describe("computeDueAt", () => {
  it("adds severity SLA hours to injected now", () => {
    const sla = { LOW: 72, MEDIUM: 24, HIGH: 8, CRITICAL: 4 };
    expect(computeDueAt(new Date("2026-01-01T00:00:00Z"), "CRITICAL", sla).toISOString()).toBe("2026-01-01T04:00:00.000Z");
  });
});

describe("exception transitions", () => {
  it("every illegal transition is rejected", () => {
    expectExactTransitions(
      ["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"] as const,
      [
        ["OPEN", "IN_REVIEW"], ["OPEN", "RESOLVED"], ["OPEN", "DISMISSED"],
        ["IN_REVIEW", "OPEN"], ["IN_REVIEW", "RESOLVED"], ["IN_REVIEW", "DISMISSED"],
      ],
      checkExceptionTransition,
    );
  });
});

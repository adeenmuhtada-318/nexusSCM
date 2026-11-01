/**
 * Exception Queue decision logic — PURE. CLAUDE.md §4.8.
 */
import { checkTransition, type TransitionMap } from "@/lib/utils/state-machine";

export type ExceptionStatus = "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED";
export type ExceptionSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Role = "ADMIN" | "WAREHOUSE_TECH" | "CUSTOMER_SERVICE" | "BUYER" | "MANAGER";
export type ExceptionType =
  | "ORDER_ADDRESS_INVALID"
  | "ORDER_CREDIT_EXCEEDED"
  | "ORDER_HAZMAT_RESTRICTED"
  | "ORDER_CUSTOMER_INACTIVE"
  | "ORDER_PRODUCT_INACTIVE"
  | "NO_WAREHOUSE_CAN_FULFIL"
  | "NO_ELIGIBLE_CARRIER"
  | "PO_APPROVAL_REQUIRED"
  | "NO_VENDOR_AVAILABLE"
  | "RMA_REVIEW"
  | "RETURN_GRADING"
  | "LEDGER_MISMATCH";

export const EXCEPTION_TRANSITIONS: TransitionMap<ExceptionStatus> = {
  OPEN: ["IN_REVIEW", "RESOLVED", "DISMISSED"],
  IN_REVIEW: ["OPEN", "RESOLVED", "DISMISSED"],
  RESOLVED: [],
  DISMISSED: [],
};
export const checkExceptionTransition = (from: ExceptionStatus, to: ExceptionStatus) =>
  checkTransition(EXCEPTION_TRANSITIONS, from, to);

/** Roles allowed to work (resolve/dismiss/assign) each exception type. ADMIN is allowed everywhere except PO approvals. */
export const EXCEPTION_ROLES: Readonly<Record<ExceptionType, readonly Role[]>> = {
  ORDER_ADDRESS_INVALID: ["CUSTOMER_SERVICE", "MANAGER", "ADMIN"],
  ORDER_CREDIT_EXCEEDED: ["MANAGER", "ADMIN"],
  ORDER_HAZMAT_RESTRICTED: ["MANAGER", "ADMIN"],
  ORDER_CUSTOMER_INACTIVE: ["CUSTOMER_SERVICE", "MANAGER", "ADMIN"],
  ORDER_PRODUCT_INACTIVE: ["CUSTOMER_SERVICE", "MANAGER", "ADMIN"],
  NO_WAREHOUSE_CAN_FULFIL: ["CUSTOMER_SERVICE", "BUYER", "MANAGER", "ADMIN"],
  NO_ELIGIBLE_CARRIER: ["WAREHOUSE_TECH", "MANAGER", "ADMIN"],
  PO_APPROVAL_REQUIRED: ["BUYER", "MANAGER"],
  NO_VENDOR_AVAILABLE: ["BUYER", "MANAGER", "ADMIN"],
  RMA_REVIEW: ["CUSTOMER_SERVICE", "MANAGER", "ADMIN"],
  RETURN_GRADING: ["WAREHOUSE_TECH", "MANAGER", "ADMIN"],
  LEDGER_MISMATCH: ["MANAGER", "ADMIN"],
};

/** Exception types that may ONLY be closed through their domain action (e.g. approving/rejecting the PO). */
export const DOMAIN_CLOSED_TYPES: ReadonlySet<ExceptionType> = new Set<ExceptionType>(["PO_APPROVAL_REQUIRED"]);

export type ResolveCheck =
  | { ok: true }
  | { ok: false; code: "FORBIDDEN" | "SEPARATION_OF_DUTIES" | "ILLEGAL_TRANSITION" | "RULE_VIOLATION" | "VALIDATION"; message: string };

/**
 * RULE: who may resolve an exception, and how. Checks (first failure wins): legal status transition →
 * domain-closed types must go through their domain action → role is allowed for the type → separation of duties
 * (resolver ≠ requester, when the exception carries a requester) → resolution note is mandatory.
 */
export function checkResolve(i: {
  type: ExceptionType;
  from: ExceptionStatus;
  to: "RESOLVED" | "DISMISSED";
  actorRole: Role;
  actorId: string;
  requesterId: string | null;
  note: string;
  viaDomainAction?: boolean;
}): ResolveCheck {
  const t = checkExceptionTransition(i.from, i.to);
  if (!t.ok) return { ok: false, code: "ILLEGAL_TRANSITION", message: t.error };
  if (DOMAIN_CLOSED_TYPES.has(i.type) && !i.viaDomainAction) {
    return { ok: false, code: "RULE_VIOLATION", message: `${i.type} is closed by approving or rejecting its subject` };
  }
  if (!EXCEPTION_ROLES[i.type].includes(i.actorRole)) {
    return { ok: false, code: "FORBIDDEN", message: `Role ${i.actorRole} cannot resolve ${i.type}` };
  }
  if (i.requesterId !== null && i.requesterId === i.actorId) {
    return { ok: false, code: "SEPARATION_OF_DUTIES", message: "Resolver cannot be the requester" };
  }
  if (i.note.trim().length < 3) return { ok: false, code: "VALIDATION", message: "A resolution note is required" };
  return { ok: true };
}

/** SLA: due_at = createdAt + sla hours for the severity (hours from config). `now` injected. */
export function computeDueAt(now: Date, severity: ExceptionSeverity, slaHours: Readonly<Record<ExceptionSeverity, number>>): Date {
  return new Date(now.getTime() + slaHours[severity] * 3_600_000);
}

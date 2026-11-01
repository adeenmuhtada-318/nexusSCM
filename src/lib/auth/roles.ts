/** RBAC roles (CLAUDE.md §4.7). Single source: the DB enum is built from this tuple. */
export const ROLES = ["ADMIN", "WAREHOUSE_TECH", "CUSTOMER_SERVICE", "BUYER", "MANAGER"] as const;
export type Role = (typeof ROLES)[number];

export interface Session {
  userId: string;
  role: Role;
  email: string;
}

/**
 * Per-action authorization matrix. Authorization is checked SERVER-SIDE per action (never trust the client).
 * Every server action names exactly one key here; tests iterate this map to assert allowed + forbidden roles.
 */
export const PERMISSIONS = {
  "inventory.receive": ["WAREHOUSE_TECH", "MANAGER", "ADMIN"],
  "inventory.adjust": ["WAREHOUSE_TECH", "MANAGER", "ADMIN"],
  "procurement.autoRequisition": ["BUYER", "MANAGER", "ADMIN"],
  "orders.create": ["CUSTOMER_SERVICE", "MANAGER", "ADMIN"],
  "orders.confirm": ["CUSTOMER_SERVICE", "MANAGER", "ADMIN"],
  "orders.cancel": ["CUSTOMER_SERVICE", "MANAGER", "ADMIN"],
  "orders.releaseHold": ["CUSTOMER_SERVICE", "MANAGER", "ADMIN"],
  "orders.ship": ["WAREHOUSE_TECH", "MANAGER", "ADMIN"],
  "orders.markDelivered": ["WAREHOUSE_TECH", "MANAGER", "ADMIN"],
  "procurement.createFromRequisition": ["BUYER", "MANAGER", "ADMIN"],
  "procurement.approve": ["BUYER", "MANAGER"],
  "procurement.reject": ["BUYER", "MANAGER"],
  "procurement.receive": ["WAREHOUSE_TECH", "BUYER", "MANAGER", "ADMIN"],
  "returns.request": ["CUSTOMER_SERVICE", "MANAGER", "ADMIN"],
  "returns.review": ["CUSTOMER_SERVICE", "MANAGER", "ADMIN"],
  "returns.receiveAndInspect": ["WAREHOUSE_TECH", "MANAGER", "ADMIN"],
  "returns.refund": ["CUSTOMER_SERVICE", "MANAGER", "ADMIN"],
  "exceptions.resolve": ["CUSTOMER_SERVICE", "WAREHOUSE_TECH", "BUYER", "MANAGER", "ADMIN"],
  "exceptions.assign": ["MANAGER", "ADMIN"],
  "config.update": ["ADMIN"],
} as const satisfies Record<string, readonly Role[]>;

export type PermissionKey = keyof typeof PERMISSIONS;

/** Pure role check, shared by requireRole() and tests. */
export function roleAllowed(role: Role, allowed: readonly Role[]): boolean {
  return allowed.includes(role);
}

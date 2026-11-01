import "server-only";
import { DomainError } from "@/lib/utils/errors";
import { getSession } from "./session";
import { roleAllowed, type Role, type Session } from "./roles";

export { PERMISSIONS, ROLES, roleAllowed } from "./roles";
export type { PermissionKey, Role, Session } from "./roles";
export { getSession };

/**
 * Authenticates and authorises. Throws DomainError UNAUTHENTICATED / FORBIDDEN (mapped to ActionResult by the
 * action runner). Client-sent user ids/roles are never trusted: identity comes only from the signed session.
 */
export async function requireRole(allowed: readonly Role[]): Promise<Session> {
  const session = await getSession();
  if (!session) throw new DomainError("UNAUTHENTICATED", "You must be signed in");
  if (!roleAllowed(session.role, allowed)) throw new DomainError("FORBIDDEN", "You are not allowed to perform this action");
  return session;
}

import "server-only";
import { ROLES, type Role, type Session } from "./roles";

/**
 * Current session or null (identity comes only from the signed Auth.js JWT).
 * Kept in its own module so tests can mock this single boundary: vi.mock("@/lib/auth/session").
 */
export async function getSession(): Promise<Session | null> {
  const { auth } = await import("./auth");
  const s = await auth();
  const role = (s?.user as { role?: string } | undefined)?.role;
  if (!s?.user?.id || !s.user.email || !role || !(ROLES as readonly string[]).includes(role)) return null;
  return { userId: s.user.id, email: s.user.email, role: role as Role };
}

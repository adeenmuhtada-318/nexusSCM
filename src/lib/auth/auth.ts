import "server-only";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getEnv } from "@/lib/config/env";
import { ROLES, type Role } from "./roles";
import { rateLimit } from "@/lib/utils/rate-limit";

/**
 * Auth.js v5, Credentials provider, JWT sessions, DB-backed users + roles (D-00a — the single auth provider).
 * The login endpoint is public ⇒ rate-limited per email (CLAUDE.md §4.7). Passwords are bcrypt-hashed.
 */
const credentialsSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });

// Valid hash computed once; comparing against it keeps timing similar when the email does not exist.
const DUMMY_HASH = bcrypt.hashSync("nexus-dummy-password", 10);

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: getEnv().AUTH_SECRET,
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const email = parsed.data.email.toLowerCase();
        if (!rateLimit(`login:${email}`, { limit: 8, windowMs: 15 * 60_000 }).allowed) return null;
        const rows = await getDb()
          .select({ id: users.id, email: users.email, name: users.name, role: users.role, hash: users.passwordHash, active: users.active })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        const u = rows[0];
        const ok = await bcrypt.compare(parsed.data.password, u?.hash ?? DUMMY_HASH);
        if (!u || !ok || !u.active) return null;
        return { id: u.id, email: u.email, name: u.name, role: u.role };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        token.role = (user as { role: Role }).role;
      }
      return token;
    },
    session({ session, token }) {
      const role = token.role;
      if (typeof token.uid === "string" && typeof role === "string" && (ROLES as readonly string[]).includes(role)) {
        session.user.id = token.uid;
        (session.user as { role?: Role }).role = role as Role;
      }
      return session;
    },
  },
});

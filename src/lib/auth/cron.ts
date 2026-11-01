import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getEnv } from "@/lib/config/env";
import { rateLimit } from "@/lib/utils/rate-limit";

/**
 * Verifies `Authorization: Bearer <CRON_SECRET>` using constant-time comparison and enforces a burst rate limit
 * (CLAUDE.md §4.7). Returns `null` when authorized, or a ready-to-return error `NextResponse`.
 */
export function verifyCronRequest(req: Request, jobName: string): NextResponse | null {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!rateLimit(`cron:${jobName}:${ip}`, { limit: 12, windowMs: 60_000 }).allowed) {
    return NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429 });
  }
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${getEnv().CRON_SECRET}`;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

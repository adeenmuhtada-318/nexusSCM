import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/auth/cron";
import { invalidate, tags } from "@/lib/utils/cache";
import { logger } from "@/lib/utils/logger";
import { expireReservations } from "@/modules/orders";

async function handle(req: Request) {
  const denied = verifyCronRequest(req, "reservations");
  if (denied) return denied;
  try {
    const out = await expireReservations();
    if (out.expired > 0) {
      invalidate([tags.ordersList, tags.inventoryList], ["/orders", "/inventory", "/"]);
    }
    return NextResponse.json({ ok: true, expired: out.expired });
  } catch (err) {
    logger.error("cron reservations failed", { message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;

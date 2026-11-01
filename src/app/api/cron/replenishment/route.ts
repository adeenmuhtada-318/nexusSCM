import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/auth/cron";
import { getDb } from "@/lib/db";
import { invalidate, tags } from "@/lib/utils/cache";
import { logger } from "@/lib/utils/logger";
import { runAutoRequisition } from "@/modules/inventory";
import { convertOpenRequisitions, getOnOrderQty } from "@/modules/procurement";

async function handle(req: Request) {
  const denied = verifyCronRequest(req, "replenishment");
  if (denied) return denied;
  try {
    const reqResult = await runAutoRequisition({ getOnOrderQty: (ids) => getOnOrderQty(getDb(), ids) });
    const poResult = await convertOpenRequisitions();
    if (reqResult.created > 0 || poResult.converted > 0) {
      invalidate([tags.procurementList, tags.exceptionsOpen, tags.inventoryList], ["/procurement", "/exceptions", "/inventory", "/"]);
    }
    return NextResponse.json({
      ok: true,
      scanned: reqResult.scanned,
      requisitionsCreated: reqResult.created,
      posCreated: poResult.converted,
      noVendor: poResult.noVendor,
    });
  } catch (err) {
    logger.error("cron replenishment failed", { message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;

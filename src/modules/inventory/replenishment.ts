import "server-only";
import { getDb } from "@/lib/db";
import { runTransaction } from "@/lib/db/tx";
import { loadBusinessRules } from "@/lib/config/business-rules";
import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/utils/logger";
import { businessToday, getReplenishmentSignals } from "./queries";
import { createRequisition } from "./mutations";
import { computeRop, requisitionQty, shouldRequisition } from "./rules";

const PAGE_SIZE = 200;

/** Caller-supplied port: units already on open POs per SKU (procurement owns that data; avoids a module cycle). */
export type OnOrderLookup = (skuIds: readonly number[]) => Promise<Map<number, number>>;

export interface AutoRequisitionResult {
  scanned: number;
  created: number;
  skippedExisting: number;
}

/**
 * AUTO-REQUISITION job (CLAUDE.md §5.1). For every active SKU (keyset pages of 200):
 *   ROP = D_avg·L_avg + Z·σ_d·√L_avg  (D_avg, σ_d computed in SQL from the ledger),
 *   create a Purchase Requisition iff qty_available + qty_on_order <= ROP and none is already open.
 * IDEMPOTENT: re-running creates nothing new (hasOpenRequisition + partial unique index backstop); safe to run from
 * a retried/duplicated cron invocation. Each SKU is decided in pure TS (rules.ts) and written in its own transaction.
 * Open POs for the SKU are folded into qty_on_order, which also suppresses duplicate orders while one is in flight.
 */
export async function runAutoRequisition(deps: { getOnOrderQty: OnOrderLookup; now?: Date }): Promise<AutoRequisitionResult> {
  const db = getDb();
  const now = deps.now ?? new Date();
  const rules = await loadBusinessRules(db, now);
  const result: AutoRequisitionResult = { scanned: 0, created: 0, skippedExisting: 0 };
  let after = 0;
  for (;;) {
    const page = await getReplenishmentSignals(db, {
      afterSkuId: after,
      limit: PAGE_SIZE,
      todayISO: businessToday(now),
      windowDays: rules.demandWindowDays,
      tz: getEnv().BUSINESS_TIMEZONE,
    });
    if (page.length === 0) break;
    const onOrder = await deps.getOnOrderQty(page.map((s) => s.skuId));
    for (const s of page) {
      result.scanned++;
      const { rop } = computeRop({ dAvg: s.dAvg, sigmaD: s.sigmaD, lAvg: s.leadTimeDays, z: rules.serviceLevelZ });
      const qtyOnOrder = onOrder.get(s.skuId) ?? 0;
      if (!shouldRequisition({ qtyAvailable: s.qtyAvailable, qtyOnOrder, rop, hasOpenRequisition: s.hasOpenRequisition })) {
        if (s.hasOpenRequisition) result.skippedExisting++;
        continue;
      }
      const qty = requisitionQty({ rop, dAvg: s.dAvg, coverDays: rules.requisitionCoverDays, position: s.qtyAvailable + qtyOnOrder });
      const id = await runTransaction((tx) =>
        createRequisition(tx, { skuId: s.skuId, qty, rop, actor: { type: "SYSTEM" }, correlationId: `auto-req-${now.toISOString()}` }),
      );
      if (id === null) result.skippedExisting++;
      else result.created++;
    }
    const last = page[page.length - 1];
    if (!last || page.length < PAGE_SIZE) break;
    after = last.skuId;
  }
  logger.info("auto-requisition finished", { ...result });
  return result;
}

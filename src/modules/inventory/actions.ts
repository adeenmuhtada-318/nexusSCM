"use server";

import { PERMISSIONS } from "@/lib/auth/roles";
import { runTransaction } from "@/lib/db/tx";
import { runAction } from "@/lib/utils/action-runner";
import { invalidate, tags } from "@/lib/utils/cache";
import type { ActionResult } from "@/lib/utils/action-response";
import { adjustBatch, receiveStock } from "./mutations";
import { adjustStockSchema, receiveStockSchema } from "./schemas";

/** Receive stock into a new batch (+ ledger row, audited). Authorised per PERMISSIONS["inventory.receive"]. */
export async function receiveStockAction(input: unknown): Promise<ActionResult<{ batchId: number }>> {
  return runAction({
    name: "inventory.receive",
    roles: PERMISSIONS["inventory.receive"],
    schema: receiveStockSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) =>
        receiveStock(tx, {
          skuId: d.skuId,
          warehouseId: d.warehouseId,
          qty: d.qty,
          zone: d.zone,
          entryType: "RECEIPT",
          expiryDate: d.expiryDate ?? null,
          lotCode: d.lotCode,
          reasonCode: d.reasonCode,
          actor: ctx.actor,
          correlationId: ctx.correlationId,
        }),
      );
      invalidate([tags.inventoryList, tags.inventorySku(d.skuId)], ["/inventory"]);
      return out;
    },
  });
}

/** Cycle-count correction as a compensating ledger row (never an edit). */
export async function adjustStockAction(input: unknown): Promise<ActionResult<{ batchId: number }>> {
  return runAction({
    name: "inventory.adjust",
    roles: PERMISSIONS["inventory.adjust"],
    schema: adjustStockSchema,
    input,
    handler: async (ctx, d) => {
      await runTransaction((tx) =>
        adjustBatch(tx, { batchId: d.batchId, delta: d.delta, reasonCode: d.reasonCode, actor: ctx.actor, correlationId: ctx.correlationId }),
      );
      invalidate([tags.inventoryList], ["/inventory"]);
      return { batchId: d.batchId };
    },
  });
}

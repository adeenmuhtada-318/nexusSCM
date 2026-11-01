"use server";

import { PERMISSIONS } from "@/lib/auth/roles";
import { getDb } from "@/lib/db";
import { runTransaction } from "@/lib/db/tx";
import { runAction } from "@/lib/utils/action-runner";
import { invalidate, tags } from "@/lib/utils/cache";
import type { ActionResult } from "@/lib/utils/action-response";
import { z } from "zod";
import { runAutoRequisition } from "@/modules/inventory";
import { approvePo, convertOpenRequisitions, createPoFromRequisition, receivePo, rejectPo, type CreatePoResult } from "./mutations";
import { getOnOrderQty } from "./queries";
import { approvePoSchema, createPoSchema, receivePoSchema, rejectPoSchema } from "./schemas";

const TAGS = [tags.procurementList, tags.exceptionsOpen, tags.inventoryList];
const PATHS = ["/procurement", "/exceptions", "/inventory", "/"];

export async function createPoAction(input: unknown): Promise<ActionResult<CreatePoResult & { replayed: boolean }>> {
  return runAction({
    name: "procurement.createFromRequisition",
    roles: PERMISSIONS["procurement.createFromRequisition"],
    schema: createPoSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) =>
        createPoFromRequisition(tx, { requisitionId: d.requisitionId, idempotencyKey: d.idempotencyKey, actor: ctx.actor, correlationId: ctx.correlationId, now: new Date() }),
      );
      invalidate(TAGS, PATHS);
      return { ...out.result, replayed: out.replayed };
    },
  });
}

/** Approve a pending PO: role per queue level, approver ≠ requester, mandatory reason code (rules.checkApproval). */
export async function approvePoAction(input: unknown): Promise<ActionResult<{ poId: number; status: string; replayed: boolean }>> {
  return runAction({
    name: "procurement.approve",
    roles: PERMISSIONS["procurement.approve"],
    schema: approvePoSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) =>
        approvePo(tx, {
          poId: d.poId,
          approver: { id: ctx.session.userId, role: ctx.session.role },
          reasonCode: d.reasonCode,
          idempotencyKey: d.idempotencyKey,
          correlationId: ctx.correlationId,
          now: new Date(),
        }),
      );
      invalidate(TAGS, PATHS);
      return { ...out.result, replayed: out.replayed };
    },
  });
}

export async function rejectPoAction(input: unknown): Promise<ActionResult<{ poId: number }>> {
  return runAction({
    name: "procurement.reject",
    roles: PERMISSIONS["procurement.reject"],
    schema: rejectPoSchema,
    input,
    handler: async (ctx, d) => {
      await runTransaction((tx) => rejectPo(tx, { poId: d.poId, approver: { id: ctx.session.userId, role: ctx.session.role }, reasonCode: d.reasonCode, correlationId: ctx.correlationId }));
      invalidate(TAGS, PATHS);
      return { poId: d.poId };
    },
  });
}

export async function receivePoAction(input: unknown): Promise<ActionResult<{ poId: number; batches: number[] }>> {
  return runAction({
    name: "procurement.receive",
    roles: PERMISSIONS["procurement.receive"],
    schema: receivePoSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) =>
        receivePo(tx, { poId: d.poId, warehouseId: d.warehouseId, lotCode: d.lotCode, expiryDate: d.expiryDate ?? null, actor: ctx.actor, correlationId: ctx.correlationId }),
      );
      invalidate(TAGS, PATHS);
      return out;
    },
  });
}

/**
 * Manual trigger of the replenishment job: ROP scan → requisitions → POs. Composition lives here (not in inventory) so
 * inventory never imports procurement: procurement injects its on-order lookup into inventory's port.
 */
export async function runReplenishmentAction(input: unknown): Promise<ActionResult<{ created: number; converted: number }>> {
  return runAction({
    name: "procurement.autoRequisition",
    roles: PERMISSIONS["procurement.autoRequisition"],
    schema: z.object({}).strict(),
    input,
    handler: async () => {
      const req = await runAutoRequisition({ getOnOrderQty: (ids) => getOnOrderQty(getDb(), ids) });
      const conv = await convertOpenRequisitions();
      invalidate(TAGS, PATHS);
      return { created: req.created, converted: conv.converted };
    },
  });
}

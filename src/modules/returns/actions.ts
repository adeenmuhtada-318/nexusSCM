"use server";

import { PERMISSIONS } from "@/lib/auth/roles";
import { runTransaction } from "@/lib/db/tx";
import { runAction } from "@/lib/utils/action-runner";
import { invalidate, tags } from "@/lib/utils/cache";
import type { ActionResult } from "@/lib/utils/action-response";
import { receiveAndInspectRma, refundRma, requestRma, reviewRma, type RequestRmaResult } from "./mutations";
import { inspectRmaSchema, refundRmaSchema, requestRmaSchema, reviewRmaSchema } from "./schemas";

const RMA_TAGS = [tags.returnsList, tags.ordersList, tags.inventoryList, tags.exceptionsOpen];
const RMA_PATHS = ["/returns", "/orders", "/inventory", "/exceptions", "/"];

/**
 * Request an RMA against an order (idempotent). Evaluates window, customization, and quantity limits per line via
 * pure rules; claims returned quantities atomically; raises RMA_REVIEW on human-review or denial.
 */
export async function requestRmaAction(input: unknown): Promise<ActionResult<RequestRmaResult & { replayed: boolean }>> {
  return runAction({
    name: "returns.request",
    roles: PERMISSIONS["returns.request"],
    schema: requestRmaSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) =>
        requestRma(tx, {
          orderId: d.orderId,
          lines: d.lines,
          reasonCode: d.reasonCode,
          idempotencyKey: d.idempotencyKey,
          actor: ctx.actor,
          correlationId: ctx.correlationId,
          now: new Date(),
        }),
      );
      invalidate(RMA_TAGS, RMA_PATHS);
      return { ...out.result, replayed: out.replayed };
    },
  });
}

/** Human review of a PENDING_REVIEW RMA. Enforces reviewer ≠ requester (separation of duties). */
export async function reviewRmaAction(input: unknown): Promise<ActionResult<{ rmaId: number; status: string }>> {
  return runAction({
    name: "returns.review",
    roles: PERMISSIONS["returns.review"],
    schema: reviewRmaSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) =>
        reviewRma(tx, {
          rmaId: d.rmaId,
          decision: d.decision,
          note: d.note,
          reviewerId: ctx.actor.id,
          correlationId: ctx.correlationId,
        }),
      );
      invalidate(RMA_TAGS, RMA_PATHS);
      return { rmaId: d.rmaId, status: out.status };
    },
  });
}

/** Dock receipt + physical inspection. Restocks unopened VERIFIED_NEW to PRIME; quarantines others + raises RETURN_GRADING. */
export async function receiveAndInspectRmaAction(
  input: unknown,
): Promise<ActionResult<{ restocked: number; quarantined: number; exceptionIds: number[] }>> {
  return runAction({
    name: "returns.receiveAndInspect",
    roles: PERMISSIONS["returns.receiveAndInspect"],
    schema: inspectRmaSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) =>
        receiveAndInspectRma(tx, {
          rmaId: d.rmaId,
          warehouseId: d.warehouseId,
          lines: d.lines,
          actor: ctx.actor,
          correlationId: ctx.correlationId,
          now: new Date(),
        }),
      );
      invalidate(RMA_TAGS, RMA_PATHS);
      return out;
    },
  });
}

/** Issue an idempotent refund for an INSPECTED RMA, capped at paid line total minus prior RMA refunds. */
export async function refundRmaAction(input: unknown): Promise<ActionResult<{ rmaId: number; amountCents: number; replayed: boolean }>> {
  return runAction({
    name: "returns.refund",
    roles: PERMISSIONS["returns.refund"],
    schema: refundRmaSchema,
    input,
    handler: async (ctx, d) => {
      const out = await runTransaction((tx) =>
        refundRma(tx, { rmaId: d.rmaId, idempotencyKey: d.idempotencyKey, actor: ctx.actor, correlationId: ctx.correlationId, now: new Date() }),
      );
      invalidate(RMA_TAGS, RMA_PATHS);
      return { ...out.result, replayed: out.replayed };
    },
  });
}

"use server";

import { PERMISSIONS } from "@/lib/auth/roles";
import { runTransaction } from "@/lib/db/tx";
import { runAction } from "@/lib/utils/action-runner";
import { invalidate, tags } from "@/lib/utils/cache";
import type { ActionResult } from "@/lib/utils/action-response";
import { assignException, resolveException } from "./mutations";
import { assignExceptionSchema, resolveExceptionSchema } from "./schemas";

/** Resolve/dismiss an Exception Queue item. Role per type + separation of duties are enforced in rules.checkResolve. */
export async function resolveExceptionAction(input: unknown): Promise<ActionResult<{ id: number }>> {
  return runAction({
    name: "exceptions.resolve",
    roles: PERMISSIONS["exceptions.resolve"],
    schema: resolveExceptionSchema,
    input,
    handler: async (ctx, data) => {
      await runTransaction((tx) =>
        resolveException(tx, {
          id: data.id,
          to: data.resolution,
          note: data.note,
          actorId: ctx.actor.id,
          actorRole: ctx.session.role,
          correlationId: ctx.correlationId,
        }),
      );
      invalidate([tags.exceptionsOpen], ["/exceptions", "/"]);
      return { id: data.id };
    },
  });
}

export async function assignExceptionAction(input: unknown): Promise<ActionResult<{ id: number }>> {
  return runAction({
    name: "exceptions.assign",
    roles: PERMISSIONS["exceptions.assign"],
    schema: assignExceptionSchema,
    input,
    handler: async (ctx, data) => {
      await runTransaction((tx) =>
        assignException(tx, { id: data.id, assigneeId: data.assigneeId, actorId: ctx.actor.id, correlationId: ctx.correlationId }),
      );
      invalidate([tags.exceptionsOpen], ["/exceptions"]);
      return { id: data.id };
    },
  });
}

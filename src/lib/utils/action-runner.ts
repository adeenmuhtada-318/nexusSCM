import "server-only";
import type { ZodType } from "zod";
import { requireRole } from "@/lib/auth";
import type { Role, Session } from "@/lib/auth/roles";
import type { Actor } from "@/lib/db/audit";
import { newCorrelationId } from "./logger";
import { ok, toActionError, validationFail, type ActionResult } from "./action-response";

export interface ActionContext {
  session: Session;
  actor: Extract<Actor, { type: "USER" }>;
  correlationId: string;
}

/**
 * The fixed Server-Action pipeline (CLAUDE.md §4.6), enforced in ONE place:
 *   1 authenticate + authorise  →  2 Zod safeParse  →  3 handler (decide via rules.ts with data from queries.ts,
 *   persist in ONE transaction incl. audit/ledger rows, then invalidate cache tags).
 * Never throws to the client: every failure is mapped to ActionResult{code}. Unexpected errors are logged with a
 * correlation id and returned generically.
 */
export async function runAction<TSchema extends ZodType, TOut>(opts: {
  name: string;
  roles: readonly Role[];
  schema: TSchema;
  input: unknown;
  handler: (ctx: ActionContext, input: TSchema["_output"]) => Promise<TOut>;
}): Promise<ActionResult<TOut>> {
  try {
    const session = await requireRole(opts.roles);
    const parsed = opts.schema.safeParse(opts.input);
    if (!parsed.success) return validationFail(parsed.error);
    const ctx: ActionContext = {
      session,
      actor: { type: "USER", id: session.userId },
      correlationId: newCorrelationId(),
    };
    return ok(await opts.handler(ctx, parsed.data));
  } catch (err) {
    return toActionError(err, opts.name);
  }
}

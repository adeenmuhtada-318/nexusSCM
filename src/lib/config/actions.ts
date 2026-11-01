"use server";

import { z } from "zod";
import { PERMISSIONS } from "@/lib/auth/roles";
import { RULE_KEYS, type RuleKey } from "./business-rules.defaults";
import { setBusinessRule } from "./business-rules";
import { runAction } from "@/lib/utils/action-runner";
import { invalidate, tags } from "@/lib/utils/cache";
import type { ActionResult } from "@/lib/utils/action-response";

const updateRuleSchema = z.object({
  key: z.enum(RULE_KEYS),
  value: z.unknown(),
  reasonCode: z.string().trim().min(3).max(64),
});

/** Admin-only runtime business-rule update; inserts a new versioned row and audits before/after snapshot. */
export async function updateBusinessRuleAction(input: unknown): Promise<ActionResult<{ key: RuleKey }>> {
  return runAction({
    name: "config.update",
    roles: PERMISSIONS["config.update"],
    schema: updateRuleSchema,
    input,
    handler: async (ctx, d) => {
      await setBusinessRule({
        key: d.key,
        value: d.value,
        actorId: ctx.actor.id,
        reasonCode: d.reasonCode,
        correlationId: ctx.correlationId,
      });
      invalidate([tags.exceptionsOpen, tags.ordersList, tags.procurementList, tags.returnsList], ["/"]);
      return { key: d.key };
    },
  });
}

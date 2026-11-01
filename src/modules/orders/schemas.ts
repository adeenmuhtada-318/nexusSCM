import { z } from "zod";

const idemKey = z.string().trim().min(8).max(128);

export const createOrderSchema = z
  .object({
    customerId: z.coerce.number().int().positive(),
    addressId: z.coerce.number().int().positive(),
    lines: z
      .array(
        z.object({
          skuId: z.coerce.number().int().positive(),
          qty: z.coerce.number().int().positive().max(100_000),
          isCustomized: z.boolean().default(false),
        }),
      )
      .min(1)
      .max(100),
    priority: z.enum(["STANDARD", "URGENT"]).default("STANDARD"),
    deliveryWindowDays: z.coerce.number().int().min(1).max(60).default(7),
    idempotencyKey: idemKey,
  })
  .superRefine((v, ctx) => {
    const seen = new Set<number>();
    v.lines.forEach((l, i) => {
      if (seen.has(l.skuId)) ctx.addIssue({ code: "custom", path: ["lines", i, "skuId"], message: "Duplicate SKU on order" });
      seen.add(l.skuId);
    });
  });
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const orderIdSchema = z.object({ orderId: z.coerce.number().int().positive() });
export const releaseHoldSchema = orderIdSchema;
export const cancelOrderSchema = orderIdSchema.extend({ reason: z.string().trim().min(3).max(200) });
export const confirmOrderSchema = orderIdSchema;
export const fulfillmentIdSchema = z.object({ fulfillmentId: z.coerce.number().int().positive() });

export const listOrdersSchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

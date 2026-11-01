import { z } from "zod";

const idemKey = z.string().trim().min(8).max(128);

export const requestRmaSchema = z
  .object({
    orderId: z.coerce.number().int().positive(),
    lines: z
      .array(z.object({ orderLineId: z.coerce.number().int().positive(), qty: z.coerce.number().int().positive().max(100_000) }))
      .min(1)
      .max(100),
    reasonCode: z.string().trim().min(2).max(64),
    idempotencyKey: idemKey,
  })
  .superRefine((v, ctx) => {
    const seen = new Set<number>();
    v.lines.forEach((l, i) => {
      if (seen.has(l.orderLineId)) ctx.addIssue({ code: "custom", path: ["lines", i, "orderLineId"], message: "Duplicate order line" });
      seen.add(l.orderLineId);
    });
  });

export const reviewRmaSchema = z.object({
  rmaId: z.coerce.number().int().positive(),
  decision: z.enum(["APPROVE", "DENY"]),
  note: z.string().trim().min(3).max(500),
});

export const inspectRmaSchema = z.object({
  rmaId: z.coerce.number().int().positive(),
  warehouseId: z.coerce.number().int().positive(),
  lines: z
    .array(
      z.object({
        rmaLineId: z.coerce.number().int().positive(),
        isOpened: z.boolean(),
        condition: z.enum(["VERIFIED_NEW", "OPENED_GOOD", "DAMAGED"]),
        /** Required for perishable SKUs that are restocked. */
        expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
});

export const refundRmaSchema = z.object({
  rmaId: z.coerce.number().int().positive(),
  idempotencyKey: idemKey,
});

export const listRmasSchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

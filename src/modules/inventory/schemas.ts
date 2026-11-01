import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const receiveStockSchema = z.object({
  skuId: z.coerce.number().int().positive(),
  warehouseId: z.coerce.number().int().positive(),
  qty: z.coerce.number().int().positive().max(1_000_000),
  lotCode: z.string().trim().min(1).max(64),
  expiryDate: isoDate.nullable().optional(),
  zone: z.enum(["PRIME", "QUARANTINE_QUALITY"]).default("PRIME"),
  reasonCode: z.string().trim().min(1).max(64).default("PO_RECEIPT"),
});
export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;

export const adjustStockSchema = z.object({
  batchId: z.coerce.number().int().positive(),
  delta: z.coerce.number().int().refine((n) => n !== 0, "delta must not be 0"),
  reasonCode: z.string().trim().min(3).max(64),
});
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

export const stockPageSchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

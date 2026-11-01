import { z } from "zod";

const idemKey = z.string().trim().min(8).max(128);

export const createPoSchema = z.object({
  requisitionId: z.coerce.number().int().positive(),
  idempotencyKey: idemKey,
});
export const approvePoSchema = z.object({
  poId: z.coerce.number().int().positive(),
  reasonCode: z.string().trim().min(2).max(64),
  idempotencyKey: idemKey,
});
export const rejectPoSchema = z.object({
  poId: z.coerce.number().int().positive(),
  reasonCode: z.string().trim().min(2).max(64),
});
export const receivePoSchema = z.object({
  poId: z.coerce.number().int().positive(),
  warehouseId: z.coerce.number().int().positive(),
  lotCode: z.string().trim().min(1).max(64),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export const listPoSchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

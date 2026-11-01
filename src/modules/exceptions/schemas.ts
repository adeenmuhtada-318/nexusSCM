import { z } from "zod";

export const resolveExceptionSchema = z.object({
  id: z.coerce.number().int().positive(),
  resolution: z.enum(["RESOLVED", "DISMISSED"]),
  note: z.string().trim().min(3).max(1000),
});
export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;

export const assignExceptionSchema = z.object({
  id: z.coerce.number().int().positive(),
  assigneeId: z.string().uuid(),
});
export type AssignExceptionInput = z.infer<typeof assignExceptionSchema>;

export const listExceptionsSchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

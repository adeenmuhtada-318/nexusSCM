import type { DomainError } from "./errors";
import { DomainError as DomainErrorClass, pgCode, type ErrorCode } from "./errors";
import { logger, newCorrelationId } from "./logger";
import { z, type ZodError } from "zod";

/** Canonical server-action return type (CLAUDE.md §4.6). */
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: ErrorCode; fieldErrors?: Record<string, string[]> };

export const ok = <T>(data: T): ActionResult<T> => ({ success: true, data });

export const fail = (
  code: ErrorCode,
  error: string,
  fieldErrors?: Record<string, string[]>,
): ActionResult<never> =>
  fieldErrors ? { success: false, error, code, fieldErrors } : { success: false, error, code };

export function validationFail(err: ZodError): ActionResult<never> {
  const flat = z.flattenError(err);
  return fail("VALIDATION", "Invalid input", flat.fieldErrors as Record<string, string[]>);
}

/**
 * Map any thrown value to an ActionResult. Domain errors keep their code/message; known Postgres integrity
 * errors map to safe codes; everything else is logged with a correlation id and returned as a generic INTERNAL.
 */
export function toActionError(err: unknown, context: string): ActionResult<never> {
  if (err instanceof DomainErrorClass) {
    return fail((err as DomainError).code, err.message, err.fieldErrors);
  }
  const correlationId = newCorrelationId();
  const pg = pgCode(err);
  logger.error("unexpected action error", {
    context,
    correlationId,
    pgCode: pg,
    name: err instanceof Error ? err.name : "unknown",
    message: err instanceof Error ? err.message : String(err),
  });
  switch (pg) {
    case "23505":
      return fail("CONFLICT", `Duplicate record (ref ${correlationId})`);
    case "23503":
      return fail("NOT_FOUND", `A referenced record does not exist (ref ${correlationId})`);
    case "23514":
      return fail("RULE_VIOLATION", `A data integrity rule rejected this change (ref ${correlationId})`);
    case "55P03":
    case "40001":
    case "40P01":
      return fail("CONFLICT", `The system is busy, please retry (ref ${correlationId})`);
    default:
      return fail("INTERNAL", `Something went wrong (ref ${correlationId})`);
  }
}

import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { logger } from "./logger";

/**
 * Cache tags (CLAUDE.md §4.5): inventory:sku:<id>, orders:list, exceptions:open … Mutations invalidate exactly
 * what they changed. Tags are only used for non-per-user aggregates.
 */
export const tags = {
  inventorySku: (id: number) => `inventory:sku:${id}`,
  inventoryList: "inventory:list",
  ordersList: "orders:list",
  order: (id: number) => `orders:order:${id}`,
  logisticsList: "logistics:list",
  procurementList: "procurement:list",
  returnsList: "returns:list",
  exceptionsOpen: "exceptions:open",
} as const;

export function invalidate(tagList: readonly string[], paths: readonly string[] = []): void {
  for (const t of tagList) {
    try {
      revalidateTag(t);
    } catch (err) {
      // revalidation is best-effort outside a Next request scope (scripts/tests); the write already committed.
      logger.warn("revalidateTag failed", { tag: t, message: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const p of paths) {
    try {
      revalidatePath(p);
    } catch (err) {
      logger.warn("revalidatePath failed", { path: p, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

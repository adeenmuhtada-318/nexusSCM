import "server-only";
import { cache } from "react";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { refunds, rmaLines, rmas } from "@/lib/db/schema";

export interface RmaRow {
  id: number;
  rmaNumber: string;
  orderId: number;
  status: string;
  reasonCode: string;
  requestedAt: Date;
}

/** Newest-first keyset page served by rmas_list_idx. */
export async function listRmas(db: DbOrTx, opts: { cursor?: string; limit: number }) {
  const [iso, idStr] = (opts.cursor ?? "").split("|");
  const id = Number(idStr);
  const hasCursor = !!iso && Number.isInteger(id) && !Number.isNaN(Date.parse(iso));
  const rows = await db
    .select({ id: rmas.id, rmaNumber: rmas.rmaNumber, orderId: rmas.orderId, status: rmas.status, reasonCode: rmas.reasonCode, requestedAt: rmas.requestedAt })
    .from(rmas)
    .where(hasCursor ? sql`(${rmas.requestedAt}, ${rmas.id}) < (${iso}::timestamptz, ${id}::int)` : sql`true`)
    .orderBy(desc(rmas.requestedAt), desc(rmas.id))
    .limit(opts.limit + 1);
  const page: RmaRow[] = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > opts.limit && last ? `${last.requestedAt.toISOString()}|${last.id}` : null };
}

export async function getRmaDetail(db: DbOrTx, rmaId: number) {
  const head = await db
    .select({ id: rmas.id, rmaNumber: rmas.rmaNumber, orderId: rmas.orderId, status: rmas.status, reasonCode: rmas.reasonCode, requestedBy: rmas.requestedBy })
    .from(rmas)
    .where(eq(rmas.id, rmaId))
    .limit(1);
  const rma = head[0];
  if (!rma) return null;
  const lines = await db
    .select({
      id: rmaLines.id,
      orderLineId: rmaLines.orderLineId,
      qty: rmaLines.qty,
      isOpened: rmaLines.isOpened,
      condition: rmaLines.condition,
      disposition: rmaLines.disposition,
      refundCents: rmaLines.refundCents,
    })
    .from(rmaLines)
    .where(eq(rmaLines.rmaId, rmaId))
    .orderBy(asc(rmaLines.id));
  const refund = await db.select({ amountCents: refunds.amountCents, issuedAt: refunds.issuedAt }).from(refunds).where(eq(refunds.rmaId, rmaId)).limit(1);
  return { rma, lines, refund: refund[0] ?? null };
}

/** Refunds already issued against an order line by OTHER RMAs (headroom check, in SQL). */
export async function getRefundedForOrderLine(db: DbOrTx, orderLineId: number, excludeRmaId: number): Promise<number> {
  const rows = await db.execute<{ total: string | null }>(sql`
    SELECT COALESCE(SUM(l.refund_cents), 0) AS total
    FROM rma_lines l JOIN rmas r ON r.id = l.rma_id
    WHERE l.order_line_id = ${orderLineId}::int AND r.id <> ${excludeRmaId}::int AND r.status IN ('REFUNDED', 'CLOSED')`);
  return Number(rows[0]?.total ?? 0);
}

export const getRmas = cache((cursor: string | undefined, limit: number) =>
  listRmas(getDb(), cursor === undefined ? { limit } : { cursor, limit }),
);
export const getRma = cache((rmaId: number) => getRmaDetail(getDb(), rmaId));

export const getRmaLinesMap = cache(async (rmaIds: readonly number[]) => {
  const map = new Map<number, number[]>();
  if (rmaIds.length === 0) return map;
  const rows = await getDb()
    .select({ id: rmaLines.id, rmaId: rmaLines.rmaId })
    .from(rmaLines)
    .where(inArray(rmaLines.rmaId, [...rmaIds]))
    .orderBy(asc(rmaLines.id));
  for (const r of rows) {
    const list = map.get(r.rmaId) ?? [];
    list.push(r.id);
    map.set(r.rmaId, list);
  }
  return map;
});

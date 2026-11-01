import "server-only";
import { cache } from "react";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { exceptions, users } from "@/lib/db/schema";

export interface ExceptionRow {
  id: number;
  type: string;
  entityType: string;
  entityId: string;
  severity: string;
  status: string;
  reasonCode: string;
  createdAt: Date;
  dueAt: Date;
  assignedTo: string | null;
}

export interface ExceptionPage {
  rows: ExceptionRow[];
  nextCursor: string | null;
}

const LIVE = ["OPEN", "IN_REVIEW"] as const;

/** Cursor encodes the keyset (due_at, id): `<iso>|<id>`. Invalid cursors are ignored (first page). */
function parseCursor(cursor?: string): { dueAt: string; id: number } | null {
  if (!cursor) return null;
  const [iso, id] = cursor.split("|");
  const n = Number(id);
  if (!iso || !Number.isInteger(n) || Number.isNaN(Date.parse(iso))) return null;
  return { dueAt: iso, id: n };
}

/**
 * Live exception queue ordered by SLA (due_at, id). Keyset-paginated; served by exceptions_queue_idx (partial).
 * Selects explicit columns only (no SELECT *).
 */
export async function listOpenExceptions(db: DbOrTx, opts: { cursor?: string; limit: number }): Promise<ExceptionPage> {
  const c = parseCursor(opts.cursor);
  const rows = await db
    .select({
      id: exceptions.id,
      type: exceptions.type,
      entityType: exceptions.entityType,
      entityId: exceptions.entityId,
      severity: exceptions.severity,
      status: exceptions.status,
      reasonCode: exceptions.reasonCode,
      createdAt: exceptions.createdAt,
      dueAt: exceptions.dueAt,
      assignedTo: exceptions.assignedTo,
    })
    .from(exceptions)
    .where(
      and(
        inArray(exceptions.status, [...LIVE]),
        c ? sql`(${exceptions.dueAt}, ${exceptions.id}) > (${c.dueAt}::timestamptz, ${c.id}::int)` : sql`true`,
      ),
    )
    .orderBy(asc(exceptions.dueAt), asc(exceptions.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  const hasMore = rows.length > opts.limit && last !== undefined;
  return { rows: page, nextCursor: hasMore ? `${last.dueAt.toISOString()}|${last.id}` : null };
}

export interface ExceptionCounts {
  open: number;
  overdue: number;
  bySeverity: Record<string, number>;
}

/** KPI counts for live exceptions; `now` is injected so overdue is deterministic. */
export async function countOpenExceptions(db: DbOrTx, now: Date): Promise<ExceptionCounts> {
  const rows = await db
    .select({
      severity: exceptions.severity,
      n: sql<number>`count(*)::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${exceptions.dueAt} < ${now.toISOString()}::timestamptz)::int`,
    })
    .from(exceptions)
    .where(inArray(exceptions.status, [...LIVE]))
    .groupBy(exceptions.severity);
  const bySeverity: Record<string, number> = {};
  let open = 0;
  let overdue = 0;
  for (const r of rows) {
    bySeverity[r.severity] = r.n;
    open += r.n;
    overdue += r.overdue;
  }
  return { open, overdue, bySeverity };
}

export async function getExceptionStatus(db: DbOrTx, id: number): Promise<string | null> {
  const r = await db.select({ status: exceptions.status }).from(exceptions).where(eq(exceptions.id, id)).limit(1);
  return r[0]?.status ?? null;
}

// Request-scoped, deduplicated readers for Server Components (CLAUDE.md §4.5).
export const getOpenExceptions = cache((cursor: string | undefined, limit: number) =>
  listOpenExceptions(getDb(), cursor === undefined ? { limit } : { cursor, limit }),
);
export const getOpenExceptionCounts = cache(() => countOpenExceptions(getDb(), new Date()));
export const getAssignableUsers = cache(async () =>
  getDb()
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(asc(users.role), asc(users.name))
    .limit(100),
);

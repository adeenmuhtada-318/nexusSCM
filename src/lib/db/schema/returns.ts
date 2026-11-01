import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, serial, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./core";
import { returnCondition, returnDisposition, rmaStatus } from "./enums";
import { orderLines, orders } from "./orders";

export const rmas = pgTable(
  "rmas",
  {
    id: serial("id").primaryKey(),
    rmaNumber: text("rma_number").notNull(),
    orderId: integer("order_id").notNull().references(() => orders.id),
    status: rmaStatus("status").notNull(),
    reasonCode: text("reason_code").notNull(),
    requestedBy: uuid("requested_by").notNull().references(() => users.id),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rmas_number_uq").on(t.rmaNumber),
    index("rmas_list_idx").on(t.requestedAt, t.id),
    index("rmas_order_idx").on(t.orderId),
  ],
);

export const rmaLines = pgTable(
  "rma_lines",
  {
    id: serial("id").primaryKey(),
    rmaId: integer("rma_id").notNull().references(() => rmas.id),
    orderLineId: integer("order_line_id").notNull().references(() => orderLines.id),
    /** Returned quantity (never hard-coded to 1). */
    qty: integer("qty").notNull(),
    isOpened: boolean("is_opened"),
    condition: returnCondition("condition"),
    disposition: returnDisposition("disposition").notNull().default("PENDING"),
    refundCents: bigint("refund_cents", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    index("rma_lines_rma_idx").on(t.rmaId),
    index("rma_lines_order_line_idx").on(t.orderLineId),
    check("rma_lines_qty_ck", sql`${t.qty} > 0`),
    check("rma_lines_refund_ck", sql`${t.refundCents} >= 0`),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: serial("id").primaryKey(),
    rmaId: integer("rma_id").notNull().references(() => rmas.id),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    issuedBy: uuid("issued_by").notNull().references(() => users.id),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One refund per RMA — a second attempt is a replay, never a second payout.
    uniqueIndex("refunds_rma_uq").on(t.rmaId),
    check("refunds_amount_ck", sql`${t.amountCents} > 0`),
  ],
);

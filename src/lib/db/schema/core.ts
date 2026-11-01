import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actorType, exceptionSeverity, exceptionStatus, exceptionType, userRole } from "./enums";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

/** Append-only (trigger in migration 0001_append_only). Corrections are new rows. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id),
    actorType: actorType("actor_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reasonCode: text("reason_code"),
    correlationId: text("correlation_id").notNull(),
  },
  (t) => [
    index("audit_entity_idx").on(t.entityType, t.entityId, t.occurredAt),
    index("audit_occurred_idx").on(t.occurredAt),
    check("audit_actor_ck", sql`(${t.actorType} = 'SYSTEM') OR (${t.actorId} IS NOT NULL)`),
  ],
);

/** The Exception Queue — first-class table (CLAUDE.md §4.8). */
export const exceptions = pgTable(
  "exceptions",
  {
    id: serial("id").primaryKey(),
    type: exceptionType("type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    severity: exceptionSeverity("severity").notNull(),
    status: exceptionStatus("status").notNull().default("OPEN"),
    reasonCode: text("reason_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    assignedTo: uuid("assigned_to").references(() => users.id),
    /** Who triggered the underlying request (NULL = system). Drives separation of duties on resolve. */
    requestedBy: uuid("requested_by").references(() => users.id),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    // Idempotent creation: at most one live exception per (entity, type).
    uniqueIndex("exceptions_live_uq")
      .on(t.entityType, t.entityId, t.type)
      .where(sql`${t.status} IN ('OPEN','IN_REVIEW')`),
    // Queue ordering: open items by SLA then id (keyset pagination).
    index("exceptions_queue_idx").on(t.dueAt, t.id).where(sql`${t.status} IN ('OPEN','IN_REVIEW')`),
    check(
      "exceptions_resolved_ck",
      sql`(${t.status} IN ('RESOLVED','DISMISSED')) = (${t.resolvedAt} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL)`,
    ),
  ],
);

/** Versioned thresholds. Latest row per key with effective_from <= now wins. */
export const businessRulesConfig = pgTable(
  "business_rules_config",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    changedBy: uuid("changed_by").references(() => users.id),
  },
  (t) => [uniqueIndex("brc_key_from_uq").on(t.key, t.effectiveFrom)],
);

/** Idempotency ledger for double-submittable mutations (create order, confirm PO, refund). */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idem_scope_key_uq").on(t.scope, t.key),
    check("idem_key_len_ck", sql`char_length(${t.key}) BETWEEN 8 AND 128`),
  ],
);

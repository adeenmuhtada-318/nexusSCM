# NexusSCM — Decision Log (ADR-style)

Format: **ID — Decision** · Status (`CONFIRMED` by user / `ASSUMED` needs business sign-off) · Rationale.

## §10 Open Decisions (answered by the user on 2026-10-31)

| ID | Decision | Status |
|----|----------|--------|
| D-00a | **Auth provider = Auth.js (NextAuth v5) Credentials**, DB-backed users/roles, JWT sessions | CONFIRMED |
| D-00b | Currency / timezone = USD / America/New_York | CONFIRMED (spec) |
| D-01 | **Credit-limit scope = per ACCOUNT** (`customer_accounts.credit_limit_cents`, shared by all customers of the account) | CONFIRMED |
| D-02 | Return window = 30 days (config key `returns.window_days`; per-category override not built yet) | CONFIRMED (spec) |
| D-03 | **Min shelf life for perishable allocation = 20 % of total shelf life** (`inventory.min_shelf_life_pct`). Remaining days must be ≥ ceil(shelf_life × 20 %) and > 0. SKU column `shelf_life_days` is required for perishables. (§5.1 mentions `min_shelf_life_days`; the user chose percentage, so it is derived.) | CONFIRMED |
| D-04 | **Reservation TTL = 30 min** (`inventory.reservation_ttl_minutes`); **Scheduled jobs = Vercel Cron** hitting `/api/cron/*` secured by `CRON_SECRET` | CONFIRMED |
| D-04b | Safety-stock Z = 1.65 (95 %) | CONFIRMED (spec) |

## Assumptions made to keep building (please confirm or change)

| ID | Assumption | Where |
|----|------------|-------|
| D-05 | **All non-stock Seven-Rights failures hold the order** (`ON_HOLD_EXCEPTION` + one `exceptions` row each): inactive product, inactive customer/account, credit, address, hazmat-restricted destination. The spec names only address & credit explicitly; the rest are held (not silently rejected) because every automatic denial must write an exception. | `orders/rules.ts` |
| D-06 | **Split tie-break**: if any single warehouse can fulfil 100 %, use the nearest such one (fewer shipments beats nearest-only). Otherwise greedy set-cover — most covered units first, ties → nearest, then lowest id. | `orders/rules.ts` |
| D-11 | **Ship-complete policy**: if the whole network cannot cover a line even by splitting → order `BACKORDERED`, nothing reserved, exception `NO_WAREHOUSE_CAN_FULFIL`. No partial reservation / partial shipment of the available part. | `orders/rules.ts` |
| D-07 | `returns.ineligible_policy` default = `AUTO_DENY` (past-window / customized). Switch to `HUMAN_REVIEW` via config. Already-returned, not-delivered and bad-quantity are always hard-denied. | config |
| D-08 | Carrier score weights default 0.4 cost / 0.3 speed / 0.3 reliability (spec requires config but gives no numbers). Weights are normalised to sum 1. | config |
| D-09 | Auto-requisition quantity = order-up-to (ROP + D_avg × `inventory.requisition_cover_days` = 30 d) − (available + on order), rounded up, min 1. Spec does not define the order quantity. | `inventory/rules.ts` |
| D-10 | Exception severities per type and SLA hours (LOW 72h / MEDIUM 24h / HIGH 8h / CRITICAL 4h) are placeholders; both required by schema (`severity`, `due_at` NOT NULL). | config + rules |
| D-12 | **URGENT never silently downgrades**: if no eligible Air Express → `NO_ELIGIBLE_CARRIER` exception. Heavy rule (>50 lb AND >3 d window) with no eligible Ground Freight falls through to the weighted score and is recorded as `WEIGHTED_SCORE`. | `logistics/rules.ts` |
| D-13 | PO approvals: manager-level items need `MANAGER` only (ADMIN excluded: administration ≠ procurement authority); buyer-level items accept `BUYER` or `MANAGER`. Approver ≠ requester, also enforced by a DB CHECK. Cascade allocates the **whole PO** to the first eligible tier (no cross-vendor quantity splitting). | `procurement/rules.ts` |
| D-14 | Split-PO guard sums open (non-rejected/cancelled) POs of the **same vendor + same SKU + same business-timezone day** and adds them to the new PO before the threshold test. | `procurement/mutations.ts` |
| D-15 | Order balance accounting: `current_balance_cents` is increased when stock is reserved (credit exposure starts), decreased on cancel/expiry and on refund. The credit check is repeated atomically with a conditional `UPDATE … WHERE balance + total <= limit` to stay race-free. | `orders/mutations.ts` |
| D-16 | Demand for ROP = `SHIP` ledger rows (physical outflow) per day over the trailing window, zero-demand days included in mean/σ. | `inventory/queries.ts` |
| D-17 | Quarantined / restocked return stock is added as a **new batch** (receipt ledger row) rather than moving quantity between batches, so each batch lives in exactly one zone. | `returns/mutations.ts` |
| D-18 | Refund = unit price × returned qty per line, capped by what was paid minus previously refunded; one refund per RMA (unique index); it also credits the account balance. | `returns/*` |
| D-19 | `audit_logs` / `inventory_ledger` append-only via triggers (not role grants) so it works on Neon/Supabase without role management. | migration `0001` |
| D-20 | `exceptions.requested_by` column added (not in the §4.8 field list) to carry the requester for separation-of-duties on resolve. | schema |
| D-21 | Multi-line RMA request status aggregation: if any line evaluates to `AUTO_DENY`, the RMA is `DENIED`; else if any line is `HUMAN_REVIEW`, `PENDING_REVIEW`; else `APPROVED`. Claimed return quantities are reserved only for non-denied RMAs and released if human review later denies. | returns |

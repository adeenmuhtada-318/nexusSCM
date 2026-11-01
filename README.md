# NexusSCM — Human-in-the-Loop Supply Chain Platform

NexusSCM is a **Management-by-Exception** supply chain control tower built with **Next.js 15 (App Router)**, **TypeScript (`strict` + `noUncheckedIndexedAccess`)**, **PostgreSQL**, **Drizzle ORM**, **Auth.js v5 (RBAC)**, **Zod**, and **Tailwind CSS**.

Routine operations execute automatically through deterministic pure rules; human operators intervene strictly on items routed to the **HITL Exception Queue** when financial, physical, or compliance thresholds are breached.

---

## Team Contributions

| Member   | Role                                 | Modules                                     |
| :---     | :---                                 | :---                                        |
| Adeen    | Product Owner / Developer            | Database + login, Inventory, Orders         |
| Kashmala | Scrum Master / QA / Docs owner       | Procurement, Logistics, tests, documentation|
| Areeza   | Developer / UI-UX                    | Returns, Dashboard, Exception Queue         |

---

## Domain Modules & Key Invariants

1. **Inventory (`src/modules/inventory`)**:
   - Append-only `inventory_ledger` enforced by PostgreSQL `BEFORE UPDATE OR DELETE OR TRUNCATE` triggers.
   - Multi-batch **FEFO** (perishables enforcing `>= 20%` remaining shelf life) and **FIFO** (standard SKUs) pessimistic `FOR UPDATE` locking in deterministic batch order, with `SET LOCAL lock_timeout = '2000ms'` and bounded jittered retry on `55P03` / `40001` / `40P01`.
   - Quarantine zones (`QUARANTINE_REFURBISHMENT`, `QUARANTINE_QUALITY`) are excluded from allocation.
   - Trailing 90-day SQL demand statistics ($D_{\text{avg}}, \sigma_d$) drive Reorder Point $\text{ROP} = D_{\text{avg}} \cdot L_{\text{avg}} + Z \cdot \sigma_d \cdot \sqrt{L_{\text{avg}}}$ ($Z = 1.65$) and idempotent auto-requisitions.
2. **Orders (`src/modules/orders`)**:
   - **Seven Rights Gate** recomputes contract/list pricing server-side, validates customer/account status, geocoded coordinates, hazmat destination restrictions, and account credit exposure, and plans multi-warehouse fulfillment splits ranked by **SQL Haversine distance (km)**.
   - Unconfirmed `RESERVED` orders expire idempotently after a 30-minute TTL (`expireReservations`).
3. **Logistics (`src/modules/logistics`)**:
   - Two-stage carrier selection: SQL compliance filter (active, hazmat certification, max weight, max dimension, transit window) followed by pure scoring rules (`URGENT_AIR`, `HEAVY_GROUND`, or normalized `WEIGHTED_SCORE`). Raises `NO_ELIGIBLE_CARRIER` when no carrier qualifies.
4. **Procurement (`src/modules/procurement`)**:
   - Vendor contract cascade (`Tier 1 -> Tier 2 -> Tier 3`), `>= $10,000.00` (`1,000,000` cents) manager approval gate, Tier-3 spot buyer approval gate, same-day vendor/SKU split-PO evasion guard, and DB-enforced separation of duties (`approved_by <> requested_by`).
5. **Returns (`src/modules/returns`)**:
   - 30-day return window computed in SQL in `America/New_York`, automatic denial of customized items, concurrency-safe anti-double-return claim on `order_lines.qty_returned`, dock inspection disposition (`PRIME` vs `QUARANTINE_REFURBISHMENT` + `RETURN_GRADING` for actual returned `qty`), and idempotent account-credit refunds capped at paid line totals.
6. **Exception Queue (`src/modules/exceptions`)**:
   - First-class SLA-ordered queue (`exceptions_queue_idx`), partial unique index preventing duplicate live exceptions per `(entity_type, entity_id, type)`, per-type RBAC resolution rules, and mandatory audit trail.

---

## Quickstart (Zero-Cloud Local Setup)

```bash
# 1. Start persistent local PostgreSQL on port 54329 (in terminal 1)
pnpm db:local

# 2. Copy .env.example -> .env, apply migrations + rule defaults, and seed >= 100k batches + demo workflows
cp .env.example .env
pnpm db:migrate
pnpm db:seed

# 3. Start Next.js 15 dev server
pnpm dev
```

### Seeded Demo RBAC Accounts (Password: `Nexus123!`)

| Role | Email | Primary Responsibilities |
| :--- | :--- | :--- |
| `ADMIN` | `admin@nexus.local` | Full platform access + versioned `business_rules_config` updates |
| `MANAGER` | `manager@nexus.local` | Approves `>= $10,000` POs, assigns & resolves cross-domain exceptions |
| `BUYER` | `buyer@nexus.local` | Converts requisitions, approves Tier-3 spot POs |
| `CUSTOMER_SERVICE` | `cs@nexus.local` | Places/confirms/cancels orders, re-evaluates holds, requests/reviews/refunds RMAs |
| `WAREHOUSE_TECH` | `tech@nexus.local` | Receives/adjusts batches, books & ships fulfillments, dock-inspects RMAs |

---

## Verification Suite

```bash
pnpm typecheck   # Strict TypeScript + noUncheckedIndexedAccess
pnpm lint        # ESLint + CLAUDE.md architectural import boundaries
pnpm test:unit   # 105 pure business-rule unit tests
pnpm test:int    # Real PostgreSQL concurrency, RBAC, idempotency, 100k-row EXPLAIN & ledger reconciliation
pnpm build       # Production Next.js 15 build
pnpm test:e2e    # Self-contained Playwright Chromium HITL flows
```

See [docs/DECISIONS.md](./docs/DECISIONS.md) for the ADR log (`D-00a`–`D-21`) and [docs/HANDOFF.md](./docs/HANDOFF.md) for free-tier cloud deployment notes.

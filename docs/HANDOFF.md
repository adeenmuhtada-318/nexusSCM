# NexusSCM — Free-Tier Deployment & Operational Handoff

## 1. Free-Tier Cloud Topology

- **Compute**: Vercel Hobby (Next.js 15 App Router, Server Components + Server Actions).
- **Database**: Neon Free Tier or Supabase Free Tier PostgreSQL:
  - Set `DATABASE_URL` to the **pooled** connection string (transaction-mode pooler; `src/lib/db/index.ts` sets `prepare: false` and `max: DB_POOL_MAX` default `3`).
  - Set `DIRECT_DATABASE_URL` to the **direct** (non-pooled) connection string for `pnpm db:migrate`.
- **Required Environment Variables**:
  - `DATABASE_URL` — Pooled Postgres URL
  - `DIRECT_DATABASE_URL` — Direct Postgres URL (used by migrations)
  - `AUTH_SECRET` — `>= 32` random characters (`openssl rand -base64 32`)
  - `CRON_SECRET` — `>= 32` random characters authenticating `Authorization: Bearer <CRON_SECRET>` on `/api/cron/*`
  - `BUSINESS_TIMEZONE` — Defaults to `America/New_York`

## 2. Scheduled Jobs on Free Tier

Both scheduled endpoints are idempotent and support `GET` and `POST` with `Authorization: Bearer <CRON_SECRET>`:

1. `/api/cron/reservations` — Expires unconfirmed `RESERVED` orders past their 30-minute TTL and releases reserved stock + credit exposure.
2. `/api/cron/replenishment` — Scans trailing 90-day ledger demand, creates open purchase requisitions when `qty_available + qty_on_order <= ROP`, and converts open requisitions into POs.

- **Vercel Hobby note**: `vercel.json` registers daily cron schedules (`0 2 * * *` and `0 6 * * *`) so deployment succeeds on Vercel Hobby without paid plan errors. For 5-minute reservation TTL sweeps in production on $0 budget, point a free external scheduler (e.g., GitHub Actions schedule or cron-job.org) at `POST https://<your-domain>/api/cron/reservations` with header `Authorization: Bearer <CRON_SECRET>`.

## 3. Rate Limiting Note

- `src/lib/utils/rate-limit.ts` provides a zero-cost sliding-window limiter per serverless warm instance on login and cron endpoints. For multi-region distributed hard rate-limiting beyond free-tier warm-instance memory, attach Vercel WAF or Upstash Redis Free Tier in front of `/api/auth/*` and `/api/cron/*`.

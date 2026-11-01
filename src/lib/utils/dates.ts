/**
 * Time helpers. Rules never call Date.now(); callers pass `now` in (CLAUDE.md §4.2).
 * Storage is timestamptz/UTC; "calendar day" semantics use the business timezone.
 */
export const BUSINESS_TZ_DEFAULT = "America/New_York";

/** YYYY-MM-DD of an instant as seen in `tz`. */
export function localDate(instant: Date, tz: string = BUSINESS_TZ_DEFAULT): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  return parts; // en-CA => YYYY-MM-DD
}

/** Whole calendar days from `from` to `to` (both interpreted in `tz`). Mirrors SQL `(CURRENT_DATE - delivered_at::date)`. */
export function calendarDaysBetween(from: Date, to: Date, tz: string = BUSINESS_TZ_DEFAULT): number {
  const a = Date.parse(`${localDate(from, tz)}T00:00:00Z`);
  const b = Date.parse(`${localDate(to, tz)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

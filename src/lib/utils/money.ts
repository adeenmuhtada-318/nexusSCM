/**
 * Money helpers (CLAUDE.md §4.2). All currency is integer minor units (USD cents).
 * No floating-point arithmetic on money: parsing/formatting go through string math.
 */
export type Cents = number;

/** Parse a decimal string like "1234.5" or "1,234.50" to integer cents. Throws on invalid / >2 dp. */
export function parseMoney(input: string): Cents {
  const s = input.trim().replace(/,/g, "");
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid money amount: "${input}"`);
  const sign = m[1] === "-" ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "0").padEnd(2, "0"));
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents)) throw new Error("Money amount out of range");
  return sign * cents;
}

/** Format integer cents as "$1,234.50". */
export function formatMoney(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${sign}$${whole}.${frac}`;
}

/** unit price (cents) × integer quantity. Throws if qty is not a non-negative integer. */
export function mulCents(unitCents: Cents, qty: number): Cents {
  if (!Number.isInteger(qty) || qty < 0) throw new Error("Quantity must be a non-negative integer");
  const total = unitCents * qty;
  if (!Number.isSafeInteger(total)) throw new Error("Money overflow");
  return total;
}

/** Sum cents safely. */
export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}

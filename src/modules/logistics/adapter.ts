import "server-only";
import type { CarrierMode, CarrierQuote } from "./rules";

/** What a carrier needs to price/book one shipment. */
export interface Parcel {
  fulfillmentOrderId: number;
  weightLbs: number;
  maxDimensionIn: number;
  hazmat: boolean;
}

export interface CarrierRecord {
  id: number;
  code: string;
  mode: CarrierMode;
  baseCostCents: number;
  costPerLbCents: number;
  transitDays: number;
  reliability: number;
}

/**
 * Carrier API / rate-shopping port (CLAUDE.md §5.3). Real integrations (UPS, FedEx…) implement this interface.
 * NOTE for real adapters: network calls should happen OUTSIDE the DB transaction; the mock is pure/in-process.
 */
export interface CarrierAdapter {
  quote(carrier: CarrierRecord, parcel: Parcel): Promise<CarrierQuote>;
  book(carrier: CarrierRecord, parcel: Parcel): Promise<{ trackingNumber: string }>;
}

/**
 * Deterministic mock adapter: cost = base + ceil(perLb × weight) in integer cents (no float money),
 * transit/reliability straight from the carrier row, tracking number derived from carrier + fulfillment id.
 */
export const mockCarrierAdapter: CarrierAdapter = {
  async quote(c, p) {
    // perLb is cents/lb; weight has ≤2 decimals → work in hundredths of a lb to stay exact.
    const hundredthsLb = Math.round(p.weightLbs * 100);
    const variable = Math.ceil((c.costPerLbCents * hundredthsLb) / 100);
    return {
      carrierId: c.id,
      code: c.code,
      mode: c.mode,
      costCents: c.baseCostCents + variable,
      transitDays: c.transitDays,
      reliability: c.reliability,
    };
  },
  async book(c, p) {
    return { trackingNumber: `MOCK-${c.code}-${p.fulfillmentOrderId}` };
  },
};

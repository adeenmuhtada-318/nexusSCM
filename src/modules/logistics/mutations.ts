import "server-only";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { shipments } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/db/audit";
import { loadBusinessRules } from "@/lib/config/business-rules";
import { raiseException } from "@/modules/exceptions";
import { DomainError } from "@/lib/utils/errors";
import { mockCarrierAdapter, type CarrierAdapter } from "./adapter";
import { getEligibleCarriers } from "./queries";
import { checkShipmentTransition, selectCarrier, type CarrierQuote, type SelectionRule } from "./rules";

export interface BookShipmentArgs {
  fulfillmentOrderId: number;
  weightLbs: number;
  maxDimensionIn: number;
  hazmat: boolean;
  priority: "STANDARD" | "URGENT";
  deliveryWindowDays: number;
  requestedBy: string | null;
  actor: Actor;
  correlationId: string;
  adapter?: CarrierAdapter;
}

export type BookShipmentResult =
  | { booked: true; shipmentId: number; carrierCode: string; rule: SelectionRule; costCents: number; trackingNumber: string }
  | { booked: false; exceptionId: number; reason: string };

/**
 * Select + book a carrier for one fulfillment order. Pipeline: SQL compliance filter → adapter quotes →
 * rules.selectCarrier (URGENT → fastest Air; heavy & long window → cheapest Ground; else normalised weighted score).
 * No eligible carrier ⇒ writes a NO_ELIGIBLE_CARRIER exceptions row and returns booked:false — never a silent default.
 * Idempotent per fulfillment: unique(shipments.fulfillment_order_id) makes a second booking fail loudly (CONFLICT).
 */
export async function bookShipment(tx: Tx, a: BookShipmentArgs): Promise<BookShipmentResult> {
  const adapter = a.adapter ?? mockCarrierAdapter;
  const rules = await loadBusinessRules(tx);
  const parcel = { fulfillmentOrderId: a.fulfillmentOrderId, weightLbs: a.weightLbs, maxDimensionIn: a.maxDimensionIn, hazmat: a.hazmat };

  const eligible = await getEligibleCarriers(tx, {
    weightLbs: a.weightLbs,
    maxDimensionIn: a.maxDimensionIn,
    hazmat: a.hazmat,
    deliveryWindowDays: a.deliveryWindowDays,
  });
  const quotes: CarrierQuote[] = [];
  for (const c of eligible) quotes.push(await adapter.quote(c, parcel));

  const selection = selectCarrier(
    { priority: a.priority, weightLbs: a.weightLbs, deliveryWindowDays: a.deliveryWindowDays, quotes },
    {
      heavyWeightLbs: rules.logisticsHeavyWeightLbs,
      heavyWindowDays: rules.logisticsHeavyWindowDays,
      weights: rules.carrierWeights,
    },
  );

  if (!selection.ok) {
    const ex = await raiseException(tx, {
      type: "NO_ELIGIBLE_CARRIER",
      entityType: "fulfillment_order",
      entityId: a.fulfillmentOrderId,
      severity: "HIGH",
      reasonCode: selection.reason,
      requestedBy: a.requestedBy,
      actor: a.actor,
      correlationId: a.correlationId,
    });
    return { booked: false, exceptionId: ex.id, reason: selection.reason };
  }

  const carrier = eligible.find((c) => c.id === selection.quote.carrierId);
  if (!carrier) throw new DomainError("INTERNAL", "Selected carrier missing from eligible set");
  const { trackingNumber } = await adapter.book(carrier, parcel);

  const inserted = await tx
    .insert(shipments)
    .values({
      fulfillmentOrderId: a.fulfillmentOrderId,
      carrierId: carrier.id,
      status: "BOOKED",
      priority: a.priority,
      selectionRule: selection.rule,
      weightLbs: a.weightLbs.toFixed(2),
      deliveryWindowDays: a.deliveryWindowDays,
      costCents: selection.quote.costCents,
      trackingNumber,
    })
    .onConflictDoNothing()
    .returning({ id: shipments.id });
  const row = inserted[0];
  if (!row) throw new DomainError("CONFLICT", "A shipment is already booked for this fulfillment order");
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "shipment",
    entityId: row.id,
    action: "SHIPMENT_BOOKED",
    after: { fulfillmentOrderId: a.fulfillmentOrderId, carrier: carrier.code, rule: selection.rule, costCents: selection.quote.costCents },
    reasonCode: selection.rule,
    correlationId: a.correlationId,
  });
  return { booked: true, shipmentId: row.id, carrierCode: carrier.code, rule: selection.rule, costCents: selection.quote.costCents, trackingNumber };
}

/** BOOKED/IN_TRANSIT → DELIVERED for a fulfillment's shipment (transition-checked; BOOKED passes through IN_TRANSIT). */
export async function markShipmentDelivered(tx: Tx, a: { fulfillmentOrderId: number; actor: Actor; correlationId: string }): Promise<void> {
  const rows = await tx
    .select({ id: shipments.id, status: shipments.status })
    .from(shipments)
    .where(eq(shipments.fulfillmentOrderId, a.fulfillmentOrderId))
    .for("update")
    .limit(1);
  const s = rows[0];
  if (!s) throw new DomainError("NOT_FOUND", "No shipment for this fulfillment order");
  let current = s.status;
  if (current === "BOOKED") {
    const t1 = checkShipmentTransition("BOOKED", "IN_TRANSIT");
    if (!t1.ok) throw new DomainError("ILLEGAL_TRANSITION", t1.error);
    current = "IN_TRANSIT";
  }
  const t = checkShipmentTransition(current, "DELIVERED");
  if (!t.ok) throw new DomainError("ILLEGAL_TRANSITION", t.error);
  await tx.update(shipments).set({ status: "DELIVERED" }).where(sql`${shipments.id} = ${s.id}`);
  await writeAudit(tx, {
    actor: a.actor,
    entityType: "shipment",
    entityId: s.id,
    action: "SHIPMENT_DELIVERED",
    before: { status: s.status },
    after: { status: "DELIVERED" },
    correlationId: a.correlationId,
  });
}

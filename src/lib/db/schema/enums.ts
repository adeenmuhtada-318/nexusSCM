import { pgEnum } from "drizzle-orm/pg-core";
import { ROLES } from "../../auth/roles";

/** All statuses/kinds are DB enum types (CLAUDE.md §4.1). Transition maps live in each module's rules.ts. */
export const userRole = pgEnum("user_role", ROLES);
export const actorType = pgEnum("actor_type", ["USER", "SYSTEM"]);

export const exceptionType = pgEnum("exception_type", [
  "ORDER_ADDRESS_INVALID",
  "ORDER_CREDIT_EXCEEDED",
  "ORDER_HAZMAT_RESTRICTED",
  "ORDER_CUSTOMER_INACTIVE",
  "ORDER_PRODUCT_INACTIVE",
  "NO_WAREHOUSE_CAN_FULFIL",
  "NO_ELIGIBLE_CARRIER",
  "PO_APPROVAL_REQUIRED",
  "NO_VENDOR_AVAILABLE",
  "RMA_REVIEW",
  "RETURN_GRADING",
  "LEDGER_MISMATCH",
]);
export const exceptionSeverity = pgEnum("exception_severity", ["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const exceptionStatus = pgEnum("exception_status", ["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"]);

export const zoneStatus = pgEnum("zone_status", ["PRIME", "QUARANTINE_REFURBISHMENT", "QUARANTINE_QUALITY"]);
export const ledgerEntryType = pgEnum("ledger_entry_type", [
  "RECEIPT",
  "RESERVE",
  "RELEASE",
  "SHIP",
  "RETURN_RESTOCK",
  "RETURN_QUARANTINE",
  "ADJUSTMENT",
]);
export const reservationStatus = pgEnum("reservation_status", ["ACTIVE", "RELEASED", "FULFILLED"]);
export const requisitionStatus = pgEnum("requisition_status", ["OPEN", "CONVERTED", "CANCELLED"]);

export const orderStatus = pgEnum("order_status", [
  "ON_HOLD_EXCEPTION",
  "BACKORDERED",
  "RESERVED",
  "CONFIRMED",
  "PARTIALLY_SHIPPED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "EXPIRED",
]);
export const fulfillmentStatus = pgEnum("fulfillment_status", ["RESERVED", "SHIPPED", "DELIVERED", "CANCELLED"]);

export const carrierMode = pgEnum("carrier_mode", ["AIR_EXPRESS", "GROUND_FREIGHT", "PARCEL"]);
export const shipmentPriority = pgEnum("shipment_priority", ["STANDARD", "URGENT"]);
export const shipmentStatus = pgEnum("shipment_status", ["BOOKED", "IN_TRANSIT", "DELIVERED", "CANCELLED"]);
export const selectionRule = pgEnum("selection_rule", ["URGENT_AIR", "HEAVY_GROUND", "WEIGHTED_SCORE"]);

export const poStatus = pgEnum("po_status", [
  "PENDING_BUYER_APPROVAL",
  "PENDING_MANAGER_APPROVAL",
  "APPROVED_AND_DISPATCHED",
  "RECEIVED",
  "REJECTED",
  "CANCELLED",
]);

export const rmaStatus = pgEnum("rma_status", [
  "PENDING_REVIEW",
  "APPROVED",
  "DENIED",
  "RECEIVED",
  "INSPECTED",
  "REFUNDED",
  "CLOSED",
]);
export const returnCondition = pgEnum("return_condition", ["VERIFIED_NEW", "OPENED_GOOD", "DAMAGED"]);
export const returnDisposition = pgEnum("return_disposition", ["PENDING", "RESTOCK_PRIME", "QUARANTINE_REFURBISHMENT"]);

/** Public API of the logistics module. */
export { bookShipment, markShipmentDelivered } from "./mutations";
export type { BookShipmentArgs, BookShipmentResult } from "./mutations";
export { getEligibleCarriers, listShipments, getShipments } from "./queries";
export type { ShipmentRow, ShipmentCriteria } from "./queries";
export { mockCarrierAdapter } from "./adapter";
export type { CarrierAdapter, CarrierRecord, Parcel } from "./adapter";
export { selectCarrier } from "./rules";

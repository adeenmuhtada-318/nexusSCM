/** Public API of the inventory module — the only entry point other modules may import. */
export {
  reserveStock,
  releaseReservations,
  fulfillReservations,
  findExpiredReservationOwners,
  clearReservationExpiry,
  receiveStock,
  adjustBatch,
  createRequisition,
  markRequisitionConverted,
  getOpenRequisition,
} from "./mutations";
export type { ReserveStockArgs, ReservationResult, ReceiveStockArgs } from "./mutations";
export { runAutoRequisition } from "./replenishment";
export type { OnOrderLookup, AutoRequisitionResult } from "./replenishment";
export {
  getSkuInfos,
  getAvailabilityContext,
  rankWarehousesByDistance,
  reconcileLedger,
  listWarehouses,
  listOpenRequisitions,
  getStockOverview,
  getStockPage,
  getReplenishmentSignals,
  businessToday,
} from "./queries";
export type { OpenRequisitionRow, SkuInfo, WarehouseAvailability, AvailabilityContext, LedgerMismatch, ReplenishmentSignal } from "./queries";
export { computeRop, shouldRequisition, requisitionQty } from "./rules";


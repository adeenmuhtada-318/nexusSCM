/** Public API of the orders module — the only entry point other modules may import. */
export { createOrder, reevaluateOrder, confirmOrder, cancelOrder, expireReservations, claimReturnQty, unclaimReturnQty, creditAccount } from "./mutations";
export type { CreateOrderArgs, PlaceOrderResult } from "./mutations";
export { shipFulfillment, markFulfillmentDelivered } from "./fulfillment";
export type { ShipResult } from "./fulfillment";
export { getOrders, getOrder, getOrderDetail, listOrders, getReturnableLine, listCustomerOptions, loadPlacementContext } from "./queries";
export type { ReturnableLine, OrderListRow } from "./queries";
export type { OrderStatus } from "./rules";

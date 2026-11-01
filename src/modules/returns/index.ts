/** Public API of the returns module. */
export { requestRma, reviewRma, receiveAndInspectRma, refundRma } from "./mutations";
export type { RequestRmaResult } from "./mutations";
export { getRmas, getRma, listRmas, getRmaDetail } from "./queries";
export type { RmaRow } from "./queries";

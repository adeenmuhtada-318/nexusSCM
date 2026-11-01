/** Public API of the exceptions module — the only entry point other modules may import. */
export { raiseException, resolveException, closeExceptionsForEntity, assignException } from "./mutations";
export type { RaiseExceptionInput } from "./mutations";
export { listOpenExceptions, countOpenExceptions, getOpenExceptions, getOpenExceptionCounts } from "./queries";
export type { ExceptionRow, ExceptionPage, ExceptionCounts } from "./queries";
export type { ExceptionType, ExceptionSeverity } from "./rules";

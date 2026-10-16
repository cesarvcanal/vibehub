import { logger } from "./logger.js";

/**
 * Keeps the server alive through a promise rejection nobody handled — Node 24's default is to end
 * the process, and here that ends every terminal, chat and turn in flight for everyone. Fire-and-
 * forget calls (`void something()`) are all over the hot paths; one missing `.catch` must cost a log
 * line, not the install. Synchronous uncaught exceptions are left to the default (crash): unlike a
 * rejected promise, they can abandon a half-applied change.
 *
 * Returns the uninstaller (tests).
 */
export function logUnownedRejections(): () => void {
  const onRejection = (reason: unknown): void => {
    logger.error({ err: reason }, "unhandled promise rejection — kept running");
  };
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("unhandledRejection", onRejection);
  };
}

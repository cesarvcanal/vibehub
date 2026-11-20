import { isAxiosError } from "axios";
import { platformFailuresApi } from "../api";

const MESSAGE_MAX_CHARS = 2_000;
const STACK_MAX_CHARS = 20_000;
const REPORTED_MESSAGES_CAP = 50;
const SEND_ATTEMPTS_PER_MESSAGE = 3;

const sendAttemptsByMessage = new Map<string, number>();
const messagesAwaitingRetry = new Set<string>();

function canSendReport(message: string): boolean {
  const sendAttempts = sendAttemptsByMessage.get(message);
  if (sendAttempts === undefined) return sendAttemptsByMessage.size < REPORTED_MESSAGES_CAP;
  return messagesAwaitingRetry.has(message) && sendAttempts < SEND_ATTEMPTS_PER_MESSAGE;
}

export function reportScreenError(error: unknown): void {
  if (!(error instanceof Error) || isAxiosError(error)) return;
  const message = (error.message || error.name).slice(0, MESSAGE_MAX_CHARS);
  if (!canSendReport(message)) return;
  messagesAwaitingRetry.delete(message);
  sendAttemptsByMessage.set(message, (sendAttemptsByMessage.get(message) ?? 0) + 1);
  const stack = error.stack?.slice(0, STACK_MAX_CHARS);
  platformFailuresApi
    .recordScreenError({ message, ...(stack ? { stack } : {}), screen: window.location.pathname })
    .catch(() => {
      messagesAwaitingRetry.add(message);
    });
}

export function listenForScreenErrors(): () => void {
  const reportUncaughtError = (event: ErrorEvent) => {
    const isOwnScript = event.filename.startsWith(window.location.origin);
    if (isOwnScript) reportScreenError(event.error);
  };
  const reportUnhandledRejection = (event: PromiseRejectionEvent) => reportScreenError(event.reason);
  window.addEventListener("error", reportUncaughtError);
  window.addEventListener("unhandledrejection", reportUnhandledRejection);
  return () => {
    window.removeEventListener("error", reportUncaughtError);
    window.removeEventListener("unhandledrejection", reportUnhandledRejection);
  };
}

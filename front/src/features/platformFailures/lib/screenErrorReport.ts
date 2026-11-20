import * as React from "react";
import { isAxiosError } from "axios";
import { platformFailuresApi } from "../api";

const MESSAGE_MAX_CHARS = 2_000;
const STACK_MAX_CHARS = 20_000;
const REPORTED_MESSAGES_CAP = 50;

const reportedMessages = new Set<string>();

export function reportScreenError(error: unknown): void {
  if (!(error instanceof Error) || isAxiosError(error)) return;
  const message = (error.message || error.name).slice(0, MESSAGE_MAX_CHARS);
  if (reportedMessages.has(message) || reportedMessages.size >= REPORTED_MESSAGES_CAP) return;
  reportedMessages.add(message);
  const stack = error.stack?.slice(0, STACK_MAX_CHARS);
  platformFailuresApi
    .recordScreenError({ message, ...(stack ? { stack } : {}), screen: window.location.pathname })
    // eslint-disable-next-line no-restricted-syntax -- melhor esforço: o erro já está na tela, e o relato que falha não pode virar outro erro a relatar
    .catch(() => undefined);
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

export function useScreenErrorReporting(): void {
  React.useEffect(() => listenForScreenErrors(), []);
}

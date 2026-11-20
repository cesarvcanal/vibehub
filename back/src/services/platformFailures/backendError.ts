import type { LogLine } from "../../utils/logger.js";
import { redactSecrets } from "../../utils/redactSecrets.js";
import type { PlatformFailureReport, UserStopMark } from "./types.js";

export const USER_STOP_WINDOW_MS = 10_000;
export const PLATFORM_FAILURE_LOG_MARK = { platformFailureLog: true } as const;
const WARN_LEVEL = 40;
const ERROR_LEVEL = 50;
const SOURCE_FILE_PATTERN = /([\w/.-]+?)\.[jt]s:\d+/;
const STACK_FRAMES_KEPT = 5;
export const SYMPTOM_MAX_CHARS = 200;

function decodePercentEscapes(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (escapedRun) => {
    try {
      return decodeURIComponent(escapedRun);
    } catch {
      return escapedRun;
    }
  });
}

function toStackPath(text: string): string {
  return decodePercentEscapes(text)
    .replace(/\\/g, "/")
    .replace(/file:\/\/\/(?=[A-Za-z]:\/)/g, "")
    .replace(/file:\/\//g, "")
    .replace(/(^|[\s(])\/([A-Za-z]:\/)/g, "$1$2");
}

export function readBackendSourceRoot(moduleUrl: string): string {
  return toStackPath(new URL("../../", moduleUrl).pathname);
}

const BACKEND_SOURCE_ROOT = readBackendSourceRoot(import.meta.url);

function readErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return "";
}

function toBackendFrame(stackLine: string, backendRoot: string): string | undefined {
  const frame = toStackPath(stackLine.trim());
  const rootAt = frame.indexOf(backendRoot);
  if (rootAt < 0) return undefined;
  return frame.slice(0, rootAt) + frame.slice(rootAt + backendRoot.length);
}

export function extractBackendFrames(err: unknown, backendRoot: string): string[] {
  if (!(err instanceof Error) || !err.stack) return [];
  return err.stack
    .split("\n")
    .map((stackLine) => toBackendFrame(stackLine, backendRoot))
    .filter((frame): frame is string => frame !== undefined)
    .slice(0, STACK_FRAMES_KEPT);
}

function readComponentOfFrame(frame: string | undefined): string | undefined {
  return frame?.match(SOURCE_FILE_PATTERN)?.[1];
}

function readTextField(fields: Record<string, unknown>, name: string): string | undefined {
  const value = fields[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function carriesCaughtError(fields: Record<string, unknown>): boolean {
  return fields.err !== undefined || readTextField(fields, "detail") !== undefined;
}

function isRightAfterUserStop(fields: Record<string, unknown>, lastUserStop: UserStopMark | undefined, now: number): boolean {
  if (lastUserStop === undefined || now - lastUserStop.at > USER_STOP_WINDOW_MS) return false;
  const loggedCardReference = readTextField(fields, "card");
  return loggedCardReference === undefined
    || loggedCardReference === lastUserStop.cardWorktreeSlug
    || loggedCardReference === lastUserStop.cardId;
}

export function isPlatformFailureLogLine(line: LogLine, lastUserStop: UserStopMark | undefined, now: number): boolean {
  if (line.fields.platformFailureLog === true) return false;
  const isErrorLevel = line.level >= ERROR_LEVEL;
  const isCaughtWarning = line.level >= WARN_LEVEL && carriesCaughtError(line.fields);
  if (!isErrorLevel && !isCaughtWarning) return false;
  return !isRightAfterUserStop(line.fields, lastUserStop, now);
}

export function buildBackendErrorReport(line: LogLine): PlatformFailureReport {
  const loggedErrorMessage = readErrorMessage(line.fields.err) || readTextField(line.fields, "detail") || "";
  const errorMessage = loggedErrorMessage === line.message ? "" : loggedErrorMessage;
  const backendFrames = extractBackendFrames(line.fields.err, BACKEND_SOURCE_ROOT);
  const symptom = redactSecrets([line.message, errorMessage].filter((part) => part !== "").join(": ")).slice(0, SYMPTOM_MAX_CHARS);
  const action = readTextField(line.fields, "action");
  const route = readTextField(line.fields, "route");
  const method = readTextField(line.fields, "method");
  const requestedRoute = route && method ? `${method} ${route}` : route;
  const evidenceLines = [
    `mensagem: ${line.message}`,
    ...(errorMessage ? [`erro: ${errorMessage}`] : []),
    ...(action ? [`ação: ${action}`] : []),
    ...(route ? [`rota: ${route}`] : []),
    ...backendFrames,
  ];
  return {
    source: "backend_error",
    component: readComponentOfFrame(backendFrames[0]) ?? requestedRoute ?? "backend",
    symptom,
    evidence: redactSecrets(evidenceLines.join("\n")),
  };
}

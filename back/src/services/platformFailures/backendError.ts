import type { LogLine } from "../../utils/logger.js";
import { redactSecrets } from "../../utils/redactSecrets.js";
import type { PlatformFailureReport, UserStopMark } from "./types.js";

export const USER_STOP_WINDOW_MS = 10_000;
const SOURCE_FILE_PATTERN = /([\w/.-]+?)\.[jt]s:\d+/;
const STACK_FRAMES_KEPT = 5;
const SYMPTOM_MAX_CHARS = 200;

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

export function backendSourceRootOf(moduleUrl: string): string {
  return toStackPath(new URL("../../", moduleUrl).pathname);
}

const BACKEND_SOURCE_ROOT = backendSourceRootOf(import.meta.url);

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

export function backendFramesOf(err: unknown, backendRoot: string): string[] {
  if (!(err instanceof Error) || !err.stack) return [];
  return err.stack
    .split("\n")
    .map((stackLine) => toBackendFrame(stackLine, backendRoot))
    .filter((frame): frame is string => frame !== undefined)
    .slice(0, STACK_FRAMES_KEPT);
}

function componentOfFrame(frame: string | undefined): string | undefined {
  return frame?.match(SOURCE_FILE_PATTERN)?.[1];
}

function readTextField(fields: Record<string, unknown>, name: string): string | undefined {
  const value = fields[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function reportFromBackendError(line: LogLine, lastUserStop: UserStopMark | undefined, now: number): PlatformFailureReport {
  const loggedErrorMessage = readErrorMessage(line.fields.err) || readTextField(line.fields, "detail") || "";
  const errorMessage = loggedErrorMessage === line.message ? "" : loggedErrorMessage;
  const backendFrames = backendFramesOf(line.fields.err, BACKEND_SOURCE_ROOT);
  const loggedCardLabel = readTextField(line.fields, "card");
  const isWithinStopWindow = lastUserStop !== undefined && now - lastUserStop.at <= USER_STOP_WINDOW_MS;
  const isFromStoppedCard = isWithinStopWindow && loggedCardLabel === lastUserStop.cardLabel;
  const isMarkedAfterStop = isWithinStopWindow && (loggedCardLabel === undefined || isFromStoppedCard);
  const baseSymptom = [line.message, errorMessage].filter((part) => part !== "").join(": ");
  const symptom = redactSecrets(isMarkedAfterStop ? `logo após um stop do usuário: ${baseSymptom}` : baseSymptom).slice(0, SYMPTOM_MAX_CHARS);
  const action = readTextField(line.fields, "action");
  const route = readTextField(line.fields, "route");
  const evidenceLines = [
    `mensagem: ${line.message}`,
    ...(errorMessage ? [`erro: ${errorMessage}`] : []),
    ...(action ? [`ação: ${action}`] : []),
    ...(route ? [`rota: ${route}`] : []),
    ...backendFrames,
  ];
  return {
    source: "backend_error",
    component: componentOfFrame(backendFrames[0]) ?? "backend",
    symptom,
    evidence: redactSecrets(evidenceLines.join("\n")),
    ...(isFromStoppedCard ? { cardId: lastUserStop.cardId } : {}),
  };
}

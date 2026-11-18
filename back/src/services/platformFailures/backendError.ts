import type { LogLine } from "../../utils/logger.js";
import { redactSecrets } from "../../utils/redactSecrets.js";
import type { PlatformFailureReport, UserStopMark } from "./types.js";

export const USER_STOP_WINDOW_MS = 10_000;
const VIBEHUB_FRAME_PATTERN = /[\\/]back[\\/](?:src|dist)[\\/]([\w/\\.-]+?)\.[jt]s:\d+/;
const STACK_FRAMES_KEPT = 5;
const SYMPTOM_MAX_CHARS = 200;

function readErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return "";
}

function readVibehubFrames(err: unknown): string[] {
  if (!(err instanceof Error) || !err.stack) return [];
  return err.stack
    .split("\n")
    .filter((frame) => VIBEHUB_FRAME_PATTERN.test(frame))
    .slice(0, STACK_FRAMES_KEPT)
    .map((frame) => frame.trim());
}

function componentOfFrame(frame: string | undefined): string | undefined {
  return frame?.match(VIBEHUB_FRAME_PATTERN)?.[1]?.replace(/\\/g, "/");
}

function readTextField(fields: Record<string, unknown>, name: string): string | undefined {
  const value = fields[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function reportFromBackendError(line: LogLine, lastUserStop: UserStopMark | undefined, now: number): PlatformFailureReport {
  const errorMessage = readErrorMessage(line.fields.err) || readTextField(line.fields, "detail") || "";
  const vibehubFrames = readVibehubFrames(line.fields.err);
  const stoppedByUser = lastUserStop !== undefined && now - lastUserStop.at <= USER_STOP_WINDOW_MS;
  const baseSymptom = [line.message, errorMessage].filter((part) => part !== "").join(": ");
  const symptom = redactSecrets(stoppedByUser ? `ao interromper: ${baseSymptom}` : baseSymptom).slice(0, SYMPTOM_MAX_CHARS);
  const action = readTextField(line.fields, "action");
  const route = readTextField(line.fields, "route");
  const card = readTextField(line.fields, "card");
  const evidenceLines = [
    `mensagem: ${line.message}`,
    ...(errorMessage ? [`erro: ${errorMessage}`] : []),
    ...(action ? [`ação: ${action}`] : []),
    ...(route ? [`rota: ${route}`] : []),
    ...(card ? [`card: ${card}`] : []),
    ...vibehubFrames,
  ];
  return {
    source: "backend_error",
    component: componentOfFrame(vibehubFrames[0]) ?? "backend",
    symptom,
    evidence: redactSecrets(evidenceLines.join("\n")),
    ...(stoppedByUser ? { cardId: lastUserStop.cardId } : {}),
  };
}

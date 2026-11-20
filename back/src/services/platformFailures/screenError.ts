import { redactSecrets } from "../../utils/redactSecrets.js";
import { SYMPTOM_MAX_CHARS } from "./backendError.js";
import { recordPlatformFailure } from "./platformFailures.js";
import type { PlatformFailureReport } from "./types.js";

const MESSAGE_MAX_CHARS = 2_000;
const SCREEN_MAX_CHARS = 500;
const STACK_MAX_CHARS = 20_000;
const STACK_LINES_KEPT = 6;

export class InvalidScreenErrorReport extends Error {}

interface ScreenErrorReport {
  message: string;
  screen: string;
  stack?: string;
}

function readBoundedText(fields: Record<string, unknown>, field: string, maxChars: number): string {
  const value = fields[field];
  if (typeof value !== "string" || value === "") throw new InvalidScreenErrorReport(`${field} must be a non-empty string`);
  if (value.length > maxChars) throw new InvalidScreenErrorReport(`${field} is longer than ${maxChars} characters`);
  return value;
}

export function parseScreenErrorReport(body: unknown): ScreenErrorReport {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new InvalidScreenErrorReport("the body must be an object");
  const fields = body as Record<string, unknown>;
  const message = readBoundedText(fields, "message", MESSAGE_MAX_CHARS);
  const screen = readBoundedText(fields, "screen", SCREEN_MAX_CHARS);
  if (fields.stack === undefined) return { message, screen };
  return { message, screen, stack: readBoundedText(fields, "stack", STACK_MAX_CHARS) };
}

export async function recordScreenError(screenError: ScreenErrorReport): Promise<boolean> {
  const stackLines = screenError.stack?.split("\n").slice(0, STACK_LINES_KEPT) ?? [];
  const report: PlatformFailureReport = {
    source: "screen_error",
    component: "front",
    symptom: redactSecrets(screenError.message).slice(0, SYMPTOM_MAX_CHARS),
    evidence: redactSecrets([`tela: ${screenError.screen}`, `mensagem: ${screenError.message}`, ...stackLines].join("\n")),
  };
  return (await recordPlatformFailure(report)) !== null;
}

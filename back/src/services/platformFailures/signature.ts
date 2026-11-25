import type { PlatformFailureReport } from "./types.js";

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX_PATTERN = /\b[0-9a-f]{12,}\b/gi;
const COLON_SEPARATED_HEX_ID_PATTERN = /\b[0-9a-f]+(?::[0-9a-f]+){3,}\b/gi;
const PATH_PATTERN = /(?:[A-Za-z]:)?(?:[\\/][\w.@-]+){2,}/g;
const NUMBER_PATTERN = /\d+/g;

export function normalizeFailureMessage(message: string): string {
  return message
    .replace(UUID_PATTERN, "<id>")
    .replace(COLON_SEPARATED_HEX_ID_PATTERN, "<id>")
    .replace(LONG_HEX_PATTERN, "<hex>")
    .replace(PATH_PATTERN, "<path>")
    .replace(NUMBER_PATTERN, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function buildFailureSignature(report: Pick<PlatformFailureReport, "source" | "component" | "symptom">): string {
  return [report.source, report.component, normalizeFailureMessage(report.symptom)].join("|");
}

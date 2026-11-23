import { getLanguage } from "@/i18n";

const FAILURE_TIME_ZONE = "America/Sao_Paulo";

export function formatFailureInstant(at: number): string {
  return new Intl.DateTimeFormat(getLanguage(), { dateStyle: "short", timeStyle: "short", timeZone: FAILURE_TIME_ZONE }).format(new Date(at));
}

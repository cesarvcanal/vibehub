/**
 * Defensive reading of JSON that comes from another process: the output of the probes that run in
 * the container (detail, workflowProbe) and the driver's frames (toolResult). It may come truncated
 * or with docker warnings before it, so each field is checked for its type before being used. PURE.
 */

export type Fields = Record<string, unknown>;

export function asFields(value: unknown): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : null;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** An instant in ms: a finite, positive number, or nothing. */
export function asInstant(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The last line of the output as JSON — docker may print warnings before it. */
export function lastJsonLine(stdout: string): unknown {
  const text = String(stdout ?? "").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
  } catch {
    return undefined;
  }
}

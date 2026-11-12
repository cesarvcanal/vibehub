/**
 * Leitura defensiva do JSON que vem de outro processo: a saída dos probes que rodam no container
 * (detail, workflowProbe) e os frames do driver (toolResult). Pode vir truncado ou com avisos do
 * docker antes, então cada campo é conferido no tipo antes de ser usado. PURE.
 */

export type Fields = Record<string, unknown>;

export function asFields(value: unknown): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : null;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Um instante em ms: número finito e positivo, ou nada. */
export function asInstant(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A última linha da saída como JSON — o docker pode imprimir avisos antes dela. */
export function lastJsonLine(stdout: string): unknown {
  const text = String(stdout ?? "").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
  } catch {
    return undefined;
  }
}

/**
 * O AVISO DE LIMITE DO PLANO, ao vivo — o "You've used 91% of your session limit" que o Claude Code
 * pinta no rodapé do terminal. O CLI emite um `rate_limit_event` sempre que a leitura de uma janela
 * muda (sessão de 5h, semana, semana do modelo forte), e o driver repassa como `rate_limit`.
 *
 * Normalizado AQUI, no lado que fala com o navegador: no evento do CLI `utilization` é FRAÇÃO (0..1,
 * ele mesmo multiplica por 100 ao escrever) e `resetsAt` é epoch em SEGUNDOS (vem do cabeçalho da
 * API). A tela recebe sempre percentual 0..100 e epoch em ms — a mesma unidade de `usage.ts`.
 */

export type RateLimitStatus = "allowed" | "allowed_warning" | "rejected";

export interface RateLimitInfo {
  status: RateLimitStatus;
  /** A janela: `five_hour`, `seven_day`, `seven_day_opus`, … — texto livre, a tela traduz as que conhece. */
  window: string;
  /** 0..100, quando o CLI disse. */
  utilization?: number;
  /** Epoch em ms em que a janela renova, quando o CLI disse. */
  resetsAt?: number;
}

export interface RateLimitEvent extends RateLimitInfo { type: "rate_limit" }

const STATUSES = new Set<RateLimitStatus>(["allowed", "allowed_warning", "rejected"]);

/** Fração (0..1) ou percentual (>1) → 0..100. PURE. */
function toPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const pct = value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, pct));
}

/** Epoch em segundos ou ms → ms. PURE. */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

/**
 * O que chegou do driver (ou o `rate_limit_info` cru do CLI) como `RateLimitInfo`, ou null quando
 * não dá para dizer nada (status desconhecido, sem janela). PURE.
 */
export function normalizeRateLimit(raw: unknown): RateLimitInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const status = o.status;
  if (typeof status !== "string" || !STATUSES.has(status as RateLimitStatus)) return null;
  const windowRaw = typeof o.window === "string" ? o.window : o.rateLimitType;
  const window = typeof windowRaw === "string" && windowRaw.trim() ? windowRaw.trim().slice(0, 64) : "";
  if (!window) return null;
  const utilization = toPercent(o.utilization);
  const resetsAt = toEpochMs(o.resetsAt);
  return {
    status: status as RateLimitStatus,
    window,
    ...(utilization !== undefined ? { utilization } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

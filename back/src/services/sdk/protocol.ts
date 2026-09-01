/**
 * SDK DRIVER PROTOCOL — the pure contract shared by the driver process (runs in the runner) and the
 * back service that bridges it. The driver writes NEWLINE-DELIMITED JSON on stdout; the back parses
 * each line into a `DriverEvent` and relays it to the front over the `/api/cards/:id/sdk` websocket.
 *
 * Nothing here has side effects — it is types, a line parser, and the permission classifier. The
 * driver embeds a COPY of `classifySensitivity`/`sdkPermissionDecision` (an .mjs cannot import from
 * the compiled back), so this file is the CANONICAL spec and the unit-tested source of truth; keep
 * `sdk-driver.mjs`'s inline copy in step with it.
 */

/* ------------------------------------------------------------------ events */

/** A block of assistant text (consolidated, from an `assistant` message). */
export interface AssistantTextEvent { type: "assistant_text"; text: string }
/** A live text delta (only when the driver runs with partial messages on). */
export interface AssistantDeltaEvent { type: "assistant_delta"; text: string }
/** A tool call the agent is about to run (or ran). */
export interface ToolUseEvent { type: "tool_use"; id: string; name: string; input: unknown }
/** The session id — emitted as soon as the driver learns it, and again on the result. */
export interface SessionEvent { type: "session"; sessionId: string }
/** A permission decision the driver's PreToolUse gate made (observability + the escalation's outcome). */
export interface PermissionEvent {
  type: "permission";
  tool: string;
  decision: "allow" | "deny";
  sensitive: boolean;
  reason?: string;
  /** Present when the decision answers a `permission_request` (the same id), so the front can pair them. */
  id?: string;
  /** True when the deny happened because nobody answered within the timeout. */
  timedOut?: boolean;
}
/**
 * A SENSITIVE tool call is waiting for the human: the driver pauses the agent (the PreToolUse hook
 * awaits) until a `permission_decision` control with this `id` arrives on stdin — or the timeout
 * (PERMISSION_TIMEOUT_MS) denies it. The front renders this as the "Permitir / Negar" card.
 */
export interface PermissionRequestEvent {
  type: "permission_request";
  id: string;
  tool: string;
  input?: unknown;
  reason?: string;
}
/** End of a turn. */
export interface ResultEvent {
  type: "result";
  subtype?: string;
  isError: boolean;
  sessionId?: string;
  result?: string;
  permissionDenials?: unknown[];
}
/** The driver is up and ready to accept the first user message. The back stamps `turnActive` on
 *  every `ready` it sends (real or synthesized on reattach) with the manager's live turn count, so
 *  a view mounting mid-turn knows work is running (card prompt-56fc: Terminal↔Chat during a turn
 *  remounted the view and the "Trabalhando…" spinner never lit). */
export interface ReadyEvent { type: "ready"; resume?: string; turnActive?: boolean }
/** The driver hit an error (SDK threw, auth missing, etc.). */
export interface DriverErrorEvent { type: "error"; message: string }
/** A line that was NOT valid JSON, or an unknown event — surfaced rather than swallowed. */
export interface ParseErrorEvent { type: "parse_error"; raw: string }

export type DriverEvent =
  | AssistantTextEvent
  | AssistantDeltaEvent
  | ToolUseEvent
  | SessionEvent
  | PermissionEvent
  | PermissionRequestEvent
  | ResultEvent
  | ReadyEvent
  | DriverErrorEvent
  | ParseErrorEvent;

/** The event `type` values the driver is allowed to emit (parse_error is synthesised by the back). */
const DRIVER_EVENT_TYPES = new Set([
  "assistant_text",
  "assistant_delta",
  "tool_use",
  "session",
  "permission",
  "permission_request",
  "result",
  "ready",
  "error",
]);

/**
 * Parse ONE stdout line from the driver into a `DriverEvent`. A blank line yields null (skip it); a
 * line that is not valid JSON, or whose `type` the back does not recognise, becomes a
 * `parse_error` so nothing is silently dropped. PURE.
 */
export function parseDriverLine(line: string): DriverEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { type: "parse_error", raw: trimmed };
  }
  if (typeof parsed !== "object" || parsed === null) return { type: "parse_error", raw: trimmed };
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || !DRIVER_EVENT_TYPES.has(type)) return { type: "parse_error", raw: trimmed };
  return parsed as DriverEvent;
}

/* ------------------------------------------------------- control (stdin) */

/** A message the front sends TO the driver over stdin (one JSON object per line). */
export interface UserControl { type: "user"; text: string }
export interface InterruptControl { type: "interrupt" }
/** The human's answer to a `permission_request` — `id` pairs it with the awaiting call. */
export interface PermissionDecisionControl { type: "permission_decision"; id: string; allow: boolean }
export type DriverControl = UserControl | InterruptControl | PermissionDecisionControl;

/** Serialise a control message as one stdin line (with the trailing newline). PURE. */
export function encodeControl(control: DriverControl): string {
  return JSON.stringify(control) + "\n";
}

/** Interpret a browser frame as a driver control message. A bare string = a user message. PURE. */
export function parseSdkClientFrame(raw: string): DriverControl | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; text?: unknown; id?: unknown; allow?: unknown };
      if (parsed.type === "interrupt") return { type: "interrupt" };
      if (parsed.type === "user" && typeof parsed.text === "string") return { type: "user", text: parsed.text };
      if (parsed.type === "permission_decision" && typeof parsed.id === "string" && typeof parsed.allow === "boolean") {
        return { type: "permission_decision", id: parsed.id, allow: parsed.allow };
      }
      return null;
    } catch {
      // not JSON — fall through and treat as a bare user message
    }
  }
  return { type: "user", text: raw };
}

/* ------------------------------------------------------ permission gate */

/**
 * The SENSITIVE set — actions this increment REFUSES to auto-run because a mistake is destructive or
 * exfiltrating. Matched against a Bash command string (the only tool whose payload is a shell line).
 *
 * Increment 2: each of these ESCALATES to a "Permitir / Negar" card in the chat — the driver's
 * PreToolUse hook emits a `permission_request` and AWAITS the human's `permission_decision` (see
 * `createPermissionBroker`); the timeout denies. The bulk of tools auto-allow (bypass sandbox) —
 * César's call: "libera tudo, pergunta só o sensível".
 */
export const SENSITIVE_BASH_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i, // rm -r / rm -f / rm -rf (recursive or forced delete)
  /\bgit\s+push\b.*(--force|-f\b)/i, // force-push (history rewrite)
  /\bgit\s+push\b.*\+/i, // git push origin +branch (forced refspec)
  /\bgit\s+reset\s+--hard\b/i, // discards work
  /\b(kubectl|helm|docker|systemctl|serverless|sls|vercel|netlify|fly|flyctl|heroku)\b.*\b(deploy|apply|rollout|up|delete|destroy|down|prune)\b/i,
  /\bnpm\s+publish\b/i,
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, // curl | sh (remote code exec)
  /(^|[^\w])(cat|less|head|tail|grep|printenv|env)\b[^\n]*(\.env|id_rsa|id_ed25519|credentials|secret|\.oauth-token|\.vibehub-token)/i,
] as const;

/** Tools whose raw name is sensitive regardless of input (destructive/deploy-shaped, no shell line). */
export const SENSITIVE_TOOLS: readonly string[] = ["KillShell"] as const;

/**
 * Is this tool call in the SENSITIVE set? Reads `input.command` for Bash-like tools. PURE.
 */
export function classifySensitivity(toolName: string, input: unknown): boolean {
  if (SENSITIVE_TOOLS.includes(toolName)) return true;
  const command =
    input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
      ? (input as { command: string }).command
      : "";
  if (command === "") return false;
  return SENSITIVE_BASH_PATTERNS.some((re) => re.test(command));
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  sensitive: boolean;
  reason?: string;
}

/**
 * The gate the driver's PreToolUse hook applies under `bypassPermissions`. Increment 1 policy:
 * auto-allow the bulk, DENY the sensitive set (rm -rf / push --force / deploy / secret reads). PURE.
 *
 * Returns `sensitive` alongside the behaviour so the driver can emit a `permission` event even for
 * the allowed calls if it ever wants to — and so increment 2 can turn the `deny` into an escalation
 * without re-deriving the classification.
 */
export function sdkPermissionDecision(toolName: string, input: unknown): PermissionDecision {
  const sensitive = classifySensitivity(toolName, input);
  if (sensitive) {
    return {
      behavior: "deny",
      sensitive: true,
      reason: `vibehub SDK driver blocked a sensitive action (${toolName}). Increment 1 denies rm -rf / force-push / deploy / secret-reads pending the chat permission button.`,
    };
  }
  return { behavior: "allow", sensitive: false };
}

/* -------------------------------------------------------- gate modes */

/**
 * How the driver's PreToolUse gate behaves — the `sdkPermissionMode` install setting, carried to the
 * driver as `--permission-gate`:
 *
 * - `"same-as-terminal"` — the native chat mirrors the permission behaviour the Terminal tab of the
 *   same card already has (the runner's own Claude settings decide; no extra vibehub gate on top).
 *   The hook only emits observability `permission` events. One card, two views, one permission
 *   story — the install owner's product decision (2026-08-31).
 * - `"ask-sensitive"` — the SENSITIVE set escalates to Permitir/Negar buttons in the chat and the
 *   agent waits for the click. Kept for less-trusted chats (shared members).
 */
export type SdkPermissionGateMode = "same-as-terminal" | "ask-sensitive";

/** Parse the `--permission-gate` argv value. Anything unrecognised falls back to the STRICTER mode. PURE. */
export function parseGateMode(raw: unknown): SdkPermissionGateMode {
  return raw === "same-as-terminal" ? "same-as-terminal" : "ask-sensitive";
}

/**
 * What the PreToolUse hook should DO with one tool call under a gate mode. PURE — the driver embeds
 * a mirror copy (see the file header); keep `sdk-driver.mjs` in step.
 */
export function sdkGateAction(
  mode: SdkPermissionGateMode,
  toolName: string,
  input: unknown,
): { action: "allow" | "escalate"; sensitive: boolean } {
  const sensitive = classifySensitivity(toolName, input);
  if (mode === "same-as-terminal") return { action: "allow", sensitive };
  return { action: sensitive ? "escalate" : "allow", sensitive };
}

/* ------------------------------------------------- permission escalation */

/**
 * How long a `permission_request` waits for the human before it is DENIED. Five minutes: long
 * enough to grab the phone and answer, short enough that a forgotten card does not hold the
 * agent's loop hostage forever (the PreToolUse hook AWAITS this).
 */
export const PERMISSION_TIMEOUT_MS = 5 * 60_000;

export interface PermissionWaitResult {
  allow: boolean;
  /** True when nobody answered in time (the deny was the clock's, not the human's). */
  timedOut: boolean;
}

export interface PermissionBroker {
  /** Await the human's decision for `id`. Resolves with a deny when the timeout fires first. */
  wait(id: string): Promise<PermissionWaitResult>;
  /** Deliver a decision. Returns false when nothing was waiting under that id (late click, typo). */
  resolve(id: string, allow: boolean): boolean;
  /** How many requests are still waiting (observability + tests). */
  pendingCount(): number;
}

/**
 * The pending-permission ledger the driver keeps between "emitted a permission_request" and "the
 * stdin brought a permission_decision". PURE apart from the injected clock (`setTimeout`), which is
 * what makes the timeout testable. The driver embeds a MIRROR copy (see the file header) — keep
 * them in step.
 */
export function createPermissionBroker(timeoutMs: number = PERMISSION_TIMEOUT_MS): PermissionBroker {
  const pending = new Map<string, (result: PermissionWaitResult) => void>();
  return {
    wait(id: string): Promise<PermissionWaitResult> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ allow: false, timedOut: true });
        }, timeoutMs);
        pending.set(id, (result) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(result);
        });
      });
    },
    resolve(id: string, allow: boolean): boolean {
      const deliver = pending.get(id);
      if (!deliver) return false;
      deliver({ allow, timedOut: false });
      return true;
    },
    pendingCount(): number {
      return pending.size;
    },
  };
}

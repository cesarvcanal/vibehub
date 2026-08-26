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
/** A permission decision the driver's PreToolUse gate made (observability + future escalation). */
export interface PermissionEvent {
  type: "permission";
  tool: string;
  decision: "allow" | "deny";
  sensitive: boolean;
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
/** The driver is up and ready to accept the first user message. */
export interface ReadyEvent { type: "ready"; resume?: string }
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
export type DriverControl = UserControl | InterruptControl;

/** Serialise a control message as one stdin line (with the trailing newline). PURE. */
export function encodeControl(control: DriverControl): string {
  return JSON.stringify(control) + "\n";
}

/* ------------------------------------------------------ permission gate */

/**
 * The SENSITIVE set — actions this increment REFUSES to auto-run because a mistake is destructive or
 * exfiltrating. Matched against a Bash command string (the only tool whose payload is a shell line).
 *
 * TODO(increment 2): instead of denying, ESCALATE each of these to a "Permitir / Negar" button in
 * the chat (the `canUseTool`/PreToolUse callback awaits the human's click). Until that UI exists the
 * safe behaviour for an experimental, opt-in driver is to DENY — the agent is told it was blocked and
 * carries on, exactly as the PoC's scenario E proved. The bulk of tools auto-allow (bypass sandbox).
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

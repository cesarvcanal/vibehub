/**
 * Optimistic local echo — painting a keystroke before the server has confirmed it.
 *
 * ## Why this is not a naive echo
 *
 * The thing on the other end of the socket is Claude Code: an ink TUI that REPAINTS THE WHOLE
 * SCREEN on every keystroke, not a cooked-mode shell that echoes one character back. Writing the
 * character locally and leaving it there fights the repaint — at best the repaint lands on top and
 * agrees, at worst the prediction sits in the wrong place for a frame and flickers.
 *
 * So the predictor is deliberately conservative, and it only opens its mouth when the server has
 * gone QUIET:
 *
 *  - only a SINGLE PRINTABLE character is predictable — never Enter, Tab, a control code, a
 *    backspace, an arrow key or a paste (those arrive as multi-character strings);
 *  - only while the server has said nothing for `quietMs`, which is exactly the state that matters:
 *    the agent is WORKING, the TUI is silent, and the round trip is the only thing between you and
 *    seeing your own typing;
 *  - every prediction is RECONCILED the instant any byte arrives from the server — erased before
 *    that byte is written, because the server's repaint is the truth and the prediction never was.
 *
 * What it does NOT model is a cursor or a scroll region (mosh does; this does not). Wrapping at the
 * right margin mid-prediction, wide characters (CJK, emoji) and editing in the middle of a line can
 * therefore drift for a frame. That is the price of the erase sequence below being one line long,
 * and it is why `enabled` exists.
 *
 * Everything here is pure or trivially fakeable, so the rules are tests rather than a screenshot.
 */

/** ON by default: the quiet-server guard is what makes this safe, not the flag. */
export const LOCAL_ECHO_ENABLED = true;

/** How long the server must have been silent before a keystroke is worth predicting. */
export const LOCAL_ECHO_QUIET_MS = 80;

/**
 * Is this keystroke predictable at all? PURE.
 *
 * Exactly one printable character. Everything else changes the flow rather than echoing: Enter
 * (`\r`), Tab, any C0 control, DEL/backspace (`\x7f`), and every escape sequence — arrows and
 * function keys reach us as multi-character strings such as `\x1b[A`, so the length check catches
 * them and pastes in one go.
 */
export function isPredictableKey(data: string): boolean {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

export interface PredictGuard {
  /** The feature flag, as the caller resolved it. */
  enabled: boolean;
  /** Milliseconds since the last byte from the server (a repaint burst keeps this near zero). */
  msSinceServerOutput: number;
  /** Minimum silence to risk a prediction. */
  quietMs?: number;
}

/** The whole decision in one pure function: the flag, the key, and the quiet window. */
export function shouldPredict(data: string, guard: PredictGuard): boolean {
  if (!guard.enabled) return false;
  if (!isPredictableKey(data)) return false;
  return guard.msSinceServerOutput >= (guard.quietMs ?? LOCAL_ECHO_QUIET_MS);
}

/**
 * The sequence that unwrites `n` predicted characters written contiguously at the end of the line:
 * step back `n` columns and clear to end of line. PURE; `n <= 0` erases nothing.
 *
 * This is only correct while the predictions sit at the end of the prompt with nothing to their
 * right — the documented limit at the top of this file.
 */
export function predictionEraseSequence(n: number): string {
  if (n <= 0) return "";
  return "\b".repeat(n) + "\x1b[K";
}

/** The sliver of xterm the echo touches, so a test can hand it an array. */
export interface EchoWriter {
  write(data: string): void;
}

export interface LocalEchoOptions {
  term: EchoWriter;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  quietMs?: number;
  /** Set false and every prediction is declined — the terminal behaves exactly as it always did. */
  enabled?: boolean;
}

/**
 * The predictor itself.
 *
 * Three calls make up the contract:
 *  - `key(data)` — before sending the keystroke to the socket. Returns whether it painted anything.
 *    The caller ALWAYS sends the key regardless: the prediction is purely visual.
 *  - `serverOutput()` — before writing the server's bytes to the terminal. Erases what is pending
 *    and restarts the quiet window.
 *  - `reset()` — on a reattach, so a stale prediction count cannot outlive its session.
 */
export class LocalEcho {
  private readonly term: EchoWriter;
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly enabled: boolean;
  private pending = 0;
  private lastServerAt: number;

  constructor(options: LocalEchoOptions) {
    this.term = options.term;
    this.now = options.now ?? (() => Date.now());
    this.quietMs = options.quietMs ?? LOCAL_ECHO_QUIET_MS;
    this.enabled = options.enabled ?? LOCAL_ECHO_ENABLED;
    // The session opens with the TUI painting its prompt, so start NOT quiet: nothing is predicted
    // until the screen has actually settled.
    this.lastServerAt = this.now();
  }

  /** Predictions painted and not yet reconciled. */
  get pendingCount(): number {
    return this.pending;
  }

  key(data: string): boolean {
    const ok = shouldPredict(data, {
      enabled: this.enabled,
      msSinceServerOutput: this.now() - this.lastServerAt,
      quietMs: this.quietMs,
    });
    if (!ok) return false;
    this.term.write(data);
    this.pending += 1;
    return true;
  }

  /** Reconcile: unwrite the predictions, then let the caller write the server's truth on top. */
  serverOutput(): void {
    if (this.pending > 0) {
      this.term.write(predictionEraseSequence(this.pending));
      this.pending = 0;
    }
    this.lastServerAt = this.now();
  }

  reset(): void {
    this.pending = 0;
    this.lastServerAt = this.now();
  }
}

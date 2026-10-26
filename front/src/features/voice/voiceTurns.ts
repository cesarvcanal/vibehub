/**
 * GPT-Live's transcript arrives as FRAGMENTS — audio cadence, not turns, and the person's and the
 * assistant's may interleave (barge-in). The chat needs TURNS: one bubble per thing said, saved
 * once. This settles fragments into turns:
 *
 * - one side speaking CLOSES the other side's open turn: the reply starting means the person's
 *   sentence is done (saved at once), and the person talking over the reply (barge-in) closes the
 *   reply where it was cut;
 * - a fragment extends its side's open turn unless the speaker paused for longer than
 *   {@link TURN_GAP_MS} (measured on the model's timeline when it sends `start_ms`/`end_ms`, else on
 *   the wall clock) — then the old turn closes and a new one starts;
 * - an open turn closes after {@link TURN_IDLE_MS} without fragments, or when the call ends;
 * - every turn has a stable id (`vid`) from the moment it opens: the bubble keeps its place while it
 *   grows, and the server saves it idempotently.
 */

export type VoiceRole = "user" | "assistant";

export interface VoiceTurn {
  vid: string;
  role: VoiceRole;
  text: string;
  /** When the turn started (epoch ms) — orders it in the chat. */
  at: number;
  /** Closed: no more text will land on it. */
  final: boolean;
}

export const TURN_GAP_MS = 1_500;
export const TURN_IDLE_MS = 2_500;

interface Open {
  turn: VoiceTurn;
  lastWallAt: number;
  lastEndMs: number | null;
}

let callSeq = 0;

/** A fresh call id: random enough to never collide across tabs, short enough for a vid. */
export function newCallId(): string {
  callSeq += 1;
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `vc${rand}${callSeq.toString(36)}`;
}

export class TurnSegmenter {
  private seq = 0;
  private readonly open: Partial<Record<VoiceRole, Open>> = {};
  /** Every turn of the call, in the order they started. */
  readonly turns: VoiceTurn[] = [];

  constructor(private readonly callId: string) {}

  /**
   * One fragment. Returns the turns that CLOSED because of it (a pause long enough opened a new
   * one) — the caller saves those.
   */
  push(role: VoiceRole, delta: string, now: number, startMs?: number, endMs?: number): VoiceTurn[] {
    if (!delta) return [];
    const closed: VoiceTurn[] = [];
    const other = role === "user" ? "assistant" : "user";
    if (this.open[other]) closed.push(this.close(other));
    const cur = this.open[role];
    if (cur) {
      const gap =
        typeof startMs === "number" && cur.lastEndMs !== null ? startMs - cur.lastEndMs : now - cur.lastWallAt;
      if (gap > TURN_GAP_MS) closed.push(this.close(role));
    }
    const open = this.open[role];
    if (open) {
      open.lastWallAt = now;
      if (typeof endMs === "number") open.lastEndMs = endMs;
      this.replace({ ...open.turn, text: open.turn.text + delta });
    } else {
      this.seq += 1;
      const turn: VoiceTurn = { vid: `${this.callId}-${role === "user" ? "u" : "a"}${this.seq}`, role, text: delta, at: now, final: false };
      this.open[role] = { turn, lastWallAt: now, lastEndMs: typeof endMs === "number" ? endMs : null };
      this.turns.push(turn);
    }
    return closed;
  }

  /** Closes turns idle for {@link TURN_IDLE_MS}. Returns them. */
  tick(now: number): VoiceTurn[] {
    const closed: VoiceTurn[] = [];
    for (const role of ["user", "assistant"] as const) {
      const cur = this.open[role];
      if (cur && now - cur.lastWallAt >= TURN_IDLE_MS) closed.push(this.close(role));
    }
    return closed;
  }

  /** The call ended: every open turn closes. */
  flush(): VoiceTurn[] {
    const closed: VoiceTurn[] = [];
    for (const role of ["user", "assistant"] as const) if (this.open[role]) closed.push(this.close(role));
    return closed;
  }

  private close(role: VoiceRole): VoiceTurn {
    const cur = this.open[role]!;
    const done = { ...cur.turn, final: true };
    this.replace(done);
    delete this.open[role];
    return done;
  }

  /** Turns are replaced, never mutated in place, so a snapshot holding an old one stays true. */
  private replace(turn: VoiceTurn): void {
    const i = this.turns.findIndex((t) => t.vid === turn.vid);
    if (i >= 0) this.turns[i] = turn;
    const cur = this.open[turn.role];
    if (cur && cur.turn.vid === turn.vid) cur.turn = turn;
  }
}

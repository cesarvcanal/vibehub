import type { LiveVoiceState } from "./liveVoice";
import type { LivingMode } from "./living/engine";

/**
 * WHAT THE CALL IS DOING, from real signals only: the session state, the model's transcript events
 * (it heard the person / it is speaking), the measured level of the assistant's audio and of the
 * microphone. One pure step function with a little memory, so the orb and the status line agree
 * and never flicker:
 *
 * - "thinking" (the living mark) only after the person stopped for {@link THINK_AFTER_MS} without an
 *   answer — never between two words — and only if they actually said something this turn;
 * - "ai_speaking" holds {@link AI_TAIL_MS} past the last sound, so the gaps between words do not
 *   flip the sphere back to pink;
 * - the person talking over the reply is "interrupted" (barge-in) for {@link INTERRUPT_MS}.
 */
export type VoicePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "user_speaking"
  | "thinking"
  | "ai_speaking"
  | "interrupted"
  | "muted"
  | "closing"
  | "error";

/** The person's speech "holds" this long past the last sign of it (between words); thinking starts after. */
export const USER_TAIL_MS = 700;
export const THINK_AFTER_MS = USER_TAIL_MS;
/** Waiting longer than this is not "thinking" any more: back to listening. */
export const THINK_MAX_MS = 12_000;
export const AI_TAIL_MS = 650;
export const INTERRUPT_MS = 900;
/** Visual intensity above which a source counts as "making sound now". */
export const SOUND_ON = 0.08;

export interface PhaseInput {
  state: LiveVoiceState;
  muted: boolean;
  now: number;
  /** The model transcribed the person / spoke (epoch ms of the last fragment). */
  lastInputAt: number | null;
  lastOutputAt: number | null;
  /** Visual intensity of the assistant's audio right now (0..1), whatever its source. */
  aiLevel: number;
  /** Visual intensity of the microphone right now (0..1); 0 while muted. */
  micLevel: number;
  /** The card's agent is working on something sent during the call (a typed message). */
  agentBusy?: boolean;
}

export interface PhaseMemory {
  phase: VoicePhase;
  since: number;
  /** The person said something since the assistant last spoke — an answer is owed. */
  turnOpen: boolean;
  userLastAt: number | null;
  aiLastAt: number | null;
}

export const INITIAL_PHASE: PhaseMemory = { phase: "idle", since: 0, turnOpen: false, userLastAt: null, aiLastAt: null };

function to(mem: PhaseMemory, phase: VoicePhase, now: number, patch: Partial<PhaseMemory> = {}): PhaseMemory {
  return { ...mem, ...patch, phase, since: mem.phase === phase ? mem.since : now };
}

/** One step. PURE. */
export function nextPhase(mem: PhaseMemory, input: PhaseInput): PhaseMemory {
  const { now } = input;
  switch (input.state) {
    case "idle":
      return mem.phase === "idle" ? mem : { ...INITIAL_PHASE, since: now };
    case "error":
      return to(mem, "error", now, { turnOpen: false });
    case "connecting":
      return to(mem, "connecting", now);
    case "closing":
      return to(mem, "closing", now);
    default:
      break;
  }

  const aiNow = input.aiLevel >= SOUND_ON || (input.lastOutputAt !== null && now - input.lastOutputAt < 400);
  const userNow =
    (!input.muted && input.micLevel >= SOUND_ON) || (input.lastInputAt !== null && now - input.lastInputAt < 400);
  const aiLastAt = aiNow ? now : mem.aiLastAt;
  const userLastAt = userNow ? now : mem.userLastAt;
  const aiRecent = aiLastAt !== null && now - aiLastAt < AI_TAIL_MS;
  const userRecent = userLastAt !== null && now - userLastAt < USER_TAIL_MS;
  const base = { aiLastAt, userLastAt };

  // Barge-in: the person speaks over a reply that is still sounding.
  if (userNow && (mem.phase === "ai_speaking" || (mem.phase === "interrupted" && now - mem.since < INTERRUPT_MS))) {
    return to(mem, "interrupted", now, { ...base, turnOpen: true });
  }
  if (mem.phase === "interrupted" && now - mem.since < INTERRUPT_MS) return { ...mem, ...base };

  if (aiRecent && !userNow) return to(mem, "ai_speaking", now, { ...base, turnOpen: false });
  if (userRecent && !input.muted) return to(mem, "user_speaking", now, { ...base, turnOpen: true });

  const quietFor = userLastAt === null ? Infinity : now - userLastAt;
  if (mem.turnOpen && quietFor >= THINK_AFTER_MS && quietFor < THINK_MAX_MS) return to(mem, "thinking", now, base);
  if (input.agentBusy) return to(mem, "thinking", now, { ...base, turnOpen: false });
  return to(mem, input.muted ? "muted" : "listening", now, { ...base, turnOpen: mem.turnOpen && quietFor < THINK_MAX_MS });
}

/** The orb for a phase: the living mark while connecting or thinking, pink while it listens, blue while it replies. PURE. */
export function phaseOrb(phase: VoicePhase): LivingMode {
  switch (phase) {
    case "listening":
    case "user_speaking":
    case "interrupted":
    case "muted":
      return "listen";
    case "ai_speaking":
      return "talk";
    default:
      return "logo";
  }
}

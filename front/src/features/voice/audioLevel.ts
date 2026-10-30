/**
 * SOUND → ORB. Two numbers, never confused:
 *
 * - the REAL volume: RMS of the signal (0..1) and its dBFS, measured with a Web Audio analyser on the
 *   stream itself — what the diagnostics and the lab show;
 * - the VISUAL intensity (0..1): that volume through a noise gate, a normalisation window
 *   (floor..ceiling in dB), a soft compression curve and an attack/release envelope — what the orb
 *   draws. Speech at a normal level fills most of it; a quiet room stays at zero.
 *
 * Calibrating the orb is tuning {@link LevelTuning}; the measurement never changes. Listened to,
 * never played and never recorded: the analyser is not connected to the destination.
 */

export interface LevelTuning {
  /** Below this the signal is room noise: visual 0. */
  gateDb: number;
  /** The window that maps to 0..1: `floorDb` → 0, `ceilDb` → 1. */
  floorDb: number;
  ceilDb: number;
  /** Soft compression: <1 lifts quiet syllables, keeps the loud ones from slamming the top. */
  curve: number;
  /** Envelope: how fast the orb follows a rise / lets go after a fall. */
  attackMs: number;
  releaseMs: number;
  /** Final multiplier, 0..2. */
  gain: number;
}

/** The person's microphone (after the browser's echo cancellation and gain control). */
export const MIC_TUNING: LevelTuning = { gateDb: -58, floorDb: -54, ceilDb: -18, curve: 0.75, attackMs: 30, releaseMs: 180, gain: 1 };
/**
 * The assistant's voice as it arrives on the WebRTC track: produced audio, steady level, no room
 * noise — a tighter window, and a faster envelope so syllables read as pulses.
 */
export const AI_TUNING: LevelTuning = { gateDb: -60, floorDb: -50, ceilDb: -16, curve: 0.7, attackMs: 18, releaseMs: 140, gain: 1 };

const MIN_RMS = 1e-6;

/** RMS (0..1) of float time-domain samples (-1..1). PURE. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

/** RMS → dBFS (−120 for silence). PURE. */
export function toDb(rms: number): number {
  return 20 * Math.log10(Math.max(MIN_RMS, rms));
}

/** The instantaneous visual intensity (0..1) of an RMS, before the envelope. PURE. */
export function visualLevel(rms: number, tuning: LevelTuning): number {
  const db = toDb(rms);
  if (db < tuning.gateDb) return 0;
  const span = Math.max(1, tuning.ceilDb - tuning.floorDb);
  const norm = Math.min(1, Math.max(0, (db - tuning.floorDb) / span));
  return Math.min(1, Math.pow(norm, tuning.curve) * tuning.gain);
}

/** One envelope step: `prev` moves toward `target` with the attack or release time. PURE. */
export function follow(prev: number, target: number, dtMs: number, tuning: LevelTuning): number {
  const tau = target > prev ? tuning.attackMs : tuning.releaseMs;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / Math.max(1, tau));
  return prev + (target - prev) * k;
}

export interface LevelReading {
  /** The REAL volume: RMS 0..1 and dBFS. */
  rms: number;
  db: number;
  /** What the orb draws, 0..1. */
  visual: number;
  /**
   * The analyser has returned exact digital zeros for this long (ms). Real silence still carries
   * dither and noise; a run of perfect zeros means the graph is not receiving the audio at all
   * (a suspended context, or a browser that does not route a remote WebRTC stream into Web Audio).
   */
  deadMs: number;
}

/**
 * Measures one MediaStream on a shared AudioContext. `read()` is called once per animation frame by
 * whoever draws; nothing here runs on its own timer.
 */
export class LevelMeter {
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private envelope = 0;
  private lastAt: number | null = null;
  private deadSince: number | null = null;
  private last: LevelReading = { rms: 0, db: -120, visual: 0, deadMs: 0 };

  constructor(ctx: AudioContext, stream: MediaStream, public tuning: LevelTuning) {
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.source.connect(this.analyser);
    this.buf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
  }

  read(now: number = performance.now()): LevelReading {
    // Several readers in one frame (orb + status) share one measurement.
    if (this.lastAt !== null && now - this.lastAt < 4) return this.last;
    this.analyser.getFloatTimeDomainData(this.buf);
    const rms = rmsOf(this.buf);
    let allZero = true;
    for (let i = 0; i < this.buf.length; i++) {
      if (this.buf[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) this.deadSince ??= now;
    else this.deadSince = null;
    const dt = this.lastAt === null ? 16 : now - this.lastAt;
    this.lastAt = now;
    this.envelope = follow(this.envelope, visualLevel(rms, this.tuning), dt, this.tuning);
    this.last = { rms, db: toDb(rms), visual: this.envelope, deadMs: this.deadSince === null ? 0 : now - this.deadSince };
    return this.last;
  }

  dispose(): void {
    try {
      this.source.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

/**
 * The visual stand-in when the assistant's audio cannot be measured: every transcript fragment the
 * model speaks is a pulse, decaying like a syllable, with a light syllabic wobble on top. Driven by
 * what the model says, not by a clock — silence between replies is still silence.
 */
export class EventEnvelope {
  private level = 0;
  private lastAt: number | null = null;

  constructor(private readonly tuning: LevelTuning = AI_TUNING) {}

  /** One fragment of spoken text: longer fragments are louder pulses (capped). */
  pulse(chars: number): void {
    this.level = Math.max(this.level, Math.min(0.85, 0.45 + chars * 0.025));
  }

  read(now: number = performance.now()): number {
    const dt = this.lastAt === null ? 16 : now - this.lastAt;
    this.lastAt = now;
    // Decay over ~0.5 s — a fragment is roughly a word or two.
    this.level = follow(this.level, 0, dt, { ...this.tuning, releaseMs: 420 });
    const wobble = 0.72 + 0.28 * Math.abs(Math.sin(now / 95));
    return this.level * wobble;
  }

  reset(): void {
    this.level = 0;
    this.lastAt = null;
  }
}

/**
 * One AudioContext for the call, created inside the click that starts it — the only moment every
 * browser lets it run (autoplay policy). Null when Web Audio is missing.
 */
export function createCallAudioContext(): AudioContext | null {
  const Ctor: typeof AudioContext | undefined =
    typeof window === "undefined" ? undefined : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    const ctx = new Ctor();
    void ctx.resume?.().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

import { LIVING_PATHS } from "./paths";

/**
 * MULTIVERSO LIVING INTELLIGENCE — the approved V37 animation, as a reusable engine.
 *
 * This is a faithful port of docs/voice/multiverso-v37-approved.html: the same 4200 particles,
 * the same three ribbons, the same palettes, timings and choreography. Only the DOM wiring of the
 * demo (buttons, calibration panel, its own microphone and the synthetic AI voice) was taken out —
 * the engine is told the mode and the two sound levels from outside, and draws on a 2D context.
 *
 * Do not "clean up" the maths: every constant here was calibrated over dozens of versions. The
 * comments carried over from V37 explain why each step is there.
 *
 * Modes: `listen` (pink/lilac, compact, follows the PERSON's microphone, counter-clockwise),
 * `talk` (blue, more open, follows the ASSISTANT's audio, clockwise) and `logo` (the living mark:
 * the same particles flowing along the three ribbons).
 */

export type LivingMode = "listen" | "talk" | "logo";

export interface StageDef {
  id: StageId;
  group: "fwd" | "ret";
  name: string;
  desc: string;
  start: number;
  ms: number;
  max: number;
  relative?: boolean;
}

export type StageId = "accel" | "align" | "draw" | "finish" | "hold" | "slow" | "release" | "reform" | "settle";

// V26: efeitos de formação podem se sobrepor. Hold e desaceleração começam após a formação,
// mas também possuem deslocamentos individuais para calibragem fina.
export const STAGE_DEFS: readonly StageDef[] = [
  { id: "accel", group: "fwd", name: "Impulso inicial", desc: "Energia e aceleração progressiva enquanto a esfera começa a reagir.", start: 0, ms: 150, max: 2200 },
  { id: "align", group: "fwd", name: "Abertura e alinhamento", desc: "Organiza a esfera na direção das três fitas. Pode coincidir com o desenho.", start: 0, ms: 450, max: 3000 },
  { id: "draw", group: "fwd", name: "Desenho das três linhas", desc: "Revela os três percursos ao mesmo tempo que a abertura acontece.", start: 0, ms: 650, max: 3500 },
  { id: "finish", group: "fwd", name: "Finalizar silhueta", desc: "Completa o contorno e ajusta a largura sem fazer toda a marca girar.", start: 540, ms: 150, max: 2000 },
  { id: "hold", group: "fwd", name: "Sustentar fluxo rápido", desc: "Após a silhueta formada, mantém a circulação intensa. Início relativo ao fim da formação.", start: 0, ms: 225, max: 3500, relative: true },
  { id: "slow", group: "fwd", name: "Desaceleração", desc: "Reduz o fluxo gradualmente. Início relativo ao fim da sustentação.", start: 0, ms: 925, max: 4000, relative: true },
  { id: "release", group: "ret", name: "Liberar as fitas", desc: "Desfaz as fitas enquanto a recomposição da esfera já acontece em paralelo.", start: 0, ms: 475, max: 2400 },
  { id: "reform", group: "ret", name: "Reconstruir a esfera", desc: "Reconstrói a esfera desde o início da liberação, sem esperar as fitas se soltarem.", start: 0, ms: 750, max: 3000 },
  { id: "settle", group: "ret", name: "Estabilizar a esfera", desc: "Pode começar antes de a recomposição terminar e controlar a aproximação final.", start: 110, ms: 1000, max: 2200 },
];

export interface StageSetting {
  on: boolean;
  ms: number;
  start: number;
}

export interface LivingSettings {
  thickness: number;
  flowSpeed: number;
  accelSpeed: number;
  tracking: number;
  returnRotation: number;
  returnSpread: number;
  listenSpin: number;
  talkSpin: number;
  spinEase: number;
  switchTurn: number;
  spinPeakMs: number;
  returnBoost: number;
  colorMs: number;
  spinColorMs: number;
  speechMorphMs: number;
  logoEntrySpin: number;
  logoEntrySpinMs: number;
  stages: Record<StageId, StageSetting>;
}

export type ScalarSetting = Exclude<keyof LivingSettings, "stages">;

/** The approved V37 defaults. */
export function defaultSettings(): LivingSettings {
  const stages = {} as Record<StageId, StageSetting>;
  for (const d of STAGE_DEFS) stages[d.id] = { on: true, ms: d.ms, start: d.start };
  return {
    thickness: 100, flowSpeed: 112, accelSpeed: 112, tracking: 42, returnRotation: 0, returnSpread: 70,
    listenSpin: 13, talkSpin: 13, spinEase: 1200, switchTurn: 30, spinPeakMs: 150, returnBoost: 75,
    colorMs: 180, spinColorMs: 400, speechMorphMs: 410, logoEntrySpin: 30, logoEntrySpinMs: 520, stages,
  };
}

/** The same text the V37 "Copiar parametrização" button produced. PURE. */
export function tuningText(settings: LivingSettings): string {
  const ids: ScalarSetting[] = [
    "thickness", "flowSpeed", "accelSpeed", "tracking", "returnRotation", "returnSpread", "logoEntrySpin", "logoEntrySpinMs",
    "listenSpin", "talkSpin", "spinEase", "switchTurn", "spinPeakMs", "returnBoost", "colorMs", "spinColorMs", "speechMorphMs",
  ];
  return (
    "Multiverso Living Intelligence V37 — Ida e volta alinhadas ao giro\n" +
    ids.map((id) => id + ": " + settings[id]).join("\n") + "\n" +
    STAGE_DEFS.map((d) => {
      const s = settings.stages[d.id];
      return `${d.name} (${d.id}): ${s.on ? "SIM" : "NÃO"}, início ${s.start}ms, duração ${s.ms}ms`;
    }).join("\n")
  );
}

export const PARTICLE_COUNT = 4200;
const N = PARTICLE_COUNT;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const ease = (a: number, b: number, v: number) => a + (b - a) * v;
const smoothstep = (a: number, b: number, x: number) => {
  x = clamp((x - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * The synthetic "words" envelope V37 used to demonstrate the assistant's voice. In the app it is
 * only the soft fallback for when the assistant's real audio cannot be measured — it never comes
 * from the microphone. PURE.
 */
export function speechEnvelope(t: number): number {
  return (
    Math.max(0, Math.sin(t * 6.4)) ** 3 * 0.4 +
    Math.max(0, Math.sin(t * 10.7 + 0.9)) ** 6 * 0.37 +
    Math.max(0, Math.sin(t * 3.1)) ** 4 * 0.22
  );
}

/** V37's default "Intensidade" for the assistant's voice: 35%. */
export const TALK_INTENSITY = 0.35;

export interface ScheduleEntry {
  id: StageId;
  name: string;
  start: number;
  end: number;
  len: number;
  on: boolean;
}

/** The overlapping effects of the way in (`fwd`) or the way back (`ret`), in seconds. PURE. */
export function makeSchedule(settings: LivingSettings, group: "fwd" | "ret"): ScheduleEntry[] {
  const ret: ScheduleEntry[] = [];
  const add = (id: StageId, anchor = 0): ScheduleEntry => {
    const d = STAGE_DEFS.find((x) => x.id === id)!;
    const state = settings.stages[id];
    const start = anchor + state.start / 1000;
    const len = state.on ? state.ms / 1000 : 0;
    const entry = { id, name: d.name, start, end: start + len, len, on: state.on };
    ret.push(entry);
    return entry;
  };
  if (group === "fwd") {
    const active = [add("accel"), add("align"), add("draw"), add("finish")];
    const formationEnd = Math.max(0, ...active.filter((e) => e.on).map((e) => e.end));
    const hold = add("hold", formationEnd);
    add("slow", hold.end);
  } else {
    add("release");
    add("reform");
    add("settle");
  }
  return ret;
}

function phaseFraction(e: ScheduleEntry, time: number): number {
  if (!e.on) return 1;
  if (e.len <= 0) return time >= e.start ? 1 : 0;
  return smoothstep(0, 1, (time - e.start) / e.len);
}

export function activeStages(arr: ScheduleEntry[], time: number): ScheduleEntry[] {
  return arr.filter((e) => e.on && e.len > 0 && time >= e.start && time < e.end);
}

export function scheduleDuration(arr: ScheduleEntry[]): number {
  return Math.max(0, ...arr.map((e) => e.end));
}

const LOGO_COLORS: ReadonlyArray<readonly [number, number, number]> = [[58, 216, 241], [145, 101, 237], [70, 139, 249]];

/** Target = [_, _, R, G, B, ribbon, u, band] — V37's array shape. */
type Target = [number, number, number, number, number, number, number, number];

interface Particle {
  z: number;
  phi: number;
  seed: number;
  size: number;
  target: Target;
  phase: number;
  drift: number;
  radiusHint: number;
  flowSpeed: number;
  lastX?: number;
  lastY?: number;
  morphFromX?: number;
  morphFromY?: number;
  sphereAngle?: number;
  returnX?: number;
  returnY?: number;
  reentryOffset?: number;
  returnPhaseAt?: number;
  colorR?: number;
  colorG?: number;
  colorB?: number;
  fromColorR?: number;
  fromColorG?: number;
  fromColorB?: number;
}

function samplePath(k: number, u: number): [number, number] {
  const a = LIVING_PATHS[k];
  const v = ((((u % 1) + 1) % 1) * a.length);
  const i = Math.floor(v);
  const f = v - i;
  const p = a[i];
  const q = a[(i + 1) % a.length];
  return [ease(p[0], q[0], f), ease(p[1], q[1], f)];
}

function pathTangent(k: number, u: number): [number, number] {
  const a = samplePath(k, u - 0.001);
  const b = samplePath(k, u + 0.001);
  const x = b[0] - a[0];
  const y = b[1] - a[1];
  const len = Math.hypot(x, y) || 1;
  return [x / len, y / len];
}

export type Transition = "none" | "fwd" | "steady" | "ret";

/** Sound for one frame. Levels are 0..1 (see levels.ts); `talk: null` = not measurable. */
export interface LivingInput {
  /** The PERSON's microphone. Drives `listen` only. */
  listen: number;
  /** The ASSISTANT's audio. Drives `talk` only; null falls back to a soft synthetic envelope. */
  talk: number | null;
  /** prefers-reduced-motion: the ribbons stop flowing and the sound ripple is dropped (as V37). */
  reduce: boolean;
}

export interface LivingEngineOptions {
  mode?: LivingMode;
  settings?: LivingSettings;
  /** Tests make the particle field deterministic; the app uses Math.random. */
  random?: () => number;
}

export class LivingEngine {
  settings: LivingSettings;
  private W = 620;
  private H = 620;
  private t = 0;
  private _mode: LivingMode;
  private _transition: Transition = "none";
  private transitionStartedAt = 0;
  private _voice = 0;
  private readonly blend = { logo: 0, talk: 0 };
  private flowTempo = 1;
  private logoClock = 0;
  private lastSource: "listen" | "talk" = "listen";
  private spherePhase = 0;
  private _sphereOmega = -13 * DEG;
  private returnTurn = 0;
  private spinCycle: { at: number; from: number; peak: number } | null = null;
  private spinColorCycle: { at: number } | null = null;
  private logoEntryTurn = 0;
  private logoEntryStartOmega = 0;
  private readonly parts: Particle[] = [];
  /** How strong the fallback envelope is when the assistant's audio cannot be measured. */
  fallbackIntensity = TALK_INTENSITY;
  /** Per-frame output: x, y, size, r, g, b, alpha per particle. */
  readonly frame = new Float32Array(N * 7);

  constructor(options: LivingEngineOptions = {}) {
    const random = options.random ?? Math.random;
    const rand = (a: number, b: number) => a + random() * (b - a);
    this.settings = options.settings ?? defaultSettings();
    this._mode = options.mode ?? "listen";
    this._sphereOmega = this.targetOmega(this._mode);
    if (this._mode === "talk") this.blend.talk = 1;
    if (this._mode === "logo") this.blend.logo = 1;
    // Same particles as V7 for listening and speaking. For the logo they are assigned to 3 smooth, closed paths.
    const indices = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const k = i % 3;
      const j = indices[k]++;
      const baseU = (j + random() * 0.68) / (N / 3);
      const z = rand(-1, 1);
      const th = rand(0, TAU);
      const rr = Math.sqrt(1 - z * z);
      const band = rand(-1, 1);
      const col = LOGO_COLORS[k];
      const q: Target = [0, 0, col[0], col[1], col[2], k, baseU, band];
      // V37 drew speed and flowOffset too; kept in the same order so a seeded field matches it.
      rand(0.07, 0.17);
      random();
      const seed = rand(0, TAU);
      const size = rand(0.48, 1.55);
      const phase = rand(0, TAU);
      const drift = rand(0.6, 2);
      const flowSpeed = rand(0.014, 0.024);
      rand(0, TAU);
      this.parts.push({ z, phi: th, seed, size, target: q, phase, drift, radiusHint: rr, flowSpeed });
    }
  }

  get mode(): LivingMode {
    return this._mode;
  }
  get transition(): Transition {
    return this._transition;
  }
  /** Signed angular speed of the sphere, rad/s: negative = counter-clockwise on screen. */
  get sphereOmega(): number {
    return this._sphereOmega;
  }
  /** The smoothed sound level the particles are reacting to right now. */
  get voice(): number {
    return this._voice;
  }
  get logoBlend(): number {
    return this.blend.logo;
  }
  get talkBlend(): number {
    return this.blend.talk;
  }
  get time(): number {
    return this.t;
  }
  get count(): number {
    return N;
  }

  setSize(width: number, height: number): void {
    this.W = width;
    this.H = height;
  }

  /** Time since the current transition began, seconds. */
  get transitionElapsed(): number {
    return Math.max(0, this.t - this.transitionStartedAt);
  }

  private targetOmega(m: LivingMode): number {
    return (m === "talk" ? this.settings.talkSpin : -this.settings.listenSpin) * DEG;
  }

  private beginSpinCycle(destination: LivingMode, scale = 1): void {
    const direction = destination === "talk" ? 1 : -1;
    const base = destination === "talk" ? this.settings.talkSpin : this.settings.listenSpin;
    // Mantém fase e velocidade atuais quando a troca é interrompida no meio.
    this.spinCycle = { at: this.t, from: this._sphereOmega, peak: direction * (base + this.settings.switchTurn * scale) * DEG };
  }

  private startSpeechColorCycle(): void {
    // Snapshot das cores reais no momento do clique: pode inverter a troca a qualquer instante.
    for (const p of this.parts) {
      p.fromColorR = p.colorR === undefined ? 92 : p.colorR;
      p.fromColorG = p.colorG === undefined ? 187 : p.colorG;
      p.fromColorB = p.colorB === undefined ? 244 : p.colorB;
    }
    this.spinColorCycle = { at: this.t };
  }

  private updateSphereOmega(dt: number): void {
    const s = this.settings;
    const dest = this.targetOmega(this._mode);
    if (this.spinCycle) {
      const duration = Math.max(0.5, s.spinEase / 1000);
      const peakTime = Math.min(s.spinPeakMs / 1000, duration * 0.6);
      const since = Math.max(0, this.t - this.spinCycle.at);
      if (since < peakTime) {
        // Arranque perceptível já nos primeiros frames, pico sem tranco (ease-out seno).
        const jump = Math.sin((Math.PI / 2) * clamp(since / peakTime, 0, 1));
        this._sphereOmega = ease(this.spinCycle.from, this.spinCycle.peak, jump);
      } else if (since < duration) {
        // Resquício de rotação por quase 2s; não zera nem inverte de repente.
        const tail = smoothstep(0, 1, (since - peakTime) / (duration - peakTime));
        this._sphereOmega = ease(this.spinCycle.peak, dest, tail);
      } else {
        this._sphereOmega = dest;
        this.spinCycle = null;
      }
    } else {
      this._sphereOmega = ease(this._sphereOmega, dest, 1 - Math.exp(-dt / 0.25));
    }
    this.spherePhase += this._sphereOmega * dt;
  }

  private remapTargetsToSphere(): void {
    // Match each particle to a logo destination at a similar bearing. This avoids
    // crossing through the center and prevents the X/butterfly on each activation.
    const { W, H } = this;
    const groupCount = N / 3;
    for (let k = 0; k < 3; k++) {
      const members = this.parts.filter((p) => p.target[5] === k);
      // Angle at current activation, rather than a stale initial angle. [-PI,PI]
      // avoids the discontinuity at the wraparound on repeat activations.
      for (const p of members) {
        // Current visible angle, including accumulated sphere rotation and speech state.
        // A stale p.phi is what made the first frames cross and clump inward.
        const ang = Math.atan2((p.morphFromY ?? H / 2) - H / 2, (p.morphFromX ?? W / 2) - W / 2);
        p.sphereAngle = Number.isFinite(ang) ? ang : p.phi;
      }
      members.sort((a, b) => a.sphereAngle! - b.sphereAngle!);
      const destinations: { u: number; angle: number }[] = [];
      for (let j = 0; j < groupCount; j++) {
        const u = (j + 0.5) / groupCount;
        const xy = samplePath(k, u);
        destinations.push({ u, angle: Math.atan2(xy[1] - 454, xy[0] - 530) });
      }
      destinations.sort((a, b) => a.angle - b.angle);
      for (let j = 0; j < members.length; j++) members[j].target[6] = destinations[j].u;
    }
  }

  /** Same contract as V37's `change(m, force)`. Asking for the current mode is a no-op. */
  change(m: LivingMode, force = false): void {
    const s = this.settings;
    const { W, H } = this;
    const mode = this._mode;
    const transition = this._transition;
    const movingToLogo = m === "logo" && (mode !== "logo" || force || transition === "ret");
    const movingOut = m !== "logo" && (mode === "logo" || transition === "fwd" || transition === "steady");
    if ((m === "listen" || m === "talk") && m !== mode) {
      if (movingOut) {
        // The logo has no listening/speaking rotation of its own.  Starting from a
        // stale previous state's velocity would make the returning dots orbit the
        // wrong way and then reverse.  Set the *velocity*, never the angle, to
        // the destination's sign before generating the transition impulse.
        this._sphereOmega = this.targetOmega(m);
        this.spinCycle = null;
      }
      this.beginSpinCycle(m, movingOut ? s.returnBoost / 100 : 1);
      if (!movingOut && (mode === "listen" || mode === "talk")) {
        this.startSpeechColorCycle();
      } else {
        // Na volta da Marca Viva, mantém a troca rápida de cor já aprovada.
        this.spinColorCycle = null;
      }
    }
    if (m === "logo") this.spinColorCycle = null;
    if (movingToLogo) {
      this.lastSource = mode === "talk" ? "talk" : "listen";
      const nowX = W / 2;
      const nowY = H / 2;
      const sz = Math.min(W, H);
      for (const p of this.parts) {
        // p.lastX/Y already incorporate the active sphere's true size, phase and orientation.
        // These two coordinates remain stable during formation to prevent a second reset.
        p.morphFromX = Number.isFinite(p.lastX) ? p.lastX : nowX + Math.cos(p.phi) * sz * 0.3 * p.radiusHint;
        p.morphFromY = Number.isFinite(p.lastY) ? p.lastY : nowY + Math.sin(p.phi) * sz * 0.3 * p.radiusHint;
      }
      this.remapTargetsToSphere();
      this._transition = "fwd";
      this.transitionStartedAt = this.t;
      this.logoClock = 0;
      this.flowTempo = 1;
      this.logoEntryTurn = 0;
      const sourceDirection = this.lastSource === "talk" ? 1 : -1;
      this.logoEntryStartOmega = sourceDirection * (Math.abs(this._sphereOmega / DEG) + s.logoEntrySpin) * DEG;
    } else if (movingOut) {
      // Rebind the sphere's angular origin per particle to its actual visible
      // position on the logo. The sphere is indistinguishable after rebinding,
      // but the return no longer travels backward to its historic p.phi angle.
      for (const p of this.parts) {
        p.returnX = Number.isFinite(p.lastX) ? p.lastX : W / 2;
        p.returnY = Number.isFinite(p.lastY) ? p.lastY : H / 2;
        const bearing = Math.atan2(p.returnY! - H / 2, p.returnX! - W / 2);
        p.reentryOffset = bearing - (p.phi + this.spherePhase);
        p.returnPhaseAt = this.spherePhase;
      }
      this._transition = "ret";
      this.transitionStartedAt = this.t;
    }
    this._mode = m;
  }

  /** Advances the simulation by `dt` seconds (capped like V37) and fills {@link frame}. */
  step(dtSeconds: number, input: LivingInput): void {
    const s = this.settings;
    const dt = Math.min(0.05, dtSeconds > 0 ? dtSeconds : 0.016);
    this.t += dt;
    const t = this.t;
    const reduce = input.reduce;
    const mode = this._mode;
    // Audio destinations are intentionally separate: listening reacts to the user's MIC;
    // responding reacts to the AI's output. Only when the AI's audio cannot be measured does
    // the V37 demonstration envelope stand in, softly.
    const listenAudio = clamp(input.listen, 0, 1);
    const responseAudio = input.talk === null ? speechEnvelope(t) * this.fallbackIntensity : clamp(input.talk, 0, 1);
    const desiredVoice = mode === "listen" ? listenAudio : mode === "talk" ? responseAudio : 0;
    this._voice = ease(this._voice, desiredVoice, 1 - Math.exp(-dt / 0.075));
    const voice = this._voice;
    // Timeline de efeitos sobrepostos e coreografia de entrada UNIFICADA.
    let bearingMix = 0, shapeMix = 0, visualBlend = 0, returnRelease = 0, returnReform = 0, returnSettle = 0;
    const elapsed = Math.max(0, t - this.transitionStartedAt);
    if (this._transition === "fwd" || this._transition === "steady") {
      const fwd = makeSchedule(s, "fwd");
      const phase = Object.fromEntries(fwd.map((e) => [e.id, phaseFraction(e, elapsed)])) as Record<StageId, number>;
      // Blend a little of geometry into angular alignment so arcs emerge without rotating
      // the whole sphere as a rigid shape before the contour is visible.
      bearingMix = s.stages.align.on ? phase.align : phase.draw;
      shapeMix =
        (s.stages.draw.on ? 0.9 * phase.draw : 0.9 * phase.align) +
        (s.stages.finish.on ? 0.1 * phase.finish : 0.1 * phase.draw);
      shapeMix = clamp(shapeMix, 0, 1);
      visualBlend = clamp(0.24 * bearingMix + 0.76 * shapeMix, 0, 1);
      const hi = (2.9 * s.accelSpeed) / 100;
      const acceleration = s.stages.accel.on ? phase.accel : 1;
      const slowdown = s.stages.slow.on ? phase.slow : 0;
      const tempoTarget = ease(1, hi, acceleration) * (1 - slowdown) + slowdown;
      this.flowTempo = ease(this.flowTempo, tempoTarget, 1 - Math.exp(-dt / 0.12));
      if (elapsed >= scheduleDuration(fwd)) {
        this._transition = "steady";
        visualBlend = 1;
        bearingMix = 1;
        shapeMix = 1;
      }
    } else if (this._transition === "ret") {
      const ret = makeSchedule(s, "ret");
      const phase = Object.fromEntries(ret.map((e) => [e.id, phaseFraction(e, elapsed)])) as Record<StageId, number>;
      returnRelease = s.stages.release.on ? phase.release : 1;
      returnReform = s.stages.reform.on ? phase.reform : returnRelease;
      returnSettle = s.stages.settle.on ? phase.settle : returnReform;
      // Giro opcional acumulado: não usa senóide para voltar ao ângulo inicial.
      // Any optional extra rotation respects the *destination*, even when the
      // user moves the slider left: return arcs never counter-rotate.
      const targetSign = mode === "talk" ? 1 : -1;
      this.returnTurn = targetSign * Math.abs(s.returnRotation) * DEG * returnReform;
      visualBlend = (1 - returnRelease) * 0.82 + (1 - returnReform) * 0.18;
      this.flowTempo = ease(this.flowTempo, 1, 1 - Math.exp(-dt / 0.21));
      if (elapsed >= scheduleDuration(ret)) {
        this.spherePhase += this.returnTurn;
        this.returnTurn = 0;
        this._transition = "none";
        visualBlend = 0;
      }
    } else {
      this.flowTempo = ease(this.flowTempo, 1, 1 - Math.exp(-dt / 0.21));
      if (mode === "logo") {
        visualBlend = 1;
        bearingMix = 1;
        shapeMix = 1;
      } else visualBlend = 0;
    }
    const transition = this._transition;
    this.blend.logo = visualBlend;
    // Giro da ida: em vez de congelar as posições capturadas no clique, damos um impulso
    // rotacional curto, integrado por frame. O ângulo não é recalculado a partir do tempo
    // global, portanto não acelera inexplicavelmente após uso prolongado.
    if (transition === "fwd") {
      const spinTime = Math.max(0.15, s.logoEntrySpinMs / 1000);
      const qtime = clamp(elapsed / spinTime, 0, 1);
      const falloff = 1 - smoothstep(0, 1, qtime);
      this.logoEntryTurn += this.logoEntryStartOmega * falloff * dt;
    }
    const speechTarget = mode === "talk" ? 1 : 0;
    // ~95% within selected time, including return from logo
    this.blend.talk = ease(this.blend.talk, speechTarget, 1 - Math.exp(-dt / Math.max(0.02, s.speechMorphMs / 3000)));
    // Rotação acumulada por frame, com mudança de sentido e impulso transitório.
    this.updateSphereOmega(dt);
    // Integra a fase ao longo do tempo: nunca recalcula posição usando um multiplicador acumulado.
    const canMoveLogo = transition === "fwd" || transition === "steady" || mode === "logo";
    const drawingActivity = transition === "fwd" ? ease(s.tracking / 100, 1, shapeMix) : 1;
    if (canMoveLogo) this.logoClock += dt * (s.flowSpeed / 100) * 1.24 * this.flowTempo * drawingActivity;

    const { W, H, blend, spherePhase, returnTurn, logoClock, logoEntryTurn, frame } = this;
    const sz = Math.min(W, H);
    const scale = (sz * 0.845) / 939;
    const cx = W / 2;
    const cy = H / 2;
    const energy = mode === "listen" ? voice * 1.6 : voice * 0.85;
    const forming = transition === "fwd" || transition === "steady";
    const listeningShape = forming ? 0 : 1 - blend.talk;
    const talkingShape = forming ? 0 : blend.talk;
    const colorAlpha = 1 - Math.exp(-dt / Math.max(0.015, s.colorMs / 3000));
    const colorProgress = this.spinColorCycle
      ? smoothstep(0, 1, Math.max(0, t - this.spinColorCycle.at) / Math.max(0.05, s.spinColorMs / 1000))
      : 0;
    const bandWidth = sz * 0.1 * (s.thickness / 100);
    const early = transition === "fwd" ? smoothstep(0, 1, Math.max(0, Math.min(1, elapsed / Math.max(0.08, s.logoEntrySpinMs / 1000)))) : 0;

    for (let i = 0; i < N; i++) {
      const p = this.parts[i];
      const q = p.target;
      const z = p.z;
      // Sentido definido pelo estado de destino; rotação acumulada sem saltos.
      // Deslocamentos internos são independentes do giro global.
      const orbitAngle = p.phi + spherePhase + (p.reentryOffset || 0) + returnTurn;
      const e0 = Math.cos(orbitAngle) * Math.sqrt(1 - z * z);
      const yr = Math.sin(orbitAngle) * Math.sqrt(1 - z * z);
      const depth = 1 + 0.17 * z;
      const sphereR = ease(0.92, 0.79, listeningShape) + energy * 0.05 * listeningShape;
      let sx = cx + e0 * sz * 0.34 * sphereR * depth;
      let sy = cy + yr * sz * 0.34 * sphereR * depth;
      // Ao escutar: pequenas emissões locais, proporcionais ao microfone, sem girar a esfera inteira.
      const liquidX = Math.sin(t * (0.7 + p.drift * 0.11) + p.phase) * sz * 0.006 + Math.sin((yr + z) * 4.2 + t * 0.9 + p.seed) * sz * 0.003;
      const liquidY = Math.cos(t * (0.64 + p.drift * 0.12) + p.phase * 1.3) * sz * 0.006 + Math.cos((e0 - z) * 4.6 - t * 0.82 + p.seed * 0.7) * sz * 0.003;
      const liquidFactor = ease(1, 0.85 + voice * 0.65, listeningShape);
      sx += liquidX * liquidFactor;
      sy += liquidY * liquidFactor;
      if (listeningShape > 0.001) {
        const distN = Math.hypot(e0, yr) || 1;
        const rx = e0 / distN;
        const ry = yr / distN;
        const syllable = Math.max(0, Math.sin(t * 11.5 + p.phase * 1.7 + p.seed * 0.6));
        const burst = (0.14 + syllable * 0.86) * voice * listeningShape;
        const outward = burst * sz * 0.028;
        const ripple = Math.sin(t * 15 - (p.radiusHint || 0) * 8 + p.seed) * voice * listeningShape * sz * 0.006;
        const tangentX = -ry;
        const tangentY = rx;
        sx += rx * (outward + ripple) + tangentX * Math.sin(t * 5 + p.seed) * voice * listeningShape * sz * 0.0035;
        sy += ry * (outward + ripple) + tangentY * Math.cos(t * 4.6 + p.seed) * voice * listeningShape * sz * 0.0035;
      }
      // Blue replying mode remains rounder and more spacious: low-amplitude outward
      // travelling waves, not the microphone's stronger local particle articulation.
      if (talkingShape > 0.001) {
        const distance = Math.hypot(e0, yr) || 1;
        const wave1 = Math.sin(t * 10.2 - distance * 10.5 + p.seed * 0.32);
        const wave2 = Math.sin(t * 6.4 - distance * 6.8 + p.phase * 0.3);
        const speechWave = voice * talkingShape * sz * 0.009 * (0.62 * wave1 + 0.38 * wave2);
        sx += (e0 / distance) * speechWave;
        sy += (yr / distance) * speechWave;
      }
      // Logo: 3 actual closed user-drawn paths. Each particle glides along ONE path with
      // bounded transverse displacement. It never rotates the overall icon.
      const k = q[5];
      const dir = k === 1 ? -1 : 1;
      const u = q[6] + (reduce ? 0 : logoClock * p.flowSpeed * dir);
      const pp = samplePath(k, u);
      const tan = pathTangent(k, u);
      const normalX = -tan[1];
      const normalY = tan[0];
      const smoothFlow = reduce ? 0 : Math.sin(t * 0.58 + p.phase) * bandWidth * 0.042;
      const side = q[7] * bandWidth * 0.5 + smoothFlow;
      const lx = cx + (pp[0] - 530) * scale + normalX * side;
      const ly = cy + (pp[1] - 454) * scale + normalY * side;
      // Evita pulso de encolhimento: a origem é SEMPRE o quadro real congelado no clique,
      // sem voltar as partículas para o ângulo inicial p.phi nem para um raio canônico menor.
      let srcScreenX = sx;
      let srcScreenY = sy;
      if (forming) {
        srcScreenX = Number.isFinite(p.morphFromX) ? p.morphFromX! : sx;
        srcScreenY = Number.isFinite(p.morphFromY) ? p.morphFromY! : sy;
      }
      // Entrada mais sutil: cada partícula já começa acelerando no sentido da fita à qual pertence,
      // com um empurrão tangencial desde o primeiro frame e uma atração leve para a própria fita.
      if (transition === "fwd") {
        const tangentKick = sz * 0.02 * (s.logoEntrySpin / 30) * early * (1 - shapeMix * 0.78);
        const ribbonPull = 0.055 * early * (1 - shapeMix * 0.55);
        srcScreenX += tan[0] * tangentKick * dir + (lx - srcScreenX) * ribbonPull;
        srcScreenY += tan[1] * tangentKick * dir + (ly - srcScreenY) * ribbonPull;
      }
      const srcX = srcScreenX - cx;
      const srcY = srcScreenY - cy;
      const sourceR = Math.hypot(srcX, srcY);
      // Na ida a origem gira um pouco desde o primeiro frame, sem interromper a formação.
      const entryAngle = transition === "fwd" ? logoEntryTurn : 0;
      const sourceA = Math.atan2(srcY, srcX) + entryAngle;
      const gx = lx - cx;
      const gy = ly - cy;
      const targetR = Math.hypot(gx, gy);
      const targetA = Math.atan2(gy, gx);
      const dAngle = Math.atan2(Math.sin(targetA - sourceA), Math.cos(targetA - sourceA));
      let x: number;
      let y: number;
      if (transition === "ret") {
        const fx = (p.returnX ?? lx) - cx;
        const fy = (p.returnY ?? ly) - cy;
        const fr = Math.hypot(fx, fy);
        const fa = Math.atan2(fy, fx);
        const desiredR = sourceR * (s.returnSpread / 100);
        const rr = ease(fr, desiredR, returnRelease);
        // All the angular displacement since the click is an INTEGRATED, one-way phase in the
        // destination's direction: it can never pick a counter-rotating shortcut.
        const destinationSign = mode === "talk" ? 1 : -1;
        const rawAdvance = spherePhase - (p.returnPhaseAt ?? spherePhase) + returnTurn;
        const directedAdvance = destinationSign * Math.abs(rawAdvance);
        const aa = fa + directedAdvance * returnReform;
        x = cx + Math.cos(aa) * rr;
        y = cy + Math.sin(aa) * rr;
        x = ease(x, sx, returnSettle);
        y = ease(y, sy, returnSettle);
      } else {
        const bearing = sourceA + dAngle * bearingMix;
        const radial = ease(sourceR, targetR, shapeMix);
        x = cx + Math.cos(bearing) * radial;
        y = cy + Math.sin(bearing) * radial;
      }
      p.lastX = x;
      p.lastY = y;
      // Preserve a softly circular volume during the early transition.
      if (!reduce && 1 - blend.talk > 0.02 && !forming) {
        const dist = Math.hypot(x - cx, y - cy);
        const rad = dist / Math.max(sz * 0.22, 1);
        const wave = Math.sin(t * 11 - rad * 13 + p.seed * 0.2) * voice * sz * 0.014 * (1 - blend.talk);
        x += ((x - cx) / (dist || 1)) * wave;
        y += ((y - cy) / (dist || 1)) * wave;
      }
      let alpha = 0.18 + 0.6 * (0.4 + (0.6 * (z + 1)) / 2) + blend.logo * 0.2;
      alpha *= 0.72 + 0.28 * Math.sin(t * 1.4 + p.seed) ** 2;
      alpha *= 1 + blend.logo * 0.13;
      // A COR SEGUE O DESTINO, NÃO A ETAPA GEOMÉTRICA: vai direto ao destino, sem passar por
      // outro estado. A cor de cada partícula é guardada para transições interrompidas.
      let paletteR: number, paletteG: number, paletteB: number;
      if (mode === "logo") {
        paletteR = q[2];
        paletteG = q[3];
        paletteB = q[4];
      } else if (mode === "talk") {
        const shimmer = 0.5 + 0.5 * Math.sin(p.seed * 1.7 + p.phase * 0.6 + t * 0.26);
        paletteR = ease(88, 122, shimmer);
        paletteG = ease(174, 210, shimmer);
        paletteB = ease(232, 255, shimmer);
      } else {
        const shimmer = 0.5 + 0.5 * Math.sin(p.seed * 1.9 + p.phase * 0.7 + t * 0.32);
        paletteR = ease(177, 213, shimmer);
        paletteG = ease(95, 144, shimmer);
        paletteB = 255;
      }
      if (p.colorR === undefined) {
        p.colorR = 92;
        p.colorG = 187;
        p.colorB = 244;
      }
      if (this.spinColorCycle && (mode === "listen" || mode === "talk")) {
        // Cor evolui no mesmo relógio da rotação, em vez de mudar toda antes do movimento.
        p.colorR = ease(p.fromColorR!, paletteR, colorProgress);
        p.colorG = ease(p.fromColorG!, paletteG, colorProgress);
        p.colorB = ease(p.fromColorB!, paletteB, colorProgress);
      } else {
        p.colorR = ease(p.colorR, paletteR, colorAlpha);
        p.colorG = ease(p.colorG!, paletteG, colorAlpha);
        p.colorB = ease(p.colorB!, paletteB, colorAlpha);
      }
      const size = p.size * (0.55 + (z + 1) * 0.42) * (1 + energy * 0.18 + 0.08 * (1 - blend.talk));
      const o = i * 7;
      frame[o] = x;
      frame[o + 1] = y;
      frame[o + 2] = size;
      frame[o + 3] = p.colorR;
      frame[o + 4] = p.colorG!;
      frame[o + 5] = p.colorB!;
      frame[o + 6] = alpha;
    }
    if (this.spinColorCycle && t - this.spinColorCycle.at >= s.spinColorMs / 1000) this.spinColorCycle = null;
  }

  /** Mean colour of the frame — what tests and the status chip read. */
  meanColor(): [number, number, number] {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < N; i++) {
      r += this.frame[i * 7 + 3];
      g += this.frame[i * 7 + 4];
      b += this.frame[i * 7 + 5];
    }
    return [r / N, g / N, b / N];
  }

  /** Additive tiny glowing atoms with independent positions; continuity across all states. */
  draw(ctx: CanvasRenderingContext2D): void {
    const f = this.frame;
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < N; i++) {
      const o = i * 7;
      const x = f[o], y = f[o + 1], r = f[o + 2], a = f[o + 6];
      // The canvas keeps 8 bits per channel anyway: rounding here changes no pixel and spares the
      // colour parser 8400 long decimals a frame.
      const rgb = `${Math.round(f[o + 3])},${Math.round(f[o + 4])},${Math.round(f[o + 5])}`;
      ctx.fillStyle = `rgba(${rgb},${Math.round(a * 150) / 1000})`;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.1, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `rgba(${rgb},${Math.round(a * 1000) / 1000})`;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.32, r * 0.79), 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }
}

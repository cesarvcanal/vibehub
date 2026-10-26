import * as React from "react";
import { api, post } from "@/lib/api";
import { LiveVoiceSession, type LiveVoiceDeps, type LiveVoiceSnapshot } from "./liveVoice";
import { AI_TUNING, LevelMeter, MIC_TUNING, createCallAudioContext, visualLevel } from "./audioLevel";
import { INITIAL_PHASE, nextPhase, type PhaseMemory, type VoicePhase } from "./voicePhase";
import type { VoiceTurn } from "./voiceTurns";

/**
 * A VOICE CALL INSIDE A CARD'S CHAT — the glue between the GPT-Live session (./liveVoice.ts), the
 * two level meters (./audioLevel.ts), the phase machine (./voicePhase.ts) and the card's chat:
 *
 * - the session is created against `/api/cards/:id/voice/sessions`, so the model knows the thread;
 * - every turn that closes is saved to `/api/cards/:id/voice/turns` (idempotent by `vid`, retried
 *   with backoff; the last flush survives the tab closing via `keepalive`), and the turns not yet
 *   echoed by the chat's socket are exposed for the chat to draw in place;
 * - the AudioContext is born inside the click that starts the call (autoplay), and the assistant's
 *   level is MEASURED on its WebRTC track — with an honest fallback chain when it cannot be: the
 *   RTP audio level from getStats, then the model's own transcript pulses. Which source is driving
 *   the orb is reported, never assumed.
 *
 * One call at a time across the app: starting one here ends any other.
 */

export type TalkSource = "analyser" | "rtp" | "events" | "none";
export type TurnSave = "saving" | "saved" | "failed";

export interface LocalVoiceTurn extends VoiceTurn {
  save?: TurnSave;
}

/** The numbers behind the orb, for diagnostics and tests: REAL volume vs VISUAL intensity. */
export interface CallMeter {
  micVisual: number;
  aiRms: number | null;
  aiDb: number | null;
  aiVisual: number;
  aiSource: TalkSource;
}

/** After this long of exact digital zeros while the model speaks, the analyser is not hearing it. */
export const DEAD_ANALYSER_MS = 700;
export const SAVE_RETRY_MS = [1_000, 3_000, 8_000, 20_000];
const PHASE_INTERVAL_MS = 80;

/** The session holding the one call the app may have at a time. */
let activeCall: LiveVoiceSession | null = null;

/** Tests swap the browser's media stack for the chat that hosts the call (it passes no options). */
const testHooks: { makeDeps?: UseVoiceCallOptions["makeDeps"]; makeAudioContext?: UseVoiceCallOptions["makeAudioContext"] } = {};
export function setVoiceCallTestHooks(hooks: typeof testHooks): void {
  testHooks.makeDeps = hooks.makeDeps;
  testHooks.makeAudioContext = hooks.makeAudioContext;
}

export interface UseVoiceCallOptions {
  cardId: string;
  /** The card's agent is working on something sent during the call. */
  agentBusy?: boolean;
  /** Tests swap the browser media stack. */
  makeDeps?: (audio: HTMLAudioElement, cardId: string) => LiveVoiceDeps;
  makeAudioContext?: () => AudioContext | null;
}

function defaultDeps(audio: HTMLAudioElement, cardId: string): LiveVoiceDeps {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPeer: () => new RTCPeerConnection(),
    exchangeOffer: (sdp, signal) =>
      post<{ sessionId: string; sdp: string }>(`/cards/${encodeURIComponent(cardId)}/voice/sessions`, { sdp }, { signal }),
    audio,
  };
}

const IDLE_METER: CallMeter = { micVisual: 0, aiRms: null, aiDb: null, aiVisual: 0, aiSource: "none" };

export function useVoiceCall({
  cardId,
  agentBusy = false,
  makeDeps = testHooks.makeDeps ?? defaultDeps,
  makeAudioContext = testHooks.makeAudioContext ?? createCallAudioContext,
}: UseVoiceCallOptions) {
  const [session, setSession] = React.useState<LiveVoiceSession | null>(null);
  const ctxRef = React.useRef<AudioContext | null>(null);
  const meters = React.useRef<{ mic: LevelMeter | null; ai: LevelMeter | null }>({ mic: null, ai: null });
  const meterRef = React.useRef<CallMeter>(IDLE_METER);
  const phaseRef = React.useRef<PhaseMemory>(INITIAL_PHASE);
  const [phase, setPhase] = React.useState<VoicePhase>("idle");
  const [saves, setSaves] = React.useState<Record<string, TurnSave>>({});
  const agentBusyRef = React.useRef(agentBusy);
  agentBusyRef.current = agentBusy;
  // Read when a session is built / a call starts — a new function each render must not rebuild it.
  const factories = React.useRef({ makeDeps, makeAudioContext });
  factories.current = { makeDeps, makeAudioContext };

  // One session per card chat, with its own hidden player. Unmount (card closed, chat switched to
  // the terminal, page left) ends the call and releases the microphone.
  React.useEffect(() => {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    const s = new LiveVoiceSession(factories.current.makeDeps(audio, cardId));
    setSession(s);
    return () => {
      if (activeCall === s) activeCall = null;
      s.dispose();
      releaseAudio();
      setSession(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  const snap = React.useSyncExternalStore(
    React.useCallback((cb: () => void) => session?.subscribe(cb) ?? (() => undefined), [session]),
    () => session?.snapshot() ?? LiveVoiceSession.idleSnapshot,
  );

  /* ------------------------------------------------------------ saving turns */

  const queue = React.useRef(new Map<string, VoiceTurn>());
  const attempt = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = React.useRef(false);

  const flush = React.useCallback(async (): Promise<void> => {
    if (inFlight.current || queue.current.size === 0) return;
    inFlight.current = true;
    const batch = [...queue.current.values()].slice(0, 40);
    setSaves((prev) => ({ ...prev, ...Object.fromEntries(batch.map((t) => [t.vid, "saving" as const])) }));
    try {
      await post(`/cards/${encodeURIComponent(cardId)}/voice/turns`, {
        turns: batch.map(({ vid, role, text, at }) => ({ vid, role, text, at })),
      });
      for (const t of batch) queue.current.delete(t.vid);
      attempt.current = 0;
      setSaves((prev) => ({ ...prev, ...Object.fromEntries(batch.map((t) => [t.vid, "saved" as const])) }));
    } catch (err) {
      setSaves((prev) => ({ ...prev, ...Object.fromEntries(batch.map((t) => [t.vid, "failed" as const])) }));
      const status = (err as { response?: { status?: number } })?.response?.status ?? 0;
      // Refused for good (bad turn, no right to this card): retrying would only repeat the answer.
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        for (const t of batch) queue.current.delete(t.vid);
        return;
      }
      const wait = SAVE_RETRY_MS[Math.min(attempt.current, SAVE_RETRY_MS.length - 1)]!;
      attempt.current += 1;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), wait);
    } finally {
      inFlight.current = false;
    }
    if (queue.current.size > 0 && attempt.current === 0) void flush();
  }, [cardId]);

  React.useEffect(() => {
    if (!session) return;
    return session.onFinalTurn((turn) => {
      if (!turn.text.trim()) return;
      queue.current.set(turn.vid, turn);
      void flush();
    });
  }, [session, flush]);

  // Leaving with turns unsaved (tab closed mid-retry): one last best-effort send that outlives the page.
  React.useEffect(() => {
    const last = (): void => {
      if (queue.current.size === 0) return;
      const body = JSON.stringify({ turns: [...queue.current.values()].map(({ vid, role, text, at }) => ({ vid, role, text, at })) });
      try {
        void fetch(`${api.defaults.baseURL ?? "/api"}/cards/${encodeURIComponent(cardId)}/voice/turns`, {
          method: "POST", body, keepalive: true, credentials: "include", headers: { "content-type": "application/json" },
        }).catch(() => undefined);
      } catch {
        /* nothing more can be done */
      }
    };
    window.addEventListener("pagehide", last);
    return () => {
      window.removeEventListener("pagehide", last);
      if (timer.current) clearTimeout(timer.current);
      last();
    };
  }, [cardId]);

  /* ------------------------------------------------------------ audio levels */

  function releaseAudio(): void {
    meters.current.mic?.dispose();
    meters.current.ai?.dispose();
    meters.current = { mic: null, ai: null };
    meterRef.current = IDLE_METER;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    void ctx?.close?.().catch(() => undefined);
  }

  const active = snap.state === "connecting" || snap.state === "live" || snap.state === "closing";
  // The meters follow the streams: the mic from the grant, the assistant's once its track arrives.
  React.useEffect(() => {
    const ctx = ctxRef.current;
    const stream = active ? session?.micStream() ?? null : null;
    if (!ctx || !stream || stream.getAudioTracks().length === 0) return;
    let meter: LevelMeter;
    try {
      meter = new LevelMeter(ctx, stream, MIC_TUNING);
    } catch {
      return;
    }
    meters.current.mic = meter;
    return () => {
      meter.dispose();
      if (meters.current.mic === meter) meters.current.mic = null;
    };
  }, [active, session, snap.diag.micTrack]);

  React.useEffect(() => {
    const ctx = ctxRef.current;
    const stream = snap.state === "live" && snap.diag.remoteAudio ? session?.remoteStream() ?? null : null;
    if (!ctx || !stream) return;
    let meter: LevelMeter;
    try {
      meter = new LevelMeter(ctx, stream, AI_TUNING);
    } catch {
      return;
    }
    // The track arrives seconds after the click; a context the browser suspended meanwhile resumes here.
    void ctx.resume?.().catch(() => undefined);
    meters.current.ai = meter;
    return () => {
      meter.dispose();
      if (meters.current.ai === meter) meters.current.ai = null;
    };
  }, [snap.state, snap.diag.remoteAudio, session]);

  const snapRef = React.useRef<LiveVoiceSnapshot>(snap);
  snapRef.current = snap;

  /** One measurement of both sources — called by the orb every frame and by the phase loop. */
  const measure = React.useCallback((): CallMeter => {
    const s = snapRef.current;
    const now = performance.now();
    const mic = meters.current.mic && !s.muted ? meters.current.mic.read(now).visual : 0;
    let aiSource: TalkSource = "none";
    let aiVisual = 0;
    let aiRms: number | null = null;
    let aiDb: number | null = null;
    const ai = meters.current.ai?.read(now) ?? null;
    if (ai && ai.deadMs < DEAD_ANALYSER_MS) {
      aiSource = "analyser";
      aiVisual = ai.visual;
      aiRms = ai.rms;
      aiDb = ai.db;
    } else if (s.diag.remoteLevel !== null && s.diag.remoteLevel > 0) {
      // getStats' audioLevel is linear amplitude, like an RMS: same window, coarser in time.
      aiSource = "rtp";
      aiRms = s.diag.remoteLevel;
      aiVisual = visualLevel(s.diag.remoteLevel, AI_TUNING);
    } else if (session) {
      aiSource = "events";
      aiVisual = session.speech.read(now);
    }
    const m: CallMeter = { micVisual: mic, aiRms, aiDb, aiVisual, aiSource };
    meterRef.current = m;
    return m;
  }, [session]);

  // The phase machine runs while a call is up: a React render only when the phase changes.
  React.useEffect(() => {
    if (snap.state === "idle" || snap.state === "error") {
      phaseRef.current = nextPhase(phaseRef.current, {
        state: snap.state, muted: false, now: Date.now(), lastInputAt: null, lastOutputAt: null, aiLevel: 0, micLevel: 0,
      });
      setPhase(phaseRef.current.phase);
      return;
    }
    const step = (): void => {
      const s = snapRef.current;
      const m = measure();
      phaseRef.current = nextPhase(phaseRef.current, {
        state: s.state,
        muted: s.muted,
        now: Date.now(),
        lastInputAt: s.diag.lastInputAt,
        lastOutputAt: s.diag.lastOutputAt,
        aiLevel: m.aiVisual,
        micLevel: m.micVisual,
        agentBusy: agentBusyRef.current,
      });
      setPhase(phaseRef.current.phase);
    };
    step();
    const id = setInterval(step, PHASE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [snap.state, measure]);

  // A call that ended (any path) gives the audio graph back.
  React.useEffect(() => {
    if (snap.state === "idle" || snap.state === "error") releaseAudio();
  }, [snap.state]);

  /** What the orb reads every frame: mic only while it listens, the assistant only while it replies. */
  const orbLevels = React.useCallback(() => {
    const m = measure();
    const p = phaseRef.current.phase;
    const listening = p === "listening" || p === "user_speaking" || p === "interrupted";
    return { listen: listening ? m.micVisual : 0, talk: p === "ai_speaking" ? m.aiVisual : 0 };
  }, [measure]);

  /* ------------------------------------------------------------ controls */

  const start = React.useCallback((): void => {
    if (!session) return;
    // Synchronously, inside the click: the one moment the browser lets audio start.
    releaseAudio();
    ctxRef.current = factories.current.makeAudioContext();
    void ctxRef.current?.resume?.().catch(() => undefined);
    if (activeCall && activeCall !== session) activeCall.stop();
    activeCall = session;
    void session.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const stop = React.useCallback(() => session?.stop(), [session]);
  const setMuted = React.useCallback((muted: boolean) => session?.setMuted(muted), [session]);
  const resumePlayback = React.useCallback(() => {
    void ctxRef.current?.resume?.().catch(() => undefined);
    session?.resumePlayback();
  }, [session]);
  const appendContext = React.useCallback((text: string) => session?.appendContext(text) ?? false, [session]);

  const turns: LocalVoiceTurn[] = React.useMemo(
    () => snap.turns.map((t) => (saves[t.vid] ? { ...t, save: saves[t.vid] } : t)),
    [snap.turns, saves],
  );

  return { snap, phase, turns, start, stop, setMuted, resumePlayback, appendContext, orbLevels, meterRef, active };
}

export type VoiceCall = ReturnType<typeof useVoiceCall>;

import { EventEnvelope } from "./audioLevel";
import { TurnSegmenter, newCallId, type VoiceTurn } from "./voiceTurns";

/**
 * VOICE MODE — the browser half of a GPT-Live conversation, held inside a card's chat.
 *
 * The microphone goes out on a WebRTC media track and the assistant's voice comes back on another;
 * JSON events ride the `oai-events` data channel. The back-end only trades the SDP offer for the
 * answer (it holds the API key): after that, audio flows browser ↔ OpenAI and never through us.
 * GPT-Live is full duplex, so turn-taking and barge-in are the model's — the mic simply stays open.
 *
 * Every exit path (stop, cancel while connecting, startup error, dropped connection, unmount) runs
 * the same {@link LiveVoiceSession.teardown}: microphone released, channel and peer closed.
 * Nothing here logs audio or events.
 *
 * The transcript is settled into TURNS here (./voiceTurns.ts): the snapshot carries them as they
 * grow, and every turn that closes is handed to {@link LiveVoiceSession.onFinalTurn} listeners —
 * the chat saves those. The call ending, by any path, closes the open ones first.
 */

export type LiveVoiceState = "idle" | "connecting" | "live" | "closing" | "error";

export interface LiveVoiceSnapshot {
  state: LiveVoiceState;
  muted: boolean;
  /** The call's turns, oldest first — open ones still growing. */
  turns: VoiceTurn[];
  /**
   * The last failure, cleared on the next start: an i18n key (`voice.err.*`) for what the browser
   * knows, or the server's message verbatim — `t()` passes an unknown key straight through.
   */
  error: string | null;
  /** A non-fatal notice (moderation cut the reply, the close was not confirmed…), same shape. */
  notice: string | null;
  diag: LiveVoiceDiag;
}

/**
 * What the connection is doing, for the diagnostics panel. Counts and states only — never audio,
 * never transcript text, never the SDP.
 */
export interface LiveVoiceDiag {
  peer: RTCPeerConnectionState | null;
  ice: RTCIceConnectionState | null;
  channel: RTCDataChannelState | null;
  /** The mic track as the browser sees it: live/ended, and whether it is enabled (not muted). */
  micTrack: "live" | "ended" | null;
  /** The assistant's audio track arrived. */
  remoteAudio: boolean;
  /** The <audio> element: playing, or blocked by the browser's autoplay policy. */
  playback: "none" | "playing" | "blocked";
  /** RTP audio bytes that LEFT this browser (getStats outbound-rtp) — what the model can receive. */
  sentBytes: number | null;
  /** RTP audio bytes that ARRIVED from the model (inbound-rtp), and its last audio level 0..1. */
  receivedBytes: number | null;
  remoteLevel: number | null;
  /** Data-channel events received, by type. */
  events: Record<string, number>;
  /** When the model last transcribed the person (it HEARD them) / last spoke, epoch ms. */
  lastInputAt: number | null;
  lastOutputAt: number | null;
  /** The last `error` event's code or type (not its message). */
  lastErrorCode: string | null;
  /** Quiet context appended to the model (`session.thinking.append`): sent / acknowledged. */
  contextSent: number;
  contextAcked: number;
}

/**
 * getStats cadence. Fine enough that the RTP audio level can stand in for the orb when the remote
 * track cannot be analysed (and closes idle turns on time); cheap — one local call, no network.
 */
export const STATS_INTERVAL_MS = 250;
/** `session.thinking.append` takes up to 500 tokens; this many characters stays well inside. */
export const CONTEXT_MAX_CHARS = 1_200;

const EMPTY_DIAG: LiveVoiceDiag = {
  peer: null, ice: null, channel: null, micTrack: null, remoteAudio: false, playback: "none",
  sentBytes: null, receivedBytes: null, remoteLevel: null, events: {}, lastInputAt: null,
  lastOutputAt: null, lastErrorCode: null, contextSent: 0, contextAcked: 0,
};

export interface LiveVoiceDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeer: () => RTCPeerConnection;
  /** POSTs the offer to the back-end and returns GPT-Live's SDP answer. */
  exchangeOffer: (sdp: string, signal: AbortSignal) => Promise<{ sessionId: string; sdp: string }>;
  /** Where the assistant's voice plays. */
  audio: HTMLAudioElement;
}

/** ICE gathering and the whole startup are each bounded: a hung step must not hold the button. */
export const ICE_TIMEOUT_MS = 10_000;
export const START_TIMEOUT_MS = 20_000;
/** How long `stop` waits for `session.closed` (pending work drains) before tearing down anyway. */
export const CLOSE_TIMEOUT_MS = 15_000;

class Cancelled extends Error {}

const INITIAL: LiveVoiceSnapshot = {
  state: "idle", muted: false, turns: [], error: null, notice: null, diag: EMPTY_DIAG,
};

export class LiveVoiceSession {
  static readonly idleSnapshot: LiveVoiceSnapshot = INITIAL;
  private snap: LiveVoiceSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private remote: MediaStream | null = null;
  private abort: AbortController | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped on every start and teardown: callbacks from an older attempt are ignored. */
  private attempt = 0;
  private segmenter: TurnSegmenter | null = null;
  private readonly finalListeners = new Set<(turn: VoiceTurn) => void>();
  /** The assistant "speaking" by its transcript — the orb's last resort when no audio is measurable. */
  readonly speech = new EventEnvelope();

  constructor(private readonly deps: LiveVoiceDeps) {}

  snapshot = (): LiveVoiceSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The microphone stream while a conversation holds it — what the level meter listens to. */
  micStream(): MediaStream | null {
    return this.mic;
  }

  /** The assistant's audio stream once its track arrived — what the orb follows while it speaks. */
  remoteStream(): MediaStream | null {
    return this.remote;
  }

  /** Called with every turn that closes (a pause, the call ending). */
  onFinalTurn(listener: (turn: VoiceTurn) => void): () => void {
    this.finalListeners.add(listener);
    return () => this.finalListeners.delete(listener);
  }

  /**
   * Quiet context for the model — what was typed or answered in the chat during the call. GPT-Live
   * has no text input: `session.thinking.append` is the documented way to tell it something without
   * making it speak. Clipped to {@link CONTEXT_MAX_CHARS}. False when the call is not up.
   */
  appendContext(text: string): boolean {
    if (this.snap.state !== "live") return false;
    const flat = text.replace(/\s+/g, " ").trim();
    if (!flat) return false;
    const content = flat.length > CONTEXT_MAX_CHARS ? `${flat.slice(0, CONTEXT_MAX_CHARS - 1)}…` : flat;
    const ok = this.send({ type: "session.thinking.append", delegation_id: null, content });
    if (ok) this.setDiag({ contextSent: this.snap.diag.contextSent + 1 });
    return ok;
  }

  /** The person pressed "play" after the browser blocked autoplay. */
  resumePlayback(): void {
    void this.deps.audio.play().then(
      () => this.setDiag({ playback: "playing" }),
      () => this.setDiag({ playback: "blocked" }),
    );
  }

  private setDiag(patch: Partial<LiveVoiceDiag>): void {
    this.set({ diag: { ...this.snap.diag, ...patch } });
  }

  private set(patch: Partial<LiveVoiceSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(): Promise<void> {
    if (this.snap.state !== "idle" && this.snap.state !== "error") return;
    const attempt = ++this.attempt;
    const abort = new AbortController();
    this.abort = abort;
    this.segmenter = new TurnSegmenter(newCallId());
    this.speech.reset();
    this.set({ state: "connecting", muted: false, turns: [], error: null, notice: null, diag: EMPTY_DIAG });

    const alive = (): void => {
      if (attempt !== this.attempt || abort.signal.aborted) throw new Cancelled();
    };
    try {
      const mic = await this.deps.getUserMedia({
        // Echo cancellation keeps the assistant's own voice out of the mic — without it, it would
        // "interrupt" itself through the speakers.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (attempt !== this.attempt || abort.signal.aborted) {
        stopTracks(mic);
        throw new Cancelled();
      }
      this.mic = mic;
      // Bounded from the grant on: the time a person spends on the browser's permission prompt is
      // theirs (and "end call" still cancels it), the network handshake after it is not.
      this.startTimer = setTimeout(() => this.fail(attempt, "voice.err.startTimeout"), START_TIMEOUT_MS);
      const micTrack = mic.getAudioTracks()[0];
      this.setDiag({ micTrack: micTrack ? micTrack.readyState : null });
      micTrack?.addEventListener?.("ended", () => {
        if (attempt === this.attempt) this.setDiag({ micTrack: "ended" });
      });

      const peer = this.deps.createPeer();
      this.peer = peer;
      peer.addEventListener("track", (event) => {
        if (attempt !== this.attempt) return;
        if (event.track.kind !== "audio") return;
        this.remote = event.streams[0] ?? new MediaStream([event.track]);
        this.deps.audio.srcObject = this.remote;
        this.setDiag({ remoteAudio: true });
        void this.deps.audio.play().then(
          () => {
            if (attempt === this.attempt) this.setDiag({ playback: "playing" });
          },
          () => {
            if (attempt !== this.attempt) return;
            this.setDiag({ playback: "blocked" });
            this.set({ notice: "voice.notice.autoplay" });
          },
        );
      });
      peer.addEventListener("connectionstatechange", () => {
        if (attempt !== this.attempt) return;
        this.setDiag({ peer: peer.connectionState });
        if (peer.connectionState === "failed") this.fail(attempt, "voice.err.connectionLost");
      });
      peer.addEventListener("iceconnectionstatechange", () => {
        if (attempt === this.attempt) this.setDiag({ ice: peer.iceConnectionState });
      });
      this.setDiag({ peer: peer.connectionState ?? null, ice: peer.iceConnectionState ?? null });
      for (const track of mic.getAudioTracks()) peer.addTrack(track, mic);

      // The channel must exist before the offer, or it is not negotiated.
      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      channel.addEventListener("message", (event) => this.onEvent(attempt, event.data));
      channel.addEventListener("open", () => {
        if (attempt === this.attempt) this.setDiag({ channel: "open" });
      });
      channel.addEventListener("close", () => this.onChannelClosed(attempt));
      this.setDiag({ channel: channel.readyState ?? null });
      this.statsTimer = setInterval(() => void this.pollStats(attempt), STATS_INTERVAL_MS);

      await peer.setLocalDescription(await peer.createOffer());
      alive();
      await waitIceComplete(peer, abort.signal);
      alive();
      const offer = peer.localDescription?.sdp;
      if (!offer) throw new Error("voice.err.noOffer");

      const result = await this.deps.exchangeOffer(offer, abort.signal);
      alive();
      await peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
      // The HTTP request started the session: `session.started` arrives on the channel. Never send
      // `session.start` here.
    } catch (err) {
      if (err instanceof Cancelled || abort.signal.aborted) return;
      this.fail(attempt, errorMessage(err));
    }
  }

  /** Ends the conversation. While connecting it cancels outright; while live it closes gracefully. */
  stop(): void {
    const { state } = this.snap;
    if (state === "connecting") {
      this.teardown();
      this.set({ state: "idle" });
      return;
    }
    if (state !== "live") return;
    const attempt = this.attempt;
    if (!this.send({ type: "session.close" })) {
      this.teardown();
      this.set({ state: "idle" });
      return;
    }
    this.set({ state: "closing" });
    // Media and channel stay up while pending work drains; teardown waits for `session.closed`.
    this.closeTimer = setTimeout(() => {
      if (attempt !== this.attempt) return;
      this.teardown();
      this.set({ state: "idle", notice: "voice.notice.closeUnconfirmed" });
    }, CLOSE_TIMEOUT_MS);
  }

  /**
   * Mute stops the mic locally (the track sends silence — nothing leaves the machine) and tells
   * the model, so it does not wait on a silent caller.
   */
  setMuted(muted: boolean): void {
    if (this.snap.state !== "live") return;
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !muted;
    this.send({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" });
    this.set({ muted });
  }

  /** The page is going away: best-effort close, then release everything right now. */
  dispose(): void {
    if (this.snap.state === "live") this.send({ type: "session.close" });
    this.teardown();
    this.listeners.clear();
    this.finalListeners.clear();
  }

  private send(event: Record<string, unknown>): boolean {
    if (this.channel?.readyState !== "open") return false;
    try {
      this.channel.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  private onEvent(attempt: number, raw: unknown): void {
    if (attempt !== this.attempt) return;
    let event: {
      type?: unknown;
      delta?: unknown;
      start_ms?: unknown;
      end_ms?: unknown;
      error?: { message?: unknown; code?: unknown; type?: unknown };
      reason?: unknown;
    };
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof event.type === "string") {
      const type = event.type.slice(0, 60);
      this.setDiag({ events: { ...this.snap.diag.events, [type]: (this.snap.diag.events[type] ?? 0) + 1 } });
    }
    switch (event.type) {
      case "session.started":
        this.clearStartTimer();
        if (this.snap.state === "connecting") this.set({ state: "live" });
        break;
      case "session.closed":
        this.teardown();
        this.set({ state: "idle", notice: closedNotice(event.reason) });
        break;
      case "session.input_transcript.delta":
        this.setDiag({ lastInputAt: Date.now() });
        this.appendTranscript("user", event);
        break;
      case "session.output_transcript.delta":
        this.setDiag({ lastOutputAt: Date.now() });
        if (typeof event.delta === "string") this.speech.pulse(event.delta.length);
        this.appendTranscript("assistant", event);
        break;
      case "session.thinking.appended":
        this.setDiag({ contextAcked: this.snap.diag.contextAcked + 1 });
        break;
      case "session.input_audio.muted":
        this.set({ muted: true });
        break;
      case "session.input_audio.unmuted":
        this.set({ muted: false });
        break;
      case "error": {
        const message = typeof event.error?.message === "string" ? event.error.message : "voice.err.generic";
        const code = event.error?.code ?? event.error?.type;
        this.setDiag({ lastErrorCode: typeof code === "string" ? code.slice(0, 80) : "error" });
        // A startup error means `session.started` never comes; after that, an error (a refused
        // command, moderation cutting a reply) does not end the session.
        if (this.snap.state === "connecting") this.fail(attempt, message);
        else this.set({ notice: message });
        break;
      }
      default:
        break;
    }
  }

  /** Audio RTP counters from getStats: did audio leave, did audio arrive, how loud is the model. */
  private async pollStats(attempt: number): Promise<void> {
    const peer = this.peer;
    if (!peer?.getStats || attempt !== this.attempt) return;
    let report: RTCStatsReport;
    try {
      report = await peer.getStats();
    } catch {
      return;
    }
    if (attempt !== this.attempt) return;
    const patch: Partial<LiveVoiceDiag> = {};
    report.forEach((stat: Record<string, unknown>) => {
      if (stat.kind !== "audio") return;
      if (stat.type === "outbound-rtp" && typeof stat.bytesSent === "number") patch.sentBytes = stat.bytesSent;
      if (stat.type === "inbound-rtp") {
        if (typeof stat.bytesReceived === "number") patch.receivedBytes = stat.bytesReceived;
        if (typeof stat.audioLevel === "number") patch.remoteLevel = stat.audioLevel;
      }
    });
    if (this.mic) {
      const track = this.mic.getAudioTracks()[0];
      if (track) patch.micTrack = track.readyState;
    }
    this.setDiag(patch);
    this.closeIdleTurns();
  }

  private closeIdleTurns(): void {
    const closed = this.segmenter?.tick(Date.now()) ?? [];
    if (closed.length > 0) this.publishTurns(closed);
  }

  /** New snapshot of the turns, then the closed ones to the listeners. */
  private publishTurns(closed: VoiceTurn[]): void {
    if (this.segmenter) this.set({ turns: this.segmenter.turns.slice() });
    for (const turn of closed) for (const listener of this.finalListeners) listener(turn);
  }

  private onChannelClosed(attempt: number): void {
    if (attempt !== this.attempt) return;
    const wasClosing = this.snap.state === "closing";
    if (this.snap.state === "idle" || this.snap.state === "error") return;
    if (wasClosing) {
      this.teardown();
      this.set({ state: "idle", notice: "voice.notice.closeUnconfirmed" });
    } else {
      this.fail(attempt, "voice.err.disconnected");
    }
  }

  /** Fragments carry no turn id: the segmenter settles them into turns (./voiceTurns.ts). */
  private appendTranscript(role: VoiceTurn["role"], event: { delta?: unknown; start_ms?: unknown; end_ms?: unknown }): void {
    if (typeof event.delta !== "string" || !event.delta || !this.segmenter) return;
    const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const closed = this.segmenter.push(role, event.delta, Date.now(), ms(event.start_ms), ms(event.end_ms));
    this.publishTurns(closed);
  }

  private fail(attempt: number, message: string): void {
    if (attempt !== this.attempt) return;
    this.teardown();
    this.set({ state: "error", error: message });
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private teardown(): void {
    this.attempt++;
    // Whatever was being said when the call ended is a turn too — closed before anything else goes.
    const closed = this.segmenter?.flush() ?? [];
    if (closed.length > 0) this.publishTurns(closed);
    this.segmenter = null;
    this.speech.reset();
    this.clearStartTimer();
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.abort?.abort();
    this.abort = null;
    if (this.mic) stopTracks(this.mic);
    this.mic = null;
    this.remote = null;
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
    try {
      this.peer?.close();
    } catch {
      /* already closed */
    }
    this.peer = null;
    this.deps.audio.pause?.();
    this.deps.audio.srcObject = null;
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** The offer is only complete (every candidate in it) once ICE gathering finishes. */
function waitIceComplete(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (err?: Error): void => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onState);
      signal.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onState = (): void => {
      if (peer.iceGatheringState === "complete") done();
    };
    const onAbort = (): void => done(new Cancelled());
    const timer = setTimeout(() => done(new Error("voice.err.iceTimeout")), ICE_TIMEOUT_MS);
    peer.addEventListener("icegatheringstatechange", onState);
    signal.addEventListener("abort", onAbort);
  });
}

function closedNotice(reason: unknown): string | null {
  switch (reason) {
    case "expired":
      return "voice.notice.expired";
    case "content":
      return "voice.notice.moderation";
    case "remote_hangup":
    case "connection_lost":
      return "voice.notice.remoteEnded";
    default:
      return null;
  }
}

/** What the person reads: the back-end's `{ error }` when there is one, the browser's otherwise. */
export function errorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { error?: unknown } } })?.response?.data;
  if (typeof data?.error === "string") return data.error;
  const name = (err as { name?: unknown })?.name;
  if (name === "NotAllowedError") return "voice.err.micDenied";
  if (name === "NotFoundError") return "voice.err.noMic";
  return err instanceof Error && err.message ? err.message : "voice.err.generic";
}

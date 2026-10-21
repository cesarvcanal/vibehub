/**
 * VOICE MODE (POC) — the browser half of a GPT-Live conversation.
 *
 * The microphone goes out on a WebRTC media track and the assistant's voice comes back on another;
 * JSON events ride the `oai-events` data channel. The back-end only trades the SDP offer for the
 * answer (it holds the API key): after that, audio flows browser ↔ OpenAI and never through us.
 * GPT-Live is full duplex, so turn-taking and barge-in are the model's — the mic simply stays open.
 *
 * Every exit path (stop, cancel while connecting, startup error, dropped connection, unmount) runs
 * the same {@link LiveVoiceSession.teardown}: microphone released, channel and peer closed.
 * Nothing here logs audio or events.
 */

export type LiveVoiceState = "idle" | "connecting" | "live" | "closing" | "error";

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface LiveVoiceSnapshot {
  state: LiveVoiceState;
  muted: boolean;
  transcript: TranscriptEntry[];
  /**
   * The last failure, cleared on the next start: an i18n key (`voice.err.*`) for what the browser
   * knows, or the server's message verbatim — `t()` passes an unknown key straight through.
   */
  error: string | null;
  /** A non-fatal notice (moderation cut the reply, the close was not confirmed…), same shape. */
  notice: string | null;
}

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

/** Cap on the transcript kept on screen — a long conversation must not grow the page forever. */
const TRANSCRIPT_MAX = 200;

class Cancelled extends Error {}

const INITIAL: LiveVoiceSnapshot = { state: "idle", muted: false, transcript: [], error: null, notice: null };

export class LiveVoiceSession {
  private snap: LiveVoiceSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private abort: AbortController | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every start and teardown: callbacks from an older attempt are ignored. */
  private attempt = 0;

  constructor(private readonly deps: LiveVoiceDeps) {}

  snapshot = (): LiveVoiceSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<LiveVoiceSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(): Promise<void> {
    if (this.snap.state !== "idle" && this.snap.state !== "error") return;
    const attempt = ++this.attempt;
    const abort = new AbortController();
    this.abort = abort;
    this.set({ state: "connecting", muted: false, transcript: [], error: null, notice: null });
    this.startTimer = setTimeout(() => this.fail(attempt, "voice.err.startTimeout"), START_TIMEOUT_MS);

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

      const peer = this.deps.createPeer();
      this.peer = peer;
      peer.addEventListener("track", (event) => {
        if (attempt !== this.attempt) return;
        this.deps.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void this.deps.audio.play().catch(() => {
          this.set({ notice: "voice.notice.autoplay" });
        });
      });
      peer.addEventListener("connectionstatechange", () => {
        if (peer.connectionState === "failed") this.fail(attempt, "voice.err.connectionLost");
      });
      for (const track of mic.getAudioTracks()) peer.addTrack(track, mic);

      // The channel must exist before the offer, or it is not negotiated.
      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      channel.addEventListener("message", (event) => this.onEvent(attempt, event.data));
      channel.addEventListener("close", () => this.onChannelClosed(attempt));

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
    let event: { type?: unknown; delta?: unknown; error?: { message?: unknown }; reason?: unknown };
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
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
        this.appendTranscript("user", event.delta);
        break;
      case "session.output_transcript.delta":
        this.appendTranscript("assistant", event.delta);
        break;
      case "session.input_audio.muted":
        this.set({ muted: true });
        break;
      case "session.input_audio.unmuted":
        this.set({ muted: false });
        break;
      case "error": {
        const message = typeof event.error?.message === "string" ? event.error.message : "voice.err.generic";
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

  /** Transcript deltas carry no turn id: consecutive fragments of one speaker form one bubble. */
  private appendTranscript(role: TranscriptEntry["role"], delta: unknown): void {
    if (typeof delta !== "string" || !delta) return;
    const transcript = this.snap.transcript.slice();
    const last = transcript[transcript.length - 1];
    if (last && last.role === role) transcript[transcript.length - 1] = { role, text: last.text + delta };
    else transcript.push({ role, text: delta });
    this.set({ transcript: transcript.slice(-TRANSCRIPT_MAX) });
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
    this.clearStartTimer();
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.abort?.abort();
    this.abort = null;
    if (this.mic) stopTracks(this.mic);
    this.mic = null;
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

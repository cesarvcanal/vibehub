import type { LiveVoiceDeps } from "./liveVoice";

/**
 * A browser media stack small enough to drive by hand: the peer, its `oai-events` channel and the
 * microphone. jsdom has no WebRTC, and the voice mode is mostly lifecycle — this is what lets the
 * tests reach every exit path without a real network or a real microphone.
 */

export class FakeTrack extends EventTarget {
  kind = "audio";
  enabled = true;
  stopped = false;
  readyState: MediaStreamTrackState = "live";
  stop(): void {
    this.stopped = true;
    this.readyState = "ended";
  }
}

export class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
}

export class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  readonly sent: Record<string, unknown>[] = [];
  constructor(readonly label: string) {
    super();
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
  /** The server side: the channel opened. */
  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
  /** The server side: an event arrives. */
  emit(event: Record<string, unknown>): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
  }
}

export class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  /** What getStats reports — set by the test. */
  stats: Record<string, unknown>[] = [];
  async getStats(): Promise<{ forEach: (fn: (s: Record<string, unknown>) => void) => void }> {
    return { forEach: (fn) => this.stats.forEach(fn) };
  }
  connect(): void {
    this.iceConnectionState = "connected";
    this.dispatchEvent(new Event("iceconnectionstatechange"));
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  /** The stream the model's audio arrives on — what the orb's analyser listens to. */
  readonly remoteStream = { id: "remote-audio" };
  /** The model's audio track arrives. */
  remoteTrack(): void {
    this.dispatchEvent(Object.assign(new Event("track"), { track: { kind: "audio" }, streams: [this.remoteStream] }));
  }
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  channel: FakeChannel | null = null;
  readonly tracks: unknown[] = [];
  closed = false;
  addTrack(track: unknown): void {
    this.tracks.push(track);
  }
  createDataChannel(label: string): FakeChannel {
    this.channel = new FakeChannel(label);
    return this.channel;
  }
  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.localDescription = desc;
  }
  async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = desc;
  }
  close(): void {
    this.closed = true;
    this.channel?.close();
  }
  fail(): void {
    this.connectionState = "failed";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

export interface FakeRig {
  deps: LiveVoiceDeps;
  peer: () => FakePeer;
  mic: () => FakeStream;
  exchanges: { sdp: string; signal: AbortSignal }[];
  audio: { srcObject: unknown; play: () => Promise<void>; pause: () => void };
}

export interface FakeRigOptions {
  getUserMedia?: () => Promise<FakeStream>;
  exchangeOffer?: (sdp: string, signal: AbortSignal) => Promise<{ sessionId: string; sdp: string }>;
}

export function fakeRig(options: FakeRigOptions = {}): FakeRig {
  let peer: FakePeer | null = null;
  let mic: FakeStream | null = null;
  const exchanges: FakeRig["exchanges"] = [];
  const audio = { srcObject: null as unknown, play: async () => undefined, pause: () => undefined };
  const deps = {
    getUserMedia: async () => {
      mic = options.getUserMedia ? await options.getUserMedia() : new FakeStream();
      return mic as unknown as MediaStream;
    },
    createPeer: () => {
      peer = new FakePeer();
      return peer as unknown as RTCPeerConnection;
    },
    exchangeOffer: async (sdp: string, signal: AbortSignal) => {
      exchanges.push({ sdp, signal });
      const result = options.exchangeOffer
        ? await options.exchangeOffer(sdp, signal)
        : { sessionId: "live_1", sdp: "v=0 answer" };
      peer?.channel?.open();
      return result;
    },
    audio: audio as unknown as HTMLAudioElement,
  } satisfies LiveVoiceDeps;
  return {
    deps,
    peer: () => {
      if (!peer) throw new Error("no peer yet");
      return peer;
    },
    mic: () => {
      if (!mic) throw new Error("no mic yet");
      return mic;
    },
    exchanges,
    audio,
  };
}

/**
 * Web Audio, small enough to drive by hand: each stream the call measures plays whatever signal the
 * test sets (a sine of some amplitude, exact zeros, nothing). Lets a test prove that the orb follows
 * the ASSISTANT's track while it replies — and never the microphone.
 */
export class FakeAudioContext {
  state: AudioContextState = "running";
  closed = false;
  resumed = 0;
  readonly signals = new Map<unknown, number | "dead">();
  readonly sources: { stream: unknown; connected: boolean }[] = [];

  createMediaStreamSource(stream: unknown) {
    const source = {
      stream,
      connected: false,
      connect: (analyser: { stream?: unknown }) => {
        analyser.stream = stream;
        source.connected = true;
      },
      disconnect: () => {
        source.connected = false;
      },
    };
    this.sources.push(source);
    return source;
  }

  createAnalyser() {
    const analyser = {
      fftSize: 2048,
      smoothingTimeConstant: 0.8,
      stream: undefined as unknown,
      getFloatTimeDomainData: (buf: Float32Array) => {
        const signal = this.signals.get(analyser.stream);
        if (signal === undefined || signal === "dead") {
          buf.fill(0);
          return;
        }
        // A little noise under the tone: real audio is never exact zeros.
        for (let i = 0; i < buf.length; i++) buf[i] = signal * Math.sin(i / 3) + (i % 2 ? 1e-5 : -1e-5);
      },
    };
    return analyser;
  }

  /** The stream plays a tone of this amplitude (0..1), or exact digital zeros. */
  play(stream: unknown, amplitude: number | "dead"): void {
    this.signals.set(stream, amplitude);
  }

  resume(): Promise<void> {
    this.resumed += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
}

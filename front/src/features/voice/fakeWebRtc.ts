import type { LiveVoiceDeps } from "./liveVoice";

/**
 * A browser media stack small enough to drive by hand: the peer, its `oai-events` channel and the
 * microphone. jsdom has no WebRTC, and the voice mode is mostly lifecycle — this is what lets the
 * tests reach every exit path without a real network or a real microphone.
 */

export class FakeTrack {
  enabled = true;
  stopped = false;
  stop(): void {
    this.stopped = true;
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
  }
  /** The server side: an event arrives. */
  emit(event: Record<string, unknown>): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
  }
}

export class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
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

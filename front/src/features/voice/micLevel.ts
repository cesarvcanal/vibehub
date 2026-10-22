import * as React from "react";

/**
 * The LOCAL microphone's level, read with Web Audio. It says the browser is capturing sound; it
 * does NOT say the model received it — that is the RTP bytes sent and the model's transcription,
 * shown separately on the page.
 *
 * The analyser taps the same MediaStream that goes to the peer connection, but nothing is
 * connected to the destination: it is listened to, never played, never recorded.
 */

/** Above this RMS the mic is "picking up sound" (speech sits around 0.02–0.2). */
export const SIGNAL_THRESHOLD = 0.02;
/** How often the level is sampled — ~20 fps is smooth for a meter and cheap for React. */
export const LEVEL_INTERVAL_MS = 50;

/** RMS (0..1) of unsigned 8-bit time-domain samples centred on 128. PURE. */
export function rmsLevel(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) {
    const v = (s - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** RMS → 0..1 for drawing: speech should fill most of the meter, not a tenth of it. PURE. */
export function displayLevel(rms: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, rms)) * 2);
}

export type MakeAudioContext = () => AudioContext;

function defaultContext(): AudioContext {
  return new AudioContext();
}

/**
 * The RMS level of `stream`, or null when there is no stream or no Web Audio. Releases its
 * AudioContext when the stream changes or the component unmounts.
 */
export function useMicLevel(stream: MediaStream | null, makeContext: MakeAudioContext = defaultContext): number | null {
  const [level, setLevel] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setLevel(null);
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = makeContext();
    } catch {
      setLevel(null);
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    // Created after the click that started the conversation, so resuming is allowed.
    void ctx.resume?.().catch(() => undefined);
    const buf = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      setLevel(rmsLevel(buf));
    }, LEVEL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      source.disconnect();
      void ctx.close?.().catch(() => undefined);
      setLevel(null);
    };
  }, [stream, makeContext]);

  return level;
}

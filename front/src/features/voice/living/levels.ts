/**
 * Sound → how much the living orb reacts, as V37 read its own analyser — what the /voice/lab's
 * microphone uses. A live call calibrates both sources in ../audioLevel.ts (gate, window, curve,
 * envelope) instead.
 */

/** Microphone RMS → 0..1, exactly as V37 read its analyser (`min(1, rms * 5)`). PURE. */
export function micVoice(rms: number): number {
  return Math.min(1, Math.max(0, rms) * 5);
}

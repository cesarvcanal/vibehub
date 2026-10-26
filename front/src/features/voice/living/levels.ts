/**
 * Sound → how much the living orb reacts. Two sources, never mixed: the PERSON's microphone drives
 * the listening sphere, the ASSISTANT's audio drives the replying one.
 */

/** Microphone RMS → 0..1, exactly as V37 read its analyser (`min(1, rms * 5)`). PURE. */
export function micVoice(rms: number): number {
  return Math.min(1, Math.max(0, rms) * 5);
}

/**
 * The assistant's audio level → 0..1. Same curve as the microphone, scaled down: V37 calibrated the
 * replying sphere on a demonstration signal that peaked around 0.35, and real speech at full scale
 * would open it far beyond what was approved. PURE.
 */
export const AI_GAIN = 0.6;
export function aiVoice(level: number): number {
  return micVoice(level) * AI_GAIN;
}

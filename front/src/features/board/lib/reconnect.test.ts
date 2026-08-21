import { describe, expect, it } from "vitest";
import {
  RECONNECT_BASE_MS,
  RECONNECT_JITTER,
  RECONNECT_MAX_MS,
  reconnectDelay,
} from "@/features/board/lib/reconnect";

describe("reconnectDelay", () => {
  it("retries almost immediately the first time — a blip should be invisible", () => {
    expect(reconnectDelay(0)).toBe(RECONNECT_BASE_MS);
  });

  it("doubles each attempt", () => {
    expect(reconnectDelay(1)).toBe(RECONNECT_BASE_MS * 2);
    expect(reconnectDelay(2)).toBe(RECONNECT_BASE_MS * 4);
    expect(reconnectDelay(3)).toBe(RECONNECT_BASE_MS * 8);
  });

  it("stops growing at the ceiling and stays there", () => {
    expect(reconnectDelay(20)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(1_000)).toBe(RECONNECT_MAX_MS);
  });

  it("never overflows to Infinity on a long outage", () => {
    expect(Number.isFinite(reconnectDelay(Number.MAX_SAFE_INTEGER))).toBe(true);
  });

  it("treats nonsense attempts as the first one", () => {
    expect(reconnectDelay(-5)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelay(Number.NaN)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelay(1.9)).toBe(RECONNECT_BASE_MS * 2);
  });

  it("adds jitter only when a source of randomness is supplied", () => {
    expect(reconnectDelay(2, () => 0)).toBe(RECONNECT_BASE_MS * 4);
    expect(reconnectDelay(2, () => 1)).toBe(Math.round(RECONNECT_BASE_MS * 4 * (1 + RECONNECT_JITTER)));
  });

  it("keeps jittered delays inside one jitter of the geometric value", () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const plain = reconnectDelay(attempt);
      const jittered = reconnectDelay(attempt, Math.random);
      expect(jittered).toBeGreaterThanOrEqual(plain);
      expect(jittered).toBeLessThanOrEqual(Math.round(plain * (1 + RECONNECT_JITTER)));
    }
  });
});

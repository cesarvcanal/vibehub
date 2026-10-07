import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECONNECT_BASE_MS,
  RECONNECT_JITTER,
  RECONNECT_MAX_MS,
  STABLE_CONNECTION_MS,
  createReconnectBackoff,
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

/**
 * THE HANDSHAKE IS NOT HEALTH. The back accepts the websocket and only THEN finds out it cannot
 * serve it (the driver setting is off, the card was deleted, the driver install failed) — it sends
 * an error and closes. Resetting the backoff on the bare `open` turned that into a reconnect at
 * ~2Hz forever, each one paying the whole server-side setup again.
 */
describe("createReconnectBackoff", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ratchets on every retry", () => {
    const backoff = createReconnectBackoff();
    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(RECONNECT_BASE_MS);
    expect(backoff.next()).toBe(RECONNECT_BASE_MS * 2);
    expect(backoff.attempt).toBe(2);
  });

  it("an open that dies before it proves itself does NOT reset the backoff", () => {
    const backoff = createReconnectBackoff();
    backoff.next();
    backoff.next();
    backoff.opened();
    vi.advanceTimersByTime(STABLE_CONNECTION_MS - 1);
    backoff.closed();
    vi.advanceTimersByTime(STABLE_CONNECTION_MS);
    expect(backoff.attempt).toBe(2);
    expect(backoff.next()).toBe(RECONNECT_BASE_MS * 4);
  });

  it("an open that HOLDS for the stability window resets to the first, fast retry", () => {
    const backoff = createReconnectBackoff();
    backoff.next();
    backoff.next();
    backoff.opened();
    vi.advanceTimersByTime(STABLE_CONNECTION_MS);
    expect(backoff.attempt).toBe(0);
    backoff.closed();
    expect(backoff.next()).toBe(RECONNECT_BASE_MS);
  });

  it("an explicit proof of health (the server's own `ready`) resets at once", () => {
    const backoff = createReconnectBackoff();
    backoff.next();
    backoff.healthy();
    expect(backoff.attempt).toBe(0);
  });

  it("dispose drops the pending stability timer", () => {
    const backoff = createReconnectBackoff();
    backoff.next();
    backoff.opened();
    backoff.dispose();
    vi.advanceTimersByTime(STABLE_CONNECTION_MS);
    expect(backoff.attempt).toBe(1);
  });

  it("adds the jitter of the source it was given", () => {
    const backoff = createReconnectBackoff(() => 1);
    expect(backoff.next()).toBe(Math.round(RECONNECT_BASE_MS * (1 + RECONNECT_JITTER)));
  });
});

import { describe, expect, it } from "vitest";
import { normalizeRateLimit } from "./rateLimit.js";

describe("normalizeRateLimit", () => {
  it("turns the CLI's fraction and epoch seconds into percent and ms", () => {
    expect(normalizeRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91, resetsAt: 1_792_440_000 }))
      .toEqual({ status: "allowed_warning", window: "five_hour", utilization: 91, resetsAt: 1_792_440_000_000 });
  });

  it("keeps values already in percent and ms, clamped to 0..100", () => {
    expect(normalizeRateLimit({ status: "rejected", window: "seven_day", utilization: 140, resetsAt: 1_792_440_000_000 }))
      .toEqual({ status: "rejected", window: "seven_day", utilization: 100, resetsAt: 1_792_440_000_000 });
  });

  it("drops what it cannot use instead of inventing it", () => {
    expect(normalizeRateLimit({ status: "allowed", window: "five_hour", utilization: "x", resetsAt: -1 }))
      .toEqual({ status: "allowed", window: "five_hour" });
    expect(normalizeRateLimit({ status: "nope", window: "five_hour" })).toBeNull();
    expect(normalizeRateLimit({ status: "allowed" })).toBeNull();
    expect(normalizeRateLimit(null)).toBeNull();
  });
});

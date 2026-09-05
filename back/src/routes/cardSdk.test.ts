import { describe, it, expect } from "vitest";
import { parseSdkClientFrame } from "./cardSdk.js";

// The driver↔socket wiring moved to services/sdk/manager.ts (one card-owned driver, multiplexed
// sockets) — its behavior is pinned by services/sdk/manager.test.ts. What stays here is the pure
// frame parser this route re-exports.

describe("parseSdkClientFrame", () => {
  it("treats a bare string as a user message", () => {
    expect(parseSdkClientFrame("build the thing")).toEqual({ type: "user", text: "build the thing" });
  });

  it("skips blank frames", () => {
    expect(parseSdkClientFrame("")).toBeNull();
    expect(parseSdkClientFrame("   ")).toBeNull();
  });

  it("parses an explicit user control object", () => {
    expect(parseSdkClientFrame(`{"type":"user","text":"oi"}`)).toEqual({ type: "user", text: "oi" });
  });

  it("parses an interrupt control", () => {
    expect(parseSdkClientFrame(`{"type":"interrupt"}`)).toEqual({ type: "interrupt" });
  });

  it("rejects a malformed control object rather than mis-sending it", () => {
    expect(parseSdkClientFrame(`{"type":"user"}`)).toBeNull();
    expect(parseSdkClientFrame(`{"type":"weird"}`)).toBeNull();
  });

  it("treats a message that merely starts with { but is not JSON as text", () => {
    expect(parseSdkClientFrame("{not json")).toEqual({ type: "user", text: "{not json" });
  });
});

describe("parseSdkClientFrame — permission decisions (increment 2)", () => {
  it("passes a well-formed permission_decision through to the driver", () => {
    expect(parseSdkClientFrame(`{"type":"permission_decision","id":"perm_1","allow":true}`)).toEqual({
      type: "permission_decision",
      id: "perm_1",
      allow: true,
    });
    expect(parseSdkClientFrame(`{"type":"permission_decision","id":"perm_2","allow":false}`)).toEqual({
      type: "permission_decision",
      id: "perm_2",
      allow: false,
    });
  });

  it("rejects a malformed decision (missing id, non-boolean allow) rather than guessing", () => {
    expect(parseSdkClientFrame(`{"type":"permission_decision","allow":true}`)).toBeNull();
    expect(parseSdkClientFrame(`{"type":"permission_decision","id":"perm_1"}`)).toBeNull();
    expect(parseSdkClientFrame(`{"type":"permission_decision","id":"perm_1","allow":"yes"}`)).toBeNull();
  });
});

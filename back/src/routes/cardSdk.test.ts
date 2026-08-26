import { describe, it, expect } from "vitest";
import { parseSdkClientFrame } from "./cardSdk.js";

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

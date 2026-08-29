import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, expect } from "vitest";
import { parseSdkClientFrame, bridgeSdkDriver } from "./cardSdk.js";

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

describe("bridgeSdkDriver — session id persistence", () => {
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { /* test double */ };
    return child;
  }
  function fakeSocket() {
    const socket = new EventEmitter() as EventEmitter & { sent: string[]; send: (s: string) => void; close: () => void };
    socket.sent = [];
    socket.send = (s: string) => socket.sent.push(s);
    socket.close = () => { /* test double */ };
    return socket;
  }

  it("reports each NEW session id exactly once (session and result frames deduplicated)", async () => {
    const child = fakeChild();
    const socket = fakeSocket();
    const seen: string[] = [];
    bridgeSdkDriver(socket as never, child as never, "t", (id) => seen.push(id));
    child.stdout.write(`{"type":"session","sessionId":"aaaa"}\n`);
    child.stdout.write(`{"type":"result","isError":false,"sessionId":"aaaa"}\n`); // same id: no re-persist
    child.stdout.write(`{"type":"result","isError":false,"sessionId":"bbbb"}\n`); // new id: persist again
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(["aaaa", "bbbb"]);
    // and every frame still reached the socket untouched
    expect(socket.sent.length).toBe(3);
    socket.emit("close");
  });

  it("does not call the persister for events without a session id", async () => {
    const child = fakeChild();
    const socket = fakeSocket();
    const seen: string[] = [];
    bridgeSdkDriver(socket as never, child as never, "t", (id) => seen.push(id));
    child.stdout.write(`{"type":"ready"}\n`);
    child.stdout.write(`{"type":"assistant_text","text":"oi"}\n`);
    child.stdout.write(`{"type":"permission_request","id":"perm_1","tool":"Bash"}\n`);
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([]);
    expect(socket.sent.length).toBe(3);
    socket.emit("close");
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer } from "node:http";
import { CallbackError, WEBHOOK_NET, assertCallbackUrl, isPublicAddress, postWebhook } from "./net.js";
import { startTestReceiver, type TestReceiver } from "./testReceiver.js";

/**
 * The outbound side of MCP Events webhooks: the server POSTs to a URL a CLIENT chose. Without these
 * rules that is an SSRF primitive — vibehub could be made to hit its own runner, the VPN, the cloud
 * metadata endpoint. Every case here is one the spec names (https only, non-public addresses
 * blocked, DNS checked at CONNECT time, no redirects, bounded time).
 */

const defaults = { ...WEBHOOK_NET };
afterEach(() => Object.assign(WEBHOOK_NET, defaults));

describe("isPublicAddress — IANA special-purpose registries", () => {
  it.each([
    "127.0.0.1", "127.8.9.10", "10.0.0.1", "10.8.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "0.1.2.3", "192.0.0.8", "192.0.2.10", "198.18.0.1",
    "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1",
    "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "100::1", "2001::1", "3fff::1",
  ])("blocks %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "104.18.0.1", "2606:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8"])(
    "allows %s", (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );

  it("treats garbage as not public", () => {
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });
});

describe("assertCallbackUrl — what a subscription may point at", () => {
  it("accepts an https URL", () => {
    expect(assertCallbackUrl("https://receiver.example.com/mcp-events/callback_123").hostname).toBe("receiver.example.com");
  });
  it.each([
    ["http://receiver.example.com/x", /https/],
    ["ftp://receiver.example.com/x", /https/],
    ["https://user:pw@receiver.example.com/x", /credentials/],
    ["not a url", /valid URL/],
    ["https://127.0.0.1/x", /public/],
    ["https://[::1]/x", /public/],
    ["https://10.0.0.5/x", /public/],
    ["https://localhost/x", /public/],
  ])("refuses %s", (url, why) => {
    expect(() => assertCallbackUrl(url)).toThrow(why);
  });
});

describe("postWebhook — the hardened POST", () => {
  let receiver: TestReceiver;
  beforeAll(async () => { receiver = await startTestReceiver(); });
  afterAll(async () => { await receiver.close(); });
  afterEach(() => { receiver.received.length = 0; });

  /** A resolver that says `receiver.test` is the loopback receiver. */
  const toLoopback = async () => ["127.0.0.1"];

  it("connects to the VALIDATED address while TLS still checks the original hostname (SNI)", async () => {
    Object.assign(WEBHOOK_NET, { allowPrivate: true, resolve: toLoopback, ca: receiver.cert });
    const res = await postWebhook(receiver.url("receiver.test"), { "content-type": "application/json" }, "{\"a\":1}");
    expect(res.status).toBe(200);
    expect(receiver.received[0]!.body).toBe("{\"a\":1}");
    expect(receiver.received[0]!.servername).toBe("receiver.test");
    expect(receiver.received[0]!.headers.host).toBe(`receiver.test:${receiver.port}`);
  });

  it("refuses a hostname that resolves to a private address (checked at connect, not only at subscribe)", async () => {
    Object.assign(WEBHOOK_NET, { allowPrivate: false, resolve: toLoopback, ca: receiver.cert });
    await expect(postWebhook(receiver.url("receiver.test"), {}, "{}")).rejects.toMatchObject({ reason: "blocked_address" });
    expect(receiver.received).toHaveLength(0);
  });

  it("DNS rebinding: public at the first lookup, private at the next — the second connect is refused", async () => {
    let calls = 0;
    // First answer is public (TEST: it may not answer — only "not blocked" matters), then loopback.
    Object.assign(WEBHOOK_NET, {
      allowPrivate: false, ca: receiver.cert, timeoutMs: 300,
      resolve: async () => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]),
    });
    const first = await postWebhook(receiver.url("receiver.test"), {}, "{}").catch((e: CallbackError) => e);
    expect((first as CallbackError).reason).not.toBe("blocked_address");
    await expect(postWebhook(receiver.url("receiver.test"), {}, "{}")).rejects.toMatchObject({ reason: "blocked_address" });
    expect(calls).toBe(2); // resolved again on the second connect: no cached answer to rebind around
    expect(receiver.received).toHaveLength(0);
  });

  it("refuses when ANY resolved address is private (a mixed answer is a rebinding vector)", async () => {
    Object.assign(WEBHOOK_NET, { allowPrivate: false, ca: receiver.cert, resolve: async () => ["93.184.216.34", "10.0.0.1"] });
    await expect(postWebhook(receiver.url("receiver.test"), {}, "{}")).rejects.toMatchObject({ reason: "blocked_address" });
  });

  it("does NOT follow redirects: a 302 is the answer, the Location is never requested", async () => {
    Object.assign(WEBHOOK_NET, { allowPrivate: true, resolve: toLoopback, ca: receiver.cert });
    receiver.respond = () => ({ status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    const res = await postWebhook(receiver.url("receiver.test"), {}, "{}");
    expect(res.status).toBe(302);
    expect(receiver.received).toHaveLength(1);
    receiver.respond = () => ({ status: 200, body: "{}" });
  });

  it("times out a receiver that never answers", async () => {
    Object.assign(WEBHOOK_NET, { allowPrivate: true, resolve: toLoopback, ca: receiver.cert, timeoutMs: 150 });
    receiver.respond = () => new Promise(() => undefined);
    await expect(postWebhook(receiver.url("receiver.test"), {}, "{}")).rejects.toMatchObject({ reason: "timeout" });
    receiver.respond = () => ({ status: 200, body: "{}" });
  });

  it("reports a certificate it cannot trust as tls_error", async () => {
    Object.assign(WEBHOOK_NET, { allowPrivate: true, resolve: toLoopback, ca: undefined });
    await expect(postWebhook(receiver.url("receiver.test"), {}, "{}")).rejects.toMatchObject({ reason: "tls_error" });
  });

  it("reports a closed port as connection_refused", async () => {
    const plain = createServer();
    await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
    const port = (plain.address() as { port: number }).port;
    await new Promise<void>((r) => plain.close(() => r()));
    Object.assign(WEBHOOK_NET, { allowPrivate: true, resolve: toLoopback });
    const err = await postWebhook(`https://receiver.test:${port}/x`, {}, "{}").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallbackError);
    expect((err as CallbackError).reason).toBe("connection_refused");
  });

  it("reads at most a bounded response body", async () => {
    Object.assign(WEBHOOK_NET, { allowPrivate: true, resolve: toLoopback, ca: receiver.cert, maxResponseBytes: 32 });
    receiver.respond = () => ({ status: 200, body: "x".repeat(10_000) });
    const res = await postWebhook(receiver.url("receiver.test"), {}, "{}");
    expect(res.body.length).toBeLessThanOrEqual(32);
    receiver.respond = () => ({ status: 200, body: "{}" });
  });
});

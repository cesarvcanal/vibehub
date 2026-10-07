import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * The runner's container name is interpolated into shell scripts everywhere (`docker exec`,
 * `docker ps -f name=^…$`). It comes from the environment, so it is validated where it is read:
 * a bad value stops vibehub at boot with a message that names the variable, instead of reaching a
 * shell — or merely producing docker errors nobody can trace back to a typo.
 */

const ORIGINAL = process.env.VIBEHUB_RUNNER_CONTAINER;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.VIBEHUB_RUNNER_CONTAINER;
  else process.env.VIBEHUB_RUNNER_CONTAINER = ORIGINAL;
  vi.resetModules();
});

async function loadWith(container: string | undefined) {
  vi.resetModules();
  if (container === undefined) delete process.env.VIBEHUB_RUNNER_CONTAINER;
  else process.env.VIBEHUB_RUNNER_CONTAINER = container;
  return await import("./env.js");
}

describe("VIBEHUB_RUNNER_CONTAINER", () => {
  it("defaults to vibehub-runner", async () => {
    expect((await loadWith(undefined)).config.runner.container).toBe("vibehub-runner");
  });

  it("accepts a docker container name", async () => {
    expect((await loadWith("my_runner.2-b")).config.runner.container).toBe("my_runner.2-b");
  });

  it("REFUSES anything a shell would read as more than a name", async () => {
    for (const bad of ["x; rm -rf /", 'a"$(id)"', "-flag", "with space", "a'b", ".hidden"]) {
      await expect(loadWith(bad)).rejects.toThrow(/VIBEHUB_RUNNER_CONTAINER/);
    }
  });
});

/**
 * VIBEHUB_TRUST_PROXY decides what `req.ip` is — the key of the sign-in ceilings. Unset must stay
 * "trust nobody": a direct install that honoured X-Forwarded-For would let any client forge fresh
 * counters with a header.
 */
describe("VIBEHUB_TRUST_PROXY", () => {
  const ORIGINAL_TRUST = process.env.VIBEHUB_TRUST_PROXY;
  afterEach(() => {
    if (ORIGINAL_TRUST === undefined) delete process.env.VIBEHUB_TRUST_PROXY;
    else process.env.VIBEHUB_TRUST_PROXY = ORIGINAL_TRUST;
  });

  async function trustWith(value: string | undefined) {
    vi.resetModules();
    if (value === undefined) delete process.env.VIBEHUB_TRUST_PROXY;
    else process.env.VIBEHUB_TRUST_PROXY = value;
    return (await import("./env.js")).config.trustProxy;
  }

  it("unset or blank trusts no proxy", async () => {
    expect(await trustWith(undefined)).toBe(false);
    expect(await trustWith("  ")).toBe(false);
  });

  it("a whole number is a hop count; anything else is an address list for Fastify", async () => {
    expect(await trustWith("1")).toBe(1);
    expect(await trustWith("10.0.0.250, 172.16.0.0/12")).toBe("10.0.0.250, 172.16.0.0/12");
    expect(await trustWith("loopback")).toBe("loopback");
  });

  it("'false' / 'no' / 'off' read as unset, not as an address Fastify would choke on", async () => {
    for (const off of ["false", "FALSE", "no", "off"]) expect(await trustWith(off)).toBe(false);
  });

  it("REFUSES at boot, naming the variable, what is neither a hop count nor an address list", async () => {
    // 'true' would be "trust everyone" (forgeable counters) and proxy-addr reads it as an IP and
    // throws deep inside Fastify's constructor — the back would not come up and nothing would say why.
    for (const bad of ["true", "yes", "1.2.3", "10.0.0.0/99", "loopback, banana"]) {
      await expect(trustWith(bad)).rejects.toThrow(/VIBEHUB_TRUST_PROXY/);
    }
  });

  it("accepts IPv6, CIDRs and dotted netmasks the way proxy-addr does", async () => {
    expect(await trustWith("::1, fd00::/8")).toBe("::1, fd00::/8");
    expect(await trustWith("10.0.0.0/255.0.0.0,uniquelocal")).toBe("10.0.0.0/255.0.0.0,uniquelocal");
  });

  /**
   * Trusting a gateway is only safe while the gateway is the ONLY way in: a client that reaches the
   * port directly from an address the setting trusts (any peer, for a hop count; docker-proxy's
   * 172.x for `uniquelocal`) forges X-Forwarded-For and gets fresh sign-in counters every try.
   * vibehub cannot see how the port is published, so it says so at boot.
   */
  it("warns at boot, whenever a gateway is trusted, that its port must be reachable only through it", async () => {
    const { trustProxyBootWarning } = await import("./env.js");
    expect(trustProxyBootWarning(false)).toBeNull();
    expect(trustProxyBootWarning(0)).toBeNull();
    for (const trusted of [1, "uniquelocal", "10.0.0.5"] as const) {
      expect(trustProxyBootWarning(trusted)).toMatch(/VIBEHUB_TRUST_PROXY.*127\.0\.0\.1:3010:3010/s);
    }
  });

  it("hands Fastify a hop count as the predicate its types accept — 0 trusting nobody", async () => {
    // Fastify's declarations take no number (its runtime does): passing the raw count broke the
    // build. The predicate is the one Fastify builds from a count: trust the first N hops.
    const { fastifyTrustProxy } = await import("./env.js");
    const zero = fastifyTrustProxy(0);
    const one = fastifyTrustProxy(1);
    if (typeof zero !== "function" || typeof one !== "function") throw new Error("expected predicates");
    expect(zero("10.0.0.250", 0)).toBe(false);
    expect(one("10.0.0.250", 0)).toBe(true);
    expect(one("203.0.113.7", 1)).toBe(false);
    expect(fastifyTrustProxy("loopback")).toBe("loopback");
    expect(fastifyTrustProxy(false)).toBe(false);
  });
});

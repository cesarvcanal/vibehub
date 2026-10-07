import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * THE PUBLIC DOORS — sign-in and the setup wizard answer to anybody on the network, and each try
 * costs a scrypt on the libuv threadpool (the same threads the filesystem uses). Without a ceiling,
 * a loop of POSTs is both a password brute force and a way to stall every fs call on the server.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let dir = "";
let app: FastifyInstance;

async function boot(trustProxy: string | number | false = false): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  env.config.trustProxy = trustProxy;
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined),
    startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => "runner-token"),
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
  }));
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

function login(username: string, password: string, remoteAddress = "10.0.0.1") {
  return app.inject({ method: "POST", url: "/api/auth/login", remoteAddress, payload: { username, password } });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-authroutes-"));
  app = await boot();
  await app.inject({ method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" } });
});
afterEach(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

describe("sign-in throttling", () => {
  it("cuts a brute force on one username off with 429 — even the right password waits", async () => {
    const { LOGIN_ATTEMPTS_PER_ACCOUNT } = await import("./auth.js");
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT; i++) {
      expect((await login("owner", `wrong-${i}-password`)).statusCode).toBe(401);
    }
    const blocked = await login("owner", "supersecret");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    // Somebody else, from another address, is not locked out by it.
    expect((await login("owner", "supersecret", "10.0.0.2")).statusCode).toBe(200);
  });

  it("a successful sign-in clears the mistakes typed before it", async () => {
    const { LOGIN_ATTEMPTS_PER_ACCOUNT } = await import("./auth.js");
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT - 1; i++) {
        expect((await login("owner", "typo-typo-typo")).statusCode).toBe(401);
      }
      expect((await login("owner", "supersecret")).statusCode).toBe(200);
    }
  });

  it("caps one address across usernames — rotating names does not buy more scrypt", async () => {
    await app.close();
    app = await boot(0); // a DIRECT install, declared: the peer is the client
    const { ATTEMPTS_PER_ADDRESS } = await import("./auth.js");
    for (let i = 0; i < ATTEMPTS_PER_ADDRESS; i++) {
      expect((await login(`ghost${i}`, "supersecret")).statusCode).toBe(401);
    }
    expect((await login("ghost-next", "supersecret")).statusCode).toBe(429);
  });

  it("the setup wizard shares the address ceiling", async () => {
    await app.close();
    app = await boot(0);
    const { ATTEMPTS_PER_ADDRESS } = await import("./auth.js");
    const setup = () => app.inject({
      method: "POST", url: "/api/setup/owner", remoteAddress: "10.0.0.9",
      payload: { username: "intruder", password: "supersecret" },
    });
    for (let i = 0; i < ATTEMPTS_PER_ADDRESS; i++) expect((await setup()).statusCode).toBe(409);
    expect((await setup()).statusCode).toBe(429);
  });

  it("only FAILED tries count — a busy address signing in correctly never reaches the ceiling", async () => {
    await app.close();
    app = await boot(0);
    const { ATTEMPTS_PER_ADDRESS } = await import("./auth.js");
    for (let i = 0; i <= ATTEMPTS_PER_ADDRESS; i++) {
      expect((await login("owner", "supersecret")).statusCode).toBe(200);
    }
    expect((await login("ghost", "supersecret")).statusCode).toBe(401);
  });

  it("a name no account can have is refused on the spot — it is never kept as a counter key", async () => {
    // The counters live for fifteen minutes; keyed on whatever the body carried, a stream of
    // multi-megabyte "usernames" would pin memory until the process falls over.
    const { LOGIN_ATTEMPTS_PER_ACCOUNT } = await import("./auth.js");
    const huge = "a".repeat(64 * 1024);
    for (let i = 0; i <= LOGIN_ATTEMPTS_PER_ACCOUNT; i++) {
      expect((await login(huge, "supersecret")).statusCode).toBe(401);
    }
  });

  it("without VIBEHUB_TRUST_PROXY the address is no client identity — nobody can lock EVERYONE out", async () => {
    // The default: vibehub cannot tell a direct client from a gateway it was not told about, and
    // behind one every request shares an address. A per-address ceiling would then be one switch,
    // in anyone's hands, that turns sign-in off for the whole install.
    const { ATTEMPTS_PER_ADDRESS } = await import("./auth.js");
    for (let i = 0; i < ATTEMPTS_PER_ADDRESS; i++) {
      expect((await login(`ghost${i}`, "supersecret")).statusCode).toBe(401);
    }
    expect((await login("owner", "supersecret")).statusCode).toBe(200);
  });
});

/**
 * BEHIND A GATEWAY every request arrives from the gateway's address. Keyed on that, the ceilings
 * stopped being a brute-force guard and became a lockout anyone could trigger: ten wrong passwords
 * for `owner` from anywhere 429'd the real owner too, and thirty tries of any name locked out the
 * whole install. VIBEHUB_TRUST_PROXY names the gateway, so `req.ip` is the CLIENT it forwarded for.
 */
describe("sign-in throttling behind a trusted gateway", () => {
  const GATEWAY = "10.0.0.250";
  const via = (client: string, username: string, password: string) => app.inject({
    method: "POST", url: "/api/auth/login", remoteAddress: GATEWAY,
    headers: { "x-forwarded-for": client }, payload: { username, password },
  });

  it("counts each forwarded client on its own — an attacker does not lock the owner out", async () => {
    await app.close();
    app = await boot(GATEWAY);
    const { LOGIN_ATTEMPTS_PER_ACCOUNT } = await import("./auth.js");
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT; i++) {
      expect((await via("203.0.113.7", "owner", `wrong-${i}-password`)).statusCode).toBe(401);
    }
    expect((await via("203.0.113.7", "owner", "supersecret")).statusCode).toBe(429);
    expect((await via("198.51.100.4", "owner", "supersecret")).statusCode).toBe(200);
  });

  it("an UNtrusted peer's x-forwarded-for is ignored — a header cannot buy fresh counters", async () => {
    const { LOGIN_ATTEMPTS_PER_ACCOUNT } = await import("./auth.js");
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT; i++) {
      expect((await via(`203.0.113.${i}`, "owner", `wrong-${i}-password`)).statusCode).toBe(401);
    }
    expect((await via("203.0.113.99", "owner", "supersecret")).statusCode).toBe(429);
  });
});

/**
 * A BROWSER THAT SIGNED IN BEFORE is not locked out by somebody else's failures. Without
 * VIBEHUB_TRUST_PROXY behind a gateway — or under Docker Desktop's port forwarding, where there is
 * no gateway to declare — every client shares one address, and ten wrong passwords for `owner` from
 * anyone 429'd the real owner too, every fifteen minutes, forever. A successful sign-in leaves a
 * signed "known device" cookie for that username; its tries are counted on their own.
 */
describe("sign-in throttling for a known device", () => {
  async function knownDevice(username = "owner", password = "supersecret"): Promise<string> {
    const res = await login(username, password);
    expect(res.statusCode).toBe(200);
    const device = res.cookies.find((c) => c.name.startsWith("vibehub_device"));
    expect(device?.value).toBeTruthy();
    return `${device?.name ?? ""}=${device?.value ?? ""}`;
  }

  function loginFrom(cookie: string, username: string, password: string) {
    return app.inject({
      method: "POST", url: "/api/auth/login", remoteAddress: "10.0.0.1", headers: { cookie }, payload: { username, password },
    });
  }

  async function exhaust(username: string): Promise<void> {
    const { LOGIN_ATTEMPTS_PER_ACCOUNT } = await import("./auth.js");
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT; i++) {
      expect((await login(username, `wrong-${i}-password`)).statusCode).toBe(401);
    }
    expect((await login(username, "supersecret")).statusCode).toBe(429);
  }

  it("an attacker sharing the owner's address does not lock out the owner's browser", async () => {
    const device = await knownDevice();
    await exhaust("owner");
    expect((await loginFrom(device, "owner", "supersecret")).statusCode).toBe(200);
  });

  it("the known device still has a ceiling of its own — it is no brute-force pass", async () => {
    const { LOGIN_ATTEMPTS_PER_ACCOUNT } = await import("./auth.js");
    const device = await knownDevice();
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT; i++) {
      expect((await loginFrom(device, "owner", `wrong-${i}-password`)).statusCode).toBe(401);
    }
    expect((await loginFrom(device, "owner", "supersecret")).statusCode).toBe(429);
  });

  it("signing in as ANOTHER user in the same browser does not cost it the first user's standing", async () => {
    const session = (await login("owner", "supersecret")).cookies.find((c) => c.name === "vibehub_session")?.value;
    await app.inject({
      method: "POST", url: "/api/users", headers: { cookie: `vibehub_session=${session ?? ""}` },
      payload: { username: "qa", password: "supersecret", role: "member" },
    });
    // One browser's cookie jar: what each response sets replaces the cookie OF THAT NAME only.
    const jar = new Map<string, string>();
    const header = (): string => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const signIn = async (username: string): Promise<void> => {
      const res = await loginFrom(header(), username, "supersecret");
      expect(res.statusCode).toBe(200);
      for (const c of res.cookies) if (c.name !== "vibehub_session") jar.set(c.name, c.value);
    };
    await signIn("owner");
    await signIn("qa");

    await exhaust("owner");
    expect((await loginFrom(header(), "owner", "supersecret")).statusCode).toBe(200);
  });

  it("is bound to its username and its signature — another name's or a forged cookie buys nothing", async () => {
    const session = (await login("owner", "supersecret")).cookies.find((c) => c.name === "vibehub_session")?.value;
    const created = await app.inject({
      method: "POST", url: "/api/users", headers: { cookie: `vibehub_session=${session ?? ""}` },
      payload: { username: "alex", password: "supersecret", role: "member" },
    });
    expect(created.statusCode).toBe(200);
    const alexDevice = await knownDevice("alex");
    const owners = await knownDevice();
    const forged = owners.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    await exhaust("owner");
    expect((await loginFrom(alexDevice, "owner", "supersecret")).statusCode).toBe(429);
    expect((await loginFrom(forged, "owner", "supersecret")).statusCode).toBe(429);
  });
});

describe("AttemptLimiter", () => {
  it("allows `limit` hits per window, then answers the seconds left; a new window starts clean", async () => {
    const { AttemptLimiter } = await import("./auth.js");
    const limiter = new AttemptLimiter(2, 60_000);
    expect(limiter.hit("k", 0)).toBe(0);
    expect(limiter.hit("k", 1_000)).toBe(0);
    expect(limiter.hit("k", 1_000)).toBe(59);
    expect(limiter.hit("other", 1_000)).toBe(0);
    expect(limiter.hit("k", 60_000)).toBe(0);
  });

  it("refund gives back one counted try — never below zero, never into a fresh window", async () => {
    const { AttemptLimiter } = await import("./auth.js");
    const limiter = new AttemptLimiter(2, 60_000);
    limiter.hit("k", 0);
    limiter.hit("k", 0);
    limiter.refund("k", 0);
    expect(limiter.hit("k", 0)).toBe(0);
    expect(limiter.hit("k", 0)).toBe(60);
    limiter.refund("gone", 0);
    expect(limiter.size).toBe(1);
    limiter.refund("k", 60_000);
    expect(limiter.hit("k", 60_000)).toBe(0);
  });

  it("forgets expired keys, so a flood of one-off keys does not grow the map forever", async () => {
    const { AttemptLimiter } = await import("./auth.js");
    const limiter = new AttemptLimiter(5, 1_000);
    for (let i = 0; i < 100; i++) limiter.hit(`k${i}`, 0);
    expect(limiter.size).toBe(100);
    limiter.hit("late", 5_000);
    expect(limiter.size).toBe(1);
  });
});

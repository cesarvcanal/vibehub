import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

async function fresh() {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.sessionSecret = "";
  return { users: await import("./users.js"), session: await import("./session.js"), env };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-auth-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("users", () => {
  it("reports a fresh install before anyone signs up", async () => {
    const { users } = await fresh();
    expect(await users.isFreshInstall()).toBe(true);
    await users.createUser("ada", "supersecret");
    expect(await users.isFreshInstall()).toBe(false);
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const { users } = await fresh();
    const created = await users.createUser("ada", "supersecret");
    expect((await users.verifyCredentials("ada", "supersecret"))?.id).toBe(created.id);
    expect(await users.verifyCredentials("ada", "nope-nope-nope")).toBeNull();
  });

  it("returns null for an unknown user without leaking existence", async () => {
    const { users } = await fresh();
    await users.createUser("ada", "supersecret");
    expect(await users.verifyCredentials("ghost", "supersecret")).toBeNull();
  });

  it("never stores the password itself", async () => {
    const { users } = await fresh();
    const user = await users.createUser("ada", "supersecret");
    expect(JSON.stringify(user)).not.toContain("supersecret");
  });

  it("refuses duplicate usernames", async () => {
    const { users } = await fresh();
    await users.createUser("ada", "supersecret");
    await expect(users.createUser("ADA", "othersecret")).rejects.toThrow(/already exists/);
  });

  it("validates username and password shape", async () => {
    const { users } = await fresh();
    await expect(users.createUser("a", "supersecret")).rejects.toThrow(/username/);
    await expect(users.createUser("ada", "short")).rejects.toThrow(/at least 8/);
  });

  it("changes a password and invalidates the old one", async () => {
    const { users } = await fresh();
    const user = await users.createUser("ada", "supersecret");
    await users.changePassword(user.id, "brand-new-secret");
    expect(await users.verifyCredentials("ada", "supersecret")).toBeNull();
    expect(await users.verifyCredentials("ada", "brand-new-secret")).not.toBeNull();
  });
});

describe("sessions", () => {
  it("round-trips a token", async () => {
    const { session } = await fresh();
    const token = await session.issueToken("user-1");
    expect(await session.verifyToken(token)).toBe("user-1");
  });

  it("rejects a tampered token", async () => {
    const { session } = await fresh();
    const token = await session.issueToken("user-1");
    expect(await session.verifyToken(token.replace("user-1", "user-2"))).toBeNull();
    expect(await session.verifyToken(`${token}x`)).toBeNull();
    expect(await session.verifyToken("garbage")).toBeNull();
  });

  it("expires after the TTL", async () => {
    const { session } = await fresh();
    const token = await session.issueToken("user-1", 1000);
    expect(await session.verifyToken(token, 1000 + session.SESSION_TTL_MS + 1)).toBeNull();
    expect(await session.verifyToken(token, 1000 + session.SESSION_TTL_MS - 1)).toBe("user-1");
  });

  it("does not honour tokens signed with another key", async () => {
    const a = await fresh();
    const token = await a.session.issueToken("user-1");
    const b = await fresh();
    b.env.config.sessionSecret = "a-different-signing-secret";
    b.session.resetSessionKeyForTesting();
    expect(await b.session.verifyToken(token)).toBeNull();
  });

  it("marks cookies secure unless the operator opts out", async () => {
    const { session, env } = await fresh();
    expect(session.cookieOptions().secure).toBe(true);
    env.config.insecureCookies = true;
    expect(session.cookieOptions().secure).toBe(false);
  });

  it("401s a request with no session", async () => {
    const { session } = await fresh();
    let code = 0;
    let body: unknown = null;
    const reply = { code(c: number) { code = c; return this; }, async send(b: unknown) { body = b; } };
    await session.requireSession({ cookies: {} } as never, reply as never);
    expect(code).toBe(401);
    expect(body).toEqual({ error: "not authenticated" });
  });
});

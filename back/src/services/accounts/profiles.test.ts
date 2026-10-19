import { describe, it, expect } from "vitest";
import {
  CLAUDE_PROFILES_DIR, DEFAULT_CLAUDE_DIR, DEFAULT_ACCOUNT_SLUG, OAUTH_TOKEN_FILE,
  CREDENTIALS_FILE, accountConfigDir, profileDirFor, oauthTokenPath, oauthTokenGuard,
} from "./profiles.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeRemotePath } from "../../runtime/host.js";

/**
 * Claude profiles in the runner. Everything here is a derivation from a VALIDATED slug — the tests
 * exist to prove that a hostile slug can never become a path, because that path goes straight into
 * a shell script (quoted, but still).
 */

describe("profile paths", () => {
  it("named account → /root/.claude-profiles/<slug>", () => {
    expect(accountConfigDir("personal")).toBe("/root/.claude-profiles/personal");
    expect(accountConfigDir("work-2")).toBe(`${CLAUDE_PROFILES_DIR}/work-2`);
  });

  it("a hostile slug THROWS instead of becoming a path", () => {
    expect(() => accountConfigDir("..")).toThrow(/invalid account slug/);
    expect(() => accountConfigDir("a/b")).toThrow(/invalid account slug/);
    expect(() => accountConfigDir("x; rm -rf /")).toThrow(/invalid account slug/);
    expect(() => accountConfigDir("$(id)")).toThrow(/invalid account slug/);
    expect(() => accountConfigDir("Upper")).toThrow(/invalid account slug/);
    expect(() => accountConfigDir("")).toThrow(/invalid account slug/);
  });

  it("'default' is reserved on the board — accountConfigDir refuses it", () => {
    expect(() => accountConfigDir(DEFAULT_ACCOUNT_SLUG)).toThrow(/reserved/);
  });

  it("profileDirFor: missing slug or 'default' → /root/.claude; a real slug → its profile", () => {
    expect(profileDirFor(undefined)).toBe(DEFAULT_CLAUDE_DIR);
    expect(profileDirFor("")).toBe(DEFAULT_CLAUDE_DIR);
    expect(profileDirFor(DEFAULT_ACCOUNT_SLUG)).toBe("/root/.claude");
    expect(profileDirFor("personal")).toBe("/root/.claude-profiles/personal");
  });

  it("oauthTokenPath hangs .oauth-token off the profile", () => {
    expect(oauthTokenPath(DEFAULT_CLAUDE_DIR)).toBe("/root/.claude/.oauth-token");
    expect(oauthTokenPath(accountConfigDir("personal"))).toBe("/root/.claude-profiles/personal/.oauth-token");
    expect(OAUTH_TOKEN_FILE).toBe(".oauth-token");
  });

  it("every derived path survives the remote-path guard (no traversal, safe charset)", () => {
    for (const p of [
      DEFAULT_CLAUDE_DIR,
      CLAUDE_PROFILES_DIR,
      accountConfigDir("personal"),
      profileDirFor("work-2"),
      oauthTokenPath(accountConfigDir("personal")),
    ]) {
      expect(() => assertSafeRemotePath(p)).not.toThrow();
    }
  });
});

/**
 * WHICH SIGN-IN A SESSION USES, run in a real bash against real files — the guard is shell, and its
 * whole point is a rule about file ages, which only a real `[ -nt ]` can prove.
 */
describe("oauthTokenGuard — the newest sign-in wins (real bash)", () => {
  const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r-123", expiresAt: 1 } });
  const NO_REFRESH = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "", expiresAt: 0 } });

  async function exported(setup: { token?: { value: string; age: number }; creds?: { body: string; age: number } }): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "vh-guard-"));
    try {
      const now = Date.now() / 1000;
      if (setup.token) {
        await writeFile(oauthTokenPath(dir), setup.token.value);
        await utimes(oauthTokenPath(dir), now - setup.token.age, now - setup.token.age);
      }
      if (setup.creds) {
        await writeFile(join(dir, CREDENTIALS_FILE), setup.creds.body);
        await utimes(join(dir, CREDENTIALS_FILE), now - setup.creds.age, now - setup.creds.age);
      }
      const script = `unset CLAUDE_CODE_OAUTH_TOKEN; ${oauthTokenGuard(dir)} printf '%s' "\${CLAUDE_CODE_OAUTH_TOKEN-<unset>}"`;
      return execFileSync("bash", ["-c", script], { encoding: "utf8" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("token only → exported", async () => {
    expect(await exported({ token: { value: "sk-tok", age: 10 } })).toBe("sk-tok");
  });

  it("no token → nothing exported (the profile's own login)", async () => {
    expect(await exported({ creds: { body: LOGIN, age: 10 } })).toBe("<unset>");
  });

  it("a /login NEWER than the token wins — the revoked setup-token stops shadowing it (produção, tech)", async () => {
    expect(await exported({ token: { value: "sk-revoked", age: 86_400 * 58 }, creds: { body: LOGIN, age: 60 } })).toBe("<unset>");
  });

  it("a token saved AFTER the login takes the lead back", async () => {
    expect(await exported({ token: { value: "sk-new", age: 10 }, creds: { body: LOGIN, age: 3_600 } })).toBe("sk-new");
  });

  it("a newer credentials file with no refresh token cannot keep itself alive — the token stays", async () => {
    expect(await exported({ token: { value: "sk-tok", age: 3_600 }, creds: { body: NO_REFRESH, age: 10 } })).toBe("sk-tok");
  });

  it("an empty token file is no token", async () => {
    expect(await exported({ token: { value: "", age: 10 } })).toBe("<unset>");
  });

  it("quotes the paths (the profile dir goes into a shell line)", () => {
    expect(oauthTokenGuard("/root/.claude-profiles/tech")).toContain("'/root/.claude-profiles/tech/.oauth-token'");
    expect(oauthTokenGuard("/root/.claude-profiles/tech")).toContain("'/root/.claude-profiles/tech/.credentials.json'");
  });
});

import { describe, it, expect } from "vitest";
import {
  CLAUDE_PROFILES_DIR, DEFAULT_CLAUDE_DIR, DEFAULT_ACCOUNT_SLUG, OAUTH_TOKEN_FILE,
  accountConfigDir, profileDirFor, oauthTokenPath,
} from "./profiles.js";
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

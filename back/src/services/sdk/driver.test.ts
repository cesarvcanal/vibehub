import { describe, it, expect } from "vitest";
import {
  buildSdkDriverCommandLine,
  buildInstallDriverScript,
  SDK_DRIVER_PATH,
  SDK_DRIVER_DIR,
} from "./driver.js";

describe("buildSdkDriverCommandLine", () => {
  const base = { containerName: "vibehub-runner", cwd: "/work/o--r-worktrees/card-1", profileDir: "/root/.claude" };

  it("wraps a `docker exec -i` (no tty) so stdio stays clean pipes for NDJSON", () => {
    const line = buildSdkDriverCommandLine(base);
    expect(line).toContain("'docker' 'exec' '-i' 'vibehub-runner' 'bash' '-c'");
    expect(line).not.toContain("-it");
  });

  it("exports the OAuth token from the profile's .oauth-token, like the TUI guard", () => {
    const line = buildSdkDriverCommandLine(base);
    expect(line).toContain("/root/.claude/.oauth-token");
    expect(line).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(line).toContain("IS_SANDBOX=1");
  });

  it("points NODE_PATH at the driver dir's node_modules and runs the driver with --cwd", () => {
    const line = buildSdkDriverCommandLine(base);
    expect(line).toContain(`${SDK_DRIVER_DIR}/node_modules`);
    expect(line).toContain(SDK_DRIVER_PATH);
    expect(line).toContain("--cwd");
    expect(line).toContain("/work/o--r-worktrees/card-1");
  });

  it("adds --resume for a valid session id and --model for a whitelisted model", () => {
    const line = buildSdkDriverCommandLine({
      ...base,
      resumeSessionId: "0d1b3864-4870-4141-8451-79d73de0bd96",
      model: "claude-opus-5",
    });
    expect(line).toContain("--resume");
    expect(line).toContain("0d1b3864-4870-4141-8451-79d73de0bd96");
    expect(line).toContain("--model");
    expect(line).toContain("claude-opus-5");
  });

  it("drops an invalid model rather than passing raw input to the shell", () => {
    const line = buildSdkDriverCommandLine({ ...base, model: "; rm -rf / #" });
    expect(line).not.toContain("--model");
    expect(line).not.toContain("rm -rf");
  });

  it("threads CLAUDE_CONFIG_DIR only for a non-default account", () => {
    expect(buildSdkDriverCommandLine(base)).not.toContain("CLAUDE_CONFIG_DIR");
    const withAcct = buildSdkDriverCommandLine({ ...base, configDir: "/root/.claude-profiles/work", profileDir: "/root/.claude-profiles/work" });
    expect(withAcct).toContain("CLAUDE_CONFIG_DIR");
    expect(withAcct).toContain("/root/.claude-profiles/work");
  });

  it("rejects a session id that is not a uuid (never reaches the shell)", () => {
    expect(() => buildSdkDriverCommandLine({ ...base, resumeSessionId: "$(evil)" })).toThrow();
  });

  it("rejects an unsafe cwd", () => {
    expect(() => buildSdkDriverCommandLine({ ...base, cwd: "/work/../etc" })).toThrow();
  });
});

describe("buildInstallDriverScript", () => {
  it("plants the driver atomically (tmp + chmod + mv) via docker exec, source in a quoted heredoc", () => {
    const script = buildInstallDriverScript("vibehub-runner", "console.log('hi')\n");
    expect(script).toContain("docker exec -i 'vibehub-runner' bash -s");
    expect(script).toContain(`mkdir -p '${SDK_DRIVER_DIR}'`);
    expect(script).toContain(`chmod 755 '${SDK_DRIVER_PATH}.tmp'`);
    expect(script).toContain(`mv -f '${SDK_DRIVER_PATH}.tmp' '${SDK_DRIVER_PATH}'`);
    expect(script).toContain("console.log('hi')");
    // quoted heredoc delimiter => the source is written literally, not expanded
    expect(script).toContain("<<'VIBEHUB_SDK_DRIVER_SRC'");
  });
});

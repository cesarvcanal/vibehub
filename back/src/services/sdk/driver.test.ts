import { describe, it, expect } from "vitest";
import {
  buildSdkDriverCommandLine,
  buildInstallDriverScript,
  buildEnsureSdkScript,
  SDK_DRIVER_PATH,
  SDK_DRIVER_DIR,
  SDK_PACKAGE_VERSION,
  SDK_VERSION_MARKER,
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

  it("exports the card environment the TUI session also carries (browser endpoint + status hooks)", () => {
    const line = buildSdkDriverCommandLine({
      ...base,
      cdpEndpoint: "http://127.0.0.1:39222",
      cardId: "card-1",
      statusUrl: "https://hub.example.com/api/runner/status",
    });
    expect(line).toContain("PW_CDP_ENDPOINT=");
    expect(line).toContain("http://127.0.0.1:39222");
    expect(line).toContain("VIBEHUB_CARD_ID=");
    expect(line).toContain("card-1");
    expect(line).toContain("VIBEHUB_STATUS_URL=");
    expect(line).toContain("https://hub.example.com/api/runner/status");
    // Without them, nothing is exported — a driver spawned by an older path stays valid.
    const bare = buildSdkDriverCommandLine(base);
    expect(bare).not.toContain("PW_CDP_ENDPOINT");
    expect(bare).not.toContain("VIBEHUB_CARD_ID");
  });

  it("rejects an unsafe cdp/status URL or card id rather than passing it to the shell", () => {
    expect(() => buildSdkDriverCommandLine({ ...base, cdpEndpoint: "http://x'; rm -rf /" })).toThrow();
    expect(() => buildSdkDriverCommandLine({ ...base, statusUrl: "ftp://nope" })).toThrow();
    expect(() => buildSdkDriverCommandLine({ ...base, cardId: "c1; evil" })).toThrow();
  });

  it("threads the permission-gate mode as a driver flag", () => {
    const same = buildSdkDriverCommandLine({ ...base, permissionGate: "same-as-terminal" });
    expect(same).toContain("--permission-gate");
    expect(same).toContain("same-as-terminal");
    const ask = buildSdkDriverCommandLine({ ...base, permissionGate: "ask-sensitive" });
    expect(ask).toContain("--permission-gate");
    expect(ask).toContain("ask-sensitive");
    expect(buildSdkDriverCommandLine(base)).not.toContain("--permission-gate");
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

describe("auth hygiene — CLAUDE_CODE_OAUTH_TOKEN only (project rule)", () => {
  const base = { containerName: "vibehub-runner", cwd: "/work/o--r-worktrees/card-1", profileDir: "/root/.claude" };

  it("UNSETS ANTHROPIC_API_KEY before anything else, so an inherited key can never win over the token", () => {
    const line = buildSdkDriverCommandLine(base);
    expect(line).toContain("unset ANTHROPIC_API_KEY");
    // the unset comes BEFORE the exec of node — it is environment prep, not an afterthought
    expect(line.indexOf("unset ANTHROPIC_API_KEY")).toBeLessThan(line.indexOf("exec node"));
    // and the command never EXPORTS an API key of its own
    expect(line).not.toContain("export ANTHROPIC_API_KEY");
  });

  it("the driver source itself deletes ANTHROPIC_API_KEY (second lock on the same door)", async () => {
    const { sdkDriverSource } = await import("./driver.js");
    expect(sdkDriverSource()).toContain("delete process.env.ANTHROPIC_API_KEY");
  });
});

describe("buildEnsureSdkScript — the automatic, idempotent SDK install", () => {
  it("installs the pinned SDK only when the version marker disagrees (idempotent by marker)", () => {
    const script = buildEnsureSdkScript("vibehub-runner");
    expect(script).toContain("docker exec -i 'vibehub-runner' bash -s");
    // the guard: marker equal + package dir present => the whole install is skipped
    expect(script).toContain(`cat '${SDK_VERSION_MARKER}'`);
    expect(script).toContain(`!= '${SDK_PACKAGE_VERSION}'`);
    expect(script).toContain("node_modules/@anthropic-ai/claude-agent-sdk");
    // the install pins the exact version and writes the marker AFTER installing
    expect(script).toContain(`'@anthropic-ai/claude-agent-sdk@${SDK_PACKAGE_VERSION}'`);
    expect(script.indexOf("npm install")).toBeLessThan(script.indexOf(`printf '%s' '${SDK_PACKAGE_VERSION}'`));
  });

  it("never touches the container itself — only /root/.vibehub-sdk", () => {
    const script = buildEnsureSdkScript("vibehub-runner");
    expect(script).not.toContain("docker run");
    expect(script).not.toContain("docker rm");
    expect(script).toContain(SDK_DRIVER_DIR);
  });

  it("rejects a malformed version rather than passing it to npm", () => {
    expect(() => buildEnsureSdkScript("vibehub-runner", "1.2; rm -rf /")).toThrow();
  });
});

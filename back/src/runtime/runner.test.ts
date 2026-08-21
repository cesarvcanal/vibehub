import { describe, it, expect, beforeEach } from "vitest";
import { config } from "../config/env.js";
import {
  buildRunScript, buildSetupScript, runnerSettingsJson, hookCommand, statusUrl,
} from "./runner.js";

beforeEach(() => {
  config.publicUrl = "http://vibehub:3010";
  config.runner.container = "vibehub-runner";
  config.runner.image = "node:24-bookworm";
  config.runner.baseDir = "/opt/vibehub/runner";
});

describe("statusUrl", () => {
  it("hangs the status route off the public URL", () => {
    expect(statusUrl()).toBe("http://vibehub:3010/api/runner/status");
  });
  it("tolerates a trailing slash", () => {
    config.publicUrl = "http://vibehub:3010/";
    expect(statusUrl()).toBe("http://vibehub:3010/api/runner/status");
  });
});

describe("hookCommand", () => {
  it("reads the token from disk instead of embedding it", () => {
    const cmd = hookCommand("working");
    expect(cmd).toContain("$(cat /root/.vibehub-token)");
    expect(cmd).toContain("$VIBEHUB_STATUS_URL");
    expect(cmd).toContain("$VIBEHUB_CARD_ID");
    expect(cmd).toContain('\\"status\\":\\"working\\"');
  });
  it("times out fast — a hook must never hang the agent", () => {
    expect(hookCommand("waiting")).toContain("-m 3");
  });
});

describe("runnerSettingsJson", () => {
  it("wires every hook that can mean 'waiting for the human'", () => {
    const settings = JSON.parse(runnerSettingsJson()) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ["Notification", "PermissionRequest", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"],
    );
  });
  it("marks a fresh session as waiting, not working", () => {
    const s = JSON.parse(runnerSettingsJson()) as { hooks: Record<string, [{ hooks: [{ command: string }] }]> };
    expect(s.hooks.SessionStart?.[0].hooks[0].command).toContain('\\"waiting\\"');
    expect(s.hooks.UserPromptSubmit?.[0].hooks[0].command).toContain('\\"working\\"');
  });
  it("only bypasses permissions when the install chose autonomy", () => {
    const auto = JSON.parse(runnerSettingsJson({ autonomous: true })) as Record<string, unknown>;
    const asks = JSON.parse(runnerSettingsJson({ autonomous: false })) as Record<string, unknown>;
    expect(auto.permissions).toEqual({ defaultMode: "bypassPermissions" });
    expect(asks.permissions).toBeUndefined();
    expect(asks.skipDangerousModePermissionPrompt).toBeUndefined();
  });
  it("keeps sessions persistent so a card can be resumed", () => {
    expect(JSON.parse(runnerSettingsJson()).env).toEqual({ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" });
  });
});

describe("buildRunScript", () => {
  const opts = { container: "vibehub-runner", image: "node:24-bookworm", baseDir: "/opt/vibehub/runner" };

  it("starts an existing container instead of recreating it", () => {
    const script = buildRunScript(opts);
    expect(script).toContain("docker ps -aq -f name=^vibehub-runner$");
    expect(script).toContain("docker start 'vibehub-runner'");
  });
  it("creates the container with both persistent mounts", () => {
    const script = buildRunScript(opts);
    expect(script).toContain("-v '/opt/vibehub/runner/root':/root");
    expect(script).toContain("-v '/opt/vibehub/runner/work':/work");
  });
  it("sets the environment the agent needs to run under root", () => {
    const script = buildRunScript(opts);
    expect(script).toContain("-e IS_SANDBOX=1");
    expect(script).toContain("-e LANG=C.UTF-8");
  });
  it("keeps the container alive and restarting", () => {
    const script = buildRunScript(opts);
    expect(script).toContain("sleep infinity");
    expect(script).toContain("--restart unless-stopped");
  });
  it("quotes a hostile container name into a single argument", () => {
    const script = buildRunScript({ ...opts, container: "a'; rm -rf /; '" });
    expect(script).toContain(`'a'\\''; rm -rf /; '\\'''`);
  });
});

describe("buildSetupScript", () => {
  const base = {
    container: "vibehub-runner",
    baseDir: "/opt/vibehub/runner",
    token: "tok-123",
    settingsJson: runnerSettingsJson(),
    git: { name: "Ada Lovelace", email: "ada@example.com" },
  };

  it("plants the token host-side at 600 so a container recreate does not lose it", () => {
    const script = buildSetupScript(base);
    expect(script).toContain("/opt/vibehub/runner/root/.vibehub-token");
    expect(script).toContain("chmod 600");
  });
  it("never passes the token as an argument to docker", () => {
    const script = buildSetupScript(base);
    const dockerLine = script.split("\n").find((l) => l.startsWith("docker exec")) ?? "";
    expect(dockerLine).not.toContain("tok-123");
    expect(dockerLine).toContain("bash -s");
  });
  it("installs the terminal and browser toolchain plus Claude Code", () => {
    const script = buildSetupScript(base);
    expect(script).toContain("tmux git ripgrep curl");
    expect(script).toContain("npm i -g @anthropic-ai/claude-code");
    expect(script).toContain("playwright install");
  });
  it("uses the configured git identity, not a hard-coded one", () => {
    const script = buildSetupScript(base);
    expect(script).toContain("git config --global user.name 'Ada Lovelace'");
    expect(script).toContain("git config --global user.email 'ada@example.com'");
  });
  it("quotes a git identity containing quotes", () => {
    const script = buildSetupScript({ ...base, git: { name: "O'Brien", email: "o@example.com" } });
    expect(script).toContain(`'O'\\''Brien'`);
  });
  it("writes settings.json through a heredoc inside the container", () => {
    const script = buildSetupScript(base);
    expect(script).toContain("cat > /root/.claude/settings.json <<'VIBEHUB_SETTINGS'");
    expect(script).toContain('"CLAUDE_CODE_FORCE_SESSION_PERSISTENCE": "1"');
  });
  it("configures tmux for truecolor and no status bar", () => {
    const script = buildSetupScript(base);
    expect(script).toContain("tmux-256color");
    expect(script).toContain("status off");
  });
});

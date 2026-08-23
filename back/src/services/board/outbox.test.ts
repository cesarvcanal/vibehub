import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));

let dir = "";

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.runner.container = "vibehub-runner";
  vi.doMock("../../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../../runtime/host.js")>("../../runtime/host.js");
    return {
      ...actual,
      hostExecutor: () => ({ kind: "local", label: "test", runScript, writeFile: vi.fn(), ptyCommand: vi.fn() }),
    };
  });
  return {
    outbox: await import("./outbox.js"),
    registry: await import("./registry.js"),
  };
}

/** The probe answers first, then the delivery. One helper so the intent reads in every test. */
function agentIs(state: "running" | "shell" | "none"): void {
  const stdout = state === "running" ? "node\n" : state === "shell" ? "bash\n" : "";
  runScript.mockResolvedValueOnce({ stdout, stderr: "" });
}

// The first `load()` pays for transforming registry + maestro + config, which is far more than a
// per-test budget: pay it once, out of band, so no test is timed against a cold module graph.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-outbox-warmup-"));
  await load();
  await rm(dir, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-outbox-"));
  runScript.mockClear();
  runScript.mockResolvedValue({ stdout: "", stderr: "" });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("classifyAgentState", () => {
  it("reads a shell pane as 'the agent is not here'", async () => {
    const { outbox } = await load();
    expect(outbox.classifyAgentState("bash\n")).toBe("shell");
    expect(outbox.classifyAgentState("  zsh  ")).toBe("shell");
  });

  it("treats anything that is not a shell as the agent", async () => {
    const { outbox } = await load();
    expect(outbox.classifyAgentState("node\n")).toBe("running");
    expect(outbox.classifyAgentState("claude\n")).toBe("running");
  });

  it("empty output is no session at all", async () => {
    const { outbox } = await load();
    expect(outbox.classifyAgentState("")).toBe("none");
    expect(outbox.classifyAgentState("\n \n")).toBe("none");
  });
});

describe("buildAgentProbeScript", () => {
  it("is read-only and never fails on a missing session", async () => {
    const { outbox } = await load();
    const script = outbox.buildAgentProbeScript("vibehub-runner", "card-1234abcd");
    expect(script).toContain("tmux list-panes");
    expect(script).toContain("pane_current_command");
    expect(script).toContain("|| true");
    expect(script).not.toMatch(/\brm\b|\bkill\b|send-keys/);
  });

  it("quotes a hostile session name into one argument", async () => {
    const { outbox } = await load();
    expect(outbox.buildAgentProbeScript("c", "s'; rm -rf /; '")).toContain(`'s'\\''; rm -rf /; '\\'''`);
  });
});

describe("queueMessage", () => {
  it("delivers straight away when Claude is running", async () => {
    const { outbox, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "open one" });
    await registry.applyOpenTerminal(c.id);

    agentIs("running");
    const out = await outbox.queueMessage(c.id, "run the tests");

    expect(out.delivered).toBe(true);
    expect(out.pending).toEqual([]);
    // probe, then send-keys
    expect(runScript).toHaveBeenCalledTimes(2);
    expect((runScript.mock.calls[1] as unknown as string[])[0]).toContain("run the tests");
    expect(await outbox.pendingMessages(c.id)).toEqual([]);
  });

  it("KEEPS the message when the pane fell back to a shell — it is not typed into bash", async () => {
    const { outbox, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "claude died in here" });
    await registry.applyOpenTerminal(c.id);

    agentIs("shell");
    const out = await outbox.queueMessage(c.id, "deploy it");

    expect(out.delivered).toBe(false);
    expect(out.pending.map((m) => m.text)).toEqual(["deploy it"]);
    expect(runScript).toHaveBeenCalledOnce(); // the probe only: nothing was sent anywhere
  });

  it("queues without touching the runner when the card has no session at all", async () => {
    const { outbox, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "never opened" });

    const out = await outbox.queueMessage(c.id, "first thing tomorrow");

    expect(out.delivered).toBe(false);
    expect(out.agent).toBe("none");
    expect(runScript).not.toHaveBeenCalled();
  });

  it("refuses empty text and an unknown card", async () => {
    const { outbox } = await load();
    await expect(outbox.queueMessage("x", "   ")).rejects.toThrow(/empty text/);
    await expect(outbox.queueMessage("nope", "hi")).rejects.toThrow(/card not found/);
  });
});

describe("flushCard", () => {
  it("delivers a waiting queue in order once the agent comes back", async () => {
    const { outbox, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "queued up" });
    await registry.applyOpenTerminal(c.id);

    agentIs("shell");
    await outbox.queueMessage(c.id, "first");
    agentIs("shell");
    await outbox.queueMessage(c.id, "second");
    expect((await outbox.pendingMessages(c.id)).map((m) => m.text)).toEqual(["first", "second"]);

    runScript.mockClear();
    agentIs("running");
    expect((await outbox.flushCard(c.id)).delivered).toBe(2);
    const sent = runScript.mock.calls.slice(1).map((call) => (call as unknown as string[])[0]);
    expect(sent[0]).toContain("first");
    expect(sent[1]).toContain("second");
    expect(await outbox.pendingMessages(c.id)).toEqual([]);
  });

  it("stops at the first failure so the conversation cannot arrive out of order", async () => {
    const { outbox, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "half delivered" });
    await registry.applyOpenTerminal(c.id);

    agentIs("shell");
    await outbox.queueMessage(c.id, "first");
    agentIs("shell");
    await outbox.queueMessage(c.id, "second");

    runScript.mockClear();
    agentIs("running");
    runScript.mockRejectedValueOnce(new Error("no server running"));
    expect((await outbox.flushCard(c.id)).delivered).toBe(0);

    const still = await outbox.pendingMessages(c.id);
    expect(still.map((m) => m.text)).toEqual(["first", "second"]);
    expect(still[0]?.attempts).toBe(1);
    expect(still[0]?.lastError).toMatch(/no server running/);
  });

  it("drops the queue of a card that no longer exists", async () => {
    const { outbox, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "doomed" });
    await registry.applyOpenTerminal(c.id);
    agentIs("shell");
    await outbox.queueMessage(c.id, "into the void");

    await registry.removeCard(c.id);
    expect((await outbox.flushCard(c.id)).delivered).toBe(0);
    expect(await outbox.pendingMessages(c.id)).toEqual([]);
    expect(await outbox.cardsWithPending()).toEqual([]);
  });

  it("never delivers twice when two triggers race", async () => {
    const { outbox, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "raced" });
    await registry.applyOpenTerminal(c.id);
    agentIs("shell");
    await outbox.queueMessage(c.id, "only once");

    runScript.mockClear();
    runScript.mockResolvedValue({ stdout: "node\n", stderr: "" });
    // Both callers get the SAME flush (the second joins the first) — so both see one delivery, and
    // the runner was told to type exactly once.
    const [a, b] = await Promise.all([outbox.flushCard(c.id), outbox.flushCard(c.id)]);
    expect(a.delivered).toBe(1);
    expect(b.delivered).toBe(1);
    const deliveries = runScript.mock.calls.filter((call) => (call as unknown as string[])[0].includes("send-keys"));
    expect(deliveries).toHaveLength(1);
  });
});

describe("cancelMessage", () => {
  it("drops one queued message and leaves the rest", async () => {
    const { outbox, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "queued" });
    agentIs("none");
    await outbox.queueMessage(c.id, "keep me");
    const { pending } = await outbox.queueMessage(c.id, "drop me");
    const target = pending.find((m) => m.text === "drop me");

    expect(await outbox.cancelMessage(c.id, target?.id ?? "")).toBe(true);
    expect((await outbox.pendingMessages(c.id)).map((m) => m.text)).toEqual(["keep me"]);
    expect(await outbox.cancelMessage(c.id, "not-a-message")).toBe(false);
  });
});

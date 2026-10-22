import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sessionGoneError } from "./cardSession.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
const pipeCommand = vi.fn((line: string) => ({ file: "sh", args: ["-c", line] }));

let dir = "";

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.runner.container = "vibehub-runner";
  vi.doMock("../../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../../runtime/host.js")>("../../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript, writeFile: vi.fn(), ptyCommand: vi.fn(), pipeCommand }) };
  });
  return {
    maestro: await import("./maestro.js"),
    settings: await import("../settings/settings.js"),
    registry: await import("../board/registry.js"),
    provenance: await import("../chat/provenance.js"),
    history: await import("../sdk/history.js"),
    agentState: await import("../board/agentState.js"),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-maestro-"));
  runScript.mockClear();
  runScript.mockResolvedValue({ stdout: "", stderr: "" });
  pipeCommand.mockClear();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const card = (over: Record<string, unknown> = {}) => ({
  column: "waiting", status: null, openedAt: 1, pausedAt: null, ...over,
}) as never;

describe("terminalSituation", () => {
  it("reads the dot when the card is on the mirrored columns", async () => {
    const { maestro } = await load();
    expect(maestro.terminalSituation(card({ status: "working" }))).toBe("working");
    expect(maestro.terminalSituation(card({ status: "waiting" }))).toBe("waiting");
  });

  it("lets the sticky columns win over the dot", async () => {
    const { maestro } = await load();
    expect(maestro.terminalSituation(card({ column: "paused", status: "working" }))).toBe("paused");
    expect(maestro.terminalSituation(card({ column: "done", status: "working" }))).toBe("done");
    expect(maestro.terminalSituation(card({ pausedAt: 5, status: "working" }))).toBe("paused");
  });

  it("says 'no session' for a card that was never opened", async () => {
    const { maestro } = await load();
    expect(maestro.terminalSituation(card({ openedAt: undefined }))).toBe("no session");
  });

  it("a card with a live session and no dot is waiting for a human", async () => {
    const { maestro } = await load();
    expect(maestro.terminalSituation(card({ status: null }))).toBe("waiting");
  });
});

describe("matchesProject", () => {
  it("matches an exact id or part of the name, case-insensitively", async () => {
    const { maestro } = await load();
    const p = { id: "abc-123", name: "Billing API" };
    expect(maestro.matchesProject(p, "abc-123")).toBe(true);
    expect(maestro.matchesProject(p, "billing")).toBe(true);
    expect(maestro.matchesProject(p, "BILL")).toBe(true);
    expect(maestro.matchesProject(p, "gateway")).toBe(false);
  });
  it("an empty filter matches everything", async () => {
    const { maestro } = await load();
    expect(maestro.matchesProject({ id: "a", name: "b" }, "  ")).toBe(true);
  });
});

describe("parseAssistantTranscript", () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it("keeps only assistant text, in order", async () => {
    const { maestro } = await load();
    const jsonl = [
      line({ type: "user", message: { content: "do the thing" } }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } }),
    ].join("\n");
    expect(maestro.parseAssistantTranscript(jsonl, 5)).toEqual(["first", "second"]);
  });

  it("drops tool calls, thinking and other non-text blocks", async () => {
    const { maestro } = await load();
    const jsonl = line({
      type: "assistant",
      message: { content: [
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
        { type: "text", text: "the answer" },
      ] },
    });
    expect(maestro.parseAssistantTranscript(jsonl, 5)).toEqual(["the answer"]);
  });

  it("survives truncated lines — `tail` cuts the first one in half", async () => {
    const { maestro } = await load();
    const jsonl = ['{"type":"assist', line({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } })].join("\n");
    expect(maestro.parseAssistantTranscript(jsonl, 5)).toEqual(["ok"]);
  });

  it("returns only the last N", async () => {
    const { maestro } = await load();
    const jsonl = ["a", "b", "c"].map((t) => line({ type: "assistant", message: { content: [{ type: "text", text: t }] } })).join("\n");
    expect(maestro.parseAssistantTranscript(jsonl, 2)).toEqual(["b", "c"]);
    expect(maestro.parseAssistantTranscript(jsonl, 0)).toEqual(["c"]);
  });

  it("accepts the older shape where content is a raw string", async () => {
    const { maestro } = await load();
    expect(maestro.parseAssistantTranscript(line({ type: "assistant", content: "plain" }), 1)).toEqual(["plain"]);
  });

  it("empty transcript = no answers, not an error", async () => {
    const { maestro } = await load();
    expect(maestro.parseAssistantTranscript("", 3)).toEqual([]);
  });
});

describe("buildSendKeysScript", () => {
  it("carries the text over stdin, never in argv", async () => {
    const { maestro } = await load();
    const script = maestro.buildSendKeysScript("vibehub-runner", "card-1234abcd", "run the tests");
    const dockerLine = script.split("\n").find((l) => l.startsWith("docker exec")) ?? "";
    expect(dockerLine).not.toContain("run the tests");
    expect(dockerLine).toContain("docker exec -i");
    expect(script).toContain("run the tests"); // in the heredoc body
  });

  it("types the text literally, so an instruction saying 'Enter' is not a keystroke", async () => {
    const { maestro } = await load();
    const script = maestro.buildSendKeysScript("c", "s", "press Enter twice");
    expect(script).toContain("send-keys -t \"$1\" -l --");
    expect(script).toContain('tmux send-keys -t "$1" Enter'); // the real submit, separate
    // ...and after the TUI's paste window, or the Enter is swallowed INTO the paste and the
    // message sits there typed but unsent.
    expect(script).toContain("sleep 0.15");
  });

  it("refuses text that would close the heredoc early", async () => {
    const { maestro } = await load();
    expect(() => maestro.buildSendKeysScript("c", "s", "before\nVIBEHUB_MAESTRO_TEXT\nafter"))
      .toThrow(/reserved line/);
  });

  it("quotes a hostile session name into one argument", async () => {
    const { maestro } = await load();
    const script = maestro.buildSendKeysScript("c", "s'; rm -rf /; '", "hi");
    expect(script).toContain(`'s'\\''; rm -rf /; '\\'''`);
  });
});

describe("buildReadTranscriptScript", () => {
  it("reads the most recent transcript, tail-limited", async () => {
    const { maestro } = await load();
    const script = maestro.buildReadTranscriptScript("vibehub-runner", "/root/.claude/projects/x", 100);
    expect(script).toContain("ls -1t");
    expect(script).toContain("tail -n 100");
    expect(script).toContain("/root/.claude/projects/x");
  });

  it("is read-only and tolerates an empty directory", async () => {
    const { maestro } = await load();
    const script = maestro.buildReadTranscriptScript("c", "/root/x", 10);
    // Only read verbs, and the single redirect is stderr going to /dev/null.
    expect(script).toMatch(/\bls -1t\b/);
    expect(script).toMatch(/\btail -n\b/);
    expect(script).not.toMatch(/\brm\b|\bmv\b|\btee\b|>>/);
    expect(script.match(/>/g) ?? []).toEqual([">"]); // just `2>/dev/null`
    expect(script).toContain("|| true");
  });

  it("clamps an absurd tail and rejects an unsafe directory", async () => {
    const { maestro } = await load();
    expect(maestro.buildReadTranscriptScript("c", "/root/x", 999_999)).toContain("tail -n 5000");
    expect(() => maestro.buildReadTranscriptScript("c", "/root/../etc", 10)).toThrow(/\.\./);
  });
});

describe("listTerminals", () => {
  it("lists cards with their situation, board order first", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const a = await registry.createCard({ projectId: p.id, title: "in the backlog" });
    const b = await registry.createCard({ projectId: p.id, title: "being worked on" });
    await registry.updateCard(b.id, { column: "working" });
    const list = await maestro.listTerminals();
    expect(list.map((t) => t.title)).toEqual(["in the backlog", "being worked on"]);
    expect(list[0]?.situation).toBe("no session");
  });

  it("filters by project name", async () => {
    const { maestro, registry } = await load();
    const one = await registry.createProject({ name: "billing" });
    const two = await registry.createProject({ name: "gateway" });
    await registry.createCard({ projectId: one.id, title: "a" });
    await registry.createCard({ projectId: two.id, title: "b" });
    expect((await maestro.listTerminals("gate")).map((t) => t.title)).toEqual(["b"]);
  });
});

describe("sendToTerminal", () => {
  it("refuses to send to a card with no live session, and says what to do", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "never opened" });
    await expect(maestro.sendToTerminal(c.id, "hello")).rejects.toThrow(/no live session/);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("refuses empty text and an unknown card", async () => {
    const { maestro } = await load();
    await expect(maestro.sendToTerminal("x", "   ")).rejects.toThrow(/empty text/);
    await expect(maestro.sendToTerminal("nope", "hi")).rejects.toThrow(/card not found/);
  });

  it("delivers to an open card", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "open one" });
    await registry.applyOpenTerminal(c.id);
    const out = await maestro.sendToTerminal(c.id, "run the tests");
    expect(out).toMatchObject({ sent: true, title: "open one", project: "billing" });
    expect(runScript).toHaveBeenCalledOnce();
    expect((runScript.mock.calls[0] as unknown as string[])[0]).toContain("run the tests");
  });
});

describe("readTerminal", () => {
  it("returns the last answers plus the situation, without needing a live session", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "paused one" });
    runScript.mockResolvedValueOnce({
      stdout: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
      stderr: "",
    });
    const out = await maestro.readTerminal(c.id, 1);
    expect(out.answers).toEqual(["done"]);
    expect(out.situation).toBe("no session");
  });

  it("404s an unknown card", async () => {
    const { maestro } = await load();
    await expect(maestro.readTerminal("nope")).rejects.toThrow(/card not found/);
  });
});

describe("sessionGoneError", () => {
  it("turns tmux's wording into the action that fixes it", async () => {
    for (const raw of ["no server running on /tmp/tmux-0/default", "can't find session: card-1234"]) {
      const out = sessionGoneError(new Error(raw), "my card");
      expect(out.message).toContain("my card");
      expect(out.message).toMatch(/open the card/i);
    }
  });

  it("leaves an unrelated failure exactly as it was", async () => {
    const original = new Error("docker: permission denied while trying to connect to the socket");
    expect(sessionGoneError(original, "my card")).toBe(original);
  });

  it("surfaces the friendly error through sendToTerminal", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "ghost session" });
    await registry.applyOpenTerminal(c.id);
    runScript.mockRejectedValueOnce(new Error("no server running on /tmp/tmux-0/default"));
    await expect(maestro.sendToTerminal(c.id, "hello")).rejects.toThrow(/open the card/i);
  });
});

describe("reportState (declared state)", () => {
  it("sets declaredState and a normalized summary, without touching the column or the dot", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "worker" });
    await registry.updateCard(c.id, { column: "working" });
    const out = await maestro.reportState(c.id, "ready", "  all green,   PR up ");
    expect(out).toMatchObject({ reported: true, state: "ready", summary: "all green, PR up" });
    const after = await registry.getCard(c.id);
    expect(after?.declaredState).toBe("ready");
    expect(after?.declaredSummary).toBe("all green, PR up");
    // orthogonal: the activity column/dot is untouched
    expect(after?.column).toBe("working");
    expect(after?.status ?? null).toBeNull();
  });

  it("rejects an unknown state and an unknown card", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "worker" });
    await expect(maestro.reportState(c.id, "shipping", "x")).rejects.toThrow(/invalid state/);
    await expect(maestro.reportState("nope", "ready", "x")).rejects.toThrow(/card not found/);
  });

  it("surfaces declaredState, summary and humanActive through the terminal listing", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "worker" });
    await maestro.reportState(c.id, "needs_me", "which currency?");
    const [row] = await maestro.listTerminals();
    expect(row).toMatchObject({ declaredState: "needs_me", declaredSummary: "which currency?", humanActive: false });
  });

  it("a card that declares it needs the user lands in the card-event inbox", async () => {
    const { maestro, registry } = await load();
    const users = await import("../../auth/users.js");
    const events = await import("../events/cardEvents.js");
    const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "worker" });
    await maestro.reportState(c.id, "needs_me", "which currency?");
    await vi.waitFor(async () => expect((await events.inboxFor(owner)).events).toEqual([
      expect.objectContaining({ kind: "needs_me", cardId: c.id, state: "needs_me", summary: "which currency?" }),
    ]));
  });
});

describe("message provenance on send", () => {
  it("agentOriginFor names the calling card, with the ids the chat links back to", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const sender = await registry.createCard({ projectId: p.id, title: "card preview" });
    expect(await maestro.agentOriginFor(sender.id)).toEqual({
      kind: "agent", name: "card preview", sourceCardId: sender.id, sourceProjectId: p.id,
    });
    // Self-declared and optional: an unknown or absent id degrades to a nameless agent, never an error.
    expect(await maestro.agentOriginFor("nope")).toEqual({ kind: "agent", name: "" });
    expect(await maestro.agentOriginFor(undefined)).toEqual({ kind: "agent", name: "" });
  });

  it("records who sent it and keeps an agent's message in the card history (TUI-only path)", async () => {
    const { maestro, registry, provenance, history, settings } = await load();
    await settings.updateSettings({ sdkDriver: false }); // TUI-only install: the tmux path
    const p = await registry.createProject({ name: "billing" });
    const sender = await registry.createCard({ projectId: p.id, title: "card preview" });
    const dest = await registry.createCard({ projectId: p.id, title: "destino" });
    await registry.applyOpenTerminal(dest.id);
    const origin = await maestro.agentOriginFor(sender.id);
    runScript.mockResolvedValueOnce({ stdout: "bash\nnode\n", stderr: "" }); // agent probe: claude alive

    const live: unknown[] = [];
    const off = history.onExternalMessage(dest.id, (e) => live.push(e));
    await maestro.sendToTerminal(dest.id, "roda os testes", { origin });
    off();

    // The agent probe, then the send-keys script; the attribution is queryable right away.
    expect(runScript).toHaveBeenCalledTimes(2);
    expect((runScript.mock.calls[1] as unknown as string[])[0]).toContain("roda os testes");
    expect(provenance.matchOrigin(dest.id, "roda  os\ntestes", Date.now())).toEqual(origin);
    // The native chat heard it live, and the history log replays it with its sender.
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ type: "user", text: "roda os testes", from: origin });
    await history.appendHistory(dest.id, { type: "session", sessionId: "s" }); // barrier: the chain is serialized
    const replay = await history.readHistory(dest.id);
    expect(replay.find((e) => e.type === "user")).toMatchObject({ text: "roda os testes", from: origin });
  });

  it("a person's send records their username, and goes nowhere near the sdk history", async () => {
    const { maestro, registry, provenance, history } = await load();
    const p = await registry.createProject({ name: "billing" });
    const dest = await registry.createCard({ projectId: p.id, title: "destino" });
    await registry.applyOpenTerminal(dest.id);
    const live: unknown[] = [];
    const off = history.onExternalMessage(dest.id, (e) => live.push(e));
    await maestro.sendToTerminal(dest.id, "oi", { origin: { kind: "user", name: "alex" } });
    off();
    expect(provenance.matchOrigin(dest.id, "oi", Date.now())).toEqual({ kind: "user", name: "alex" });
    expect(live).toHaveLength(0); // their own websocket already draws it — no external announcement
  });

  it("a send without origin records nothing (the pre-provenance behaviour)", async () => {
    const { maestro, registry, provenance } = await load();
    const p = await registry.createProject({ name: "billing" });
    const dest = await registry.createCard({ projectId: p.id, title: "destino" });
    await registry.applyOpenTerminal(dest.id);
    await maestro.sendToTerminal(dest.id, "sem origem");
    expect(provenance.matchOrigin(dest.id, "sem origem", Date.now())).toBeUndefined();
  });
});

describe("an agent's send goes to the native chat while it is in use, to the terminal otherwise", () => {
  // THE BUG: with the native chat on, the card's conversation lives in its SDK driver — but the
  // maestro typed into the tmux TUI, whose Claude still held the context of the day it was opened
  // (or was a bare shell by then). The child worked blind, or nobody worked at all.
  type Child = EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; kill: () => void;
    stdin: EventEmitter & { written: string[]; writable: boolean; write: (s: string) => boolean; end: () => void };
  };
  let spawned: Child[] = [];
  const fakeChild = (): Child => {
    const child = new EventEmitter() as Child;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const stdin = new EventEmitter() as Child["stdin"];
    stdin.written = [];
    stdin.writable = true;
    stdin.write = (s: string) => { stdin.written.push(s); return true; };
    stdin.end = () => { stdin.writable = false; };
    child.stdin = stdin;
    child.exitCode = null;
    child.kill = () => undefined;
    return child;
  };
  const userFrames = (child: Child) =>
    child.stdin.written.map((l) => JSON.parse(l) as { type: string; text?: string }).filter((f) => f.type === "user");
  const sendKeysRan = () =>
    runScript.mock.calls.some((c) => String((c as unknown as string[])[0]).includes("tmux send-keys"));

  async function nativeCard() {
    const loaded = { ...(await load()), manager: await import("../sdk/manager.js") };
    spawned = [];
    loaded.manager.setDriverSpawnerForTesting(() => {
      const child = fakeChild();
      spawned.push(child);
      return child as never;
    });
    const p = await loaded.registry.createProject({ name: "billing" });
    const sender = await loaded.registry.createCard({ projectId: p.id, title: "maestro" });
    const dest = await loaded.registry.createCard({ projectId: p.id, title: "filho" });
    await loaded.registry.applyOpenTerminal(dest.id);
    const origin = await loaded.maestro.agentOriginFor(sender.id);
    return { ...loaded, dest, origin };
  }

  it("with the card's driver alive, the instruction is a turn of THAT driver — no send-keys, one bubble", async () => {
    const { maestro, manager, history, dest, origin } = await nativeCard();
    manager.ensureDriverSession({ cardId: dest.id, label: "filho", command: { file: "x", args: [] } });
    const live: unknown[] = [];
    const off = history.onExternalMessage(dest.id, (e) => live.push(e));
    const out = await maestro.sendToTerminal(dest.id, "rode os testes e corrija", { respectHumanActive: true, origin });
    off();
    manager.resetSdkSessionsForTesting();

    expect(out).toMatchObject({ sent: true, title: "filho", project: "billing" });
    expect(sendKeysRan()).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(userFrames(spawned[0]!)).toEqual([{ type: "user", text: "rode os testes e corrija" }]);
    // The driver path draws the bubble itself (history + relay); the external bus would draw a second one.
    expect(live).toHaveLength(0);
    await history.appendHistory(dest.id, { type: "session", sessionId: "s" }); // barrier: the chain is serialized
    const replay = await history.readHistory(dest.id);
    expect(replay.filter((e) => e.type === "user")).toEqual([
      expect.objectContaining({ text: "rode os testes e corrija", from: origin }),
    ]);
  });

  it("with no live driver (chat not in use), the instruction is typed at the terminal — no hidden driver is spawned", async () => {
    const { maestro, manager, dest, origin } = await nativeCard();
    runScript.mockResolvedValueOnce({ stdout: "bash\nnode\n", stderr: "" }); // agent probe: claude alive in the TUI
    const out = await maestro.sendToTerminal(dest.id, "continue a tarefa", { respectHumanActive: true, origin });
    manager.resetSdkSessionsForTesting();

    expect(out).toMatchObject({ sent: true, title: "filho" });
    expect(spawned).toHaveLength(0);
    expect(sendKeysRan()).toBe(true);
  });

  it("a driver that can no longer take a turn fails the send out loud — nothing recorded", async () => {
    const { maestro, manager, history, dest, origin } = await nativeCard();
    manager.ensureDriverSession({ cardId: dest.id, label: "filho", command: { file: "x", args: [] } });
    spawned[0]!.exitCode = 1; // died; its close has not fired yet
    await expect(maestro.sendToTerminal(dest.id, "oi", { respectHumanActive: true, origin })).rejects.toThrow(/driver/i);
    manager.resetSdkSessionsForTesting();
    expect(sendKeysRan()).toBe(false);
    await history.appendHistory(dest.id, { type: "session", sessionId: "s" });
    expect((await history.readHistory(dest.id)).some((e) => e.type === "user")).toBe(false);
  });

  it("a person typing in the card still blocks the agent on the native chat", async () => {
    const { maestro, manager, registry, dest, origin } = await nativeCard();
    await registry.markCardHumanActive(dest.id, Date.now());
    await expect(maestro.sendToTerminal(dest.id, "oi", { respectHumanActive: true, origin })).rejects.toThrow(/human-active/);
    manager.resetSdkSessionsForTesting();
    expect(spawned).toHaveLength(0);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("on a TUI-only install, an agent never types into a bare shell: refused, and no bubble announced", async () => {
    const { maestro, settings, history, dest, origin } = await nativeCard();
    await settings.updateSettings({ sdkDriver: false });
    runScript.mockResolvedValueOnce({ stdout: "bash\n", stderr: "" }); // agent probe: only a shell in the pane
    const live: unknown[] = [];
    const off = history.onExternalMessage(dest.id, (e) => live.push(e));
    await expect(maestro.sendToTerminal(dest.id, "oi", { respectHumanActive: true, origin })).rejects.toThrow(/no agent running/i);
    off();
    expect(sendKeysRan()).toBe(false);
    expect(live).toHaveLength(0);
  });
});

describe("human-active lock (maestro-only)", () => {
  it("with respectHumanActive, refuses a send to a human-active card, sends nothing, but still allows a read", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "someone is typing" });
    await registry.applyOpenTerminal(c.id); // a live session — the refusal is about the human, not the session
    await registry.markCardHumanActive(c.id, Date.now());

    // the MAESTRO path opts in and is refused
    await expect(maestro.sendToTerminal(c.id, "run the tests", { respectHumanActive: true })).rejects.toThrow(/human-active/);
    expect(runScript).not.toHaveBeenCalled();

    // reading is always allowed
    runScript.mockResolvedValueOnce({
      stdout: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      stderr: "",
    });
    expect((await maestro.readTerminal(c.id, 1)).answers).toEqual(["hi"]);
  });

  it("the PERSON's own send (no respectHumanActive) is NEVER blocked by human-active — their typing is what marks it", async () => {
    // REGRESSION: the human-active check was firing on the user's OWN chat send, so nothing they
    // typed could be delivered. Their send must always go through.
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "the user is here" });
    await registry.applyOpenTerminal(c.id);
    await registry.markCardHumanActive(c.id, Date.now()); // active RIGHT NOW
    const out = await maestro.sendToTerminal(c.id, "oi"); // no opts = the user path
    expect(out).toMatchObject({ sent: true });
    expect(runScript).toHaveBeenCalledOnce();
  });

  it("a stale human-active stamp (older than the window) does not block even the maestro", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "typed a while ago" });
    await registry.applyOpenTerminal(c.id);
    await registry.markCardHumanActive(c.id, Date.now() - registry.HUMAN_ACTIVE_WINDOW_MS - 1);
    const out = await maestro.sendToTerminal(c.id, "carry on", { respectHumanActive: true });
    expect(out).toMatchObject({ sent: true });
    expect(runScript).toHaveBeenCalledOnce();
  });
});

describe("requireAgent guard — the chat's forever-pending bubble", () => {
  // THE BUG: Claude exits, the pane is a bare shell that still accepts keystrokes; the chat send
  // answered 200 and the message went to bash — never echoed, so the optimistic bubble hung as
  // "enviando" forever. With `requireAgent` the send refuses instead, and the UI can say so.
  it("refuses to type into a pane where Claude exited to a bare shell", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "claude saiu" });
    await registry.applyOpenTerminal(c.id);
    runScript.mockResolvedValueOnce({ stdout: "bash\n", stderr: "" }); // agent probe: only shells in the tree
    await expect(maestro.sendToTerminal(c.id, "arruma o dre", { requireAgent: true })).rejects.toThrow(
      /no agent running/i,
    );
    expect(runScript).toHaveBeenCalledOnce(); // only the probe — never the send-keys
  });

  it("refuses when the tmux session is gone entirely (probe sees nothing)", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "sessão sumiu" });
    await registry.applyOpenTerminal(c.id);
    runScript.mockResolvedValueOnce({ stdout: "", stderr: "" }); // agent probe: no panes at all
    await expect(maestro.sendToTerminal(c.id, "oi", { requireAgent: true })).rejects.toThrow(/no agent running/i);
  });

  it("with Claude alive, the message goes through (probe + send)", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "vivo" });
    await registry.applyOpenTerminal(c.id);
    runScript.mockResolvedValueOnce({ stdout: "bash\nnode\n", stderr: "" }); // agent probe: claude under the shell
    runScript.mockResolvedValueOnce({ stdout: "", stderr: "" }); // the send-keys
    const out = await maestro.sendToTerminal(c.id, "roda os testes", { requireAgent: true });
    expect(out).toMatchObject({ sent: true });
    expect(runScript).toHaveBeenCalledTimes(2);
  });
});

describe("interactive-menu guard", () => {
  it("with guardInteractiveMenu, refuses to send into an open menu and never types", async () => {
    // The chat send opts in. A menu in the pane (resume/compact/permission) → refuse, so the message
    // is not pressed onto the highlighted option. Only the probe ran; no send-keys.
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "at a menu" });
    await registry.applyOpenTerminal(c.id);
    runScript.mockResolvedValueOnce({
      stdout: "❯ 1. Resume from summary\n  2. Resume full\nEnter to confirm · Esc to cancel",
      stderr: "",
    });
    await expect(maestro.sendToTerminal(c.id, "arruma o dre", { guardInteractiveMenu: true })).rejects.toThrow(
      /awaiting choice/i,
    );
    expect(runScript).toHaveBeenCalledOnce();
  });

  it("with guardInteractiveMenu but no menu, the message goes through", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "at the prompt" });
    await registry.applyOpenTerminal(c.id);
    runScript.mockResolvedValueOnce({ stdout: "> \n? for shortcuts", stderr: "" }); // menu probe: normal prompt
    runScript.mockResolvedValueOnce({ stdout: "", stderr: "" }); // the send-keys
    const out = await maestro.sendToTerminal(c.id, "roda os testes", { guardInteractiveMenu: true });
    expect(out).toMatchObject({ sent: true });
    expect(runScript).toHaveBeenCalledTimes(2);
  });

  it("the agent path (no flag) never probes for a menu", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "agent send" });
    await registry.applyOpenTerminal(c.id);
    const out = await maestro.sendToTerminal(c.id, "carry on");
    expect(out).toMatchObject({ sent: true });
    expect(runScript).toHaveBeenCalledOnce(); // just the send-keys
  });
});

/**
 * Produção, 21/10/2026 (card a8f0 do api-space): create_card(open) answered "opened", and every
 * vibehub_send_to_terminal after it failed with "awaiting choice" — the new card's Claude sat on the
 * folder-trust dialog, and a send right after an open also races Claude's boot. A waiting send
 * (readyWaitMs) holds while Claude boots, delivers once the prompt is drawn, and still NEVER types
 * into a menu: one open at the deadline refuses, naming which.
 */
describe("a waiting send (readyWaitMs) — boot race and menus", () => {
  /** The pane the runner showed for card a8f0, captured from production. */
  const TRUST_PANE = [
    " Accessing workspace:",
    " /work/multiversoatacado--api-space-worktrees/relatorio-top-100-clientes-b2b-space-a8f0",
    " Quick safety check: Is this a project you created or one you trust? (Like your",
    " own code, a well-known open source project, or work from your team).",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    " Enter to confirm · Esc to cancel",
  ].join("\n");
  const READY_PANE = "╭────╮\n│ > │\n╰────╯\n  ⏵⏵ bypass permissions on · ? for shortcuts";

  const sentAfter: number[] = [];

  /** Answers the host by WHAT the script is: agent probe, pane capture or the send itself. */
  function runner(states: { agent: string; pane: string }[]) {
    let i = 0;
    const sent: string[] = [];
    sentAfter.length = 0;
    runScript.mockImplementation((async (script: string) => {
      const st = states[Math.min(i, states.length - 1)];
      // `sentAfter` = how many pane captures ran before the keys went: proof the send WAITED.
      if (script.includes("tmux send-keys")) { sent.push(script); sentAfter.push(i); return { stdout: "", stderr: "" }; }
      if (script.includes("list-panes")) return { stdout: st.agent, stderr: "" };
      if (script.includes("capture-pane")) { i += 1; return { stdout: st.pane, stderr: "" }; }
      return { stdout: "", stderr: "" };
    }) as never);
    return sent;
  }

  async function openedCard(title: string) {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "api-space" });
    const c = await registry.createCard({ projectId: p.id, title });
    await registry.applyOpenTerminal(c.id);
    return { maestro, c };
  }

  const waiting = { guardInteractiveMenu: true, requireAgent: true, readyWaitMs: 400, readyPollMs: 5 };

  it("holds while Claude boots (pane not drawn, then a shell-only tree) and delivers once the prompt is up", async () => {
    const { maestro, c } = await openedCard("booting");
    const sent = runner([
      { agent: "bash\nnode\n", pane: "" }, // the seed's node is running, nothing painted yet
      { agent: "bash\nclaude\n", pane: "" },
      { agent: "bash\nclaude\n", pane: READY_PANE },
    ]);
    const out = await maestro.sendToTerminal(c.id, "gera o relatorio", waiting);
    expect(out).toMatchObject({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("gera o relatorio");
    expect(sentAfter).toEqual([3]); // only after the third look, the one that saw the prompt
  });

  it("without a wait, the same boot keeps the old answer (one look, an empty pane is not a refusal)", async () => {
    const { maestro, c } = await openedCard("no wait");
    const sent = runner([{ agent: "bash\nclaude\n", pane: "" }]);
    await maestro.sendToTerminal(c.id, "oi", { guardInteractiveMenu: true, requireAgent: true });
    expect(sent).toHaveLength(1);
  });

  it("a menu that clears during the wait (e.g. answered on the board) lets the send through", async () => {
    const { maestro, c } = await openedCard("menu clears");
    const sent = runner([
      { agent: "bash\nclaude\n", pane: TRUST_PANE },
      { agent: "bash\nclaude\n", pane: READY_PANE },
    ]);
    await maestro.sendToTerminal(c.id, "segue", waiting);
    expect(sent).toHaveLength(1);
  });

  it("never types into a menu still open at the deadline — refuses naming the trust dialog", async () => {
    const { maestro, c } = await openedCard("stuck on trust");
    const sent = runner([{ agent: "bash\nclaude\n", pane: TRUST_PANE }]);
    await expect(maestro.sendToTerminal(c.id, "segue", waiting)).rejects.toThrow(
      /awaiting choice \(trust\).*folder-trust dialog.*waited/i,
    );
    expect(sent).toHaveLength(0); // Enter would have picked "No, exit" and killed Claude
  });

  it("names the resume menu and the permission prompt too", async () => {
    const { maestro, c } = await openedCard("resume");
    runner([{ agent: "claude\n", pane: "❯ 1. Resume from summary\n  2. Resume full\nEnter to confirm · Esc to cancel" }]);
    await expect(maestro.sendToTerminal(c.id, "x", waiting)).rejects.toThrow(/awaiting choice \(resume\)/);
    runner([{ agent: "claude\n", pane: "Do you want to proceed?\n❯ 1. Yes\n  2. No" }]);
    await expect(maestro.sendToTerminal(c.id, "x", waiting)).rejects.toThrow(/awaiting choice \(permission\)/);
  });

  it("a Claude that never comes up refuses as 'no agent running', and one never drawn as 'terminal not ready'", async () => {
    const { maestro, c } = await openedCard("dead");
    runner([{ agent: "bash\n", pane: "$ " }]);
    await expect(maestro.sendToTerminal(c.id, "x", waiting)).rejects.toThrow(/no agent running.*bare shell/);
    runner([{ agent: "claude\n", pane: "" }]);
    await expect(maestro.sendToTerminal(c.id, "x", waiting)).rejects.toThrow(/terminal not ready/);
  });

  it("waitTerminalReady (the open's readiness) says ready, or why not — never throws", async () => {
    const { maestro, c } = await openedCard("open readiness");
    runner([{ agent: "claude\n", pane: "" }, { agent: "claude\n", pane: READY_PANE }]);
    expect(await maestro.waitTerminalReady(c.id, 400, 5)).toEqual({ ready: true });
    runner([{ agent: "claude\n", pane: TRUST_PANE }]);
    const stuck = await maestro.waitTerminalReady(c.id, 30, 5);
    expect(stuck).toMatchObject({ ready: false });
    expect((stuck as { detail: string }).detail).toMatch(/awaiting choice \(trust\)/);
    expect(await maestro.waitTerminalReady("nope", 30, 5)).toEqual({ ready: false, detail: "card not found" });
  });
});

describe("session introspection", () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it("reads the model of the LAST assistant turn", async () => {
    const { maestro } = await load();
    const jsonl = [
      line({ type: "assistant", message: { model: "claude-sonnet-5", content: [] } }),
      line({ type: "user", message: { content: "x" } }),
      line({ type: "assistant", message: { model: "claude-opus-5", content: [] } }),
    ].join("\n");
    expect(maestro.parseLastModel(jsonl)).toBe("claude-opus-5");
    expect(maestro.parseLastModel("")).toBeNull();
    expect(maestro.parseLastModel('{"type":"assi')).toBeNull();
  });

  it("maps model ids to the names the UI shows, VERSION included, and passes unknown ids through", async () => {
    const { maestro } = await load();
    // A card pins a family alias, so only the transcript can name the release it resolved to.
    expect(maestro.modelLabelFor("claude-opus-5-5")).toBe("Opus 5.5");
    expect(maestro.modelLabelFor("claude-opus-5")).toBe("Opus 5");
    expect(maestro.modelLabelFor("claude-fable-5-1")).toBe("Fable 5.1");
    expect(maestro.modelLabelFor("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(maestro.modelLabelFor("claude-sonnet-6")).toBe("Sonnet 6");
    expect(maestro.modelLabelFor("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(maestro.modelLabelFor("gpt-x")).toBe("gpt-x");
    expect(maestro.modelLabelFor(null)).toBeNull();
  });

  it("reports the effective account name and the live model; tolerates no transcript", async () => {
    const { maestro, registry } = await load();
    const acct = await registry.createAccount({ name: "Tech" });
    const p = await registry.createProject({ name: "billing", defaultAccountSlug: acct.slug });
    const c = await registry.createCard({ projectId: p.id, title: "x" });
    runScript.mockResolvedValueOnce({ stdout: line({ type: "assistant", effort: "xhigh", message: { model: "claude-opus-5", content: [] } }), stderr: "" });
    const info = await maestro.sessionInfo(c.id);
    expect(info).toEqual({
      model: "claude-opus-5",
      modelLabel: "Opus 5",
      // Unpinned card: the level comes from the transcript's stamp, so the menu can tick it.
      effort: "xhigh",
      account: { slug: acct.slug, name: "Tech" },
      // A card that was never opened has no session for the chat to be waiting on.
      situation: "no session",
    });
    runScript.mockRejectedValueOnce(new Error("runner down"));
    expect((await maestro.sessionInfo(c.id)).model).toBeNull();
  });

  it("falls back to the default account label when nothing is set", async () => {
    const { maestro, registry } = await load();
    await registry.setDefaultAccountLabel("principal");
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "x" });
    expect((await maestro.sessionInfo(c.id)).account).toEqual({ slug: null, name: "principal" });
  });

  it("a live card whose Claude EXITED to a bare shell reads as 'stopped' (J: 'Claude parou')", async () => {
    // The registry still calls this card 'waiting' (openedAt set, not paused); only a live probe
    // knows Claude is gone and the pane is a bare shell. sessionInfo runs it: transcript first, then
    // the probe. CLASSIC chat: the conversation really is the tmux one, so the pane is the truth.
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "claude left" });
    await registry.applyOpenTerminal(c.id);
    runScript
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // transcript: no model yet
      .mockResolvedValueOnce({ stdout: "bash\n", stderr: "" }); // probe: only a shell in the tree
    expect((await maestro.sessionInfo(c.id)).situation).toBe("stopped");
  });

  it("a live card the runner lost (empty probe) reads as 'no session', not a false 'waiting'", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "ghost" });
    await registry.applyOpenTerminal(c.id);
    runScript
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // transcript
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // probe: nothing at all → none
    expect((await maestro.sessionInfo(c.id)).situation).toBe("no session");
  });

  it("a live card with Claude alive in the tree stays 'waiting' (no false 'stopped')", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "alive" });
    await registry.applyOpenTerminal(c.id);
    runScript
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // transcript
      .mockResolvedValueOnce({ stdout: "bash\nclaude\n", stderr: "" }); // probe: claude is there
    expect((await maestro.sessionInfo(c.id)).situation).toBe("waiting");
  });

  // ---- the native chat (SDK driver): its claude is NOT in the tmux tree ----

  it("a driver with a turn in flight reads as 'working', even with the status hooks unreachable", async () => {
    const { maestro, registry, agentState } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "busy" });
    await registry.applyOpenTerminal(c.id);
    const off = agentState.onCardDriverProbe((cardId) => (cardId === c.id ? "turn" : "none"));
    try {
      runScript.mockResolvedValueOnce({ stdout: "", stderr: "" });
      expect((await maestro.sessionInfo(c.id)).situation).toBe("working");
    } finally {
      off();
    }
  });

  it("a live driver at its prompt is 'waiting' — never the bare-shell verdict", async () => {
    // Produção, 2026-10-02: the native chat's claude is a child of the BACK, invisible to the tmux
    // probe — which read the bare pane under it as "Claude exited" and hung the "Claude parou"
    // banner over a session that was answering normally. A card being driven is being driven.
    const { maestro, registry, agentState } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "idle driver" });
    await registry.applyOpenTerminal(c.id);
    const off = agentState.onCardDriverProbe(() => "idle" as const);
    try {
      runScript.mockResolvedValueOnce({ stdout: "", stderr: "" });
      expect((await maestro.sessionInfo(c.id)).situation).toBe("waiting");
      expect(runScript).toHaveBeenCalledOnce();
    } finally {
      off();
    }
  });
});

describe("model signals", () => {
  it("ignores Claude Code's <synthetic> notices when reading the model in use", async () => {
    const { maestro } = await load();
    const line = (obj: unknown) => JSON.stringify(obj);
    const jsonl = [
      line({ type: "assistant", timestamp: "2026-08-22T03:00:00Z", message: { model: "claude-fable-5", content: [] } }),
      line({ type: "assistant", timestamp: "2026-08-22T03:05:00Z", message: { model: "<synthetic>", content: [] } }),
    ].join("\n");
    expect(maestro.parseLastTurn(jsonl)).toEqual({ model: "claude-fable-5", at: Date.parse("2026-08-22T03:00:00Z"), effort: null });
  });

  it("a /model choice newer than the last reply wins; an older one loses", async () => {
    const { maestro } = await load();
    const turn = { model: "claude-sonnet-5", at: 1000 };
    expect(maestro.pickModel(turn, { model: "fable", at: 2000 })).toBe("fable");
    expect(maestro.pickModel(turn, { model: "fable", at: 500 })).toBe("claude-sonnet-5");
    expect(maestro.pickModel({ model: null, at: 0 }, { model: "opus", at: 0 })).toBe("opus");
    expect(maestro.pickModel({ model: null, at: 0 }, { model: null, at: 0 })).toBeNull();
  });

  it("a card that PINS a model ignores settings.json — that profile is shared with every other card", async () => {
    const { maestro } = await load();
    const turn = { model: "claude-fable-5", at: 1000 };
    // The bug: `/model opus` typed in a NEIGHBOURING card on the same account wrote "opus" into the
    // shared profile, and this card (pinned to Fable, started with `--model`) read it as its own.
    expect(maestro.pickModel(turn, { model: "opus", at: 5000 }, { model: "claude-fable-5", at: 900 })).toBe("claude-fable-5");
    // The pin is newer than the transcript right after a switch (it restarted the session onto it).
    expect(maestro.pickModel(turn, { model: null, at: 0 }, { model: "claude-opus-5", at: 2000 })).toBe("claude-opus-5");
    // `/model` typed HERE after that switch is newer still, and it is what is answering.
    expect(maestro.pickModel({ model: "claude-sonnet-5", at: 3000 }, { model: null, at: 0 }, { model: "claude-opus-5", at: 2000 }))
      .toBe("claude-sonnet-5");
    // No pin: settings.json keeps its old say.
    expect(maestro.pickModel(turn, { model: "opus", at: 5000 })).toBe("opus");
  });

  it("splits the session script output into transcript and settings", async () => {
    const { maestro } = await load();
    const out = maestro.parseSessionOutput('{"type":"assistant"}\n' + maestro.SESSION_MARKER + "\n1787370000\n{\"model\":\"fable\"}");
    expect(out.transcript.trim()).toBe('{"type":"assistant"}');
    expect(out.settings).toEqual({ model: "fable", at: 1787370000000, effort: null });
    expect(maestro.parseSessionOutput("only transcript").settings).toEqual({ model: null, at: 0, effort: null });
    const withLevel = maestro.parseSessionOutput(maestro.SESSION_MARKER + '\n1787370000\n{"effortLevel":"xhigh"}');
    expect(withLevel.settings.effort).toBe("xhigh");
    // A level the whitelist does not know is not a reading.
    expect(maestro.parseSessionOutput(maestro.SESSION_MARKER + '\n1\n{"effortLevel":"turbo"}').settings.effort).toBeNull();
  });

  it("reads the reasoning level Claude Code stamps on each assistant turn", async () => {
    const { maestro } = await load();
    const line = (obj: unknown) => JSON.stringify(obj);
    const jsonl = [
      line({ type: "assistant", timestamp: "2026-08-22T03:00:00Z", effort: "medium", message: { model: "claude-opus-5", content: [] } }),
      line({ type: "assistant", timestamp: "2026-08-22T03:05:00Z", effort: "max", message: { model: "claude-opus-5", content: [] } }),
      line({ type: "assistant", timestamp: "2026-08-22T03:06:00Z", message: { model: "<synthetic>", content: [] } }),
    ].join("\n");
    expect(maestro.parseLastTurn(jsonl).effort).toBe("max");
    // A turn with no stamp (older CLI) or an unknown word is not a reading.
    expect(maestro.parseLastTurn(line({ type: "assistant", message: { model: "claude-opus-5" } })).effort).toBeNull();
    expect(maestro.parseLastTurn(line({ type: "assistant", effort: "turbo", message: { model: "claude-opus-5" } })).effort).toBeNull();
  });

  it("picks the effort in use: a newer pin change, else the last reply, else the pin, else settings", async () => {
    const { maestro } = await load();
    const turn = { effort: "medium", at: 1000 };
    // Unpinned card: the transcript is the truth — this is what the menu ticks.
    expect(maestro.pickEffort(turn, { effort: null })).toBe("medium");
    // Pin set AFTER the last reply: the session restarted onto it.
    expect(maestro.pickEffort(turn, { effort: null }, { effort: "max", at: 2000 })).toBe("max");
    // `/effort` typed in the terminal after the pin: the newer reply wins.
    expect(maestro.pickEffort({ effort: "low", at: 3000 }, { effort: null }, { effort: "max", at: 2000 })).toBe("low");
    // Pin CLEARED after the last reply: the old stamp is stale; the account's settings decide, or nothing does.
    expect(maestro.pickEffort({ effort: "max", at: 1000 }, { effort: null }, { effort: null, at: 2000 })).toBeNull();
    expect(maestro.pickEffort({ effort: "max", at: 1000 }, { effort: "high" }, { effort: null, at: 2000 })).toBe("high");
    // Nothing answered yet: pin, then settings.json.
    expect(maestro.pickEffort({ effort: null, at: 0 }, { effort: "high" }, { effort: "low", at: 0 })).toBe("low");
    expect(maestro.pickEffort({ effort: null, at: 0 }, { effort: "high" })).toBe("high");
    expect(maestro.pickEffort({ effort: null, at: 0 }, { effort: null })).toBeNull();
  });

  it("labels the aliases settings.json uses", async () => {
    const { maestro } = await load();
    expect(maestro.modelLabelFor("fable")).toBe("Fable");
    expect(maestro.modelLabelFor("sonnet")).toBe("Sonnet");
  });
});

/**
 * A TROCA DE AUTOR SÓ ACONTECE SE A ORDEM FOR ENTREGUE. O maestro carimbava o autor do remetente no
 * destino ANTES do envio — e um envio recusado (alguém digitando ali, sessão morta) deixava a autoria
 * trocada sem ordem nenhuma ter chegado.
 */
describe("sendToTerminal — beforeDeliver roda só quando a mensagem vai mesmo", () => {
  it("envio recusado: o gancho não roda", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "alguém digitando" });
    await registry.applyOpenTerminal(c.id);
    await registry.markCardHumanActive(c.id, Date.now());
    const beforeDeliver = vi.fn(async () => undefined);
    await expect(maestro.sendToTerminal(c.id, "roda", { respectHumanActive: true, beforeDeliver })).rejects.toThrow(/human-active/);
    expect(beforeDeliver).not.toHaveBeenCalled();
  });

  it("envio que vai: o gancho roda ANTES de digitar no terminal", async () => {
    const { maestro, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "livre" });
    await registry.applyOpenTerminal(c.id);
    const order: string[] = [];
    runScript.mockImplementation(async () => { order.push("send"); return { stdout: "", stderr: "" }; });
    await maestro.sendToTerminal(c.id, "roda", { beforeDeliver: async () => { order.push("autor"); } });
    expect(order).toEqual(["autor", "send"]);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript, writeFile: vi.fn(), ptyCommand: vi.fn() }) };
  });
  return {
    maestro: await import("./maestro.js"),
    registry: await import("../board/registry.js"),
    provenance: await import("../chat/provenance.js"),
    history: await import("../sdk/history.js"),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-maestro-"));
  runScript.mockClear();
  runScript.mockResolvedValue({ stdout: "", stderr: "" });
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
    const { maestro } = await load();
    for (const raw of ["no server running on /tmp/tmux-0/default", "can't find session: card-1234"]) {
      const out = maestro.sessionGoneError(new Error(raw), "my card");
      expect(out.message).toContain("my card");
      expect(out.message).toMatch(/open the card/i);
    }
  });

  it("leaves an unrelated failure exactly as it was", async () => {
    const { maestro } = await load();
    const original = new Error("docker: permission denied while trying to connect to the socket");
    expect(maestro.sessionGoneError(original, "my card")).toBe(original);
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

  it("records who sent it and announces an agent's message to the native chat", async () => {
    const { maestro, registry, provenance, history } = await load();
    const p = await registry.createProject({ name: "billing" });
    const sender = await registry.createCard({ projectId: p.id, title: "card preview" });
    const dest = await registry.createCard({ projectId: p.id, title: "destino" });
    await registry.applyOpenTerminal(dest.id);
    const origin = await maestro.agentOriginFor(sender.id);

    const live: unknown[] = [];
    const off = history.onExternalMessage(dest.id, (e) => live.push(e));
    await maestro.sendToTerminal(dest.id, "roda os testes", { origin });
    off();

    // Delivery is unchanged (same send-keys script), and the attribution is queryable right away.
    expect(runScript).toHaveBeenCalledOnce();
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

  it("maps model ids to the names the UI shows, and passes unknown ids through", async () => {
    const { maestro } = await load();
    expect(maestro.modelLabelFor("claude-opus-5")).toBe("Opus");
    expect(maestro.modelLabelFor("claude-fable-5")).toBe("Fable");
    expect(maestro.modelLabelFor("claude-haiku-4-5-20251001")).toBe("Haiku");
    expect(maestro.modelLabelFor("gpt-x")).toBe("gpt-x");
    expect(maestro.modelLabelFor(null)).toBeNull();
  });

  it("reports the effective account name and the live model; tolerates no transcript", async () => {
    const { maestro, registry } = await load();
    const acct = await registry.createAccount({ name: "Tech" });
    const p = await registry.createProject({ name: "billing", defaultAccountSlug: acct.slug });
    const c = await registry.createCard({ projectId: p.id, title: "x" });
    runScript.mockResolvedValueOnce({ stdout: line({ type: "assistant", message: { model: "claude-opus-5", content: [] } }), stderr: "" });
    const info = await maestro.sessionInfo(c.id);
    expect(info).toEqual({
      model: "claude-opus-5",
      modelLabel: "Opus",
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
    // the probe.
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
});

describe("model signals", () => {
  it("ignores Claude Code's <synthetic> notices when reading the model in use", async () => {
    const { maestro } = await load();
    const line = (obj: unknown) => JSON.stringify(obj);
    const jsonl = [
      line({ type: "assistant", timestamp: "2026-08-22T03:00:00Z", message: { model: "claude-fable-5", content: [] } }),
      line({ type: "assistant", timestamp: "2026-08-22T03:05:00Z", message: { model: "<synthetic>", content: [] } }),
    ].join("\n");
    expect(maestro.parseLastTurn(jsonl)).toEqual({ model: "claude-fable-5", at: Date.parse("2026-08-22T03:00:00Z") });
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
    expect(out.settings).toEqual({ model: "fable", at: 1787370000000 });
    expect(maestro.parseSessionOutput("only transcript").settings).toEqual({ model: null, at: 0 });
  });

  it("labels the aliases settings.json uses", async () => {
    const { maestro } = await load();
    expect(maestro.modelLabelFor("fable")).toBe("Fable");
    expect(maestro.modelLabelFor("sonnet")).toBe("Sonnet");
  });
});

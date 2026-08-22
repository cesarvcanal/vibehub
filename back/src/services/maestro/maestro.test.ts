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
    expect(info).toEqual({ model: "claude-opus-5", modelLabel: "Opus", account: { slug: acct.slug, name: "Tech" } });
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

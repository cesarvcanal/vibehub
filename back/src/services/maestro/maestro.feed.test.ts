import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

/**
 * Following a card from OUTSIDE the board (ChatGPT over the external MCP, by voice): the reads an
 * assistant needs to know what the card is doing, and the wait that lets it answer "it finished,
 * here is what it said" instead of polling. The registry and the sdk history are REAL against a temp
 * data dir; only the runner (the transcript read) is mocked.
 */

const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
let dir = "";

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.runner.container = "vibehub-runner";
  vi.doMock("../../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../../runtime/host.js")>("../../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript, writeFile: vi.fn(), ptyCommand: vi.fn(), pipeCommand: vi.fn() }) };
  });
  const loaded = {
    maestro: await import("./maestro.js"),
    registry: await import("../board/registry.js"),
    history: await import("../sdk/history.js"),
    manager: await import("../sdk/manager.js"),
  };
  const p = await loaded.registry.createProject({ name: "billing" });
  const card = await loaded.registry.createCard({ projectId: p.id, title: "filho" });
  await loaded.registry.applyOpenTerminal(card.id);
  return { ...loaded, card };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-feed-"));
  runScript.mockReset();
  runScript.mockResolvedValue({ stdout: "", stderr: "" });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const Q = [{ question: "Qual banco?", options: [{ label: "Mongo (recomendado)" }, { label: "MySQL" }] }];
const line = (o: Record<string, unknown>) => JSON.stringify(o);
const assistantText = (at: number, text: string) =>
  line({ type: "assistant", uuid: `a${at}`, timestamp: new Date(at).toISOString(), message: { content: [{ type: "text", text }] } });
const askLine = (at: number) =>
  line({ type: "assistant", uuid: `q${at}`, timestamp: new Date(at).toISOString(), message: { content: [{ type: "tool_use", id: "tu1", name: "AskUserQuestion", input: { questions: Q } }] } });
const transcript = (...lines: string[]) => ({ stdout: lines.join("\n"), stderr: "" });
/** A driver child the sdk manager can spawn: records what it was told on stdin, never exits. */
function fakeChild(written: string[] = []) {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.writable = true;
  stdin.write = (s: string) => { written.push(s); return true; };
  stdin.end = () => { stdin.writable = false; };
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = () => undefined;
  return child as never;
}
/** The history file is appended through a serialized chain; a read right after must wait for it. */
async function flush(history: typeof import("../sdk/history.js"), cardId: string) {
  await history.appendHistory(cardId, { type: "session", sessionId: "barrier" });
}

describe("readTerminal surfaces the question a card is waiting on", () => {
  it("from the native chat's history — a message answers it", async () => {
    const { maestro, history, card } = await load();
    await history.appendHistory(card.id, { type: "user_question", id: "q1", questions: Q, at: Date.now() });
    await flush(history, card.id);
    runScript.mockResolvedValueOnce(transcript(assistantText(Date.now(), "Preciso de uma decisão.")));
    const out = await maestro.readTerminal(card.id, 1);
    expect(out.answers).toEqual(["Preciso de uma decisão."]);
    expect(out.pendingQuestion).toMatchObject({ id: "q1", source: "chat", questions: Q });
  });

  it("from the terminal's transcript when there is no chat question", async () => {
    const { maestro, card } = await load();
    runScript.mockResolvedValueOnce(transcript(askLine(Date.now())));
    expect((await maestro.readTerminal(card.id, 1)).pendingQuestion).toMatchObject({ id: "tu1", source: "terminal" });
  });

  it("is null when nothing is pending", async () => {
    const { maestro, card } = await load();
    runScript.mockResolvedValueOnce(transcript(assistantText(Date.now(), "pronto")));
    expect((await maestro.readTerminal(card.id, 1)).pendingQuestion).toBeNull();
  });
});

describe("readCardActivity", () => {
  it("tells the situation, the pending question/permission and what the card did since a moment", async () => {
    const { maestro, history, registry, card } = await load();
    await registry.applyCardStatus(card.id, "working");
    const t0 = Date.now() - 10_000;
    await history.appendHistory(card.id, { type: "permission_request", id: "p1", tool: "Bash", reason: "rm -rf build", at: Date.now() });
    await flush(history, card.id);
    runScript.mockResolvedValueOnce(transcript(assistantText(t0 - 5000, "velho"), assistantText(t0 + 1000, "novo")));
    const out = await maestro.readCardActivity(card.id, { since: t0 });
    expect(out).toMatchObject({
      cardId: card.id, title: "filho", situation: "working", busy: true,
      pendingQuestion: null, pendingPermission: { id: "p1", tool: "Bash", reason: "rm -rf build" },
    });
    expect(out.events.map((e) => e.text)).toEqual(["novo"]);
    expect(typeof out.now).toBe("number");
  });

  it("404s an unknown card", async () => {
    const { maestro } = await load();
    await expect(maestro.readCardActivity("nope")).rejects.toThrow(/card not found/);
  });
});

describe("waitForTurn — wait for the card's turn to end instead of polling", () => {
  it("returns `finished` once the card goes from working back to waiting, with its answer", async () => {
    const { maestro, registry, card } = await load();
    const since = Date.now();
    await registry.applyCardStatus(card.id, "working");
    // Kept, and awaited before the test ends: the wait returns on the in-memory status, while the
    // store is still renaming board.json into a tmp dir that afterEach is about to delete.
    const ended = new Promise((resolve) => setTimeout(() => resolve(registry.applyCardStatus(card.id, "waiting")), 60));
    runScript.mockResolvedValue(transcript(assistantText(since + 1, "Feito: 3 testes novos.")));
    const out = await maestro.waitForTurn(card.id, { since, timeoutMs: 2000, pollMs: 20 });
    await ended;
    expect(out.outcome).toBe("finished");
    expect(out.answers).toEqual(["Feito: 3 testes novos."]);
    expect(out.activity.map((e) => e.text)).toEqual(["Feito: 3 testes novos."]);
  });

  it("does NOT read an idle card as finished before its turn even started (the race right after a send)", async () => {
    const { maestro, registry, card } = await load();
    await registry.applyCardStatus(card.id, "waiting"); // the previous turn's dot
    const since = Date.now() + 1; // the send happened after that dot
    const out = await maestro.waitForTurn(card.id, { since, timeoutMs: 150, pollMs: 20 });
    expect(out.outcome).toBe("not_started");
  });

  it("returns `timeout` while the card is still working, with what it did so far", async () => {
    const { maestro, registry, card } = await load();
    const since = Date.now();
    await registry.applyCardStatus(card.id, "working");
    runScript.mockResolvedValue(transcript(line({
      type: "assistant", uuid: "a1", timestamp: new Date(since + 5).toISOString(),
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { description: "Run the tests" } }] },
    })));
    const out = await maestro.waitForTurn(card.id, { since, timeoutMs: 120, pollMs: 20 });
    expect(out.outcome).toBe("timeout");
    expect(out.situation).toBe("working");
    expect(out.activity).toEqual([expect.objectContaining({ kind: "tool", tool: "Bash", text: "Run the tests" })]);
  });

  it("returns `question` as soon as the native chat asks something, without waiting for the timeout", async () => {
    const { maestro, registry, history, card } = await load();
    const since = Date.now();
    await registry.applyCardStatus(card.id, "working");
    const asked = new Promise((resolve) =>
      setTimeout(() => resolve(history.appendHistory(card.id, { type: "user_question", id: "q1", questions: Q, at: Date.now() })), 40),
    );
    const started = Date.now();
    const out = await maestro.waitForTurn(card.id, { since, timeoutMs: 5000, pollMs: 20 });
    await asked;
    expect(out.outcome).toBe("question");
    expect(out.pendingQuestion).toMatchObject({ id: "q1", source: "chat" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("returns `question` for a terminal menu found at the end of the wait", async () => {
    const { maestro, registry, card } = await load();
    await registry.applyCardStatus(card.id, "working");
    runScript.mockResolvedValue(transcript(askLine(Date.now())));
    const out = await maestro.waitForTurn(card.id, { since: Date.now(), timeoutMs: 80, pollMs: 20 });
    expect(out.outcome).toBe("question");
    expect(out.pendingQuestion).toMatchObject({ source: "terminal" });
  });

  it("returns `permission` when a sensitive tool waits for the board", async () => {
    const { maestro, registry, history, card } = await load();
    await registry.applyCardStatus(card.id, "working");
    await history.appendHistory(card.id, { type: "permission_request", id: "p1", tool: "Bash", at: Date.now() });
    await flush(history, card.id);
    const out = await maestro.waitForTurn(card.id, { since: Date.now() - 1000, timeoutMs: 2000, pollMs: 20 });
    expect(out.outcome).toBe("permission");
    expect(out.pendingPermission).toMatchObject({ id: "p1" });
  });

  it("counts the native chat's driver turn as work even when no hook moved the dot", async () => {
    const { maestro, manager, card } = await load();
    manager.setDriverSpawnerForTesting(() => fakeChild());
    const session = manager.ensureDriverSession({ cardId: card.id, label: "filho", command: { file: "x", args: [] } });
    const since = Date.now();
    expect(manager.sendAgentTurn(session, "rode os testes", { kind: "owner", name: "cesar" })).toBe(true);
    const out = await maestro.waitForTurn(card.id, { since, timeoutMs: 120, pollMs: 20 });
    manager.resetSdkSessionsForTesting();
    expect(out.outcome).toBe("timeout");
    expect(out.busy).toBe(true);
  });

  it("answers `no session` right away for a card that is not open", async () => {
    const { maestro, registry, card } = await load();
    await registry.updateCard(card.id, { column: "backlog" });
    const other = await registry.createCard({ projectId: card.projectId, title: "fechado" });
    const out = await maestro.waitForTurn(other.id, { timeoutMs: 5000, pollMs: 20 });
    expect(out.outcome).toBe("no session");
  });

  it("caps the wait at WAIT_MAX_MS whatever is asked", async () => {
    const { maestro } = await load();
    expect(maestro.WAIT_MAX_MS).toBeLessThanOrEqual(55_000);
  });
});

describe("sendToTerminal `viaNativeChat` — a person's message from outside follows the conversation", () => {
  it("goes to the live native-chat driver, not to the tmux prompt (the chat would fork otherwise)", async () => {
    const { maestro, manager, history, card } = await load();
    const written: string[] = [];
    manager.setDriverSpawnerForTesting(() => fakeChild(written));
    manager.ensureDriverSession({ cardId: card.id, label: "filho", command: { file: "x", args: [] } });
    const origin = { kind: "owner" as const, name: "cesar" };
    const out = await maestro.sendToTerminal(card.id, "use o MySQL", { viaNativeChat: true, origin, requireAgent: true, guardInteractiveMenu: true });
    manager.resetSdkSessionsForTesting();
    expect(out).toMatchObject({ sent: true });
    expect(written.map((s) => JSON.parse(s) as { type: string; text?: string }).filter((f) => f.type === "user"))
      .toEqual([{ type: "user", text: "use o MySQL" }]);
    expect(runScript.mock.calls.some((c) => String((c as unknown as string[])[0]).includes("tmux send-keys"))).toBe(false);
    await flush(history, card.id);
    expect((await history.readHistory(card.id)).filter((e) => e.type === "user"))
      .toEqual([expect.objectContaining({ text: "use o MySQL", from: origin })]);
  });

  it("without a live driver it is typed at the terminal, as before", async () => {
    const { maestro, card } = await load();
    runScript.mockResolvedValueOnce({ stdout: "bash\nclaude\n", stderr: "" }); // agent probe
    runScript.mockResolvedValueOnce({ stdout: "> ", stderr: "" }); // menu probe: plain prompt
    await maestro.sendToTerminal(card.id, "continue", { viaNativeChat: true, origin: { kind: "owner", name: "cesar" }, requireAgent: true, guardInteractiveMenu: true });
    expect(runScript.mock.calls.some((c) => String((c as unknown as string[])[0]).includes("tmux send-keys"))).toBe(true);
  });
});

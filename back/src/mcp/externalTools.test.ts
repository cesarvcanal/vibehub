import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * THE EXTERNAL MCP, END TO END — exactly what ChatGPT does: an MCP client connects to the server
 * built for ONE user (the OAuth token's), lists the tools and calls them. The registry, users,
 * shares and sdk history are REAL against a temp data dir; only the runner and GitHub are mocked.
 *
 * What matters for a person driving cards by voice through an assistant: the assistant can SEND,
 * WAIT for the turn to end, READ what the card said (and the question it is asking), FOLLOW what it
 * is doing, and SEE what it produced in git — each one inside that person's reach on the board.
 */

const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
let dir = "";

async function load() {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.runner.container = "vibehub-runner";
  vi.doMock("../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../runtime/host.js")>("../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript, writeFile: vi.fn(), ptyCommand: vi.fn(), pipeCommand: vi.fn((line: string) => ({ file: "sh", args: ["-c", line] })) }) };
  });
  vi.doMock("../services/github/client.js", () => ({ tokenFor: vi.fn(async () => "ghp_" + "C".repeat(36)), gitAuthHeaderFor: vi.fn() }));
  const registry = await import("../services/board/registry.js");
  const users = await import("../auth/users.js");
  const history = await import("../services/sdk/history.js");
  const manager = await import("../services/sdk/manager.js");
  const { createMcpServer } = await import("./server.js");

  const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const member = users.publicUser(await users.createUser("mussa", "senha-forte-456", "member"));
  const project = await registry.createProject({ name: "erp" });
  const card = await registry.createCard({ projectId: project.id, title: "login" });
  await registry.applyOpenTerminal(card.id);

  async function connect(user: typeof owner) {
    const server = createMcpServer("external", user);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "chatgpt-test", version: "1" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0]!.text;
      return JSON.parse(text) as Record<string, unknown>;
    };
    return { client, call, close: () => client.close() };
  }
  return { registry, users, history, manager, owner, member, project, card, connect };
}

// The first `load()` transforms the whole module graph (registry, maestro, manager, events) — more
// than a per-test budget under load. Pay it once, out of band.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-external-warmup-"));
  await load();
  await rm(dir, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-external-"));
  runScript.mockReset();
  runScript.mockResolvedValue({ stdout: "", stderr: "" });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const Q = [{ question: "Qual banco?", options: [{ label: "Mongo (recomendado)" }, { label: "MySQL" }] }];
const answerLine = (at: number, text: string) => JSON.stringify({
  type: "assistant", uuid: `a${at}`, timestamp: new Date(at).toISOString(), message: { content: [{ type: "text", text }] },
});

function fakeDriver(written: string[]) {
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

describe("external MCP — the tools an assistant gets", () => {
  it("lists the follow-up tools next to the ones that act", async () => {
    const env = await load();
    const { client, close } = await env.connect(env.owner);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await close();
    for (const name of [
      "vibehub_list_projects", "vibehub_list_terminals", "vibehub_create_card", "vibehub_open_card",
      "vibehub_send_to_terminal", "vibehub_read_terminal", "vibehub_wait_for_card", "vibehub_card_activity",
      "vibehub_card_changes", "vibehub_move_cards", "vibehub_deliver",
    ]) expect(names).toContain(name);
    // A card's own tools never leak to an app on the internet.
    expect(names).not.toContain("vibehub_report");
    expect(names).not.toContain("vibehub_credential_fill");
  });

  it("every follow-up tool is marked read-only, so the app does not ask the user to confirm each poll", async () => {
    const env = await load();
    const { client, close } = await env.connect(env.owner);
    const tools = (await client.listTools()).tools;
    await close();
    for (const name of ["vibehub_read_terminal", "vibehub_wait_for_card", "vibehub_card_activity", "vibehub_card_changes", "vibehub_list_terminals", "vibehub_list_projects"]) {
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    for (const name of ["vibehub_send_to_terminal", "vibehub_deliver", "vibehub_create_card"]) {
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint, name).not.toBe(true);
    }
  });
});

describe("send → wait → read, the voice loop", () => {
  it("send answers with `sentAt`, and goes into the live native chat (one conversation, attributed to the person)", async () => {
    const env = await load();
    const written: string[] = [];
    env.manager.setDriverSpawnerForTesting(() => fakeDriver(written));
    env.manager.ensureDriverSession({ cardId: env.card.id, label: "login", command: { file: "x", args: [] } });
    const { call, close } = await env.connect(env.owner);
    const before = Date.now();
    const out = await call("vibehub_send_to_terminal", { cardId: env.card.id, text: "corrija o login com senha vazia" });
    await close();
    env.manager.resetSdkSessionsForTesting();
    expect(out).toMatchObject({ sent: true, title: "login" });
    expect(out.sentAt as number).toBeGreaterThanOrEqual(before);
    expect(written.map((l) => JSON.parse(l) as { type: string; text?: string }).filter((f) => f.type === "user"))
      .toEqual([{ type: "user", text: "corrija o login com senha vazia" }]);
    await env.history.appendHistory(env.card.id, { type: "session", sessionId: "barrier" });
    expect((await env.history.readHistory(env.card.id)).find((e) => e.type === "user"))
      .toMatchObject({ from: { kind: "owner", name: "cesar" } });
  });

  it("wait_for_card returns the answer once the turn ends", async () => {
    const env = await load();
    const { call, close } = await env.connect(env.owner);
    const since = Date.now();
    await env.registry.applyCardStatus(env.card.id, "working");
    setTimeout(() => { void env.registry.applyCardStatus(env.card.id, "waiting"); }, 50);
    runScript.mockResolvedValue({ stdout: answerLine(since + 1, "Corrigido, testes verdes."), stderr: "" });
    const out = await call("vibehub_wait_for_card", { cardId: env.card.id, since, timeoutSeconds: 5 });
    await close();
    expect(out).toMatchObject({ outcome: "finished", answers: ["Corrigido, testes verdes."] });
  });

  it("wait_for_card stops on the card's question and hands its options over", async () => {
    const env = await load();
    await env.registry.applyCardStatus(env.card.id, "working");
    await env.history.appendHistory(env.card.id, { type: "user_question", id: "q1", questions: Q, at: Date.now() });
    await env.history.appendHistory(env.card.id, { type: "session", sessionId: "barrier" });
    const { call, close } = await env.connect(env.owner);
    const out = await call("vibehub_wait_for_card", { cardId: env.card.id, since: Date.now() - 1000, timeoutSeconds: 5 });
    await close();
    expect(out.outcome).toBe("question");
    expect(out.pendingQuestion).toMatchObject({ source: "chat", questions: Q });
  });

  it("read_terminal carries the pending question too", async () => {
    const env = await load();
    await env.history.appendHistory(env.card.id, { type: "user_question", id: "q1", questions: Q, at: Date.now() });
    await env.history.appendHistory(env.card.id, { type: "session", sessionId: "barrier" });
    const { call, close } = await env.connect(env.owner);
    const out = await call("vibehub_read_terminal", { cardId: env.card.id });
    await close();
    expect(out.pendingQuestion).toMatchObject({ id: "q1" });
  });

  it("card_activity and card_changes answer for the card", async () => {
    const env = await load();
    const { call, close } = await env.connect(env.owner);
    runScript.mockResolvedValueOnce({ stdout: answerLine(Date.now(), "trabalhando nisso"), stderr: "" });
    const activity = await call("vibehub_card_activity", { cardId: env.card.id });
    runScript.mockResolvedValueOnce({
      stdout: ["__VIBEHUB_CHANGES__ branch", "card/login-1", "__VIBEHUB_CHANGES__ pr", "[]", "__VIBEHUB_CHANGES__ end"].join("\n"),
      stderr: "",
    });
    const changes = await call("vibehub_card_changes", { cardId: env.card.id });
    await close();
    expect(activity).toMatchObject({ cardId: env.card.id, events: [expect.objectContaining({ kind: "assistant", text: "trabalhando nisso" })] });
    expect(changes).toMatchObject({ cardId: env.card.id, branch: "card/login-1", pr: null });
  });

  it("wait_for_card never holds the call past the cap, whatever timeout is asked", async () => {
    const env = await load();
    const { client, close } = await env.connect(env.owner);
    const tool = (await client.listTools()).tools.find((t) => t.name === "vibehub_wait_for_card")!;
    await close();
    const max = (tool.inputSchema.properties as Record<string, { maximum?: number }>).timeoutSeconds?.maximum;
    expect(max).toBeLessThanOrEqual(50);
  });
});

describe("reach — the assistant is the person, never more", () => {
  it("a member reaches nothing that was not shared: every follow-up tool says not found", async () => {
    const env = await load();
    const { call, close } = await env.connect(env.member);
    for (const name of ["vibehub_wait_for_card", "vibehub_card_activity", "vibehub_card_changes", "vibehub_read_terminal"]) {
      expect(await call(name, { cardId: env.card.id, timeoutSeconds: 1 }), name).toEqual({ error: "card not found" });
    }
    await close();
    expect(runScript).not.toHaveBeenCalled();
  });

  it("a read-only share may follow the card but not send to it", async () => {
    const env = await load();
    await env.registry.shareWith({ kind: "card", targetId: env.card.id, userId: env.member.id, level: "view" });
    const { call, close } = await env.connect(env.member);
    runScript.mockResolvedValue({ stdout: answerLine(Date.now(), "oi"), stderr: "" });
    expect((await call("vibehub_card_activity", { cardId: env.card.id })).cardId).toBe(env.card.id);
    expect(await call("vibehub_send_to_terminal", { cardId: env.card.id, text: "faça X" })).toEqual({ error: "this card is shared with you read-only" });
    await close();
  });
});

describe("the inbox — what happened on the board while the user was not asking", () => {
  const blocks = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: args })).content as { type: string; text: string }[]).map((b) => JSON.parse(b.text) as Record<string, unknown>);

  it("vibehub_inbox is listed and read-only (no confirmation per check, by voice)", async () => {
    const env = await load();
    const { client, close } = await env.connect(env.owner);
    const tool = (await client.listTools()).tools.find((t) => t.name === "vibehub_inbox");
    await close();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    // The wrapper that attaches the news keeps each tool's own schema.
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["since"]);
  });

  it("lists the open events of the cards the user reaches, by title, with the question's options", async () => {
    const env = await load();
    const events = await import("../services/events/cardEvents.js");
    await events.observeDriverEvent(env.card.id, { type: "user_question", id: "q1", questions: Q });
    const { call, close } = await env.connect(env.owner);
    const inbox = await call("vibehub_inbox");
    await close();
    expect(inbox.events).toEqual([expect.objectContaining({ cardId: env.card.id, card: "login", kind: "question", questions: Q })]);
    // The time in the server's own zone, with its offset — never a bare UTC "Z" read aloud as local.
    expect((inbox.events as { at: string }[])[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(typeof inbox.cursor).toBe("number");
  });

  it("a member hears nothing about a card not shared with them", async () => {
    const env = await load();
    const events = await import("../services/events/cardEvents.js");
    await events.observeCardStatus(env.card.id, "working", "waiting");
    const { call, close } = await env.connect(env.member);
    expect((await call("vibehub_inbox")).events).toEqual([]);
    await close();
  });

  it("any other tool answer carries what is NEW, once — the next answer does not repeat it", async () => {
    const env = await load();
    const events = await import("../services/events/cardEvents.js");
    await events.observeCardStatus(env.card.id, "working", "waiting");
    const { client, close } = await env.connect(env.owner);
    const first = await blocks(client, "vibehub_list_projects");
    expect(first).toHaveLength(2);
    expect(first[1]!.notifications).toEqual([expect.objectContaining({ cardId: env.card.id, card: "login", kind: "turn_finished" })]);
    expect(await blocks(client, "vibehub_list_projects")).toHaveLength(1);
    await close();
  });

  it("reading the inbox counts as heard: the next answer does not repeat it either", async () => {
    const env = await load();
    const events = await import("../services/events/cardEvents.js");
    await events.observeCardStatus(env.card.id, "working", "waiting");
    const { client, close } = await env.connect(env.owner);
    expect(await blocks(client, "vibehub_inbox")).toHaveLength(1);
    expect(await blocks(client, "vibehub_list_projects")).toHaveLength(1);
    await close();
  });
});

/**
 * Produção, 21/10/2026: create_card(open) and then send_to_terminal answered "awaiting choice" until
 * someone opened the card by hand. The open now reports whether Claude can take a message, and the
 * send WAITS for a card that is still booting instead of failing (or typing into an undrawn pane).
 */
describe("external MCP — open/send right after creating a card", () => {
  const READY = "╭───╮\n│ > │\n╰───╯\n  ⏵⏵ bypass permissions on · ? for shortcuts";
  /** The runner by WHAT each script is: the pane is blank for the first `blank` captures. */
  function bootingRunner(blank: number) {
    let captures = 0;
    const sent: string[] = [];
    runScript.mockImplementation((async (script: string) => {
      if (script.includes("tmux send-keys")) { sent.push(script); return { stdout: "", stderr: "" }; }
      if (script.includes("list-panes")) return { stdout: "bash\nclaude\n", stderr: "" };
      if (script.includes("capture-pane")) { captures += 1; return { stdout: captures > blank ? READY : "", stderr: "" }; }
      return { stdout: "", stderr: "" };
    }) as never);
    return { sent, captures: () => captures };
  }

  it("create_card(open) answers ready once Claude has drawn its prompt", async () => {
    const env = await load();
    const run = bootingRunner(1);
    const { call, close } = await env.connect(env.owner);
    const out = await call("vibehub_create_card", { projectId: env.project.id, title: "relatorio top 100" });
    expect(out).toMatchObject({ opened: true, ready: true });
    expect(run.captures()).toBeGreaterThanOrEqual(2);
    await close();
  }, 20_000);

  it("send_to_terminal waits for a card still booting, then delivers — no 'awaiting choice'", async () => {
    const env = await load();
    // The TUI route (native chat off): the one where Claude's boot is the race.
    const settings = await import("../services/settings/settings.js");
    await settings.updateSettings({ sdkDriver: false });
    const run = bootingRunner(1);
    const { call, close } = await env.connect(env.owner);
    const out = await call("vibehub_send_to_terminal", { cardId: env.card.id, text: "gera o relatorio" });
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ sent: true });
    expect(run.sent).toHaveLength(1);
    expect(run.sent[0]).toContain("gera o relatorio");
    await close();
  }, 20_000);
});

/**
 * Produção, 21/10/2026 (card de voz 7d49): ChatGPT's orders reached a card only after someone opened
 * it — a hibernated card answered "no live session", and one woken by vibehub_open_card had its order
 * typed into a TUI whose status hooks could not reach the back (so the next idle sweep killed it
 * mid-task). An order from outside the board now WAKES an eligible card and lands as a turn of a
 * native-chat driver started for it, with no browser involved — and never wakes a paused card.
 */
describe("external MCP — an order to a card that is asleep", () => {
  /** The runner: every session idle (or `busy`), Claude up, prompt drawn. Records what was typed. */
  function quietRunner(state: "idle" | "busy" = "idle") {
    const typed: string[] = [];
    runScript.mockImplementation((async (script: string) => {
      if (script.includes("tmux send-keys")) { typed.push(script); return { stdout: "", stderr: "" }; }
      if (script.includes("esc to interrupt")) {
        const names = [...script.matchAll(/'(card-[0-9a-f]+)'/g)].map((m) => m[1]);
        return { stdout: names.map((n) => `${n} ${state}`).join("\n"), stderr: "" };
      }
      if (script.includes("list-panes")) return { stdout: "bash\nclaude\n", stderr: "" };
      if (script.includes("capture-pane")) return { stdout: "│ > │\n  ⏵⏵ bypass permissions on", stderr: "" };
      return { stdout: "", stderr: "" };
    }) as never);
    return typed;
  }

  /** A fake driver spawner that counts spawns and collects every frame written to any driver. */
  function countingSpawner(env: Awaited<ReturnType<typeof load>>) {
    const written: string[] = [];
    let spawns = 0;
    env.manager.setDriverSpawnerForTesting(() => { spawns += 1; return fakeDriver(written); });
    const turns = () => written.map((l) => JSON.parse(l) as { type: string; text?: string }).filter((f) => f.type === "user").map((f) => f.text);
    return { turns, spawns: () => spawns };
  }

  it("a HIBERNATED card is woken and the order becomes a turn of a driver started headless", async () => {
    const env = await load();
    const typed = quietRunner();
    const driver = countingSpawner(env);
    await env.registry.hibernateCard(env.card.id);
    const { call, close } = await env.connect(env.owner);
    const out = await call("vibehub_send_to_terminal", { cardId: env.card.id, text: "retome o redesenho da esfera" });
    await close();
    env.manager.resetSdkSessionsForTesting();
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ sent: true, route: "sdk-driver", woke: true });
    expect(driver.spawns()).toBe(1);
    expect(driver.turns()).toEqual(["retome o redesenho da esfera"]);
    expect(typed).toHaveLength(0); // nothing typed into the TUI
    const card = await env.registry.getCard(env.card.id);
    expect(card?.hibernatedAt ?? null).toBeNull();
    expect(card?.activityAt).toBeGreaterThan(0); // the idle sweep sees the order
  }, 20_000);

  it("a card NEVER opened is opened and takes the order the same way", async () => {
    const env = await load();
    quietRunner();
    const driver = countingSpawner(env);
    const fresh = await env.registry.createCard({ projectId: env.project.id, title: "novo" });
    const { call, close } = await env.connect(env.owner);
    const out = await call("vibehub_send_to_terminal", { cardId: fresh.id, text: "comece pelo README" });
    await close();
    env.manager.resetSdkSessionsForTesting();
    expect(out).toMatchObject({ sent: true, route: "sdk-driver", woke: true });
    expect(driver.turns()).toEqual(["comece pelo README"]);
    expect((await env.registry.getCard(fresh.id))?.openedAt).toBeGreaterThan(0);
  }, 20_000);

  it("a PAUSED card is never woken by a message — clear refusal, nothing opened, nothing sent", async () => {
    const env = await load();
    const typed = quietRunner();
    const driver = countingSpawner(env);
    await env.registry.pauseCard(env.card.id, { effective: true });
    const { call, close } = await env.connect(env.owner);
    const out = await call("vibehub_send_to_terminal", { cardId: env.card.id, text: "continua" });
    await close();
    env.manager.resetSdkSessionsForTesting();
    expect(String(out.error)).toMatch(/^paused: .*paused on purpose/);
    expect(driver.spawns()).toBe(0);
    expect(typed).toHaveLength(0);
    expect((await env.registry.getCard(env.card.id))?.pausedAt).toBeGreaterThan(0);
  }, 20_000);

  it("two orders at once to a sleeping card: one wake, ONE driver, both turns delivered in order", async () => {
    const env = await load();
    quietRunner();
    const driver = countingSpawner(env);
    await env.registry.hibernateCard(env.card.id);
    const { call, close } = await env.connect(env.owner);
    const [a, b] = await Promise.all([
      call("vibehub_send_to_terminal", { cardId: env.card.id, text: "primeiro" }),
      call("vibehub_send_to_terminal", { cardId: env.card.id, text: "segundo" }),
    ]);
    await close();
    env.manager.resetSdkSessionsForTesting();
    expect(a).toMatchObject({ sent: true, route: "sdk-driver" });
    expect(b).toMatchObject({ sent: true, route: "sdk-driver" });
    expect(driver.spawns()).toBe(1);
    expect([...driver.turns()].sort()).toEqual(["primeiro", "segundo"]);
  }, 20_000);

  it("a TUI generating right now keeps the order (typed, queued by Claude) — never a second Claude", async () => {
    const env = await load();
    const typed = quietRunner("busy");
    const driver = countingSpawner(env);
    const { call, close } = await env.connect(env.owner);
    const out = await call("vibehub_send_to_terminal", { cardId: env.card.id, text: "e depois rode os testes" });
    await close();
    env.manager.resetSdkSessionsForTesting();
    expect(out).toMatchObject({ sent: true, route: "terminal", woke: false });
    expect(driver.spawns()).toBe(0);
    expect(typed).toHaveLength(1);
  }, 20_000);

  it("native chat off: the woken card takes the order in its TUI once Claude is up", async () => {
    const env = await load();
    const settings = await import("../services/settings/settings.js");
    await settings.updateSettings({ sdkDriver: false });
    const typed = quietRunner();
    const driver = countingSpawner(env);
    await env.registry.hibernateCard(env.card.id);
    const { call, close } = await env.connect(env.owner);
    const out = await call("vibehub_send_to_terminal", { cardId: env.card.id, text: "segue" });
    await close();
    env.manager.resetSdkSessionsForTesting();
    expect(out).toMatchObject({ sent: true, route: "terminal", woke: true });
    expect(driver.spawns()).toBe(0);
    expect(typed).toHaveLength(1);
  }, 20_000);
});


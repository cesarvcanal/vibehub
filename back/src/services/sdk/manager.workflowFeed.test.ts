import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";

/**
 * O FEED DE UM SUBAGENTE, sob demanda: a aba pede `{type:"workflow_feed", runId, agentId}` e o
 * manager roda a sondagem do feed no runner e responde SÓ a quem pediu. Arquivo à parte porque o
 * executor do host é um dublê aqui (a sondagem real precisa de um runner); o resto é o de verdade.
 */
const { runScript } = vi.hoisted(() => ({
  runScript: vi.fn(async (_script: string, _opts?: unknown) => ({ stdout: "[]", stderr: "" })),
}));
vi.mock("../../runtime/host.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime/host.js")>();
  return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript, writeFile: vi.fn(), ptyCommand: vi.fn() }) };
});
vi.mock("../board/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../board/registry.js")>();
  return { ...actual, updateCard: () => Promise.resolve(undefined), markCardHumanActive: () => Promise.resolve(undefined) };
});

const { attachSocket, ensureDriverSession, resetSdkSessionsForTesting, setDriverSpawnerForTesting } = await import("./manager.js");
const { readHistory, rewindHistory } = await import("./history.js");

const CARD = "ffff498d-98dd-44b6-97ee-c06a181c3769";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { writable: boolean; written: string[]; write: (s: string) => boolean; end: () => void };
  exitCode: number | null;
  kill: () => void;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.writable = true;
  stdin.written = [];
  stdin.write = (s: string) => { stdin.written.push(s); return true; };
  stdin.end = () => { stdin.writable = false; };
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = () => {};
  return child;
}

interface FakeSocket extends EventEmitter {
  sent: string[];
  closed: boolean;
  readyState: number;
  send: (s: string) => void;
  close: () => void;
}

function fakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.sent = [];
  socket.closed = false;
  socket.readyState = 1;
  socket.send = (s: string) => socket.sent.push(s);
  socket.close = () => { socket.closed = true; socket.readyState = 3; };
  return socket;
}

const line = (event: object) => Buffer.from(JSON.stringify(event) + "\n");
const ask = (runId: unknown, agentId: unknown) => Buffer.from(JSON.stringify({ type: "workflow_feed", runId, agentId }));
const feedFrames = (socket: FakeSocket) =>
  socket.sent.map((s) => JSON.parse(s) as { type: string; items?: unknown[]; error?: string; runId?: string; agentId?: string })
    .filter((e) => e.type === "workflow_feed");

let dir = "";
let savedDataDir = "";
let child: FakeChild;

beforeEach(async () => {
  runScript.mockReset();
  runScript.mockResolvedValue({ stdout: "[]", stderr: "" });
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-feed-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
  setDriverSpawnerForTesting(() => {
    child = fakeChild();
    return child as never;
  });
});

afterEach(async () => {
  resetSdkSessionsForTesting();
  setDriverSpawnerForTesting(null);
  await rewindHistory(CARD, "");
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

/** A card's driver with a known session id — the feed's directory depends on it. */
function liveSession(withSessionId = true) {
  const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] }, transcriptDir: "/root/.claude/projects/p" });
  if (withSessionId) child.stdout.emit("data", line({ type: "session", sessionId: "s1" }));
  return session;
}

describe("workflow_feed — o feed de um subagente, sob demanda", () => {
  it("roda a sondagem do feed e responde SÓ a quem pediu — nada no stdin, nada no histórico", async () => {
    const session = liveSession();
    const asker = fakeSocket();
    const other = fakeSocket();
    attachSocket(session, asker as never);
    attachSocket(session, other as never);
    runScript.mockResolvedValue({ stdout: `${JSON.stringify([{ at: 5, kind: "tool", tool: "Read", target: "/w/a.ts" }])}\n`, stderr: "" });

    asker.emit("message", ask("wf_abc12", "a01f"));
    await vi.waitFor(() => expect(feedFrames(asker)).toHaveLength(1));

    expect(runScript).toHaveBeenCalledTimes(1);
    const script = String(runScript.mock.calls[0]![0]);
    expect(script).toContain("'/root/.claude/projects/p/s1/subagents/workflows' 'wf_abc12' 'a01f'");
    expect(feedFrames(asker)[0]).toEqual({ type: "workflow_feed", runId: "wf_abc12", agentId: "a01f", items: [{ at: 5, kind: "tool", tool: "Read", target: "/w/a.ts" }] });
    expect(feedFrames(other)).toEqual([]);
    expect(child.stdin.written.join("")).not.toContain("workflow_feed");
    expect(JSON.stringify(await readHistory(CARD))).not.toContain("workflow_feed");
  });

  it("ids inválidos: responde com erro, sem rodar nada no runner e sem derrubar o socket", async () => {
    const session = liveSession();
    const socket = fakeSocket();
    attachSocket(session, socket as never);

    socket.emit("message", ask("../etc", "a01f; rm -rf /"));
    await vi.waitFor(() => expect(feedFrames(socket)).toHaveLength(1));
    expect(feedFrames(socket)[0]).toMatchObject({ type: "workflow_feed", items: [], error: "invalid-id" });
    expect(runScript).not.toHaveBeenCalled();
    expect(socket.closed).toBe(false);
    // O socket segue vivo: a mensagem seguinte é um turno normal.
    socket.emit("message", Buffer.from(JSON.stringify({ type: "user", text: "oi" })));
    expect(child.stdin.written.join("")).toContain('"text":"oi"');
  });

  it("sondagem que falha vira resposta com erro, não exceção", async () => {
    const session = liveSession();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    runScript.mockRejectedValue(new Error("runner down"));

    socket.emit("message", ask("wf_abc12", "a01f"));
    await vi.waitFor(() => expect(feedFrames(socket)).toHaveLength(1));
    expect(feedFrames(socket)[0]).toMatchObject({ items: [], error: "probe-failed" });
    expect(socket.closed).toBe(false);
  });

  it("sem id de sessão ainda não há onde ler: responde vazio sem tocar o runner", async () => {
    const session = liveSession(false);
    const socket = fakeSocket();
    attachSocket(session, socket as never);

    socket.emit("message", ask("wf_abc12", "a01f"));
    await vi.waitFor(() => expect(feedFrames(socket)).toHaveLength(1));
    expect(feedFrames(socket)[0]).toMatchObject({ items: [], error: "no-session" });
    expect(runScript).not.toHaveBeenCalled();
  });

  it("um pedido por vez por aba: o que chega com outro em voo espera, e só o MAIS RECENTE roda", async () => {
    const session = liveSession();
    const socket = fakeSocket();
    attachSocket(session, socket as never);
    let release: (() => void) | null = null;
    runScript.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ stdout: "[]", stderr: "" }); }));

    socket.emit("message", ask("wf_abc12", "a01f"));
    socket.emit("message", ask("wf_abc12", "a02f"));
    socket.emit("message", ask("wf_abc12", "a03f"));
    await vi.waitFor(() => expect(runScript).toHaveBeenCalledTimes(1));
    release!();
    await vi.waitFor(() => expect(feedFrames(socket)).toHaveLength(2));
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(feedFrames(socket).map((f) => f.agentId)).toEqual(["a01f", "a03f"]);
  });
});

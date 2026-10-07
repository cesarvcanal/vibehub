import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

/**
 * O websocket do chat legado (`/api/cards/:id/chat`) e o follow do transcript que ele carrega.
 *
 * Dois buracos do mesmo handler:
 *  - a aba que fecha enquanto `chatSource`/`primeProvenance` ainda estão em voo dispara o `close`
 *    antes de o handler escutá-lo; o handler seguia, subia o `docker exec` de follow e registrava um
 *    teardown que nunca mais rodaria — um follow eterno no runner por aba fechada cedo;
 *  - o filho sem ouvinte de `error`: uma falha assíncrona de spawn (EAGAIN, EMFILE) vira um `error`
 *    sem ninguém escutando, que o Node transforma em exceção não tratada — e derruba o back inteiro.
 *    O mesmo vale para o STDIN do filho: o teardown o fecha, e se o follow já morreu o EPIPE chega
 *    como `error` no stream.
 */

const CARD = "ffff498d-98dd-44b6-97ee-c06a181c3769";

const h = vi.hoisted(() => ({
  source: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  spawned: [] as unknown[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      // O stdin é um stream de verdade no Node: um EPIPE (o follow já morreu quando o teardown o
      // fecha) chega como `error` NELE, não no filho.
      child.stdin = Object.assign(new EventEmitter(), { end: () => undefined });
      child.killed = false;
      child.kill = () => { child.killed = true; };
      h.spawned.push(child);
      return child;
    },
  };
});
vi.mock("../services/maestro/maestro.js", () => ({ sendToTerminal: () => Promise.resolve() }));
vi.mock("../services/chat/chat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/chat/chat.js")>();
  return { ...actual, chatSource: () => h.source?.promise };
});
vi.mock("../services/chat/provenance.js", () => ({
  primeProvenance: () => Promise.resolve(),
  matchOrigin: () => undefined,
}));

const { chatRoutes } = await import("./chat.js");

type Handler = (socket: WebSocket, req: { params: { id: string } }) => Promise<void>;

/** O handler do websocket, capturado sem subir um servidor (as rotas POST são ignoradas). */
async function captureSocketHandler(): Promise<Handler> {
  let handler: Handler | null = null;
  const app = {
    get: (_path: string, opts: { websocket?: boolean }, fn: Handler) => { if (opts.websocket) handler = fn; },
    post: () => undefined,
  };
  await chatRoutes(app as unknown as FastifyInstance);
  if (!handler) throw new Error("the chat route did not register its websocket handler");
  return handler;
}

interface FakeSocket extends EventEmitter {
  readyState: number;
  sent: string[];
  send: (s: string) => void;
  close: () => void;
  ping: () => void;
}

/** Um socket `ws` mínimo: `readyState` segue o ciclo real (OPEN=1 → CLOSED=3, e então o `close`). */
function fakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.sent = [];
  socket.send = (s: string) => { socket.sent.push(s); };
  socket.close = () => {
    if (socket.readyState === 3) return;
    socket.readyState = 3;
    socket.emit("close");
  };
  socket.ping = () => undefined;
  return socket;
}

const SOURCE = { cardId: CARD, command: { file: "docker", args: ["exec"] } };

beforeEach(() => {
  h.spawned = [];
  let resolve: (v: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((r) => { resolve = r; });
  h.source = { promise, resolve };
});

describe("/api/cards/:id/chat — o follow do transcript", () => {
  it("a aba que fecha no meio do setup não sobe follow nenhum (o teardown dela nunca rodaria)", async () => {
    const handler = await captureSocketHandler();
    const socket = fakeSocket();
    const done = handler(socket as unknown as WebSocket, { params: { id: CARD } });
    socket.close();
    h.source?.resolve(SOURCE);
    await done;
    expect(h.spawned.length).toBe(0);
  });

  it("uma falha de spawn não derruba o back: vira log, e o socket é fechado", async () => {
    const handler = await captureSocketHandler();
    const socket = fakeSocket();
    h.source?.resolve(SOURCE);
    await handler(socket as unknown as WebSocket, { params: { id: CARD } });
    const child = h.spawned[0] as EventEmitter;
    expect(() => child.emit("error", new Error("spawn EAGAIN"))).not.toThrow();
    expect(socket.readyState).toBe(3);
  });

  it("um EPIPE no stdin do follow (o filho já morreu quando o teardown o fecha) não derruba o back", async () => {
    const handler = await captureSocketHandler();
    const socket = fakeSocket();
    h.source?.resolve(SOURCE);
    await handler(socket as unknown as WebSocket, { params: { id: CARD } });
    socket.close(); // teardown → stdin.end() num pipe cujo leitor já se foi
    const stdin = (h.spawned[0] as { stdin: EventEmitter }).stdin;
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => stdin.emit("error", epipe)).not.toThrow();
  });

  it("um caractere multibyte partido entre dois chunks do follow chega inteiro (nada de U+FFFD)", async () => {
    const handler = await captureSocketHandler();
    const socket = fakeSocket();
    h.source?.resolve(SOURCE);
    await handler(socket as unknown as WebSocket, { params: { id: CARD } });
    const line = JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date().toISOString(), message: { content: "ação" } }) + "\n";
    const bytes = Buffer.from(line);
    const cut = bytes.indexOf(Buffer.from("ç")) + 1;
    const stdout = (h.spawned[0] as { stdout: EventEmitter }).stdout;
    stdout.emit("data", bytes.subarray(0, cut));
    stdout.emit("data", bytes.subarray(cut));
    expect(socket.sent.map((s) => (JSON.parse(s) as { text?: string }).text)).toEqual(["ação"]);
  });

  it("uma linha patológica (maior que o teto) é descartada sem levar a seguinte junto", async () => {
    const handler = await captureSocketHandler();
    const socket = fakeSocket();
    h.source?.resolve(SOURCE);
    await handler(socket as unknown as WebSocket, { params: { id: CARD } });
    const stdout = (h.spawned[0] as { stdout: EventEmitter }).stdout;
    stdout.emit("data", Buffer.from("x".repeat(3 * 1024 * 1024)));
    const line = JSON.stringify({ type: "user", uuid: "u2", timestamp: new Date().toISOString(), message: { content: "depois" } });
    stdout.emit("data", Buffer.from(`\n${line}\n`));
    expect(socket.sent.map((s) => (JSON.parse(s) as { text?: string }).text)).toEqual(["depois"]);
  });

  it("o caminho feliz segue igual: o close da aba encerra o follow", async () => {
    const handler = await captureSocketHandler();
    const socket = fakeSocket();
    h.source?.resolve(SOURCE);
    await handler(socket as unknown as WebSocket, { params: { id: CARD } });
    expect(h.spawned.length).toBe(1);
    socket.close();
    expect((h.spawned[0] as { killed: boolean }).killed).toBe(true);
  });
});

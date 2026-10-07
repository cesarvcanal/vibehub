import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

/**
 * O CICLO DE VIDA DO SOCKET DURANTE O SETUP da rota `/api/cards/:id/sdk`.
 *
 * O handler gasta segundos em `await` (settings, instalação do driver, a sonda do transcript, o
 * replay) antes de se ligar ao driver do card. Uma aba que fecha NESSE intervalo dispara o `close`
 * antes de alguém escutá-lo — e a rota, sem saber, seguia em frente: assinava o barramento externo,
 * pegava uma referência do espelho (um `docker exec` de follow eterno), subia um driver e prendia o
 * socket morto em `session.sockets`. Esse conjunto nunca mais esvaziava: o idle stop nunca armava,
 * `isCardChatInUse` dizia "em uso" para sempre (o card nunca hibernava) e o ping vazava.
 *
 * Aqui o handler é chamado direto, com as dependências de I/O trocadas por dublês: o que importa é
 * o que a rota ADQUIRE depois de um `close` que aconteceu no meio do setup.
 */

const CARD = "eeee498d-98dd-44b6-97ee-c06a181c3769";

const h = vi.hoisted(() => ({
  install: null as null | { promise: Promise<void>; resolve: () => void },
  acquireCalls: 0,
  externalSubscriptions: 0,
}));

// A rota lê o autor com `requestUser` (o usuário que o gate já resolveu); sem gate aqui, ninguém.
vi.mock("../auth/session.js", () => ({ requestUser: () => Promise.resolve(null) }));
vi.mock("../services/board/actor.js", () => ({
  recordCardActor: () => Promise.resolve(),
  authorsTheTurn: () => false,
}));
vi.mock("../services/settings/settings.js", () => ({ getSettings: () => Promise.resolve({ sdkDriver: true }) }));
vi.mock("../services/board/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/board/registry.js")>();
  return {
    ...actual,
    getCard: () => Promise.resolve({ id: CARD, projectId: "p1", worktreeSlug: "t" }),
    getProject: () => Promise.resolve({ id: "p1" }),
    effectiveAccountSlug: () => undefined,
    updateCard: () => Promise.resolve(undefined),
    markCardHumanActive: () => Promise.resolve(undefined),
  };
});
vi.mock("../services/sdk/driver.js", () => ({
  installCardSdkDriver: () => h.install?.promise ?? Promise.resolve(),
  sdkDriverCommand: () => Promise.resolve({ file: "docker", args: ["exec"] }),
}));
vi.mock("../runtime/host.js", () => ({
  hostExecutor: () => ({ runScript: () => Promise.resolve({ stdout: "" }) }),
}));
vi.mock("../services/maestro/maestro.js", () => ({ transcriptDirFor: () => "/root/.claude/projects/t" }));
vi.mock("../services/sdk/catalog.js", () => ({
  readCardCatalog: () => Promise.resolve(null),
  writeCardCatalog: () => Promise.resolve(),
}));
vi.mock("../services/sdk/history.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/sdk/history.js")>();
  return {
    ...actual,
    readHistory: () => Promise.resolve([]),
    appendHistory: () => Promise.resolve(),
    onExternalMessage: () => { h.externalSubscriptions += 1; return () => { h.externalSubscriptions -= 1; }; },
  };
});
vi.mock("../services/chat/provenance.js", () => ({
  primeProvenance: () => Promise.resolve(),
  matchOrigin: () => undefined,
}));
vi.mock("../services/sdk/mirror.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/sdk/mirror.js")>();
  return {
    ...actual,
    acquireTranscriptMirror: () => { h.acquireCalls += 1; return Promise.resolve(() => { h.acquireCalls -= 1; }); },
  };
});

const { cardSdkRoutes } = await import("./cardSdk.js");
const { hasDriverSession, isCardChatInUse, resetSdkSessionsForTesting, setDriverSpawnerForTesting } =
  await import("../services/sdk/manager.js");

type Handler = (socket: WebSocket, req: { params: { id: string } }) => Promise<void>;

/** O handler da rota, capturado sem subir um servidor. */
async function captureHandler(): Promise<Handler> {
  let handler: Handler | null = null;
  const app = { get: (_path: string, _opts: unknown, fn: Handler) => { handler = fn; } };
  await cardSdkRoutes(app as unknown as FastifyInstance);
  if (!handler) throw new Error("the route did not register its handler");
  return handler;
}

interface FakeSocket extends EventEmitter {
  readyState: number;
  OPEN: number;
  sent: string[];
  send: (s: string) => void;
  close: () => void;
  ping: () => void;
}

/** Um socket `ws` mínimo: `readyState` segue o ciclo real (OPEN=1 → CLOSED=3, e então o `close`). */
function fakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.OPEN = 1;
  socket.sent = [];
  socket.send = (s: string) => { socket.sent.push(s); };
  socket.close = () => { socket.readyState = 3; socket.emit("close"); };
  socket.ping = () => undefined;
  return socket;
}

function fakeChild(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.write = () => true;
  stdin.end = () => undefined;
  stdin.writable = true;
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = () => undefined;
  return child;
}

let spawnedCount = 0;

beforeEach(() => {
  spawnedCount = 0;
  h.acquireCalls = 0;
  h.externalSubscriptions = 0;
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => { resolve = r; });
  h.install = { promise, resolve };
  setDriverSpawnerForTesting(() => { spawnedCount += 1; return fakeChild() as never; });
});

afterEach(() => {
  resetSdkSessionsForTesting();
  setDriverSpawnerForTesting(null);
});

describe("/api/cards/:id/sdk — a aba que fecha no meio do setup", () => {
  it("não sobe driver, não prende o socket morto, não segura espelho nem barramento", async () => {
    const handler = await captureHandler();
    const socket = fakeSocket();
    const done = handler(socket as unknown as WebSocket, { params: { id: CARD } });
    // O setup está parado na instalação do driver quando a pessoa fecha a aba.
    await new Promise((r) => setTimeout(r, 0));
    socket.close();
    h.install?.resolve();
    await done;
    await new Promise((r) => setTimeout(r, 0));

    expect(spawnedCount).toBe(0);
    expect(hasDriverSession(CARD)).toBe(false);
    expect(isCardChatInUse(CARD)).toBe(false);
    expect(h.acquireCalls).toBe(0);
    expect(h.externalSubscriptions).toBe(0);
  });

  it("o caminho feliz segue igual: socket aberto liga no driver, e o close solta tudo", async () => {
    const handler = await captureHandler();
    const socket = fakeSocket();
    h.install?.resolve();
    await handler(socket as unknown as WebSocket, { params: { id: CARD } });
    await new Promise((r) => setTimeout(r, 0));

    expect(spawnedCount).toBe(1);
    expect(isCardChatInUse(CARD)).toBe(true);
    expect(h.acquireCalls).toBe(1);
    expect(h.externalSubscriptions).toBe(1);

    socket.close();
    expect(isCardChatInUse(CARD)).toBe(false);
    expect(h.acquireCalls).toBe(0);
    expect(h.externalSubscriptions).toBe(0);
  });
});

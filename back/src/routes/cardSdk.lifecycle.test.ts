import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

/**
 * THE SOCKET'S LIFECYCLE DURING THE SETUP of the `/api/cards/:id/sdk` route.
 *
 * The handler spends seconds in `await` (settings, installing the driver, the transcript probe, the
 * replay) before hooking up to the card's driver. A tab that closes IN THAT window fires `close` before
 * anybody listens to it — and the route, unaware, went ahead: it subscribed to the external bus, took a
 * reference to the mirror (a `docker exec` with an endless follow), started a driver and held the dead
 * socket in `session.sockets`. That set never emptied again: the idle stop never armed,
 * `isCardChatInUse` said "em uso" forever (the card never hibernated) and the ping leaked.
 *
 * Here the handler is called directly, with the I/O dependencies swapped for doubles: what matters is
 * what the route ACQUIRES after a `close` that happened in the middle of the setup.
 */

const CARD = "eeee498d-98dd-44b6-97ee-c06a181c3769";

const h = vi.hoisted(() => ({
  install: null as null | { promise: Promise<void>; resolve: () => void },
  acquireCalls: 0,
  externalSubscriptions: 0,
  /** Who the route stamped as the card's author, in order. */
  stamps: [] as string[],
}));

// The route reads the author with `requestUser` (the user the gate already resolved); with no gate here, nobody.
vi.mock("../auth/session.js", () => ({
  requestUser: () => Promise.resolve({ id: "u-mussa", username: "mussa", role: "member", createdAt: "" }),
}));
vi.mock("../services/board/actor.js", async (importOriginal) => ({
  authorsTheTurn: (await importOriginal<typeof import("../services/board/actor.js")>()).authorsTheTurn,
  isCardActor: () => false,
  recordCardActor: (user: { id: string } | null) => { h.stamps.push(user?.id ?? "-"); return Promise.resolve(); },
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
vi.mock("../services/board/workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/board/workspace.js")>()),
  restoreMissingWorkspace: () => Promise.resolve(false),
}));
vi.mock("../runtime/host.js", () => ({
  hostExecutor: () => ({ runScript: () => Promise.resolve({ stdout: "" }) }),
}));
vi.mock("../services/maestro/cardSession.js", () => ({ transcriptDirFor: () => "/root/.claude/projects/t" }));
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
vi.mock("../services/chat/provenance.js", async (importOriginal) => ({
  originOfUser: (await importOriginal<typeof import("../services/chat/provenance.js")>()).originOfUser,
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

/** The route's handler, captured without starting a server. */
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

/** A minimal `ws` socket: `readyState` follows the real cycle (OPEN=1 → CLOSED=3, and then `close`). */
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
  h.stamps = [];
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
    // The setup is stuck installing the driver when the person closes the tab.
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

describe("/api/cards/:id/sdk — só a ORDEM troca o autor do card", () => {
  it("conectar (abrir o card para olhar) não carimba ninguém; a mensagem carimba", async () => {
    const handler = await captureHandler();
    const socket = fakeSocket();
    h.install?.resolve();
    await handler(socket as unknown as WebSocket, { params: { id: CARD } });
    await new Promise((r) => setTimeout(r, 0));
    // Mussa only opened the card in which César asked for a review: the review's authorship stays César's.
    expect(h.stamps).toEqual([]);

    socket.emit("message", Buffer.from(`{"type":"interrupt"}`));
    expect(h.stamps).toEqual([]);
    socket.emit("message", Buffer.from(`{"type":"user","text":"corrige o que o review apontou"}`));
    expect(h.stamps).toEqual(["u-mussa"]);
    socket.close();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import { onCardStatusSink } from "../board/agentState.js";
import {
  driverTurnRunning,
  ensureDriverSession,
  handleClientFrame,
  resetSdkSessionsForTesting,
  setDriverSpawnerForTesting,
} from "./manager.js";
import { appendHistory } from "./history.js";

/**
 * O CHAT NATIVO ALIMENTA A CENTRAL DE EVENTOS (services/events/cardEvents.ts): a pergunta e o pedido
 * de permissão do driver viram evento, e o desfecho deles (inclusive a pergunta que uma mensagem
 * superou) o encerra. A central é observada, não gravada.
 */
const { observed } = vi.hoisted(() => ({ observed: [] as Array<{ cardId: string; event: Record<string, unknown> }> }));
vi.mock("../events/cardEvents.js", () => ({
  observeDriverEvent: (cardId: string, event: Record<string, unknown>) => {
    observed.push({ cardId, event });
    return Promise.resolve();
  },
}));
const { applied, cards } = vi.hoisted(() => ({
  applied: [] as Array<{ cardId: string; status: string }>,
  cards: new Map<string, Record<string, unknown>>(),
}));
vi.mock("../board/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../board/registry.js")>();
  return {
    ...actual,
    markCardHumanActive: () => Promise.resolve(undefined),
    updateCard: () => Promise.resolve(undefined),
    getCard: (id: string) => Promise.resolve(cards.get(id)),
  };
});

/** O caminho dos hooks (services/board/status.ts), observado: o que o driver reporta chega aqui. */
onCardStatusSink((cardId, status) => {
  applied.push({ cardId, status });
  const card = cards.get(cardId);
  if (card) card.status = status;
  return Promise.resolve(card);
});

const CARD = "eeee498d-98dd-44b6-97ee-c06a181c3769";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: (s: string) => boolean; end: () => void; writable: boolean };
  exitCode: number | null;
  kill: () => void;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.writable = true;
  stdin.write = () => true;
  stdin.end = () => { stdin.writable = false; };
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = () => {};
  return child;
}

const line = (event: object) => Buffer.from(JSON.stringify(event) + "\n");
const flush = () => new Promise((r) => setTimeout(r, 0));

let dir = "";
let savedDataDir = "";
let spawned: FakeChild[] = [];

beforeEach(async () => {
  applied.length = 0;
  observed.length = 0;
  cards.clear();
  cards.set(CARD, { id: CARD, column: "waiting", status: "waiting", pausedAt: null, restartPendingAt: null });
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-card-events-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
  spawned = [];
  setDriverSpawnerForTesting(() => {
    const child = fakeChild();
    spawned.push(child);
    return child as never;
  });
});

afterEach(async () => {
  resetSdkSessionsForTesting();
  setDriverSpawnerForTesting(null);
  await flush();
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

function ensure() {
  return ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
}

const kinds = () => observed.map((o) => [o.cardId, o.event.type, o.event.id]);

describe("sdk manager — a central de eventos ouve o chat nativo", () => {
  it("a pergunta do driver chega à central", async () => {
    ensure();
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line({ type: "user_question", id: "q1", questions: [{ question: "Qual banco?", options: [{ label: "Mongo" }] }] }));
    await flush();
    expect(kinds()).toContainEqual([CARD, "user_question", "q1"]);
  });

  it("o pedido de permissão e a decisão chegam à central", async () => {
    ensure();
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line({ type: "permission_request", id: "p1", tool: "Bash" }));
    spawned[0]!.stdout.emit("data", line({ type: "permission", id: "p1", tool: "Bash", decision: "deny", sensitive: true }));
    await flush();
    expect(kinds()).toEqual(expect.arrayContaining([[CARD, "permission_request", "p1"], [CARD, "permission", "p1"]]));
  });

  it("a pergunta que o driver encerra (respondida, superada, expirada) chega à central", async () => {
    ensure();
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    spawned[0]!.stdout.emit("data", line({ type: "question_result", id: "q1", superseded: true }));
    await flush();
    expect(kinds()).toContainEqual([CARD, "question_result", "q1"]);
  });

  it("a órfã de antes de um reinício, superada por uma mensagem, também é encerrada na central", async () => {
    await appendHistory(CARD, { type: "user_question", id: "q0", questions: [{ question: "Qual banco?", options: [{ label: "Mongo" }] }], at: Date.now() });
    const session = ensure();
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    handleClientFrame(session, `{"type":"user","text":"use o mysql"}`);
    await vi.waitFor(() => expect(kinds()).toContainEqual([CARD, "question_result", "q0"]));
  });
});

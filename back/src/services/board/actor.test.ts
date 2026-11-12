import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * WHO a card's commits belong to. The rule under test is the one the four routes share: touching a
 * card you may WORK makes you its author; touching one you may only VIEW must not.
 *
 * The registry is REAL (temp data dir). The runner is not: `reapplyCardIdentity` is the only thing
 * that would reach docker, and what matters here is WHETHER it is called — once per real switch,
 * never for the same person twice.
 */

let dir = "";
const reapply = vi.fn(async (_cardId: string) => undefined);
/**
 * A runner failure, delivered OUTSIDE the `vi.fn`: vitest's mock hangs a `.then` on the promise it
 * returns (settledResults), and a rejection coming from it never gets to be "unhandled".
 */
let reapplyFailure: Error | null = null;
/** When set, the runner "takes" this long to apply the identity: the reapply settles with it. */
let reapplyGate: Promise<boolean> | null = null;

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  // The REAL module, with only the per-card reapply swapped: the propagation test calls
  // `reapplyIdentityForUser` for real and needs it to exist.
  vi.doMock("./workspace.js", async () => {
    const actual = await vi.importActual<typeof import("./workspace.js")>("./workspace.js");
    return {
      ...actual,
      reapplyCardIdentity: (cardId: string): Promise<boolean> => {
        void reapply(cardId);
        const failure = reapplyFailure;
        reapplyFailure = null;
        if (failure) return Promise.reject(failure);
        return reapplyGate ?? Promise.resolve(true);
      },
    };
  });
  const registry = await import("./registry.js");
  registry.resetForTesting();
  const { recordCardActor, authorsTheTurn, isCardActor, relayCardActor, actAsParticipant } = await import("./actor.js");
  return { registry, recordCardActor, authorsTheTurn, isCardActor, relayCardActor, actAsParticipant };
}

const owner = { id: "u-cesar", username: "cesar", role: "owner" as const, createdAt: "" };
const mussa = { id: "u-mussa", username: "mussa", role: "member" as const, createdAt: "" };
const viewer = { id: "u-view", username: "espectador", role: "member" as const, createdAt: "" };

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-actor-")); reapply.mockClear(); reapplyFailure = null; reapplyGate = null; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.doUnmock("./workspace.js"); });

async function seed(registry: Awaited<ReturnType<typeof load>>["registry"]) {
  const project = await registry.createProject({ name: "widgets" });
  const card = await registry.createCard({ projectId: project.id, title: "um card" });
  return card;
}

describe("o ator do card decide a identidade do commit", () => {
  it("quem só PODE VER não vira autor; quem trabalha, vira", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);

    await registry.shareWith({ kind: "card", targetId: card.id, userId: viewer.id, level: "view" });
    await recordCardActor(viewer, card.id);
    expect((await registry.getCard(card.id))?.actorUserId).toBeUndefined();
    expect(reapply).not.toHaveBeenCalled();

    await registry.shareWith({ kind: "card", targetId: card.id, userId: mussa.id, level: "work" });
    await recordCardActor(mussa, card.id);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(mussa.id);
  });

  it("o César retoma a autoria quando volta a trabalhar no card do Mussa", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);

    await registry.shareWith({ kind: "card", targetId: card.id, userId: mussa.id, level: "work" });
    await recordCardActor(mussa, card.id);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(mussa.id);

    await recordCardActor(owner, card.id);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(owner.id);
  });

  it("reaplica no runner UMA vez por troca real, não a cada toque", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);

    await recordCardActor(owner, card.id);
    const afterFirst = reapply.mock.calls.length;
    await recordCardActor(owner, card.id);
    await recordCardActor(owner, card.id);
    // Same actor: no docker exec per prompt.
    expect(reapply.mock.calls.length).toBe(afterFirst);

    await registry.shareWith({ kind: "card", targetId: card.id, userId: mussa.id, level: "work" });
    await recordCardActor(mussa, card.id);
    expect(reapply.mock.calls.length).toBe(afterFirst + 1);
  });

  it("sessão sem usuário não estampa nada", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);
    await recordCardActor(null, card.id);
    expect((await registry.getCard(card.id))?.actorUserId).toBeUndefined();
  });
});

/**
 * AUTHORSHIP PER MESSAGE. The native chat stamped the actor on CONNECT: with César and Mussa on the same
 * card at the same time, the commit went out in the name of whoever had opened it last, not of whoever
 * sent the request. Now each message stamps — and that is why it needs to be CHEAP: the whole board.json
 * is rewritten on every mutation, and one write per message (plus a docker exec) is exactly the
 * overhead to avoid.
 */
describe("autoria por mensagem — barata quando nada muda", () => {
  it("mensagem repetida do mesmo autor NÃO reescreve o board.json", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);
    const file = join(dir, "board.json");

    await recordCardActor(owner, card.id);
    const before = (await stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));

    // Ten messages in a row from the same person: nothing changed, nothing is written.
    for (let i = 0; i < 10; i += 1) await recordCardActor(owner, card.id);

    expect((await stat(file)).mtimeMs).toBe(before);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(owner.id);
  });

  it("a troca real continua escrevendo e reaplicando — uma vez", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);
    await registry.shareWith({ kind: "card", targetId: card.id, userId: mussa.id, level: "work" });

    await recordCardActor(owner, card.id);
    reapply.mockClear();
    await recordCardActor(mussa, card.id);
    await recordCardActor(mussa, card.id);

    expect((await registry.getCard(card.id))?.actorUserId).toBe(mussa.id);
    expect(reapply.mock.calls.length).toBe(1);
  });
});

describe("authorsTheTurn (pura) — que frame do chat é um pedido de trabalho", () => {
  it("mensagem do usuário (objeto ou texto cru) e edição de mensagem SIM", async () => {
    const { authorsTheTurn } = await load();
    expect(authorsTheTurn('{"type":"user","text":"commita isso"}')).toBe(true);
    expect(authorsTheTurn("commita isso")).toBe(true);
    expect(authorsTheTurn('{"type":"edit_user","original":"a","text":"b"}')).toBe(true);
  });

  it("interromper, responder permissão ou pergunta NÃO troca a autoria", async () => {
    const { authorsTheTurn } = await load();
    // Clicking "permitir" on the request of whoever is working does not make the spectator the author.
    expect(authorsTheTurn('{"type":"interrupt"}')).toBe(false);
    expect(authorsTheTurn('{"type":"permission_decision","id":"perm_1","allow":true}')).toBe(false);
    expect(authorsTheTurn('{"type":"question_answer","id":"q1","answers":[{"selected":["a"]}]}')).toBe(false);
  });

  it("frame vazio ou quebrado não carimba ninguém", async () => {
    const { authorsTheTurn } = await load();
    expect(authorsTheTurn("")).toBe(false);
    expect(authorsTheTurn("   ")).toBe(false);
    expect(authorsTheTurn('{"type":"weird"}')).toBe(false);
  });
});

describe("vincular identidade alcança os cards já abertos", () => {
  it("salvar a identidade de alguém reaplica nos cards em que essa pessoa é o ator", async () => {
    const { registry } = await load();
    const workspace = await import("./workspace.js");
    const project = await registry.createProject({ name: "widgets" });

    const aberto = await registry.createCard({ projectId: project.id, title: "aberto" });
    const outro = await registry.createCard({ projectId: project.id, title: "de outra pessoa" });
    const nuncaAberto = await registry.createCard({ projectId: project.id, title: "nunca aberto" });
    await registry.applyOpenTerminal(aberto.id);
    await registry.applyOpenTerminal(outro.id);
    await registry.stampCardActor(aberto.id, "u-mussa");
    await registry.stampCardActor(outro.id, "u-cesar");
    await registry.stampCardActor(nuncaAberto.id, "u-mussa");

    // THE BUG: the identity was only written on OPEN or on an actor switch, and whoever has just gained
    // an identity ALREADY IS the actor of the card they are sitting on. The owner saved, the screen said saved, and the
    // next commit kept going out with the installation's default.
    expect(await workspace.reapplyIdentityForUser("u-mussa")).toBe(1);
    expect(await workspace.reapplyIdentityForUser("u-cesar")).toBe(1);
    expect(await workspace.reapplyIdentityForUser("u-ninguem")).toBe(0);
    expect(await workspace.reapplyIdentityForUser("")).toBe(0);
  });
});

/**
 * THE STAMP GOES OUT ON EVERY CHAT MESSAGE, as `void recordCardActor(...)`. An unhandled rejected
 * promise brings the process down on Node 24 — and with it everyone's terminals and chats. A full disk
 * or a runner that is down become a log line, never a rejection.
 */
describe("o carimbo do autor nunca rejeita", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
  afterEach(() => { process.off("unhandledRejection", onUnhandled); vi.doUnmock("./registry.js"); });

  /** Lets unhandled rejections reach the process before looking. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  it("um disco que recusa a gravação do board não rejeita", async () => {
    vi.resetModules();
    const env = await import("../../config/env.js");
    env.config.dataDir = dir;
    vi.doMock("./registry.js", async () => {
      const actual = await vi.importActual<typeof import("./registry.js")>("./registry.js");
      return { ...actual, stampCardActor: async () => { throw new Error("ENOSPC: no space left on device"); } };
    });
    const registry = await import("./registry.js");
    registry.resetForTesting();
    const { recordCardActor } = await import("./actor.js");
    const card = await seed(registry);

    await expect(recordCardActor(owner, card.id)).resolves.toBeUndefined();
  });

  it("o runner que falha ao reaplicar a identidade não vira rejeição sem dono", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);
    reapplyFailure = new Error("runner unreachable");

    await recordCardActor(owner, card.id);
    await settle();
    expect(reapply).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });
});

/**
 * THE SWITCH LANDS BEFORE THE ORDER. Mussa's message may only reach the agent after his token
 * and author are in the runner — otherwise the first commit of his request goes out as César.
 */
describe("a troca de autor aterrissa antes da mensagem que a causou", () => {
  it("recordCardActor só resolve quando a identidade nova já está no runner", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);
    await registry.shareWith({ kind: "card", targetId: card.id, userId: mussa.id, level: "work" });
    await recordCardActor(owner, card.id);

    let landed!: (ok: boolean) => void;
    reapplyGate = new Promise<boolean>((r) => { landed = r; });
    let done = false;
    const switching = recordCardActor(mussa, card.id).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    landed(true);
    await switching;
    expect(done).toBe(true);
  });

  it("um runner que não responde segura a mensagem só até o limite — nunca para sempre", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);
    reapplyGate = new Promise<boolean>(() => undefined);
    const started = Date.now();
    await recordCardActor(owner, card.id, { waitMs: 100 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(owner.id);
  });

  it("isCardActor (síncrono) diz se a mensagem precisa esperar uma troca", async () => {
    const { registry, recordCardActor, isCardActor } = await load();
    const card = await seed(registry);
    await registry.shareWith({ kind: "card", targetId: card.id, userId: mussa.id, level: "work" });
    // Nothing known yet: when in doubt, it goes through the path that checks.
    expect(isCardActor(owner, card.id)).toBe(false);
    await recordCardActor(owner, card.id);
    expect(isCardActor(owner, card.id)).toBe(true);
    expect(isCardActor(mussa, card.id)).toBe(false);
    await recordCardActor(mussa, card.id);
    expect(isCardActor(owner, card.id)).toBe(false);
    expect(isCardActor(mussa, card.id)).toBe(true);
    expect(isCardActor(null, card.id)).toBe(false);
  });
});

/**
 * THE MAESTRO RELAYS A PERSON'S ORDER. When César's card delegates to card B, the one who gave the order
 * was César: the work on B that it triggers goes out with his account.
 */
describe("relayCardActor — a ordem delegada por outro card leva o autor junto", () => {
  it("o autor do card remetente vira o autor do destino", async () => {
    const { registry, relayCardActor } = await load();
    const users = await import("../../auth/users.js");
    const cesar = await users.createUser("cesar", "senha-forte-1", "owner");
    const project = await registry.createProject({ name: "widgets" });
    const maestro = await registry.createCard({ projectId: project.id, title: "maestro" });
    const alvo = await registry.createCard({ projectId: project.id, title: "alvo" });
    await registry.stampCardActor(maestro.id, cesar.id);
    await registry.stampCardActor(alvo.id, "u-mussa");

    await relayCardActor(maestro.id, alvo.id);
    expect((await registry.getCard(alvo.id))?.actorUserId).toBe(cesar.id);
  });

  it("remetente sem autor, desconhecido ou sem acesso de trabalho ao destino: nada muda", async () => {
    const { registry, relayCardActor } = await load();
    const users = await import("../../auth/users.js");
    const semAcesso = await users.createUser("fulano", "senha-forte-1", "member");
    const project = await registry.createProject({ name: "widgets" });
    const maestro = await registry.createCard({ projectId: project.id, title: "maestro" });
    const alvo = await registry.createCard({ projectId: project.id, title: "alvo" });
    await registry.stampCardActor(alvo.id, "u-mussa");

    await relayCardActor(maestro.id, alvo.id);
    await relayCardActor(undefined, alvo.id);
    await relayCardActor("card-que-nao-existe", alvo.id);
    // A card from ANOTHER project does not lend its author (the `from` is declared by the agent itself).
    const outro = await registry.createProject({ name: "outro" });
    const deFora = await registry.createCard({ projectId: outro.id, title: "de fora" });
    await registry.stampCardActor(deFora.id, (await users.createUser("cesar", "senha-forte-1", "owner")).id);
    await relayCardActor(deFora.id, alvo.id);
    await registry.stampCardActor(maestro.id, semAcesso.id);
    await relayCardActor(maestro.id, alvo.id);
    expect((await registry.getCard(alvo.id))?.actorUserId).toBe("u-mussa");
  });
});

/**
 * AN APPLICATION THAT FAILED MUST NOT BECOME "ALREADY THE AUTHOR". The cache said Mussa was already the author
 * before his identity reached the runner; if the docker exec failed, none of his following messages
 * tried again — and the commits kept going out as César, silently.
 */
describe("a troca que não aterrissou é tentada de novo na próxima ordem", () => {
  it("runner falhou: a próxima mensagem da mesma pessoa reaplica", async () => {
    const { registry, recordCardActor, isCardActor } = await load();
    const card = await seed(registry);
    reapplyGate = Promise.resolve(false);
    await recordCardActor(owner, card.id);
    expect(isCardActor(owner, card.id)).toBe(false);

    reapplyGate = null;
    reapply.mockClear();
    await recordCardActor(owner, card.id);
    expect(reapply).toHaveBeenCalledTimes(1);
    expect(isCardActor(owner, card.id)).toBe(true);
  });

  it("o board já diz quem é, mas ESTE processo nunca viu aterrissar (reinício): aplica uma vez", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);
    await registry.stampCardActor(card.id, owner.id);
    await recordCardActor(owner, card.id);
    await recordCardActor(owner, card.id);
    expect(reapply).toHaveBeenCalledTimes(1);
  });

  it("estourou o limite de espera: a mensagem segue, e a próxima confere de novo", async () => {
    const { registry, recordCardActor, isCardActor } = await load();
    const card = await seed(registry);
    reapplyGate = new Promise<boolean>(() => undefined);
    await recordCardActor(owner, card.id, { waitMs: 50 });
    expect(isCardActor(owner, card.id)).toBe(false);
  });
});

/**
 * ACTING AS SOMEONE WHO ALREADY GAVE AN ORDER ON THE CARD. Albert asked for the work; Mussa joined the card and said
 * "commita e push como Albert, eu sou coautor". Mussa's message switched the card's account to
 * his, and the agent got stuck until Albert came back and sent "faça o que o Mussa pediu". Now the agent
 * goes back to Albert's account on its own, because Albert has already given an order there. The account of someone who never
 * spoke on the card stays out of reach.
 */
describe("actAsParticipant — agir como quem já deu ordem no card", () => {
  async function cenario() {
    const ctx = await load();
    const users = await import("../../auth/users.js");
    const albert = await users.createUser("albert", "senha-forte-1", "member");
    const mussa = await users.createUser("mussa", "senha-forte-1", "member");
    const card = await seed(ctx.registry);
    for (const u of [albert, mussa]) {
      await ctx.registry.shareWith({ kind: "card", targetId: card.id, userId: u.id, level: "work" });
    }
    await ctx.recordCardActor(albert, card.id);
    await ctx.recordCardActor(mussa, card.id);
    return { ...ctx, users, albert, mussa, card };
  }

  it("o Mussa manda sair como Albert: o card volta para a conta do Albert e a identidade é reaplicada", async () => {
    const { registry, actAsParticipant, isCardActor, albert, card } = await cenario();
    reapply.mockClear();

    const r = await actAsParticipant(card.id, "Albert");

    expect(r.actor).toBe("albert");
    expect((await registry.getCard(card.id))?.actorUserId).toBe(albert.id);
    expect(reapply).toHaveBeenCalledTimes(1);
    expect(isCardActor(albert, card.id)).toBe(true);
  });

  it("a próxima mensagem do Mussa devolve a conta para ele (a ordem seguinte é dele)", async () => {
    const { registry, actAsParticipant, recordCardActor, mussa, card } = await cenario();
    await actAsParticipant(card.id, "albert");
    await recordCardActor(mussa, card.id);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(mussa.id);
  });

  it("sem usuário: só diz quem é o ator e quem pode ser usado, sem trocar nada", async () => {
    const { registry, actAsParticipant, mussa, card } = await cenario();
    reapply.mockClear();
    const r = await actAsParticipant(card.id);
    expect(r).toEqual({ actor: "mussa", participants: ["albert", "mussa"] });
    expect((await registry.getCard(card.id))?.actorUserId).toBe(mussa.id);
    expect(reapply).not.toHaveBeenCalled();
  });

  it("quem nunca deu ordem no card é recusado, mesmo sendo owner", async () => {
    const { registry, actAsParticipant, users, mussa, card } = await cenario();
    await users.createUser("cesar", "senha-forte-1", "owner");
    await expect(actAsParticipant(card.id, "cesar")).rejects.toThrow(/never gave this card an order.*albert, mussa/);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(mussa.id);
  });

  it("usuário inexistente ou card inexistente: erro claro, nada muda", async () => {
    const { registry, actAsParticipant, mussa, card } = await cenario();
    await expect(actAsParticipant(card.id, "fulano")).rejects.toThrow(/no user named 'fulano'/);
    await expect(actAsParticipant("nao-existe", "albert")).rejects.toThrow(/card not found/);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(mussa.id);
  });

  it("participante que perdeu o acesso de trabalho ao card não pode mais ser usado", async () => {
    const { registry, actAsParticipant, albert, mussa, card } = await cenario();
    await registry.shareWith({ kind: "card", targetId: card.id, userId: albert.id, level: "view" });
    await expect(actAsParticipant(card.id, "albert")).rejects.toThrow(/no longer has work access/);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(mussa.id);
  });

  it("a troca não aterrissou no runner: erro, para o push não sair com a conta errada", async () => {
    const { actAsParticipant, card } = await cenario();
    reapplyGate = Promise.resolve(false);
    await expect(actAsParticipant(card.id, "albert")).rejects.toThrow(/did not land/);
  });

  it("card de antes da lista de participantes: o ator atual conta como participante", async () => {
    const { registry, actAsParticipant } = await load();
    const users = await import("../../auth/users.js");
    const albert = await users.createUser("albert", "senha-forte-1", "owner");
    const card = await seed(registry);
    await registry.stampCardActor(card.id, albert.id);
    expect((await actAsParticipant(card.id)).participants).toEqual(["albert"]);
  });
});

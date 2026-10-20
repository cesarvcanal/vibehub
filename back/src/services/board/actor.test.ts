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
 * Uma falha do runner, entregue FORA do `vi.fn`: o mock do vitest pendura um `.then` na promise que
 * devolve (settledResults), e uma rejeição vinda dele nunca chega a ser "sem dono".
 */
let reapplyFailure: Error | null = null;
/** When set, the runner "takes" this long to apply the identity: the reapply settles with it. */
let reapplyGate: Promise<boolean> | null = null;

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  // O módulo REAL, com só o reapply por card trocado: o teste de propagação chama
  // `reapplyIdentityForUser` de verdade e precisa que ele exista.
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
  const { recordCardActor, authorsTheTurn, isCardActor, relayCardActor } = await import("./actor.js");
  return { registry, recordCardActor, authorsTheTurn, isCardActor, relayCardActor };
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
    // Mesmo ator: nada de docker exec por prompt.
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
 * AUTORIA POR MENSAGEM. O chat nativo carimbava o ator no CONNECT: com o César e o Mussa no mesmo
 * card ao mesmo tempo, o commit saía no nome de quem tinha aberto por último, não no de quem
 * mandou o pedido. Agora cada mensagem carimba — e por isso ela precisa ser BARATA: o board.json
 * inteiro é reescrito a cada mutação, e um write por mensagem (mais um docker exec) é justamente a
 * sobrecarga a evitar.
 */
describe("autoria por mensagem — barata quando nada muda", () => {
  it("mensagem repetida do mesmo autor NÃO reescreve o board.json", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);
    const file = join(dir, "board.json");

    await recordCardActor(owner, card.id);
    const before = (await stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));

    // Dez mensagens seguidas da mesma pessoa: nada mudou, nada é escrito.
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
    // Clicar em "permitir" no pedido de quem está trabalhando não torna o espectador o autor.
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

    // O BUG: a identidade só era escrita na ABERTURA ou na troca de ator, e quem acabou de ganhar
    // identidade JÁ É o ator do card em que está sentado. O dono salvava, a tela dizia salvo, e o
    // commit seguinte continuava saindo com o padrão da instalação.
    expect(await workspace.reapplyIdentityForUser("u-mussa")).toBe(1);
    expect(await workspace.reapplyIdentityForUser("u-cesar")).toBe(1);
    expect(await workspace.reapplyIdentityForUser("u-ninguem")).toBe(0);
    expect(await workspace.reapplyIdentityForUser("")).toBe(0);
  });
});

/**
 * O CARIMBO SAI A CADA MENSAGEM DO CHAT, como `void recordCardActor(...)`. Uma promise rejeitada sem
 * dono derruba o processo no Node 24 — e com ele os terminais e os chats de todo mundo. Disco cheio
 * ou runner fora do ar viram uma linha de log, nunca uma rejeição.
 */
describe("o carimbo do autor nunca rejeita", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
  afterEach(() => { process.off("unhandledRejection", onUnhandled); vi.doUnmock("./registry.js"); });

  /** Deixa as rejeições sem dono chegarem ao processo antes de olhar. */
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
 * A TROCA ATERRISSA ANTES DA ORDEM. A mensagem do Mussa só pode chegar ao agente depois que o token
 * e o autor dele estão no runner — senão o primeiro commit do pedido dele sai como o César.
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
    // Nada conhecido ainda: na dúvida, passa pelo caminho que confere.
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
 * O MAESTRO REPASSA A ORDEM DE UMA PESSOA. Quando o card do César delega ao card B, quem deu a ordem
 * foi o César: o trabalho de B que ela provoca sai com a conta dele.
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
    // Um card de OUTRO projeto não empresta o autor dele (o `from` é declarado pelo próprio agente).
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
 * UMA APLICAÇÃO QUE FALHOU NÃO PODE VIRAR "JÁ É O AUTOR". O cache dizia que o Mussa já era o autor
 * antes de a identidade dele chegar ao runner; se o docker exec falhasse, nenhuma mensagem seguinte
 * dele tentava de novo — e os commits seguiam saindo como o César, em silêncio.
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

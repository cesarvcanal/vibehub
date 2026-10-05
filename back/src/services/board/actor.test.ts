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
const reapply = vi.fn(async () => undefined);

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  // O módulo REAL, com só o reapply por card trocado: o teste de propagação chama
  // `reapplyIdentityForUser` de verdade e precisa que ele exista.
  vi.doMock("./workspace.js", async () => {
    const actual = await vi.importActual<typeof import("./workspace.js")>("./workspace.js");
    return { ...actual, reapplyCardIdentity: reapply };
  });
  const registry = await import("./registry.js");
  registry.resetForTesting();
  const { recordCardActor, authorsTheTurn } = await import("./actor.js");
  return { registry, recordCardActor, authorsTheTurn };
}

const owner = { id: "u-cesar", username: "cesar", role: "owner" as const, createdAt: "" };
const mussa = { id: "u-mussa", username: "mussa", role: "member" as const, createdAt: "" };
const viewer = { id: "u-view", username: "espectador", role: "member" as const, createdAt: "" };

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-actor-")); reapply.mockClear(); });
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

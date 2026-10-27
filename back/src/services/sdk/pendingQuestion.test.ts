import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEvent } from "./history.js";

/**
 * O CARD QUE PAROU NUMA PERGUNTA (produção, 2026-10-27, card 37fa689a): a bandeja do chat mostrava
 * "Quer que eu abra um PR pequeno para a mensagem de HTTPS?" e o ícone do card na barra lateral era o
 * círculo neutro de "sua vez". O servidor lê o mesmo log com a mesma regra e carimba o card.
 */

let dir = "";

async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  const registry = await import("../board/registry.js");
  const history = await import("./history.js");
  const pending = await import("./pendingQuestion.js");
  return { registry, history, pending };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-pending-question-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const said = (text: string, extra: object = {}): HistoryEvent => ({ type: "assistant_text", text, ...extra }) as HistoryEvent;
const typed = (text: string): HistoryEvent => ({ type: "user", text });

describe("proseQuestion — a MESMA regra da bandeja (front/src/features/board/lib/pendingDecisions.ts)", () => {
  it("pega a pergunta dirigida que FECHA o texto", async () => {
    const { pending } = await fresh();
    expect(pending.proseQuestion("Analisei as duas rotas.\n\nQual das duas você prefere?")).toBe("Qual das duas você prefere?");
    expect(pending.proseQuestion("Posso seguir com a opção A?")).toBe("Posso seguir com a opção A?");
    expect(pending.proseQuestion("Fiz o levantamento.\n\nMe confirma o CNPJ da filial 5?")).toBe("Me confirma o CNPJ da filial 5?");
    expect(pending.proseQuestion("Two builds exist.\n\nWhich one do you prefer?")).toBe("Which one do you prefer?");
    expect(pending.proseQuestion("Segue o plano.\n\nDecisão sua: A (rápida) ou B (completa).")).toBe("Decisão sua: A (rápida) ou B (completa).");
    expect(pending.proseQuestion("Pronto.\n\n**Qual opção você quer?**")).toBe("**Qual opção você quer?**");
  });

  it("fica quieta no retórico, no que o próprio texto responde, em citação e em código", async () => {
    const { pending } = await fresh();
    expect(pending.proseQuestion("Faz sentido?")).toBeNull();
    expect(pending.proseQuestion("O que será que acontece aqui? Vamos descobrir.")).toBeNull();
    expect(pending.proseQuestion("Rodei os testes e está tudo verde.")).toBeNull();
    expect(pending.proseQuestion("")).toBeNull();
    expect(pending.proseQuestion("Qual você prefere?\n\nFui de A: é a mais simples e já está pronta.")).toBeNull();
    expect(pending.proseQuestion("Contexto.\n\n> Qual você prefere?")).toBeNull();
    expect(pending.proseQuestion("Contexto.\n\n```\nQual você prefere?\n```")).toBeNull();
  });
});

describe("pendingProseQuestion — o que a conversa espera, lido do log", () => {
  it("o caso de produção: a última fala do agente fecha na pergunta e ninguém respondeu", async () => {
    const { pending } = await fresh();
    const log: HistoryEvent[] = [
      typed("Continue de onde parou: o processo anterior foi interrompido por um reinício do servidor do painel (deploy)."),
      said("Retomo verificando o estado atual."),
      { type: "tool_use", id: "t1", name: "Bash", input: {} } as HistoryEvent,
      said("Afeta só o preview, nada do produto; não corrigi pelo mesmo motivo.\n\nQuer que eu abra um PR pequeno para a mensagem de HTTPS?"),
      { type: "tool_use", id: "t2", name: "Bash", input: {} } as HistoryEvent,
    ];
    expect(pending.pendingProseQuestion(log)).toBe("Quer que eu abra um PR pequeno para a mensagem de HTTPS?");
  });

  it("qualquer mensagem depois da pergunta a resolve", async () => {
    const { pending } = await fresh();
    expect(pending.pendingProseQuestion([said("Posso seguir com a opção A?"), typed("pode")])).toBeNull();
  });

  it("o agente falou de novo: vale a fala NOVA, não a pergunta velha", async () => {
    const { pending } = await fresh();
    expect(pending.pendingProseQuestion([said("Posso seguir com a opção A?"), said("Segui com a A; está pronto.")])).toBeNull();
    expect(pending.pendingProseQuestion([said("Feito."), said("Quer que eu suba pra dev?")])).toBe("Quer que eu suba pra dev?");
  });

  it("fala de subagente, turno de voz e texto vazio não são a conversa", async () => {
    const { pending } = await fresh();
    const log: HistoryEvent[] = [
      said("Quer que eu abra o PR?"),
      said("Qual arquivo você quer que eu leia?", { parentToolUseId: "agent-1" }),
      { type: "voice_turn", vid: "v1", role: "assistant", text: "Tudo certo." } as HistoryEvent,
      said(""),
    ];
    expect(pending.pendingProseQuestion(log)).toBe("Quer que eu abra o PR?");
    expect(pending.pendingProseQuestion([])).toBeNull();
  });
});

describe("syncPendingQuestion / backfillPendingQuestions — o carimbo no card", () => {
  async function cardWithLog(log: HistoryEvent[], status: "waiting" | "working" = "waiting") {
    const env = await fresh();
    const project = await env.registry.createProject({ name: "vibehub" });
    const card = await env.registry.createCard({ projectId: project.id, title: "Voz" });
    await env.registry.applyCardStatus(card.id, status);
    for (const event of log) void env.history.appendHistory(card.id, event);
    return { ...env, card };
  }

  it("o fim do turno lê o log já com as últimas linhas (enfileiradas, não esperadas) e carimba", async () => {
    const { registry, pending, card } = await cardWithLog([typed("revisa"), said("Revisei.\n\nPosso fazer o merge?")]);
    await pending.syncPendingQuestion(card.id);
    expect((await registry.getCard(card.id))!.pendingQuestionAt).toEqual(expect.any(Number));
  });

  it("sem pergunta no fim, limpa um carimbo que tenha ficado", async () => {
    const { registry, pending, card } = await cardWithLog([said("Posso fazer o merge?"), typed("pode"), said("Merge feito.")]);
    await registry.setCardPendingQuestion(card.id, 1);
    await pending.syncPendingQuestion(card.id);
    expect((await registry.getCard(card.id))!.pendingQuestionAt ?? null).toBeNull();
  });

  it("no boot, carimba quem já tinha parado numa pergunta — e deixa de fora o turno em voo e o card concluído", async () => {
    const env = await fresh();
    const project = await env.registry.createProject({ name: "vibehub" });
    const asking = await env.registry.createCard({ projectId: project.id, title: "pergunta" });
    const working = await env.registry.createCard({ projectId: project.id, title: "trabalhando" });
    const done = await env.registry.createCard({ projectId: project.id, title: "concluído" });
    const answered = await env.registry.createCard({ projectId: project.id, title: "respondido" });
    await env.registry.applyCardStatus(asking.id, "waiting");
    await env.registry.applyCardStatus(working.id, "working");
    await env.registry.updateCard(done.id, { column: "done" });
    await env.registry.applyCardStatus(answered.id, "waiting");
    for (const id of [asking.id, working.id, done.id]) void env.history.appendHistory(id, said("Quer que eu abra um PR pequeno?"));
    void env.history.appendHistory(answered.id, said("Quer que eu abra um PR pequeno?"));
    void env.history.appendHistory(answered.id, typed("não precisa"));
    await env.registry.setCardPendingQuestion(answered.id, 5); // stale: answered while the old server ran
    await env.history.historySettled(answered.id);
    for (const id of [asking.id, working.id, done.id]) await env.history.historySettled(id);

    expect(await env.pending.backfillPendingQuestions()).toBe(1);
    expect((await env.registry.getCard(asking.id))!.pendingQuestionAt).toEqual(expect.any(Number));
    expect((await env.registry.getCard(working.id))!.pendingQuestionAt ?? null).toBeNull();
    expect((await env.registry.getCard(done.id))!.pendingQuestionAt ?? null).toBeNull();
    expect((await env.registry.getCard(answered.id))!.pendingQuestionAt ?? null).toBeNull();
  });
});

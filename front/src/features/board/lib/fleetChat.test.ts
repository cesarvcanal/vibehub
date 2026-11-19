import { describe, expect, it } from "vitest";
import type { AnalysisConversation, ReviewFleetAgent, ReviewFleetRun } from "@/api/types";
import { analysisFleetChat, chatClockText, isLongSpeech, modelFamily, reviewFleetChat } from "./fleetChat";

function reviewAgent(overrides: Partial<ReviewFleetAgent> = {}): ReviewFleetAgent {
  return { id: "a1", label: "contexto", phase: "Contexto", status: "done", ...overrides };
}

function reviewRun(agents: ReviewFleetAgent[], finished = false): ReviewFleetRun {
  return { runId: "wf_1", name: "revisao", phases: [], total: agents.length, done: 0, agents, at: 1, finished };
}

function analysis(items: AnalysisConversation["items"], finished = false): AnalysisConversation {
  return {
    runId: "wf_a1", finished, items,
    agents: [
      { id: "rev", label: "revisão:performance", phase: "Revisão", status: "done", modelLabel: "Sonnet 5.5" },
      { id: "ver", label: "verificação:performance · matchMedia a cada frame", phase: "Verificação", status: "running", modelLabel: "Haiku 4.5" },
    ],
  };
}

describe("modelFamily", () => {
  it.each([
    ["claude-opus-5-5", "opus"],
    ["Sonnet 5.5", "sonnet"],
    ["haiku", "haiku"],
    ["gpt-5", "other"],
    [undefined, "other"],
  ] as const)("%s → %s", (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });
});

describe("reviewFleetChat", () => {
  it("quem terminou fala na ordem em que terminou, o juiz por último, quem parou avisa e quem trabalha está digitando", () => {
    const entries = reviewFleetChat(reviewRun([
      reviewAgent({ id: "judge", label: "juiz", endedAt: 5, result: "apto" }),
      reviewAgent({ id: "ver", label: "verificação:correctness · Busca duplicada", endedAt: 30, result: '{"confirmed":true}', model: "haiku" }),
      reviewAgent({ id: "rev", label: "revisão:correctness", endedAt: 20, result: '{"findings":[{"title":"Busca duplicada"}]}', model: "sonnet" }),
      reviewAgent({ id: "dead", label: "revisão:tests", status: "stopped" }),
      reviewAgent({ id: "live", label: "revisão:security", status: "running", model: "sonnet" }),
    ]));
    expect(entries.map((entry) => [entry.kind, entry.speaker.agentId])).toEqual([
      ["message", "rev"], ["message", "ver"], ["message", "judge"], ["stopped", "dead"], ["typing", "live"],
    ]);
    expect(entries[0]).toMatchObject({ at: 20, reading: { kind: "findings", titles: ["Busca duplicada"] }, speaker: { family: "sonnet", model: "sonnet" } });
  });

  it("a verificação responde citando a fala da revisão da mesma dimensão", () => {
    const entries = reviewFleetChat(reviewRun([
      reviewAgent({ id: "rev", label: "revisão:correctness", endedAt: 1, result: '{"findings":[{"title":"Busca duplicada"}]}' }),
      reviewAgent({ id: "ver", label: "verificação:correctness · Busca duplicada", endedAt: 2, result: '{"confirmed":false}' }),
    ]));
    expect(entries[1]).toMatchObject({ replyTo: { title: "Busca duplicada", messageId: entries[0]!.id } });
    expect(entries[0]).not.toHaveProperty("replyTo");
  });

  it("verificação cuja revisão ainda não falou cita só o título, sem destino", () => {
    const [entry] = reviewFleetChat(reviewRun([
      reviewAgent({ id: "ver", label: "verificação:correctness · Busca duplicada", endedAt: 2, result: '{"confirmed":true}' }),
    ]));
    expect(entry).toMatchObject({ replyTo: { title: "Busca duplicada" } });
    expect(entry!.kind === "message" && entry!.replyTo?.messageId).toBeUndefined();
  });

  it("frota terminada não deixa ninguém digitando", () => {
    expect(reviewFleetChat(reviewRun([reviewAgent({ status: "running" })], true))).toEqual([]);
  });

  it("ids das falas carregam a execução: duas rodadas na mesma tela não colidem", () => {
    const first = reviewFleetChat({ ...reviewRun([reviewAgent({ result: "a" })]), runId: "wf_1" });
    const second = reviewFleetChat({ ...reviewRun([reviewAgent({ result: "a" })]), runId: "wf_2" });
    expect(first[0]!.id).not.toBe(second[0]!.id);
  });
});

describe("analysisFleetChat", () => {
  it("cada texto de um agente é uma fala; ferramenta e resultado não viram balão", () => {
    const entries = analysisFleetChat(analysis([
      { agentId: "rev", at: 1, kind: "tool", tool: "Read", target: "a.ts" },
      { agentId: "rev", at: 2, kind: "result", text: "conteúdo" },
      { agentId: "rev", at: 3, kind: "text", text: "Vou conferir o hook." },
      { agentId: "rev", at: 4, kind: "text", text: '{"findings":[{"title":"matchMedia a cada frame"}]}' },
    ], true));
    expect(entries.map((entry) => entry.kind === "message" && entry.reading)).toEqual([
      { kind: "text", text: "Vou conferir o hook." },
      { kind: "findings", titles: ["matchMedia a cada frame"] },
    ]);
    expect(entries[0]).toMatchObject({ at: 3, speaker: { model: "Sonnet 5.5", family: "sonnet" } });
  });

  it("quem ainda trabalha está digitando, com a última ferramenta que usou", () => {
    const entries = analysisFleetChat(analysis([
      { agentId: "ver", at: 1, kind: "thinking" },
      { agentId: "ver", at: 2, kind: "tool", tool: "Read", target: "front/src/lib/useTweenedNumber.ts" },
    ]));
    expect(entries).toEqual([
      expect.objectContaining({ kind: "typing", speaker: expect.objectContaining({ agentId: "ver" }), doing: { tool: "Read", target: "front/src/lib/useTweenedNumber.ts" } }),
    ]);
  });

  it("pensando por último: digitando sem dizer a ferramenta", () => {
    const [entry] = analysisFleetChat(analysis([
      { agentId: "ver", at: 1, kind: "tool", tool: "Read", target: "a.ts" },
      { agentId: "ver", at: 2, kind: "thinking" },
    ]));
    expect(entry).toMatchObject({ kind: "typing" });
    expect(entry).not.toHaveProperty("doing");
  });

  it("a verificação cita a última fala da revisão da mesma dimensão", () => {
    const entries = analysisFleetChat(analysis([
      { agentId: "rev", at: 1, kind: "text", text: "Lendo." },
      { agentId: "rev", at: 2, kind: "text", text: '{"findings":[{"title":"matchMedia a cada frame"}]}' },
      { agentId: "ver", at: 3, kind: "text", text: '{"confirmed":true,"evidence":"linha 32"}' },
    ], true));
    expect(entries[2]).toMatchObject({ replyTo: { title: "matchMedia a cada frame", messageId: entries[1]!.id } });
  });

  it("passo de um agente que a lista não traz fica de fora", () => {
    expect(analysisFleetChat(analysis([{ agentId: "fantasma", at: 1, kind: "text", text: "oi" }], true))).toEqual([]);
  });
});

describe("isLongSpeech", () => {
  it.each([
    ["fala curta", "1 achado: matchMedia a cada frame", false],
    ["muitos caracteres", "x".repeat(600), true],
    ["muitas linhas curtas", Array.from({ length: 9 }, (_, line) => `- item ${line}`).join("\n"), true],
  ])("%s", (_name, text, long) => {
    expect(isLongSpeech(text)).toBe(long);
  });
});

describe("chatClockText", () => {
  it("hora e minuto no relógio de São Paulo, qualquer que seja o fuso do navegador", () => {
    expect(chatClockText(Date.UTC(2026, 10, 19, 1, 41))).toBe("22:41");
  });
});

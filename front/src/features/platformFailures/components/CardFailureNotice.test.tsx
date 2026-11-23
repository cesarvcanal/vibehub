import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { resetLanguage, setLanguage } from "@/i18n";
import type { PlatformFailureNotice } from "@/api/types";
import { CardFailureNotice } from "./CardFailureNotice";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  get: (...args: unknown[]) => get(...args),
  post: (...args: unknown[]) => post(...args),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const MEDIDOR: PlatformFailureNotice = {
  id: "f-medidor",
  source: "agent_report",
  status: "open",
  explanation: "O medidor de uso no topo do card mostrou o consumo da conta Claude anterior.",
  occurrences: 1,
  firstSeenAt: 2_000,
  lastSeenAt: 2_000,
  details: { symptom: "user_report: medidor velho", component: "usage-meter", evidence: "GET /api/usage devolveu 3%; a tela mostrava 57%" },
};

function signInAs(role: "owner" | "member") {
  get.mockImplementation(async (url: string) => {
    if (url === "/auth/me") return { user: { id: "u1", username: "mussa", role } };
    return {};
  });
}

function renderNotice(notices: PlatformFailureNotice[], cardId = "card-1") {
  return renderApp(<CardFailureNotice cardId={cardId} notices={notices} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setLanguage("pt-BR");
  signInAs("member");
  return () => resetLanguage();
});

describe("aviso de falha do vibehub dentro do card", () => {
  it("sem aviso, não mostra nada", () => {
    const { container } = renderNotice([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("membro vê a explicação e que o dono foi avisado, sem botão de investigar", async () => {
    renderNotice([MEDIDOR]);
    expect(await screen.findByText(MEDIDOR.explanation!)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /ver detalhes/i }));
    expect(await screen.findByText(/o dono da instalação foi avisado/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /investigar/i })).toBeNull();
    expect(screen.getByText(/GET \/api\/usage devolveu 3%/)).toBeTruthy();
  });

  it("falha sem explicação usa o texto leigo da origem, nunca o sintoma técnico", async () => {
    renderNotice([{ id: "f-lento", source: "slow_turn", status: "open", occurrences: 1, firstSeenAt: 1_000, lastSeenAt: 1_000 }]);
    expect(await screen.findByText(/as respostas do agente estão demorando/i)).toBeTruthy();
  });

  it("com a explicação da IA, mostra como num PR: o que aconteceu, quando, o contexto, a causa e quem provocou", async () => {
    const firstSeenAt = Date.UTC(2026, 10, 23, 13, 5);
    renderNotice([{
      ...MEDIDOR,
      firstSeenAt,
      lastSeenAt: firstSeenAt + 3_600_000,
      occurrences: 3,
      details: {
        ...MEDIDOR.details!,
        narrative: {
          context: "O card 'entrega' estava abrindo o PR.",
          whatHappened: "A entrega do PR parou no meio.",
          cause: "O agente foi interrompido pelo 'enviar agora'.",
          trigger: "person",
          triggerReason: "Uma pessoa mandou 'enviar agora' 2s antes do erro.",
        },
      },
    }]);
    expect(await screen.findByText("A entrega do PR parou no meio.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /ver detalhes/i }));
    const dialog = await screen.findByRole("dialog");
    for (const expectedText of [
      /provocado por uma pessoa/i, "Uma pessoa mandou 'enviar agora' 2s antes do erro.", "Contexto", "O card 'entrega' estava abrindo o PR.",
      "Por que aconteceu", "O agente foi interrompido pelo 'enviar agora'.", /23\/11\/2026.*10:05.*11:05.*3 vezes/,
    ]) expect(within(dialog).getByText(expectedText)).toBeTruthy();
  });

  it.each([
    ["no_api_key", /sem chave da anthropic/i],
    ["request_failed", /a ia não conseguiu/i],
  ] as const)("sem explicação automática (%s), o aviso diz o porquê", async (reason, expectedText) => {
    renderNotice([{ ...MEDIDOR, details: { ...MEDIDOR.details!, narrativeUnavailable: reason } }]);
    await userEvent.click(await screen.findByRole("button", { name: /ver detalhes/i }));
    expect(within(await screen.findByRole("dialog")).getByText(expectedText)).toBeTruthy();
  });

  it("aviso sem detalhes não mostra a seção técnica", async () => {
    const { details: _details, ...withoutDetails } = MEDIDOR;
    renderNotice([withoutDetails]);
    await userEvent.click(await screen.findByRole("button", { name: /ver detalhes/i }));
    await screen.findByRole("dialog");
    expect(screen.queryByText(/detalhes técnicos/i)).toBeNull();
  });

  it("dono investiga pelo aviso do card", async () => {
    signInAs("owner");
    post.mockResolvedValueOnce({ failure: { ...MEDIDOR, status: "investigating" }, card: { id: "fix-1", projectId: "p-vh", title: "Falha da plataforma: medidor" } });
    renderNotice([MEDIDOR]);
    await userEvent.click(await screen.findByRole("button", { name: /ver detalhes/i }));
    await userEvent.click(await screen.findByRole("button", { name: /investigar e corrigir/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/platform-failures/f-medidor/investigate"));
  });

  it("dono descarta pelo aviso do card", async () => {
    signInAs("owner");
    post.mockResolvedValueOnce({ failure: { ...MEDIDOR, status: "dismissed" } });
    renderNotice([MEDIDOR]);
    await userEvent.click(await screen.findByRole("button", { name: /ver detalhes/i }));
    await userEvent.click(await screen.findByRole("button", { name: /não é bug/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/platform-failures/f-medidor/dismiss"));
  });

  it("'agora não' esconde o aviso até o status da falha mudar", async () => {
    const { rerender } = renderNotice([MEDIDOR]);
    await userEvent.click(await screen.findByRole("button", { name: /agora não/i }));
    expect(screen.queryByText(MEDIDOR.explanation!)).toBeNull();
    rerender(<CardFailureNotice cardId="card-1" notices={[{ ...MEDIDOR }]} />);
    expect(screen.queryByText(MEDIDOR.explanation!)).toBeNull();
    rerender(<CardFailureNotice cardId="card-1" notices={[{ ...MEDIDOR, status: "investigating" }]} />);
    expect(await screen.findByText(MEDIDOR.explanation!)).toBeTruthy();
    expect(screen.getByText(/em investigação/i)).toBeTruthy();
  });

  it("'agora não' num card não esconde o aviso em outro card", async () => {
    const first = renderNotice([MEDIDOR], "card-1");
    await userEvent.click(await screen.findByRole("button", { name: /agora não/i }));
    first.unmount();
    renderNotice([MEDIDOR], "card-2");
    expect(await screen.findByText(MEDIDOR.explanation!)).toBeTruthy();
  });

  it("o diálogo não reabre sozinho quando um aviso novo chega depois de o último sumir", async () => {
    const { rerender } = renderNotice([MEDIDOR]);
    await userEvent.click(await screen.findByRole("button", { name: /ver detalhes/i }));
    await screen.findByRole("dialog");
    rerender(<CardFailureNotice cardId="card-1" notices={[]} />);
    rerender(<CardFailureNotice cardId="card-1" notices={[{ ...MEDIDOR, id: "f-novo", explanation: "Outro problema." }]} />);
    expect(await screen.findByText("Outro problema.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("mais de um aviso mostra o mais recente e quantos outros há", async () => {
    const older = { ...MEDIDOR, id: "f-velho", explanation: "Aviso mais antigo.", firstSeenAt: 1_000 };
    renderNotice([MEDIDOR, older]);
    expect(await screen.findByText(MEDIDOR.explanation!)).toBeTruthy();
    expect(screen.queryByText("Aviso mais antigo.")).toBeNull();
    expect(screen.getByText("+1")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /ver detalhes/i }));
    expect(await screen.findByText("Aviso mais antigo.")).toBeTruthy();
  });
});

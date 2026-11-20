import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { CardWaitNotice } from "./CardWaitNotice";
import { del, post } from "@/lib/api";
import { testQueryClient } from "@/test/render";
import type { CardWait } from "@/api/types";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const WAIT: CardWait = { cardId: "target", instruction: "faça o PR complementar", createdAt: 1, createdBy: "user-1" };

function renderNotice(wait: CardWait, waitTargetTitle?: string) {
  const queryClient = testQueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <CardWaitNotice cardId="waiting" wait={wait} waitTargetTitle={waitTargetTitle} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe("CardWaitNotice", () => {
  it("diz quem o card aguarda e o que fará depois, com o botão de cancelar", () => {
    renderNotice(WAIT, "Captura de falhas");
    expect(screen.getByTestId("card-wait-notice")).toHaveTextContent('This card is waiting for the card "Captura de falhas" to finish');
    expect(screen.getByText(/faça o PR complementar/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel wait" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Wake now" })).toBeNull();
  });

  it("sem acesso ao card esperado fala de outro card, sem o título", () => {
    renderNotice(WAIT);
    expect(screen.getByTestId("card-wait-notice")).toHaveTextContent("This card is waiting for the awaited card to finish");
  });

  it("cancelar chama a rota do card e atualiza o board", async () => {
    vi.mocked(del).mockResolvedValueOnce({ ok: true });
    const { invalidate } = renderNotice(WAIT, "Captura de falhas");
    await userEvent.click(screen.getByRole("button", { name: "Cancel wait" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/cards/waiting/wait"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["board", "cards"] }));
  });

  it("falha ao acordar mostra o motivo e o botão de acordar agora, e o erro da tentativa aparece", async () => {
    vi.mocked(post).mockRejectedValueOnce(Object.assign(new Error("x"), { response: { data: { error: "runner fora do ar" } } }));
    renderNotice({ ...WAIT, readyAt: 2, outcome: "pr_merged", prNumber: 356, failure: { at: 3, reason: "sessão sumiu" } }, "Captura de falhas");
    expect(screen.getByTestId("card-wait-notice")).toHaveTextContent("sessão sumiu");
    await userEvent.click(screen.getByRole("button", { name: "Wake now" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/cards/waiting/wait/fire"));
    expect(await screen.findByRole("alert")).toHaveTextContent("runner fora do ar");
  });

  it("acordar agora que falha pelo mesmo motivo já mostrado não repete o motivo", async () => {
    vi.mocked(post).mockRejectedValueOnce(Object.assign(new Error("x"), { response: { data: { error: "sessão sumiu" } } }));
    renderNotice({ ...WAIT, readyAt: 2, outcome: "concluded", failure: { at: 3, reason: "sessão sumiu" } }, "Captura de falhas");
    await userEvent.click(screen.getByRole("button", { name: "Wake now" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Wake now" })).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("card esperado terminou e o card está pausado: avisa que continua ao sair de Pausado", () => {
    renderNotice({ ...WAIT, readyAt: 2, outcome: "concluded" }, "Captura de falhas");
    expect(screen.getByTestId("card-wait-notice")).toHaveTextContent(/leaves Paused/);
    expect(screen.queryByRole("button", { name: "Wake now" })).toBeNull();
  });
});

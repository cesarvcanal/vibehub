import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { apiReject, renderApp } from "@/test/render";
import type { PlatformFailure } from "@/api/types";
import { PLATFORM_FAILURES_KEY } from "../api";
import { PlatformFailuresButton } from "./PlatformFailuresButton";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  get: (...args: unknown[]) => get(...args),
  post: (...args: unknown[]) => post(...args),
}));
const toastCall = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign((...args: unknown[]) => toastCall(...args), {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  }),
}));

function deferred<Value>() {
  const handlers: { resolve?: (value: Value) => void; reject?: (reason: unknown) => void } = {};
  const promise = new Promise<Value>((resolve, reject) => Object.assign(handlers, { resolve, reject }));
  return { promise, resolve: (value: Value) => handlers.resolve!(value), reject: (reason: unknown) => handlers.reject!(reason) };
}

const INVESTIGATION = { failure: { ...{ id: "f1" }, status: "investigating", investigationCardId: "fix-1" }, card: { id: "fix-1", projectId: "p-vh", title: "Falha da plataforma: x" } };

const FAILURE = {
  id: "f1", signature: "backend_error|services/sdk/manager|logo após um stop do usuário: write after end",
  source: "backend_error", status: "open", component: "services/sdk/manager",
  symptom: "logo após um stop do usuário: write after end",
  evidence: "mensagem: write after end\nat writeToDriver (services/sdk/manager.ts:1339:5)",
  occurrences: 3, affectedCardIds: ["c1"], firstSeenAt: 0, lastSeenAt: 0,
} satisfies PlatformFailure;

const setFailuresResponse = (buildFailuresResponse: () => Promise<{ failures: PlatformFailure[] }>) => {
  get.mockImplementation(async (url: string) => {
    if (url === "/platform-failures") return buildFailuresResponse();
    throw new Error(`unexpected GET ${url}`);
  });
};
const setServedFailures = (failures: PlatformFailure[]) => setFailuresResponse(async () => ({ failures }));
const setFailuresRequestToFail = () => setFailuresResponse(async () => { throw apiReject(502, "bad gateway"); });
const refetchFailures = (queryClient: QueryClient) => queryClient.refetchQueries({ queryKey: PLATFORM_FAILURES_KEY });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  setServedFailures([FAILURE]);
});

describe("PlatformFailuresButton", () => {
  it("não mostra nada quando não há falha", async () => {
    setServedFailures([]);
    const { queryClient, container } = renderApp(<PlatformFailuresButton />);
    await waitFor(() => expect(queryClient.getQueryState(PLATFORM_FAILURES_KEY)?.status).toBe("success"));
    expect(container).toBeEmptyDOMElement();
  });

  it("lista que não carrega avisa o dono em vez de parecer que não há falha", async () => {
    setFailuresRequestToFail();
    renderApp(<PlatformFailuresButton />);
    expect(await screen.findByText(/could not load vibehub's failures|não deu pra carregar as falhas do vibehub/i)).toBeTruthy();
  });

  it("poll que falha depois de uma lista vazia avisa o dono em vez de parecer que não há falha", async () => {
    setServedFailures([]);
    const { queryClient } = renderApp(<PlatformFailuresButton />);
    await waitFor(() => expect(queryClient.getQueryState(PLATFORM_FAILURES_KEY)?.status).toBe("success"));
    setFailuresRequestToFail();
    await refetchFailures(queryClient);
    expect(await screen.findByText(/could not load vibehub's failures|não deu pra carregar as falhas do vibehub/i)).toBeTruthy();
  });

  it("poll que falha com falhas em cache avisa ao lado do indicador, sem tirar a lista", async () => {
    const { queryClient } = renderApp(<PlatformFailuresButton />);
    await screen.findByRole("button", { name: /1/ });
    setFailuresRequestToFail();
    await refetchFailures(queryClient);
    expect(await screen.findByText(/could not load vibehub's failures|não deu pra carregar as falhas do vibehub/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /1/ })).toBeTruthy();
  });

  it("dispensar a última falha com o relato aberto não reabre o relato quando chega outra falha", async () => {
    const { queryClient } = renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    post.mockResolvedValueOnce({ failure: { ...FAILURE, status: "dismissed" } });
    setServedFailures([]);
    await userEvent.click(await screen.findByRole("button", { name: /não é bug|not a bug/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    setServedFailures([{ ...FAILURE, id: "f2" }]);
    await refetchFailures(queryClient);
    await screen.findByRole("button", { name: /1/, hidden: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("um poll que falha com o relato aberto mantém o relato na tela", async () => {
    const { queryClient } = renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    await screen.findByText("logo após um stop do usuário: write after end");
    setFailuresRequestToFail();
    await refetchFailures(queryClient);
    await waitFor(() => expect(queryClient.getQueryState(PLATFORM_FAILURES_KEY)?.status).toBe("error"));
    expect(screen.getByText("logo após um stop do usuário: write after end")).toBeTruthy();
  });

  it("mostra a contagem e abre o relato, sem anunciar: o aviso é do PlatformFailuresAnnouncer, montado em qualquer tela", async () => {
    renderApp(<PlatformFailuresButton />);
    const indicator = await screen.findByRole("button", { name: /1/ });
    await userEvent.click(indicator);
    expect(await screen.findByText("logo após um stop do usuário: write after end")).toBeTruthy();
    expect(screen.getByText(/write after end/, { selector: "pre" })).toBeTruthy();
    expect(toastCall).not.toHaveBeenCalled();
  });

  it("investigar manda o pedido do relato aberto", async () => {
    post.mockResolvedValueOnce({ failure: { ...FAILURE, status: "investigating", investigationCardId: "fix-1" }, card: { id: "fix-1", projectId: "p-vh", title: "Falha da plataforma: x" } });
    renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    await userEvent.click(await screen.findByRole("button", { name: /investigar|investigate/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/platform-failures/f1/investigate"));
  });

  it("falha em investigação ainda oferece investigar de novo, a saída quando o card sumiu", async () => {
    setServedFailures([{ ...FAILURE, status: "investigating", investigationCardId: "fix-1" }]);
    post.mockResolvedValueOnce({ failure: { ...FAILURE, status: "investigating", investigationCardId: "fix-2" }, card: { id: "fix-2", projectId: "p-vh", title: "Falha da plataforma: x" } });
    renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    await userEvent.click(await screen.findByRole("button", { name: /investigar de novo|investigate again/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/platform-failures/f1/investigate"));
  });

  it("mostra o texto leigo e guarda o técnico em detalhes recolhíveis", async () => {
    setServedFailures([{ ...FAILURE, explanation: "O medidor de uso mostrou a conta Claude anterior." }]);
    renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    expect(await screen.findByText("O medidor de uso mostrou a conta Claude anterior.")).toBeTruthy();
    expect(screen.getByText(/write after end/, { selector: "pre" }).closest("details")).toBeTruthy();
  });

  it("erro do back sem explicação mostra o texto leigo do erro interno", async () => {
    renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    expect(await screen.findByText(/erro interno|internal error/i)).toBeTruthy();
  });

  it("'não é bug' manda o descarte", async () => {
    post.mockResolvedValueOnce({ failure: { ...FAILURE, status: "dismissed" } });
    renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    await userEvent.click(await screen.findByRole("button", { name: /não é bug|not a bug/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/platform-failures/f1/dismiss"));
  });

  it("investigar mostra que está abrindo o card, esmaece o item e trava as ações até o back responder", async () => {
    const pendingInvestigation = deferred<unknown>();
    post.mockReturnValueOnce(pendingInvestigation.promise);
    renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    await userEvent.click(await screen.findByRole("button", { name: /investigar e corrigir|investigate and fix/i }));
    const busyButton = await screen.findByRole("button", { name: /abrindo o card da investigação|opening the investigation card/i });
    expect(busyButton).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /não é bug|not a bug/i })).toHaveProperty("disabled", true);
    expect(busyButton.closest("li")?.getAttribute("aria-busy")).toBe("true");
    setServedFailures([]);
    pendingInvestigation.resolve(INVESTIGATION);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("Falha da plataforma: x"),
      expect.objectContaining({ action: expect.objectContaining({ label: expect.stringMatching(/abrir card|open card/i) }) }),
    ));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("'não é bug' mostra o mesmo carregando enquanto o back responde", async () => {
    const pendingDismissal = deferred<unknown>();
    post.mockReturnValueOnce(pendingDismissal.promise);
    renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    await userEvent.click(await screen.findByRole("button", { name: /não é bug|not a bug/i }));
    const busyButton = await screen.findByRole("button", { name: /marcando como não é bug|marking as not a bug/i });
    expect(busyButton.closest("li")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: /investigar e corrigir|investigate and fix/i })).toHaveProperty("disabled", true);
    pendingDismissal.resolve({ failure: { ...FAILURE, status: "dismissed" } });
    await waitFor(() => expect(busyButton.closest("li")?.getAttribute("aria-busy")).not.toBe("true"));
  });

  it("investigação que falha devolve o item ao normal e mostra o erro", async () => {
    post.mockRejectedValueOnce(apiReject(500, "runner down"));
    renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    await userEvent.click(await screen.findByRole("button", { name: /investigar e corrigir|investigate and fix/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const investigateButton = screen.getByRole("button", { name: /investigar e corrigir|investigate and fix/i });
    expect(investigateButton).toHaveProperty("disabled", false);
    expect(investigateButton.closest("li")?.getAttribute("aria-busy")).not.toBe("true");
  });
});

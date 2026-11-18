import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { renderApp } from "@/test/render";
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
vi.mock("sonner", () => ({ toast: Object.assign((...args: unknown[]) => toastCall(...args), { success: vi.fn(), error: vi.fn() }) }));

const FAILURE = {
  id: "f1", signature: "backend_error|services/sdk/manager|logo após um stop do usuário: write after end",
  source: "backend_error", status: "open", component: "services/sdk/manager",
  symptom: "logo após um stop do usuário: write after end",
  evidence: "mensagem: write after end\nat writeToDriver (services/sdk/manager.ts:1339:5)",
  occurrences: 3, affectedCardIds: ["c1"], firstSeenAt: 0, lastSeenAt: 0,
} satisfies PlatformFailure;

function answerFailuresList(answerFailures: () => Promise<{ failures: PlatformFailure[] }>) {
  get.mockImplementation(async (url: string) => {
    if (url === "/platform-failures") return await answerFailures();
    throw new Error(`unexpected GET ${url}`);
  });
}

const serveFailures = (failures: PlatformFailure[]) => answerFailuresList(async () => ({ failures }));
const failFailuresRequest = () => answerFailuresList(async () => { throw new Error("502"); });
const refetchFailures = (queryClient: QueryClient) => queryClient.refetchQueries({ queryKey: PLATFORM_FAILURES_KEY });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  serveFailures([FAILURE]);
});

describe("PlatformFailuresButton", () => {
  it("não mostra nada quando não há falha", async () => {
    serveFailures([]);
    renderApp(<PlatformFailuresButton />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/platform-failures"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lista que não carrega avisa o dono em vez de parecer que não há falha", async () => {
    failFailuresRequest();
    renderApp(<PlatformFailuresButton />);
    expect(await screen.findByText(/could not load vibehub's failures|não deu pra carregar as falhas do vibehub/i)).toBeTruthy();
  });

  it("poll que falha depois de uma lista vazia avisa o dono em vez de parecer que não há falha", async () => {
    serveFailures([]);
    const { queryClient } = renderApp(<PlatformFailuresButton />);
    await waitFor(() => expect(queryClient.getQueryState(PLATFORM_FAILURES_KEY)?.status).toBe("success"));
    failFailuresRequest();
    await refetchFailures(queryClient);
    expect(await screen.findByText(/could not load vibehub's failures|não deu pra carregar as falhas do vibehub/i)).toBeTruthy();
  });

  it("poll que falha com falhas em cache avisa ao lado do indicador, sem tirar a lista", async () => {
    const { queryClient } = renderApp(<PlatformFailuresButton />);
    await screen.findByRole("button", { name: /1/ });
    failFailuresRequest();
    await refetchFailures(queryClient);
    expect(await screen.findByText(/could not load vibehub's failures|não deu pra carregar as falhas do vibehub/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /1/ })).toBeTruthy();
  });

  it("dispensar a última falha com o relato aberto não reabre o relato quando chega outra falha", async () => {
    const { queryClient } = renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    post.mockResolvedValueOnce({ failure: { ...FAILURE, status: "dismissed" } });
    serveFailures([]);
    await userEvent.click(await screen.findByRole("button", { name: /não é bug|not a bug/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    serveFailures([{ ...FAILURE, id: "f2" }]);
    await refetchFailures(queryClient);
    await screen.findByRole("button", { name: /1/, hidden: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("um poll que falha com o relato aberto mantém o relato na tela", async () => {
    const { queryClient } = renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    await screen.findByText("logo após um stop do usuário: write after end");
    failFailuresRequest();
    await refetchFailures(queryClient);
    await waitFor(() => expect(queryClient.getQueryState(PLATFORM_FAILURES_KEY)?.status).toBe("error"));
    expect(screen.getByText("logo após um stop do usuário: write after end")).toBeTruthy();
  });

  it("mostra a contagem, anuncia a falha nova uma vez e abre o relato", async () => {
    renderApp(<PlatformFailuresButton />);
    const indicator = await screen.findByRole("button", { name: /1/ });
    await waitFor(() => expect(toastCall).toHaveBeenCalledTimes(1));
    await userEvent.click(indicator);
    expect(await screen.findByText("logo após um stop do usuário: write after end")).toBeTruthy();
    expect(screen.getByText(/write after end/, { selector: "pre" })).toBeTruthy();
  });

  it("não anuncia de novo a mesma falha quando o board é montado outra vez na sessão", async () => {
    const firstBoard = renderApp(<PlatformFailuresButton />);
    await waitFor(() => expect(toastCall).toHaveBeenCalledTimes(1));
    firstBoard.unmount();
    renderApp(<PlatformFailuresButton />);
    await screen.findByRole("button", { name: /1/ });
    expect(toastCall).toHaveBeenCalledTimes(1);
  });

  it("investigar manda o pedido do relato aberto", async () => {
    post.mockResolvedValueOnce({ failure: { ...FAILURE, status: "investigating", investigationCardId: "fix-1" }, card: { id: "fix-1", projectId: "p-vh", title: "Falha da plataforma: x" } });
    renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    await userEvent.click(await screen.findByRole("button", { name: /investigar|investigate/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/platform-failures/f1/investigate"));
  });

  it("falha em investigação ainda oferece investigar de novo, a saída quando o card sumiu", async () => {
    serveFailures([{ ...FAILURE, status: "investigating", investigationCardId: "fix-1" }]);
    post.mockResolvedValueOnce({ failure: { ...FAILURE, status: "investigating", investigationCardId: "fix-2" }, card: { id: "fix-2", projectId: "p-vh", title: "Falha da plataforma: x" } });
    renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    await userEvent.click(await screen.findByRole("button", { name: /investigar de novo|investigate again/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/platform-failures/f1/investigate"));
  });

  it("'não é bug' manda o descarte", async () => {
    post.mockResolvedValueOnce({ failure: { ...FAILURE, status: "dismissed" } });
    renderApp(<PlatformFailuresButton />);
    await userEvent.click(await screen.findByRole("button", { name: /1/ }));
    await userEvent.click(await screen.findByRole("button", { name: /não é bug|not a bug/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/platform-failures/f1/dismiss"));
  });
});

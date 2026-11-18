import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
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
  id: "f1", source: "backend_error", status: "open", component: "services/sdk/manager",
  symptom: "ao interromper: write after end", evidence: "erro: write after end",
  occurrences: 3, affectedCardIds: ["c1"], firstSeenAt: 0, lastSeenAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  get.mockImplementation(async (url: string) => {
    if (url === "/platform-failures") return { failures: [FAILURE] };
    throw new Error(`unexpected GET ${url}`);
  });
});

describe("PlatformFailuresButton", () => {
  it("não mostra nada quando não há falha", async () => {
    get.mockResolvedValueOnce({ failures: [] });
    renderApp(<PlatformFailuresButton />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/platform-failures"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lista que não carrega avisa o dono em vez de parecer que não há falha", async () => {
    get.mockRejectedValue(new Error("500"));
    renderApp(<PlatformFailuresButton />);
    expect(await screen.findByText(/could not load vibehub's failures|não deu pra carregar as falhas do vibehub/i)).toBeTruthy();
  });

  it("mostra a contagem, anuncia a falha nova uma vez e abre o relato", async () => {
    renderApp(<PlatformFailuresButton />);
    const indicator = await screen.findByRole("button", { name: /1/ });
    await waitFor(() => expect(toastCall).toHaveBeenCalledTimes(1));
    await userEvent.click(indicator);
    expect(await screen.findByText("ao interromper: write after end")).toBeTruthy();
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
    get.mockResolvedValue({ failures: [{ ...FAILURE, status: "investigating", investigationCardId: "fix-1" }] });
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

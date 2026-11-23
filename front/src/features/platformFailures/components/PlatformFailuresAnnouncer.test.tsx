import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { renderApp } from "@/test/render";
import type { PlatformFailure } from "@/api/types";
import { PlatformFailuresAnnouncer } from "./PlatformFailuresAnnouncer";

const get = vi.fn();
vi.mock("@/lib/api", () => ({
  get: (...args: unknown[]) => get(...args),
  post: vi.fn(),
}));
const toastCall = vi.fn();
vi.mock("sonner", () => ({ toast: Object.assign((...args: unknown[]) => toastCall(...args), { success: vi.fn(), error: vi.fn() }) }));

const FAILURE = {
  id: "f1", signature: "backend_error|services/maestro/deliver|deliver failed: merge_failed",
  source: "backend_error", status: "open", component: "services/maestro/deliver",
  symptom: "deliver failed: merge_failed: GraphQL: Base branch was modified",
  evidence: "mensagem: deliver failed", occurrences: 1, affectedCardIds: [], firstSeenAt: 0, lastSeenAt: 0,
} satisfies PlatformFailure;

function serveFailures(failures: PlatformFailure[]) {
  get.mockImplementation(async (url: string) => {
    if (url === "/platform-failures") return { failures };
    throw new Error(`unexpected GET ${url}`);
  });
}

function readToastAction(): { label: string; onClick: () => void } {
  const [, options] = toastCall.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
  return options.action;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  serveFailures([FAILURE]);
});

describe("PlatformFailuresAnnouncer", () => {
  it("anuncia a falha nova uma vez, e o 'Ver' do aviso abre o relato ali mesmo, sem botão na tela", async () => {
    renderApp(<PlatformFailuresAnnouncer />);
    await waitFor(() => expect(toastCall).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button")).toBeNull();
    act(() => readToastAction().onClick());
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("deliver failed: merge_failed: GraphQL: Base branch was modified")).toBeTruthy();
  });

  it("não anuncia de novo a mesma falha quando a tela é montada outra vez na sessão", async () => {
    const firstMount = renderApp(<PlatformFailuresAnnouncer />);
    await waitFor(() => expect(toastCall).toHaveBeenCalledTimes(1));
    firstMount.unmount();
    const { queryClient } = renderApp(<PlatformFailuresAnnouncer />);
    await waitFor(() => expect(queryClient.getQueryState(["platform-failures"])?.status).toBe("success"));
    expect(toastCall).toHaveBeenCalledTimes(1);
  });

  it("o aviso de uma falha nova diz o que aconteceu em linguagem leiga", async () => {
    serveFailures([{ ...FAILURE, explanation: "O medidor de uso mostrou a conta Claude anterior." }]);
    renderApp(<PlatformFailuresAnnouncer />);
    await waitFor(() => expect(toastCall).toHaveBeenCalledWith(expect.stringContaining("O medidor de uso mostrou a conta Claude anterior."), expect.anything()));
  });

  it("sem falha não anuncia nada", async () => {
    serveFailures([]);
    const { queryClient } = renderApp(<PlatformFailuresAnnouncer />);
    await waitFor(() => expect(queryClient.getQueryState(["platform-failures"])?.status).toBe("success"));
    expect(toastCall).not.toHaveBeenCalled();
  });
});

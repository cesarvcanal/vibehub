import { beforeEach, describe, it, expect, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CardOutbox, agentCopyKey } from "./CardOutbox";
import { del, get } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    dismiss: vi.fn(),
  }),
}));

const mockGet = vi.mocked(get);
const mockDel = vi.mocked(del);

function renderOutbox(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(ui, { wrapper: Wrapper });
}

beforeEach(() => vi.resetAllMocks());

describe("agentCopyKey", () => {
  it("says WHY it is waiting, because the fix is different in each case", () => {
    expect(agentCopyKey("none")).toBe("outbox.waitingSession");
    expect(agentCopyKey("shell")).toBe("outbox.waitingAgent");
    expect(agentCopyKey("running")).toBe("outbox.waitingDelivery");
    expect(agentCopyKey(undefined)).toBe("outbox.waitingDelivery");
  });
});

describe("CardOutbox", () => {
  it("renders NOTHING when the queue is empty — which is almost always", async () => {
    mockGet.mockResolvedValue({ pending: [], agent: "running" });
    renderOutbox(<CardOutbox cardId="c1" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/cards/c1/messages"));
    expect(screen.queryByTestId("card-outbox")).not.toBeInTheDocument();
  });

  it("shows what is waiting, and says the agent is not running in there", async () => {
    mockGet.mockResolvedValue({
      pending: [
        { id: "m1", text: "run the tests", createdAt: 1, attempts: 0 },
        { id: "m2", text: "then open a PR", createdAt: 2, attempts: 0 },
      ],
      agent: "shell",
    });
    renderOutbox(<CardOutbox cardId="c1" />);

    const messages = await screen.findAllByTestId("card-outbox-message");
    expect(messages.map((m) => m.textContent)).toEqual(["run the tests", "then open a PR"]);
    expect(screen.getByTestId("card-outbox").textContent).toMatch(/Claude is not running/i);
  });

  it("drops one message from the queue", async () => {
    mockGet.mockResolvedValue({
      pending: [{ id: "m1", text: "never mind", createdAt: 1, attempts: 0 }],
      agent: "none",
    });
    mockDel.mockResolvedValue({ ok: true });
    renderOutbox(<CardOutbox cardId="c1" />);

    await userEvent.click(await screen.findByTestId("card-outbox-cancel"));
    expect(mockDel).toHaveBeenCalledWith("/cards/c1/messages/m1");
  });
});

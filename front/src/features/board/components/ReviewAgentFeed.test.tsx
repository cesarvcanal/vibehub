import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReviewAgentFeed } from "@/features/board/components/ReviewAgentFeed";
import { testQueryClient } from "@/test/render";

const get = vi.fn();
vi.mock("@/lib/api", () => ({ get: (...args: unknown[]) => get(...args) }));

const AGENT = { cardId: "c1", runId: "wf_abc12", agentId: "a01f" };
const FEED_URL = "/cards/c1/review/agents/wf_abc12/a01f/feed";

describe("ReviewAgentFeed", () => {
  it("quando o agente termina com o passo a passo aberto, lê de novo e mostra os passos finais", async () => {
    get.mockResolvedValueOnce({ items: [{ at: 1, kind: "text", text: "Lendo o fluxo." }] });
    get.mockResolvedValueOnce({ items: [{ at: 1, kind: "text", text: "Lendo o fluxo." }, { at: 2, kind: "text", text: "Concluí: sem achados." }] });
    const queryClient = testQueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ReviewAgentFeed agent={{ ...AGENT, running: true }} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Lendo o fluxo.")).toBeInTheDocument();
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ReviewAgentFeed agent={{ ...AGENT, running: false, endedAt: 3 }} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Concluí: sem achados.")).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith(FEED_URL);
  });

  it("o pensamento que fechou a vida do agente dura até o fim dele, não zero", async () => {
    get.mockResolvedValueOnce({ items: [{ at: 1_000, kind: "thinking" }] });
    render(
      <QueryClientProvider client={testQueryClient()}>
        <ReviewAgentFeed agent={{ ...AGENT, running: false, endedAt: 13_000 }} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/12s/)).toBeInTheDocument();
  });
});

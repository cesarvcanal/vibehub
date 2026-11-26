import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import type { ReviewFleetAgent, ReviewFleetRun } from "@/api/types";
import { FleetChat } from "@/features/board/components/FleetChat";
import { reviewFleetChat } from "@/features/board/lib/fleetChat";

function fleetAgent(agent: Pick<ReviewFleetAgent, "id" | "label"> & Partial<ReviewFleetAgent>): ReviewFleetAgent {
  return { phase: "", status: "done", endedAt: 1, result: "ok", ...agent };
}

function renderFleet(agents: ReviewFleetAgent[]) {
  const run: ReviewFleetRun = { runId: "wf_1", name: "revisao", phases: [], total: agents.length, done: agents.length, agents, at: 1, finished: true };
  render(<FleetChat entries={reviewFleetChat(run)} label="Conversa dos agentes" />);
  return screen.getAllByTestId("fleet-chat-message");
}

describe("FleetChat", () => {
  it("dois agentes do mesmo modelo em papéis diferentes têm cores diferentes", () => {
    const [correctness, security] = renderFleet([
      fleetAgent({ id: "a1", label: "revisão:correctness", model: "sonnet" }),
      fleetAgent({ id: "a2", label: "revisão:security", model: "sonnet" }),
    ]);
    const toneOf = (bubble: HTMLElement) => bubble.closest("li")!.querySelector("[data-tone]")!.getAttribute("data-tone");
    expect(toneOf(correctness!)).toBe("correctness");
    expect(toneOf(security!)).toBe("security");
  });

  it("a consolidação dos achados aparece com o nome e a cor do papel dela, e fala os defeitos que juntou", () => {
    const [bubble] = renderFleet([
      fleetAgent({ id: "a1", label: "consolidação", model: "opus", result: JSON.stringify({ findings: [{ title: "embalagem travada só na tela", members: ["c1", "c3"] }] }) }),
    ]);
    expect(within(bubble!).getByText("Consolidation")).toBeInTheDocument();
    expect(within(bubble!).getByText("embalagem travada só na tela")).toBeInTheDocument();
    expect(bubble!.closest("li")!.querySelector("[data-tone]")).toHaveAttribute("data-tone", "consolidation");
  });

  it("verificações da mesma dimensão saem numeradas, com o avatar vazado", () => {
    const [, first, second] = renderFleet([
      fleetAgent({ id: "a1", label: "revisão:correctness", model: "sonnet" }),
      fleetAgent({ id: "a2", label: "verificação:correctness · A", model: "sonnet", endedAt: 2 }),
      fleetAgent({ id: "a3", label: "verificação:correctness · B", model: "sonnet", endedAt: 3 }),
    ]);
    expect(within(first!).getByText("Correctness check #1")).toBeInTheDocument();
    expect(within(second!).getByText("Correctness check #2")).toBeInTheDocument();
    expect(second!.closest("li")!.querySelector("[data-tone]")).toHaveAttribute("data-verification", "true");
  });

  it("o modelo aparece ao lado do nome do agente como texto simples, sem selo com borda nem fundo", () => {
    const [bubble] = renderFleet([fleetAgent({ id: "a1", label: "contexto", model: "opus" })]);
    const model = within(bubble!).getByTestId("fleet-chat-model");
    expect(model).toHaveTextContent("opus");
    expect(model.className).not.toMatch(/\bborder\b|\bbg-/);
  });

  it("o modelo mostra a versão que respondeu quando o servidor a conhece", () => {
    const [bubble] = renderFleet([fleetAgent({ id: "a1", label: "contexto", model: "claude-sonnet-5-5", modelLabel: "Sonnet 5.5" })]);
    expect(within(bubble!).getByTestId("fleet-chat-model")).toHaveTextContent("Sonnet 5.5");
  });

  it("abrir o passo a passo de dois agentes no mesmo instante deixa os dois abertos", () => {
    const run: ReviewFleetRun = {
      runId: "wf_1", name: "revisao", phases: [], total: 2, done: 0, at: 1, finished: false,
      agents: [fleetAgent({ id: "a1", label: "juiz", status: "running" }), fleetAgent({ id: "a2", label: "contexto", status: "running" })],
    };
    render(<FleetChat entries={reviewFleetChat(run)} label="Conversa dos agentes" agentDetail={({ agentId }) => <p>passos de {agentId}</p>} />);
    const [judge, context] = screen.getAllByRole("button", { expanded: false });
    act(() => {
      judge!.click();
      context!.click();
    });
    expect(screen.getByText("passos de a1")).toBeInTheDocument();
    expect(screen.getByText("passos de a2")).toBeInTheDocument();
  });

  it("a fala que chega com o chat aberto entra animada; a que já estava na tela fica parada", () => {
    const runWith = (agents: ReviewFleetAgent[]): ReviewFleetRun => ({
      runId: "wf_1", name: "revisao", phases: [], total: 2, done: agents.length, agents, at: 1, finished: false,
    });
    const context = fleetAgent({ id: "a1", label: "contexto" });
    const judge = fleetAgent({ id: "a2", label: "juiz", endedAt: 2 });
    const { rerender } = render(<FleetChat entries={reviewFleetChat(runWith([context]))} label="Conversa dos agentes" />);
    rerender(<FleetChat entries={reviewFleetChat(runWith([context, judge]))} label="Conversa dos agentes" />);
    const [already, arrived] = screen.getAllByTestId("fleet-chat-message").map((bubble) => bubble.closest("li")!);
    expect(already).toHaveAttribute("data-arrived", "false");
    expect(arrived).toHaveAttribute("data-arrived", "true");
  });
});

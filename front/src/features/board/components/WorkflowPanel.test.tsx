import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { FEED_RETRY_MAX, WorkflowPanel } from "@/features/board/components/WorkflowPanel";
import { WorkflowFeedContext, createWorkflowFeedChannel } from "@/features/board/lib/workflowFeed";
import type { SdkRow, WorkflowAgentFrame, WorkflowFeedItem } from "@/features/board/lib/sdkChat";
import { resetLanguage, setLanguage } from "@/i18n";

type WorkflowRow = Extract<SdkRow, { kind: "workflow" }>;

const T0 = Date.parse("2026-10-14T12:00:00.000Z");

const agent = (id: string, over: Partial<WorkflowAgentFrame> = {}): WorkflowAgentFrame => ({
  id, label: `rótulo ${id}`, status: "running", ...over,
});

function workflowRow(over: Partial<WorkflowRow> = {}): WorkflowRow {
  const agents = over.agents ?? [];
  return {
    kind: "workflow",
    id: "wf:wf_abc",
    runId: "wf_abc",
    name: "review-lentidao",
    agents,
    total: agents.length,
    done: agents.filter((a) => a.status === "done").length,
    at: 1,
    finished: false,
    ...over,
  };
}

/** O painel com um canal de feed de verdade, cujo `send` só registra o que a aba pediu. */
function renderPanel(row: WorkflowRow) {
  const sent: Array<{ type: string; runId: string; agentId: string }> = [];
  const channel = createWorkflowFeedChannel((frame) => { sent.push(frame); });
  const ui = (r: WorkflowRow) => (
    <WorkflowFeedContext.Provider value={channel}>
      <WorkflowPanel row={r} />
    </WorkflowFeedContext.Provider>
  );
  const view = render(ui(row));
  const answer = (agentId: string, items: WorkflowFeedItem[], error?: "probe-failed" | "invalid-id") =>
    act(() => channel.deliver({ type: "workflow_feed", runId: row.runId, agentId, items, ...(error ? { error } : {}) }));
  return { sent, answer, rerender: (r: WorkflowRow) => view.rerender(ui(r)) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  setLanguage("pt-BR");
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  act(() => resetLanguage());
});

describe("WorkflowPanel — fases e agentes", () => {
  it("agentes aparecem pelo NOME, agrupados por fase; a fase que não começou diz 'aguardando'", () => {
    renderPanel(workflowRow({
      phases: [{ title: "Varredura" }, { title: "Verificação" }, { title: "Síntese" }],
      agents: [
        agent("a1", { label: "varre:front-render", phase: "Varredura", status: "done", startedAt: T0 - 60_000, endedAt: T0 - 30_000 }),
        agent("a2", { label: "cetico:front-render", phase: "Verificação", startedAt: T0 - 10_000 }),
      ],
    }));
    const groups = screen.getAllByTestId("workflow-phase-group");
    expect(groups.map((g) => g.getAttribute("data-phase"))).toEqual(["Varredura", "Verificação"]);
    expect(within(groups[0]!).getByText("varre:front-render")).toBeInTheDocument();
    expect(within(groups[1]!).getByText("cetico:front-render")).toBeInTheDocument();
    const pills = screen.getAllByTestId("workflow-phase-pill");
    expect(pills.map((p) => p.getAttribute("data-state"))).toEqual(["done", "current", "waiting"]);
    expect(pills[0]).toHaveTextContent("1/1");
    expect(pills[2]).toHaveTextContent(/Síntese.*aguardando/);
    expect(screen.getByTestId("sdk-workflow-count")).toHaveTextContent("1/2 agentes");
  });

  it("o que cada um faz agora: verbo + alvo na ferramenta, 'Pensando há Ns' no raciocínio", () => {
    renderPanel(workflowRow({
      agents: [
        agent("a1", { activity: { kind: "tool", tool: "Read", target: "/w/app.ts" } }),
        agent("a2", { activity: { kind: "tool", tool: "Bash", target: "Roda a suíte do front" } }),
        agent("a3", { activity: { kind: "thinking", since: T0 - 7_000 } }),
        agent("a4", { activity: { kind: "text", text: "Achei 2 problemas" } }),
      ],
    }));
    const now = screen.getAllByTestId("workflow-agent-now").map((n) => n.textContent);
    expect(now).toEqual(["Leu /w/app.ts", "Rodou Roda a suíte do front", "Pensando há 7s…", "Achei 2 problemas"]);
  });
});

describe("WorkflowPanel — tempo e quanto falta", () => {
  it("sem nenhum concluído não há estimativa; com um concluído há; terminado diz em quanto tempo", () => {
    const view = renderPanel(workflowRow({ startedAt: T0 - 60_000, agents: [agent("a1", { startedAt: T0 - 60_000 }), agent("a2", { startedAt: T0 - 60_000 })] }));
    expect(screen.getByTestId("workflow-eta")).toHaveTextContent("Calculando quanto falta…");

    view.rerender(workflowRow({
      startedAt: T0 - 60_000,
      agents: [agent("a1", { status: "done", startedAt: T0 - 60_000, endedAt: T0 - 20_000 }), agent("a2", { startedAt: T0 - 60_000 })],
    }));
    expect(screen.getByTestId("workflow-eta")).toHaveTextContent(/Faltam ~\d+s \(média de 40s por agente\)/);
    expect(screen.getByTestId("workflow-status")).toHaveTextContent("1 trabalhando · 0 na fila");

    view.rerender(workflowRow({
      startedAt: T0 - 60_000, finished: true,
      agents: [agent("a1", { status: "done", startedAt: T0 - 60_000, endedAt: T0 - 20_000 }), agent("a2", { status: "done", startedAt: T0 - 60_000, endedAt: T0 - 5_000 })],
    }));
    expect(screen.getByTestId("workflow-eta")).toHaveTextContent("Concluído em 55s");
  });

  it("o tempo decorrido anda sozinho — e o relógio PARA quando a rodada termina", () => {
    const running = workflowRow({ startedAt: T0 - 5_000, agents: [agent("a1", { startedAt: T0 - 5_000 })] });
    const view = renderPanel(running);
    expect(screen.getByTestId("workflow-elapsed")).toHaveTextContent("Rodando há 5s");
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getByTestId("workflow-elapsed")).toHaveTextContent("Rodando há 8s");
    expect(screen.getAllByTestId("workflow-agent-time")[0]).toHaveTextContent("8s");

    view.rerender({ ...running, finished: true, done: 1, agents: [agent("a1", { status: "done", startedAt: T0 - 5_000, endedAt: T0 + 2_000 })] });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("WorkflowPanel — o feed de um agente, sob demanda", () => {
  const running = () => workflowRow({ agents: [agent("a01f", { label: "varre:back", startedAt: T0 - 30_000, toolCount: 3 }), agent("a02f", { status: "done", result: '{"findings":2}' })] });

  it("abrir pede o feed UMA vez, mostra os itens, re-pede a cada 4s enquanto roda e para ao fechar", () => {
    const { sent, answer } = renderPanel(running());
    expect(sent).toEqual([]); // sob demanda: nada sem abrir
    const head = screen.getAllByTestId("sdk-workflow-agent")[0]!;
    fireEvent.click(head);
    expect(sent).toEqual([{ type: "workflow_feed", runId: "wf_abc", agentId: "a01f" }]);

    answer("a01f", [
      { at: T0 - 20_000, kind: "thinking", text: "segredo do raciocínio" },
      { at: T0 - 8_000, kind: "tool", tool: "Read", target: "/w/manager.ts" },
      { at: T0 - 7_000, kind: "result", text: "conteúdo cru" },
      { at: T0 - 6_000, kind: "text", text: "Achei o debounce" },
    ]);
    const feed = screen.getByTestId("workflow-feed");
    expect(feed).toHaveTextContent("Tarefa: varre:back");
    expect(feed).toHaveTextContent("Pensou por 12s");
    expect(feed).toHaveTextContent("Leu /w/manager.ts");
    expect(feed).toHaveTextContent("Achei o debounce");
    expect(feed).toHaveTextContent("3 ferramentas · começou há 30s");
    expect(feed).not.toHaveTextContent("segredo");
    expect(feed).not.toHaveTextContent("conteúdo cru");

    act(() => { vi.advanceTimersByTime(4_000); });
    expect(sent).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(sent).toHaveLength(3);

    fireEvent.click(head); // fecha
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(sent).toHaveLength(3);
  });

  it("um agente concluído para de pedir depois da primeira resposta; abrir outro fecha o primeiro", () => {
    const { sent, answer } = renderPanel(running());
    const [first, second] = screen.getAllByTestId("sdk-workflow-agent");
    fireEvent.click(second!);
    expect(screen.getByTestId("sdk-workflow-result")).toHaveTextContent("findings: 2");
    expect(sent.filter((f) => f.agentId === "a02f")).toHaveLength(1);
    answer("a02f", [{ at: T0 - 1_000, kind: "text", text: "pronto" }]);
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(sent.filter((f) => f.agentId === "a02f")).toHaveLength(1);
    fireEvent.click(first!);
    expect(screen.getAllByTestId("workflow-feed")).toHaveLength(1);
    expect(second).toHaveAttribute("aria-expanded", "false");
  });

  it("um pedido perdido (socket caindo, back antigo) não deixa o concluído em 'Carregando' para sempre", () => {
    const { sent, answer } = renderPanel(running());
    fireEvent.click(screen.getAllByTestId("sdk-workflow-agent")[1]!);
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(sent.filter((f) => f.agentId === "a02f")).toHaveLength(2);
    answer("a02f", [{ at: T0 - 1_000, kind: "text", text: "pronto" }]);
    expect(screen.getByTestId("workflow-feed")).toHaveTextContent("pronto");
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(sent.filter((f) => f.agentId === "a02f")).toHaveLength(2);
  });

  it("uma falha passageira da sonda não encerra os pedidos de um concluído — a próxima resposta vale", () => {
    const { sent, answer } = renderPanel(running());
    fireEvent.click(screen.getAllByTestId("sdk-workflow-agent")[1]!);
    answer("a02f", [], "probe-failed");
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(sent.filter((f) => f.agentId === "a02f")).toHaveLength(2);
    answer("a02f", [{ at: T0 - 1_000, kind: "text", text: "pronto" }]);
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(sent.filter((f) => f.agentId === "a02f")).toHaveLength(2);
  });

  it("um runner que segue caído não vira pedido eterno: o concluído tenta FEED_RETRY_MAX vezes e para", () => {
    const { sent, answer } = renderPanel(running());
    fireEvent.click(screen.getAllByTestId("sdk-workflow-agent")[1]!);
    for (let i = 0; i < 20; i += 1) {
      answer("a02f", [], "probe-failed");
      act(() => { vi.advanceTimersByTime(4_000); });
    }
    expect(sent.filter((f) => f.agentId === "a02f")).toHaveLength(1 + FEED_RETRY_MAX);
  });

  it("socket caído não gasta o teto: só pedido que SAIU conta, e ao voltar o concluído pede de novo", () => {
    let online = false;
    const sent: Array<{ agentId: string }> = [];
    const channel = createWorkflowFeedChannel((frame) => {
      if (!online) throw new Error("offline");
      sent.push(frame);
    });
    render(
      <WorkflowFeedContext.Provider value={channel}>
        <WorkflowPanel row={running()} />
      </WorkflowFeedContext.Provider>,
    );
    fireEvent.click(screen.getAllByTestId("sdk-workflow-agent")[1]!);
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(sent).toHaveLength(0);
    online = true;
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(sent.filter((f) => f.agentId === "a02f")).toHaveLength(1);
  });

  it("um id recusado (invalid-id) não muda pedindo de novo: um pedido só", () => {
    const { sent, answer } = renderPanel(running());
    fireEvent.click(screen.getAllByTestId("sdk-workflow-agent")[1]!);
    answer("a02f", [], "invalid-id");
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(sent.filter((f) => f.agentId === "a02f")).toHaveLength(1);
  });

  it("toolCountPartial vira '80+'", () => {
    renderPanel(workflowRow({ agents: [agent("a01f", { toolCount: 80, toolCountPartial: true, startedAt: T0 - 1_000 })] }));
    fireEvent.click(screen.getByTestId("sdk-workflow-agent"));
    expect(screen.getByTestId("workflow-feed")).toHaveTextContent("80+ ferramentas");
  });
});

describe("WorkflowPanel — quadro de um back antigo (blue/green)", () => {
  it("sem phases, startedAt, toolCount nem activity ainda desenha", () => {
    renderPanel(workflowRow({ agents: [{ id: "a1", label: "achar bugs", status: "running" }, { id: "a2", label: "", status: "done", result: "ok" }] }));
    expect(screen.getAllByTestId("sdk-workflow-agent")).toHaveLength(2);
    expect(screen.getByText("achar bugs")).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-elapsed")).toBeNull();
    expect(screen.queryAllByTestId("workflow-phase-pill")).toHaveLength(0);
    fireEvent.click(screen.getAllByTestId("sdk-workflow-agent")[0]!);
    expect(screen.getByTestId("workflow-feed")).toHaveTextContent("0 ferramentas");
  });
});

/**
 * Produção, 17/10/2026: o painel ficou horas com spinner em agentes de rodadas que já tinham acabado
 * (uma MORTA, outra abandonada pela sondagem). Quadro terminado não pode girar nem contar tempo.
 */
describe("WorkflowPanel — rodada terminada com agente que nunca respondeu", () => {
  const spinners = () => document.querySelectorAll(".animate-spin").length;

  it("back antigo (agente ainda 'running' num quadro finished): sem spinner, tempo congelado, 'interrompido'", () => {
    renderPanel(workflowRow({
      finished: true,
      startedAt: T0 - 600_000,
      agents: [agent("a1", { startedAt: T0 - 600_000, lastAt: T0 - 540_000 }), agent("a2", { status: "done", startedAt: T0 - 600_000, endedAt: T0 - 590_000 })],
    }));
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(spinners()).toBe(0);
    const [stopped] = screen.getAllByTestId("sdk-workflow-agent");
    expect(within(stopped!).getByTestId("workflow-agent-time")).toHaveTextContent("1m");
    expect(within(stopped!).getByTestId("workflow-agent-now")).toHaveTextContent("interrompido");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(within(stopped!).getByTestId("workflow-agent-time")).toHaveTextContent("1m");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rodada MORTA: o cabeçalho diz 'interrompido' (não 'concluído') e o agente 'stopped' não gira", () => {
    renderPanel(workflowRow({
      finished: true,
      outcome: "killed",
      agents: [agent("a1", { status: "stopped" }), agent("a2", { status: "done", result: "ok" })],
    }));
    const header = screen.getByRole("button", { expanded: false });
    expect(header).toHaveTextContent("interrompido");
    expect(header).not.toHaveTextContent("concluído");
    fireEvent.click(header);
    expect(spinners()).toBe(0);
    expect(screen.getAllByTestId("sdk-workflow-agent")[0]).toHaveAttribute("data-status", "stopped");
  });

  it("abrir o agente interrompido: diz que não vai responder e NÃO fica re-pedindo o feed", () => {
    const { sent, answer } = renderPanel(workflowRow({ finished: true, outcome: "killed", agents: [agent("a1", { status: "stopped" })] }));
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByTestId("sdk-workflow-agent"));
    answer("a1", []);
    expect(screen.getByTestId("sdk-workflow-result")).toHaveTextContent("interrompido");
    expect(screen.getByTestId("sdk-workflow-result")).not.toHaveTextContent("ainda trabalhando");
    expect(spinners()).toBe(0);
    const asked = sent.length;
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(sent.length).toBe(asked);
  });

  it("o tempo de uma rodada interrompida diz 'Interrompido após', não 'Concluído em'", () => {
    renderPanel(workflowRow({
      finished: true,
      outcome: "killed",
      startedAt: T0 - 600_000,
      agents: [agent("a1", { status: "stopped", startedAt: T0 - 600_000, lastAt: T0 - 60_000 })],
    }));
    expect(screen.getByTestId("workflow-eta")).toHaveTextContent("Interrompido após 9m");
    expect(screen.getByTestId("workflow-eta")).not.toHaveTextContent("Concluído");
  });
});

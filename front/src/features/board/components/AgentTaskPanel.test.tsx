import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { AgentTaskPanel } from "./AgentTaskPanel";

const PROMPT = "Revise o diff.\n\n- [ ] Achados\n- [ ] Veredito";

describe("AgentTaskPanel — o placar das entregas diz o que se sabe", () => {
  it.each([
    { scenario: "rodando", report: "", running: true, progress: "2 deliverables, marked when it finishes", hasBar: false },
    { scenario: "relatório marcou", report: "- [x] Achados\n- [ ] Veredito", running: false, progress: "1 of 2 done", hasBar: true },
    { scenario: "relatório não marcou nada", report: "Tudo certo.", running: false, progress: "the report did not mark the list", hasBar: false },
  ])("$scenario", ({ report, running, progress, hasBar }) => {
    const { container } = renderApp(<AgentTaskPanel prompt={PROMPT} report={report} running={running} />);
    expect(screen.getByTestId("sdk-agent-deliverables-progress")).toHaveTextContent(progress);
    expect(container.querySelector(".bg-emerald-400\\/80") !== null).toBe(hasBar);
  });
});

import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAnalysisRereadOnReport } from "./useCardAnalysis";
import type { SdkRow } from "./sdkChat";

function renderWithClient(rows: SdkRow[]) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const hook = renderHook(({ chatRows }: { chatRows: SdkRow[] }) => useAnalysisRereadOnReport("c1", chatRows), {
    wrapper, initialProps: { chatRows: rows },
  });
  return { hook, invalidate };
}

const reportCall = (id: string, finished: boolean) =>
  ({ kind: "tool", id, name: "mcp__vibehub__vibehub_analysis_report", summary: "", ...(finished ? { result: {} } : {}) }) as SdkRow;

describe("releitura da análise pelo chat do card", () => {
  it("quando a ferramenta de relatório volta no chat, a análise do card é relida", () => {
    const { hook, invalidate } = renderWithClient([]);
    hook.rerender({ chatRows: [reportCall("t1", true)] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["card-analysis", "c1"] });
  });

  it("a chamada ainda rodando não relê nada", () => {
    const { hook, invalidate } = renderWithClient([]);
    hook.rerender({ chatRows: [reportCall("t1", false)] });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("abrir o chat de um card que já gravou o relatório não relê de novo a cada render", () => {
    const rows = [reportCall("t1", true)];
    const { hook, invalidate } = renderWithClient(rows);
    hook.rerender({ chatRows: [...rows] });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

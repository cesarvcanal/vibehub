import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAnalysisRereadOnReport } from "./useCardAnalysis";
import type { SdkChatState } from "./sdkChat";

type LiveToolResult = SdkChatState["lastLiveToolResult"];

const REPORT_TOOL = "mcp__vibehub__vibehub_analysis_report";

function renderReread(enabled: boolean) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const hook = renderHook<void, { liveToolResult: LiveToolResult }>(
    ({ liveToolResult }) => useAnalysisRereadOnReport("c1", liveToolResult, { enabled }),
    { wrapper, initialProps: { liveToolResult: undefined } },
  );
  const analysisRereads = () => invalidate.mock.calls.filter(([filters]) => JSON.stringify(filters?.queryKey) === '["card-analysis","c1"]').length;
  return { hook, analysisRereads };
}

describe("releitura da análise pelo resultado ao vivo da ferramenta de relatório", () => {
  it("montar sem resultado ao vivo não relê nada", () => {
    const { analysisRereads } = renderReread(true);
    expect(analysisRereads()).toBe(0);
  });

  it("o resultado ao vivo da ferramenta de relatório relê a análise uma vez, e os renders seguintes não relêem de novo", () => {
    const { hook, analysisRereads } = renderReread(true);
    const reportResult = { id: "t1", name: REPORT_TOOL };
    hook.rerender({ liveToolResult: reportResult });
    hook.rerender({ liveToolResult: reportResult });
    expect(analysisRereads()).toBe(1);
  });

  it("cada novo resultado ao vivo da ferramenta relê de novo", () => {
    const { hook, analysisRereads } = renderReread(true);
    hook.rerender({ liveToolResult: { id: "t1", name: REPORT_TOOL } });
    hook.rerender({ liveToolResult: { id: "t2", name: REPORT_TOOL } });
    expect(analysisRereads()).toBe(2);
  });

  it("o resultado ao vivo de outra ferramenta não relê", () => {
    const { hook, analysisRereads } = renderReread(true);
    hook.rerender({ liveToolResult: { id: "t1", name: "Bash" } });
    expect(analysisRereads()).toBe(0);
  });

  it("fora de um card de análise nada relê", () => {
    const { hook, analysisRereads } = renderReread(false);
    hook.rerender({ liveToolResult: { id: "t1", name: REPORT_TOOL } });
    expect(analysisRereads()).toBe(0);
  });
});

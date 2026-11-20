import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { boardApi } from "@/features/board/api";
import { cardAnalysisKey, isAnalysisReportTool } from "@/features/board/lib/analysis";
import type { SdkChatState } from "@/features/board/lib/sdkChat";

export function useAnalysisRereadOnReport(
  cardId: string, liveToolResult: SdkChatState["lastLiveToolResult"], opts: { enabled: boolean },
): void {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (!opts.enabled || !liveToolResult || !isAnalysisReportTool(liveToolResult.name)) return;
    void queryClient.invalidateQueries({ queryKey: cardAnalysisKey(cardId) });
  }, [queryClient, cardId, opts.enabled, liveToolResult]);
}

const MERGING_REREAD_MS = 5_000;

export function useCardAnalysis(cardId: string, opts: { enabled: boolean; cardWorking?: boolean }) {
  const queryClient = useQueryClient();
  const analysisQuery = useQuery({
    queryKey: cardAnalysisKey(cardId),
    queryFn: () => boardApi.readCardAnalysis(cardId),
    enabled: opts.enabled,
    refetchInterval: (query) => (query.state.data?.analysis && query.state.data.merging ? MERGING_REREAD_MS : false),
  });
  const wasWorking = React.useRef(opts.cardWorking);
  React.useEffect(() => {
    const turnJustEnded = wasWorking.current === true && opts.cardWorking === false;
    wasWorking.current = opts.cardWorking;
    if (opts.enabled && turnJustEnded) void queryClient.invalidateQueries({ queryKey: cardAnalysisKey(cardId) });
  }, [queryClient, cardId, opts.enabled, opts.cardWorking]);
  return analysisQuery;
}

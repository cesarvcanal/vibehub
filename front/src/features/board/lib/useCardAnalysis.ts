import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { boardApi } from "@/features/board/api";
import { cardAnalysisKey, finishedAnalysisReports } from "@/features/board/lib/analysis";
import type { SdkRow } from "@/features/board/lib/sdkChat";

export function useAnalysisRereadOnReport(cardId: string, chatRows: SdkRow[]): void {
  const queryClient = useQueryClient();
  const reportsInChat = React.useMemo(() => finishedAnalysisReports(chatRows), [chatRows]);
  const reportsSeen = React.useRef(reportsInChat);
  React.useEffect(() => {
    const newReportArrived = reportsInChat > reportsSeen.current;
    reportsSeen.current = reportsInChat;
    if (newReportArrived) void queryClient.invalidateQueries({ queryKey: cardAnalysisKey(cardId) });
  }, [queryClient, cardId, reportsInChat]);
}

export function useCardAnalysis(cardId: string, opts: { enabled: boolean; cardWorking?: boolean }) {
  const queryClient = useQueryClient();
  const analysisQuery = useQuery({
    queryKey: cardAnalysisKey(cardId),
    queryFn: () => boardApi.readCardAnalysis(cardId),
    enabled: opts.enabled,
  });
  const wasWorking = React.useRef(opts.cardWorking);
  React.useEffect(() => {
    const turnJustEnded = wasWorking.current === true && opts.cardWorking === false;
    wasWorking.current = opts.cardWorking;
    if (opts.enabled && turnJustEnded) void queryClient.invalidateQueries({ queryKey: cardAnalysisKey(cardId) });
  }, [queryClient, cardId, opts.enabled, opts.cardWorking]);
  return analysisQuery;
}

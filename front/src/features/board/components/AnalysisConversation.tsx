import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { AnalysisConversation as Conversation, AnalysisReadModel } from "@/api/types";
import { boardApi } from "@/features/board/api";
import { FleetChat } from "@/features/board/components/FleetChat";
import { cardAnalysisConversationKey } from "@/features/board/lib/analysis";
import type { CardStateKind } from "@/features/board/lib/board";
import { analysisFleetChat } from "@/features/board/lib/fleetChat";
import { AnalysisTimeline } from "@/features/review/components/AnalysisTimeline";
import { apiErrorMessage } from "@/lib/apiError";
import { useT } from "@/i18n";

const CONVERSATION_POLL_MS = 8_000;

export function AnalysisConversation({ cardId, read, cardState }: {
  cardId: string;
  read?: AnalysisReadModel;
  cardState: CardStateKind | undefined;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overflow-x-hidden pr-1">
      <FleetSection cardId={cardId} />
      {read ? <AnalysisTimeline timeline={read.timeline} analysis={read.analysis} cardState={cardState} /> : null}
    </div>
  );
}

function FleetSection({ cardId }: { cardId: string }) {
  const t = useT();
  const conversationQuery = useQuery({
    queryKey: cardAnalysisConversationKey(cardId),
    queryFn: () => boardApi.readAnalysisConversation(cardId),
    refetchInterval: (query) => (query.state.data && !query.state.data.finished ? CONVERSATION_POLL_MS : false),
  });
  if (conversationQuery.isPending) return <p className="text-xs text-muted-foreground">{t("common.loading")}</p>;
  if (conversationQuery.isError) return <p className="text-xs text-destructive">{apiErrorMessage(conversationQuery.error)}</p>;
  if (!conversationQuery.data) return <p className="text-xs text-muted-foreground">{t("analysis.conversation.empty")}</p>;
  return <FleetConversation conversation={conversationQuery.data} />;
}

function FleetConversation({ conversation }: { conversation: Conversation }) {
  const t = useT();
  const answered = conversation.agents.filter((agent) => agent.status === "done").length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
        {conversation.finished
          ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          : <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />}
        {t(conversation.finished ? "analysis.conversation.finished" : "analysis.conversation.working", {
          done: answered, total: conversation.agents.length,
        })}
      </p>
      <FleetChat entries={analysisFleetChat(conversation)} label={t("analysis.conversation.aria")} />
    </div>
  );
}

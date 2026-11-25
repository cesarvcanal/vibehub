import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { AnalysisConversation as Conversation, AnalysisReadModel } from "@/api/types";
import { boardApi } from "@/features/board/api";
import { FleetChat, FleetGathering } from "@/features/board/components/FleetChat";
import { JumpToLatest, useStickToBottom } from "@/features/board/components/JumpToLatest";
import { cardAnalysisConversationKey } from "@/features/board/lib/analysis";
import type { CardStateKind } from "@/features/board/lib/board";
import { analysisFleetChat, type FleetChatEntry } from "@/features/board/lib/fleetChat";
import { AnalysisTimeline } from "@/features/review/components/AnalysisTimeline";
import { apiErrorMessage } from "@/lib/apiError";
import { useT } from "@/i18n";

const CONVERSATION_POLL_MS = 8_000;

export function AnalysisConversation({ cardId, read, cardState }: {
  cardId: string;
  read?: AnalysisReadModel;
  cardState: CardStateKind | undefined;
}) {
  const reportWritten = read !== undefined;
  const conversationQuery = useQuery({
    queryKey: cardAnalysisConversationKey(cardId),
    queryFn: () => boardApi.readAnalysisConversation(cardId),
    refetchInterval: (query) => {
      const conversation = query.state.data;
      const fleetStillComing = conversation === null && !reportWritten;
      const fleetTalking = conversation ? !conversation.finished : false;
      return fleetStillComing || fleetTalking ? CONVERSATION_POLL_MS : false;
    },
  });
  const conversation = conversationQuery.data;
  const entries = conversation ? analysisFleetChat(conversation) : [];
  const lastEntry = entries[entries.length - 1];
  const stick = useStickToBottom(
    `${entries.length}:${lastEntry?.id}:${lastEntry?.kind}:${read?.timeline.length ?? 0}`,
    { smooth: true },
  );
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={stick.scrollerRef}
        onScroll={stick.onScroll}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden pr-1"
      >
        <FleetSection
          isPending={conversationQuery.isPending}
          error={conversationQuery.isError ? conversationQuery.error : null}
          conversation={conversation ?? null}
          entries={entries}
          reportWritten={reportWritten}
        />
        {read ? <AnalysisTimeline timeline={read.timeline} analysis={read.analysis} cardState={cardState} /> : null}
      </div>
      <JumpToLatest stick={stick} />
    </div>
  );
}

function FleetSection({ isPending, error, conversation, entries, reportWritten }: {
  isPending: boolean;
  error: Error | null;
  conversation: Conversation | null;
  entries: FleetChatEntry[];
  reportWritten: boolean;
}) {
  const t = useT();
  if (isPending) return <p className="text-xs text-muted-foreground">{t("common.loading")}</p>;
  if (error) return <p className="text-xs text-destructive">{apiErrorMessage(error)}</p>;
  if (conversation) return <FleetConversation conversation={conversation} entries={entries} />;
  if (reportWritten) return <p className="text-xs text-muted-foreground">{t("analysis.conversation.empty")}</p>;
  return <FleetGathering title={t("analysis.conversation.gathering.title")} body={t("analysis.conversation.gathering.body")} />;
}

function FleetConversation({ conversation, entries }: { conversation: Conversation; entries: FleetChatEntry[] }) {
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
      <FleetChat entries={entries} label={t("analysis.conversation.aria")} />
    </div>
  );
}

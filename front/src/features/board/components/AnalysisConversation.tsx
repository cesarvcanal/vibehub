import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { AnalysisConversation as Conversation, AnalysisConversationItem } from "@/api/types";
import { boardApi } from "@/features/board/api";
import { fleetAgentName } from "@/features/board/components/ReviewFleet";
import { cardAnalysisConversationKey } from "@/features/board/lib/analysis";
import { conversationTurns, type ConversationTurn } from "@/features/board/lib/analysisConversation";
import { apiErrorMessage } from "@/lib/apiError";
import { useT } from "@/i18n";

const CONVERSATION_POLL_MS = 8_000;

export function AnalysisConversation({ cardId }: { cardId: string }) {
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
    <div className="flex min-h-0 min-w-0 flex-col gap-2">
      <p className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
        {conversation.finished
          ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          : <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />}
        {t(conversation.finished ? "analysis.conversation.finished" : "analysis.conversation.working", {
          done: answered, total: conversation.agents.length,
        })}
      </p>
      <ol aria-label={t("analysis.conversation.aria")} className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto overflow-x-hidden">
        {conversationTurns(conversation).map((turn) => (
          <li key={`${turn.agent.id}-${turn.items[0]!.at}`}>
            <AgentTurn turn={turn} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function AgentTurn({ turn }: { turn: ConversationTurn }) {
  const t = useT();
  return (
    <article className="flex min-w-0 flex-col gap-1 rounded-md border border-border/60 bg-background/40 p-2.5 text-xs">
      <header className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-foreground/90">{fleetAgentName(turn.agent.label, t)}</span>
        {turn.agent.modelLabel ? <span className="rounded-full bg-muted px-1.5 text-[11px] text-foreground/80">{turn.agent.modelLabel}</span> : null}
        {turn.agent.phase ? <span className="text-[11px] text-muted-foreground">{turn.agent.phase}</span> : null}
      </header>
      {turn.items.map((item, index) => <TurnStep key={`${item.at}-${index}`} item={item} />)}
    </article>
  );
}

function TurnStep({ item }: { item: AnalysisConversationItem }) {
  const t = useT();
  const wrapped = "whitespace-pre-wrap [overflow-wrap:anywhere]";
  switch (item.kind) {
    case "thinking":
      return <p className="italic text-muted-foreground/70">{t("analysis.conversation.thinking")}</p>;
    case "tool":
      return <p className={`font-mono text-[11px] text-sky-400 ${wrapped}`}>{item.target ? `${item.tool} · ${item.target}` : item.tool}</p>;
    case "result":
      return <p className={`border-l-2 border-border/60 pl-2 font-mono text-[11px] text-muted-foreground ${wrapped}`}>{item.text}</p>;
    case "text":
      return <p className={`leading-relaxed text-foreground/90 ${wrapped}`}>{item.text}</p>;
  }
}

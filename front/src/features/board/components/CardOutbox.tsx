import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Clock, X } from "lucide-react";
import { apiErrorMessage } from "@/lib/apiError";
import { boardApi, cardMessagesKey } from "@/features/board/api";
import type { AgentState, OutboxMessage } from "@/api/types";
import { t as translate, useT } from "@/i18n";

/**
 * What you sent that has not reached the agent yet.
 *
 * A message is queued when the card's pane is not running Claude — the session was never opened,
 * it is paused, the agent exited and left a bare shell behind. Before this, that message was typed
 * into whatever was there and vanished. Now it waits, and this strip is the promise being kept in
 * public: it says how many are waiting, what they say, and why they have not gone.
 *
 * It renders NOTHING when the queue is empty, which is almost always. That is deliberate: a
 * permanent "0 pending" row would be a piece of chrome earning its space once a week.
 */
export function CardOutbox({ cardId }: { cardId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const key = cardMessagesKey(cardId);

  const { data } = useQuery({
    queryKey: key,
    queryFn: () => boardApi.cardMessages(cardId),
    // Polling is the ONLY way the front-end learns that the agent came back: delivery happens on
    // the server, on triggers this tab cannot see. It only runs while something is actually
    // waiting — an empty queue costs one request per card visit and nothing after that.
    refetchInterval: (query) => ((query.state.data?.pending.length ?? 0) > 0 ? 4_000 : false),
  });

  const pending: OutboxMessage[] = data?.pending ?? [];

  const cancel = useMutation({
    mutationFn: (messageId: string) => boardApi.cancelCardMessage(cardId, messageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
    onError: (error) => toast.error(apiErrorMessage(error, translate("outbox.cancelError"))),
  });

  if (pending.length === 0) return null;

  return (
    <div
      data-testid="card-outbox"
      className="mt-1.5 flex shrink-0 flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5"
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-500">
        <Clock className="h-3.5 w-3.5 shrink-0" />
        <span>{t(agentCopyKey(data?.agent), { n: pending.length })}</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {pending.map((message) => (
          <li key={message.id} className="flex items-start gap-1.5">
            <span
              data-testid="card-outbox-message"
              className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
              title={message.text}
            >
              {message.text}
            </span>
            <button
              type="button"
              data-testid="card-outbox-cancel"
              aria-label={t("outbox.cancel")}
              title={t("outbox.cancel")}
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(message.id)}
              className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * WHY it is waiting, in the words that tell you what to do about it: a session that does not exist
 * needs the card opened, a shell means Claude is not running in there. Anything else is "on its
 * way", which is what a queue mid-delivery is. PURE.
 */
export function agentCopyKey(agent: AgentState | undefined): string {
  if (agent === "none") return "outbox.waitingSession";
  if (agent === "shell") return "outbox.waitingAgent";
  return "outbox.waitingDelivery";
}

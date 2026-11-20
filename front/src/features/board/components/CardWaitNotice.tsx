import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Hourglass } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import { boardApi, CARDS_PREFIX_KEY, cardKey } from "@/features/board/api";
import { cardWaitPhase } from "@/features/board/lib/cardWait";
import type { CardWait } from "@/api/types";
import { useT } from "@/i18n";

export function CardWaitNotice({ cardId, wait, waitTargetTitle }: { cardId: string; wait: CardWait; waitTargetTitle?: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const phase = cardWaitPhase(wait);
  const card = waitTargetTitle ? t("cardWait.namedCard", { title: waitTargetTitle }) : t("cardWait.unnamedCard");
  const refreshBoard = async () => {
    await queryClient.invalidateQueries({ queryKey: CARDS_PREFIX_KEY });
    await queryClient.invalidateQueries({ queryKey: cardKey(cardId) });
  };
  const cancel = useMutation({ mutationFn: () => boardApi.cancelCardWait(cardId), onSuccess: refreshBoard });
  const wake = useMutation({ mutationFn: () => boardApi.fireCardWait(cardId), onSettled: refreshBoard });
  const wakeError = wake.error ? apiErrorMessage(wake.error, t("cardWait.wakeError")) : undefined;
  const wakeErrorNotShownYet = wakeError !== wait.failure?.reason ? wakeError : undefined;
  const failedAction = cancel.error ? apiErrorMessage(cancel.error, t("cardWait.cancelError")) : wakeErrorNotShownYet;
  const busy = cancel.isPending || wake.isPending;
  const headline = wait.failure ? t("cardWait.failed", { card, reason: wait.failure.reason }) : t(phase === "ready" ? "cardWait.ready" : "cardWait.waiting", { card });
  const Icon = phase === "failed" ? AlertTriangle : Hourglass;

  return (
    <div
      data-testid="card-wait-notice"
      role="status"
      className={cn(
        "mb-1.5 flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-xs",
        phase === "failed" ? "border-destructive/50 bg-destructive/10" : "border-sky-500/40 bg-sky-500/10",
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", phase === "failed" ? "text-destructive" : "text-sky-500")} aria-hidden />
      <div className="min-w-0 flex-1 basis-60 space-y-0.5">
        <p className="break-words">{headline}</p>
        <p className="break-words text-muted-foreground">{t("cardWait.instruction", { instruction: wait.instruction })}</p>
        {failedAction ? <p role="alert" className="break-words text-destructive">{failedAction}</p> : null}
      </div>
      <div className="flex shrink-0 gap-1.5">
        {phase === "failed" ? (
          <Button type="button" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => wake.mutate()}>
            {t("cardWait.wakeNow")}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => cancel.mutate()}>
          {t("cardWait.cancel")}
        </Button>
      </div>
    </div>
  );
}

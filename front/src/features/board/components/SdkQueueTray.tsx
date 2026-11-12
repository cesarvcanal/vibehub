import * as React from "react";
import { ChevronRight, Clock3, Pencil, SendHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { LinkifiedText } from "@/features/board/components/ChatView";
import type { QueuedMessage } from "@/features/board/lib/sdkQueue";

/**
 * THE QUEUE, drawn — the messages written during a turn, waiting at the ready right above the
 * text field.
 *
 * Why here and not in the conversation: a bubble in the conversation claims that Claude read it. While the
 * message waits, nobody has read anything — it is still a handed-in draft, and saying otherwise is the
 * lie this screen exists not to tell. The moment it is delivered it leaves here and is born
 * there, as a bubble, with a receipt.
 *
 * Each row carries the two gestures the queue promises: the pencil (back to the field, and it LEAVES the queue —
 * no being sent in the middle of the correction) and the X (I gave up on this one).
 */
function SdkQueueTrayView({
  queue,
  onEdit,
  onRemove,
  onSendNow,
}: {
  queue: readonly QueuedMessage[];
  /** No pencil nor "enviar agora" where there is no chat to receive them (the card still preparing). */
  onEdit?: (id: string) => void;
  onRemove: (id: string) => void;
  onSendNow?: (id: string) => void;
}) {
  const t = useT();
  return (
    <div
      data-testid="sdk-queue"
      // CEILING. The tray is a sibling of the conversation's scroller in a flex column: without a limit it grows
      // with the waiting text and squeezes the scroller's `flex-1` down to almost zero — a
      // two-hundred-line instruction pushed the whole conversation off the screen, and along with
      // it the only way to follow what the agent was saying (production, 2026-09-28).
      // The wait is a notice, not a read: whatever does not fit scrolls in here.
      className="mt-1.5 flex max-h-[28vh] shrink-0 flex-col gap-1 overflow-y-auto overscroll-contain rounded-md border border-border/60 bg-muted/40 px-2 py-1.5"
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Clock3 className="h-3 w-3 shrink-0" />
        <span>{t("sdk.queueTitle", { n: queue.length })}</span>
        <span className="min-w-0 truncate font-normal opacity-80">{t("sdk.queueHint")}</span>
      </div>
      {queue.map((message) => (
        <div
          key={message.id}
          data-testid="sdk-queued"
          data-editing={message.editing === true || undefined}
          className={cn(
            "group flex items-start gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-background/60",
            message.editing === true && "opacity-60",
          )}
        >
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
          {/* A ceiling PER MESSAGE TOO: with several in the queue, a giant one would push the others
              out of the tray's ceiling and they would disappear from view. Each one scrolls in its own place — and the
              pencil remains the way to read it whole, in the text field. */}
          <span
            data-testid="sdk-queued-text"
            className="min-w-0 flex-1 max-h-24 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-foreground/90"
          >
            {/* Same render as the bubble: the path of a pasted screenshot becomes its thumbnail — waiting
                in the queue reading `/work/.uploads/…/1792-image.png` does not say which image is going. */}
            <LinkifiedText text={message.text} compact />
          </span>
          {/* IN THE FIELD, being rewritten: it keeps its place in the queue and offers no gesture at all —
              the field is in charge now (Enter writes over it, the X there gives up on the correction). */}
          {message.editing === true ? (
            <span data-testid="sdk-queued-editing" className="shrink-0 pt-0.5 italic text-muted-foreground">
              {t("sdk.queueBeingEdited")}
            </span>
          ) : (
            <>
              {/* JUMPING THE WAIT: this one goes now, in the middle of the turn. The default is still
                  to wait — but "para, tá errado" is not a question for ten minutes from now. */}
              {onSendNow ? (
                <button
                  type="button"
                  data-testid="sdk-queued-send-now"
                  aria-label={t("sdk.queueSendNow")}
                  title={t("sdk.queueSendNow")}
                  onClick={() => onSendNow(message.id)}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <SendHorizontal className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t("sdk.queueSendNowShort")}</span>
                </button>
              ) : null}
              {onEdit ? (
                <button
                  type="button"
                  data-testid="sdk-queued-edit"
                  aria-label={t("sdk.queueEdit")}
                  title={t("sdk.queueEdit")}
                  onClick={() => onEdit(message.id)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                data-testid="sdk-queued-remove"
                aria-label={t("sdk.queueRemove")}
                title={t("sdk.queueRemove")}
                onClick={() => onRemove(message.id)}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/* Memoised: the tray only shows while a turn streams, which is when SdkChatView re-renders on
   every delta — and each queued row is now tokenised, not printed. The callbacks are stable. */
export const SdkQueueTray = React.memo(SdkQueueTrayView);

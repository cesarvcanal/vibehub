import * as React from "react";
import { Check, Copy, Loader2, Square, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/i18n";
import { copyText } from "@/features/board/lib/terminalZoom";
import { useVoiceStatus } from "./status";
import { readAloud, useReadAloud, type ReadAloudPlayer } from "./readAloud";

/** How long the copy button shows its check. */
export const COPIED_MS = 2_000;

const BUTTON =
  "rounded p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Under a FINISHED answer (see `finishedAnswerIds`): copy it whole, and listen to it — ChatGPT's two
 * buttons. The speaker only shows when the server can speak (an OpenAI key); while it reads, the
 * same button stops it.
 */
export function AnswerActions({
  id,
  cardId,
  text,
  player = readAloud,
}: {
  /** The answer's row id — which answer the single player is reading. */
  id: string;
  cardId: string;
  /** The answer as written (markdown): what is copied, and what is read. */
  text: string;
  player?: ReadAloudPlayer;
}) {
  const t = useT();
  const speech = useVoiceStatus().data?.speech === true;
  const phase = useReadAloud(id, player);
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (await copyText(text)) setCopied(true);
    else toast.error(t("answer.copyFailed"));
  };
  const listen = () => {
    if (phase) player.stop();
    else player.start(id, cardId, text);
  };
  const listenLabel = phase === "playing" ? t("answer.stop") : phase === "loading" ? t("answer.loading") : t("answer.listen");

  return (
    <div data-testid="sdk-answer-actions" className="mt-1 flex items-center gap-0.5">
      <button
        type="button"
        data-testid="sdk-answer-copy"
        aria-label={copied ? t("answer.copied") : t("answer.copy")}
        title={copied ? t("answer.copied") : t("answer.copy")}
        onClick={() => void copy()}
        className={BUTTON}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {speech ? (
        <button
          type="button"
          data-testid="sdk-answer-listen"
          data-phase={phase ?? "idle"}
          aria-label={listenLabel}
          aria-pressed={phase !== null}
          title={listenLabel}
          onClick={listen}
          className={BUTTON}
        >
          {phase === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : phase === "playing" ? (
            <Square className="h-3.5 w-3.5 fill-current" />
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
        </button>
      ) : null}
    </div>
  );
}

import { AudioLines } from "lucide-react";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import type { MessageOrigin } from "@/features/board/lib/chat";

/**
 * One spoken turn in the thread, drawn among the typed messages it was said between. Same seats as
 * the typed conversation — the person on the right, the other side on the left — with a small
 * waveform mark saying it was SPOKEN. The voice assistant's answers are not the card agent's: they
 * carry the "voz" label and no markdown (it speaks, it does not write).
 */
export function VoiceTurnBubble({
  role,
  text,
  from,
  viewer,
  live,
  save,
}: {
  role: "user" | "assistant";
  text: string;
  /** Who held the call (stamped by the server) — another person's turns carry their name. */
  from?: MessageOrigin;
  viewer?: string;
  /** Still being spoken. */
  live?: boolean;
  save?: "saving" | "saved" | "failed";
}) {
  const t = useT();
  let who = t("voice.turn.you");
  if (role === "assistant") who = t("voice.turn.assistant");
  else if (from?.name && viewer && from.name !== viewer) who = t("voice.turn.by", { name: from.name });
  const mine = role === "user";
  return (
    <div
      className={cn("flex flex-col", mine ? "items-end" : "items-start")}
      data-testid="sdk-voice"
      data-role={role}
      data-live={live || undefined}
      data-save={save}
    >
      <div
        className={cn(
          "max-w-[85%] select-text whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-sm",
          mine ? "border-fuchsia-400/30 bg-primary/10" : "border-sky-500/30 bg-sky-500/[0.06]",
        )}
      >
        <span className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-sky-600 dark:text-sky-400">
          <AudioLines className="h-3 w-3" aria-hidden="true" />
          {who}
        </span>
        {text}
        {live && <span aria-hidden="true" className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-foreground/50 align-middle" />}
        {save === "failed" && (
          <span className="mt-1 block text-[11px] text-amber-600 dark:text-amber-400">{t("voice.turn.unsaved")}</span>
        )}
      </div>
    </div>
  );
}

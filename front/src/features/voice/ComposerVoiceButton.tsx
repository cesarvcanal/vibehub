import { ArrowUp, AudioLines, Loader2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { voicePath } from "./status";

/**
 * Opens the /voice conversation for this card. The conversation is the POC: it does not act on the
 * card, but the card (and its project) travel in the URL, so /voice says where it came from and
 * leads back there even after a reload or in a new tab. The draft survives on its own (saved per
 * card).
 *
 * `column` is the desktop seat: OUTSIDE the field, beside the dictation mic and drawn like it, so
 * the field keeps its corner free. `corner` is the phone's: inside the field, where the send arrow
 * lives (see {@link ComposerVoiceButton}).
 */
export function VoiceChatButton({
  cardId,
  disabled,
  placement,
}: {
  cardId: string;
  disabled: boolean;
  placement: "column" | "corner";
}) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const project = new URLSearchParams(location.search).get("project");
  return (
    <Button
      type="button"
      size="icon"
      variant={placement === "column" ? "outline" : "default"}
      data-testid="composer-voice"
      aria-label={t("composer.voiceChat")}
      title={t("composer.voiceChat")}
      disabled={disabled}
      onClick={() => navigate(voicePath(cardId, project))}
      className={cn(
        "shrink-0",
        placement === "column"
          ? "h-9 w-9 rounded-md text-sky-500 hover:border-sky-500/50 hover:bg-sky-500/10 hover:text-sky-600"
          : "absolute bottom-1.5 right-1.5 h-11 w-11 rounded-full bg-sky-500 text-white shadow-sm shadow-sky-500/30 hover:bg-sky-600",
      )}
    >
      <AudioLines className={placement === "column" ? "h-4 w-4" : "h-5 w-5"} />
    </Button>
  );
}

/**
 * The phone's corner button while the voice mode is available: with an EMPTY draft it opens a
 * voice conversation (blue waveform); the moment there is something to send it becomes the send
 * arrow. Two jobs, one seat — but never both at once: what a click does is decided by the draft at
 * click time, so an empty field can never "send", and text can never start a call.
 */
export function ComposerVoiceButton({
  cardId,
  empty,
  sending,
  busy,
  voice,
  onSend,
}: {
  cardId: string;
  /** Nothing to send (no text, no attachment). */
  empty: boolean;
  sending: boolean;
  /** The microphone is taken (dictation recording or transcribing): no call can start. */
  busy: boolean;
  /** Voice may be offered at all (not while editing a sent message). */
  voice: boolean;
  onSend: () => void;
}) {
  const t = useT();

  if (empty && voice) {
    return <VoiceChatButton cardId={cardId} disabled={busy || sending} placement="corner" />;
  }

  return (
    <Button
      type="button"
      size="icon"
      data-testid="composer-send"
      aria-label={t("composer.send")}
      title={t("composer.send")}
      disabled={sending || empty}
      aria-busy={sending || undefined}
      onClick={onSend}
      className="absolute bottom-1.5 right-1.5 h-11 w-11 shrink-0 rounded-full"
    >
      {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUp className="h-5 w-5" />}
    </Button>
  );
}

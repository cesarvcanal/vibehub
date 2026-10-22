import { ArrowUp, AudioLines, Loader2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Paths } from "@/lib/paths";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import type { VoiceReturnState } from "./status";

/**
 * The composer's corner button while the voice mode is available: with an EMPTY draft it opens a
 * voice conversation (blue waveform); the moment there is something to send it becomes the send
 * arrow. Two jobs, one seat — but never both at once: what a click does is decided by the draft at
 * click time, so an empty field can never "send", and text can never start a call.
 *
 * The conversation is the /voice POC: it does not belong to the card and never acts on it. The
 * card's location travels in the navigation state so /voice can lead back to it, and the draft
 * survives on its own (it is saved per card).
 */
export function ComposerVoiceButton({
  empty,
  sending,
  busy,
  voice,
  mobile,
  onSend,
}: {
  /** Nothing to send (no text, no attachment). */
  empty: boolean;
  sending: boolean;
  /** The microphone is taken (dictation recording or transcribing): no call can start. */
  busy: boolean;
  /** Voice may be offered at all (not while editing a sent message). */
  voice: boolean;
  mobile: boolean;
  onSend: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const size = mobile ? "h-11 w-11" : "h-9 w-9";

  if (empty && voice) {
    const state: VoiceReturnState = { from: `${location.pathname}${location.search}` };
    return (
      <Button
        type="button"
        size="icon"
        data-testid="composer-voice"
        aria-label={t("composer.voiceChat")}
        title={t("composer.voiceChat")}
        disabled={busy || sending}
        onClick={() => navigate(Paths.VOICE, { state })}
        className={cn(
          "absolute bottom-1.5 right-1.5 shrink-0 rounded-full bg-sky-500 text-white shadow-sm shadow-sky-500/30 hover:bg-sky-600",
          size,
        )}
      >
        <AudioLines className="h-5 w-5" />
      </Button>
    );
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
      className={cn("absolute bottom-1.5 right-1.5 shrink-0 rounded-full", size)}
    >
      {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUp className="h-5 w-5" />}
    </Button>
  );
}

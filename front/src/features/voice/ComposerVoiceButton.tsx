import * as React from "react";
import { ArrowUp, AudioLines, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The composer's way into a voice call — IN this chat, never another page. The chat that hosts the
 * call (SdkChatView) provides this context; a composer without it (the older transcript chat, a
 * composer outside a card) shows no voice button at all.
 */
export interface VoiceCallControl {
  /** A call is up (connecting, live or closing) in this chat. */
  inCall: boolean;
  start: () => void;
  stop: () => void;
}

export const VoiceCallContext = React.createContext<VoiceCallControl | null>(null);

export function useVoiceCallControl(): VoiceCallControl | null {
  return React.useContext(VoiceCallContext);
}

/**
 * Starts the call (or, pressed, ends it). `column` is the desktop seat: OUTSIDE the field, beside
 * the dictation mic and drawn like it. `bar` is the phone's: in the field's bottom bar, where
 * the send arrow lives (see {@link ComposerVoiceButton}).
 */
export function VoiceChatButton({
  control,
  disabled,
  placement,
}: {
  control: VoiceCallControl;
  disabled: boolean;
  placement: "column" | "bar";
}) {
  const t = useT();
  const label = control.inCall ? t("voice.call.end") : t("composer.voiceChat");
  return (
    <Button
      type="button"
      size="icon"
      variant={placement === "column" && !control.inCall ? "outline" : "default"}
      data-testid="composer-voice"
      aria-label={label}
      aria-pressed={control.inCall}
      title={label}
      disabled={disabled && !control.inCall}
      onClick={() => (control.inCall ? control.stop() : control.start())}
      className={cn(
        "shrink-0",
        placement === "column"
          ? control.inCall
            ? "h-9 w-9 rounded-md bg-sky-500 text-white hover:bg-sky-600"
            : "h-9 w-9 rounded-md text-sky-500 hover:border-sky-500/50 hover:bg-sky-500/10 hover:text-sky-600"
          : "h-11 w-11 rounded-full bg-sky-500 text-white shadow-sm shadow-sky-500/30 hover:bg-sky-600",
      )}
    >
      <AudioLines className={placement === "column" ? "h-4 w-4" : "h-5 w-5"} />
    </Button>
  );
}

/**
 * The phone's send seat in the field's bar: with an EMPTY draft and no call it starts a voice call (blue
 * waveform); the moment there is something to send — or a call is already up, whose controls live
 * in the call strip — it is the send arrow. What a click does is decided by the state at click
 * time, so an empty field can never "send", and text can never start a call.
 */
export function ComposerVoiceButton({
  control,
  empty,
  sending,
  busy,
  voice,
  onSend,
}: {
  control: VoiceCallControl;
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

  if (empty && voice && !control.inCall) {
    return <VoiceChatButton control={control} disabled={busy || sending} placement="bar" />;
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
      className="h-11 w-11 shrink-0 rounded-full"
    >
      {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUp className="h-5 w-5" />}
    </Button>
  );
}

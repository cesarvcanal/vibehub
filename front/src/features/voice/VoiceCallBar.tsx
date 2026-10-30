import * as React from "react";
import { Loader2, Mic, MicOff, PhoneOff, RotateCcw, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { LivingOrb } from "./living/LivingOrb";
import { phaseOrb, type VoicePhase } from "./voicePhase";
import type { VoiceCall } from "./useVoiceCall";

/**
 * THE CALL, INSIDE THE CHAT — no box of its own. Between the thread and the composer the living orb
 * floats on the app's own background (grid and constellations show through it: the canvas is
 * transparent), centred like the conversation's pulse, with one quiet line on its left saying what
 * is happening and the two call controls (mute, hang up) on its right. The thread keeps scrolling
 * above and the composer keeps working below — typing, attaching, sending all go on.
 *
 * The orb is the approved V37 (see LivingOrb's reference stage): the living mark while it connects
 * or thinks, lilac while it listens, blue while it replies. Its canvas is larger than its slot and
 * spills over the empty margins around it (never catching a click), so the mark reads at full
 * presence without the strip taking the height of a panel.
 */

const PHASE_TONE: Partial<Record<VoicePhase, string>> = {
  listening: "text-fuchsia-500 dark:text-fuchsia-300",
  user_speaking: "text-fuchsia-500 dark:text-fuchsia-300",
  interrupted: "text-fuchsia-500 dark:text-fuchsia-300",
  ai_speaking: "text-sky-500 dark:text-sky-300",
  error: "text-destructive",
};


export function VoiceCallBar({
  call,
  agentBusy,
  onClose,
}: {
  call: VoiceCall;
  /** What the card's agent is doing with something sent during the call, for the "thinking" line. */
  agentBusy: boolean;
  /** Dismiss a failed call's strip. */
  onClose: () => void;
}) {
  const t = useT();
  const { snap, phase } = call;
  const orbRef = React.useRef<HTMLDivElement>(null);

  // The numbers behind the orb on the DOM, ~10x/s, for the diagnostics and the end-to-end checks:
  // the REAL level of the assistant's audio, the VISUAL intensity drawn, and where it came from.
  React.useEffect(() => {
    if (!call.active) return;
    const id = setInterval(() => {
      const el = orbRef.current;
      if (!el) return;
      const m = call.meterRef.current;
      el.dataset.aiSource = m.aiSource;
      el.dataset.aiRms = m.aiRms === null ? "" : m.aiRms.toFixed(4);
      el.dataset.aiDb = m.aiDb === null ? "" : m.aiDb.toFixed(1);
      el.dataset.aiVisual = m.aiVisual.toFixed(3);
      el.dataset.micVisual = m.micVisual.toFixed(3);
    }, 100);
    return () => clearInterval(id);
  }, [call.active, call.meterRef]);

  const busy = snap.state === "connecting" || snap.state === "closing";
  const label =
    phase === "thinking" && agentBusy ? t("voice.phase.thinkingAgent") : t(`voice.phase.${phase}`);
  const detail = snap.error ? t(snap.error) : snap.notice ? t(snap.notice) : null;

  return (
    <div
      role="region"
      aria-label={t("voice.call.label")}
      data-testid="voice-call-bar"
      data-phase={phase}
      className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 md:gap-5"
    >
      <div className="min-w-0 text-right">
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "flex items-center justify-end gap-1.5 text-sm font-medium text-muted-foreground transition-colors",
            PHASE_TONE[phase],
          )}
        >
          {busy && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}
          <span className="truncate">{label}</span>
        </p>
        {detail ? (
          <p role={snap.error ? "alert" : undefined} className={cn("line-clamp-2 text-xs", snap.error ? "text-destructive" : "text-muted-foreground")} title={detail}>
            {detail}
          </p>
        ) : (
          <p className="hidden text-xs leading-snug text-muted-foreground/80 md:line-clamp-2" title={t("voice.call.hint")}>
            {t("voice.call.hint")}
          </p>
        )}
      </div>

      <div ref={orbRef} data-testid="voice-call-orb" data-orb={phaseOrb(phase)} className="relative mx-2 size-24 md:mx-3 md:size-[120px]">
        <LivingOrb
          mode={phaseOrb(phase)}
          levels={call.orbLevels}
          fps={30}
          className="absolute left-1/2 top-1/2 size-[116px] -translate-x-1/2 -translate-y-1/2 md:size-[148px]"
        />
      </div>

      <div className="flex min-w-0 items-center gap-1.5">
        {snap.state === "live" && snap.diag.playback === "blocked" && (
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 rounded-full" onClick={call.resumePlayback} aria-label={t("voice.playAudio")} title={t("voice.playAudio")}>
            <Volume2 className="size-4" />
          </Button>
        )}
        {phase === "error" ? (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={call.start} data-testid="voice-call-retry">
              <RotateCcw className="size-4" />
              {t("voice.call.retry")}
            </Button>
            <Button type="button" variant="ghost" size="icon" className="h-9 w-9 rounded-full" onClick={onClose} aria-label={t("voice.call.dismiss")} title={t("voice.call.dismiss")}>
              <X className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={snap.state !== "live"}
              onClick={() => call.setMuted(!snap.muted)}
              aria-pressed={snap.muted}
              aria-label={snap.muted ? t("voice.unmute") : t("voice.mute")}
              title={snap.muted ? t("voice.unmute") : t("voice.mute")}
              data-testid="voice-call-mute"
              className={cn(
                "h-9 w-9 rounded-full text-muted-foreground hover:text-foreground",
                snap.muted && "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
              )}
            >
              {snap.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={snap.state === "closing"}
              onClick={call.stop}
              aria-label={t("voice.call.end")}
              title={t("voice.call.end")}
              data-testid="voice-call-end"
              className="h-9 w-9 rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <PhoneOff className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

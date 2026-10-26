import * as React from "react";
import { Loader2, Mic, MicOff, PhoneOff, RotateCcw, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { LivingOrb } from "./living/LivingOrb";
import { phaseOrb, type VoicePhase } from "./voicePhase";
import type { VoiceCall } from "./useVoiceCall";

/**
 * THE CALL, INSIDE THE CHAT — a compact strip docked right above the composer, never over the
 * thread: the living orb as the call's face, one line saying what is happening, and the two call
 * controls (mute, hang up). The thread keeps scrolling above it and the composer keeps working
 * below it — typing, attaching, sending all go on during the call.
 *
 * The orb is the approved V37 at miniature scale (see LivingOrb's reference stage): the living
 * mark while it connects or thinks, lilac while it listens, blue while it replies.
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
      el.dataset.aiVisual = m.aiVisual.toFixed(3);
      el.dataset.micVisual = m.micVisual.toFixed(3);
    }, 100);
    return () => clearInterval(id);
  }, [call.active, call.meterRef]);

  const busy = snap.state === "connecting" || snap.state === "closing";
  const label =
    phase === "thinking" && agentBusy ? t("voice.phase.thinkingAgent") : t(`voice.phase.${phase}`);

  return (
    <div
      role="region"
      aria-label={t("voice.call.label")}
      data-testid="voice-call-bar"
      data-phase={phase}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card/60 px-2.5 py-2 transition-colors",
        phase === "ai_speaking" ? "border-sky-500/40" : phase === "error" ? "border-destructive/40" : "border-border/70",
      )}
    >
      <div ref={orbRef} data-testid="voice-call-orb" data-orb={phaseOrb(phase)} className="shrink-0">
        <LivingOrb
          mode={phaseOrb(phase)}
          levels={call.orbLevels}
          stage="badge"
          fps={40}
          className="size-14 md:size-16"
        />
      </div>

      <div className="min-w-0 flex-1">
        <p
          role="status"
          aria-live="polite"
          className={cn("flex items-center gap-1.5 truncate text-sm font-medium", PHASE_TONE[phase])}
        >
          {busy && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}
          <span className="truncate">{label}</span>
        </p>
        {snap.error ? (
          <p role="alert" className="truncate text-xs text-destructive" title={t(snap.error)}>
            {t(snap.error)}
          </p>
        ) : snap.notice ? (
          <p className="truncate text-xs text-muted-foreground" title={t(snap.notice)}>{t(snap.notice)}</p>
        ) : (
          <p className="hidden truncate text-xs text-muted-foreground sm:block" title={t("voice.call.hint")}>
            {t("voice.call.hint")}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {snap.state === "live" && snap.diag.playback === "blocked" && (
          <Button type="button" variant="outline" size="icon" className="h-9 w-9" onClick={call.resumePlayback} aria-label={t("voice.playAudio")} title={t("voice.playAudio")}>
            <Volume2 className="size-4" />
          </Button>
        )}
        {phase === "error" ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={call.start} data-testid="voice-call-retry">
              <RotateCcw className="size-4" />
              {t("voice.call.retry")}
            </Button>
            <Button type="button" variant="ghost" size="icon" className="h-9 w-9" onClick={onClose} aria-label={t("voice.call.dismiss")} title={t("voice.call.dismiss")}>
              <X className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={snap.state !== "live"}
              onClick={() => call.setMuted(!snap.muted)}
              aria-pressed={snap.muted}
              aria-label={snap.muted ? t("voice.unmute") : t("voice.mute")}
              title={snap.muted ? t("voice.unmute") : t("voice.mute")}
              data-testid="voice-call-mute"
              className={cn("h-9 w-9 rounded-full", snap.muted && "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15")}
            >
              {snap.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="icon"
              disabled={snap.state === "closing"}
              onClick={call.stop}
              aria-label={t("voice.call.end")}
              title={t("voice.call.end")}
              data-testid="voice-call-end"
              className="h-9 w-9 rounded-full"
            >
              <PhoneOff className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

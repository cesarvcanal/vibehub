import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Mic, MicOff, PhoneOff } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { SecretInput } from "@/components/ui/secret-input";
import { useAuth } from "@/providers/auth";
import { get, post } from "@/lib/api";
import { Paths } from "@/lib/paths";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { LiveVoiceSession, type LiveVoiceDeps, type LiveVoiceSnapshot } from "./liveVoice";

/**
 * VOICE MODE (POC) — `/voice`. A spoken conversation with GPT-Live, like ChatGPT's voice mode:
 * one button starts and ends it, the mic stays open, and you can talk over the assistant to
 * interrupt it. Not connected to Claude Code or to any card. Hidden unless the server has
 * `VIBEHUB_VOICE_LIVE=1` and an OpenAI key.
 */

interface VoiceLiveStatus {
  enabled: boolean;
  available: boolean;
  model: string;
}

export const VOICE_STATUS_KEY = ["voice", "live"] as const;

function defaultDeps(audio: HTMLAudioElement): LiveVoiceDeps {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPeer: () => new RTCPeerConnection(),
    exchangeOffer: (sdp, signal) => post<{ sessionId: string; sdp: string }>("/voice/live/sessions", { sdp }, { signal }),
    audio,
  };
}

export interface VoiceModePageProps {
  /** Tests swap the browser's media stack; the app never passes this. */
  makeDeps?: (audio: HTMLAudioElement) => LiveVoiceDeps;
}

export function VoiceModePage({ makeDeps = defaultDeps }: VoiceModePageProps) {
  const t = useT();
  const status = useQuery({ queryKey: VOICE_STATUS_KEY, queryFn: () => get<VoiceLiveStatus>("/voice/live") });
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const [session, setSession] = React.useState<LiveVoiceSession | null>(null);

  React.useEffect(() => {
    if (!audioRef.current) return;
    const s = new LiveVoiceSession(makeDeps(audioRef.current));
    setSession(s);
    // Leaving the page ends the conversation and releases the microphone.
    return () => s.dispose();
  }, [makeDeps]);

  const snap = React.useSyncExternalStore(
    React.useCallback((cb: () => void) => session?.subscribe(cb) ?? (() => undefined), [session]),
    () => session?.snapshot() ?? IDLE,
  );

  const supported = typeof window !== "undefined" && "RTCPeerConnection" in window && Boolean(navigator.mediaDevices);
  const ready = status.data?.enabled && status.data.available;
  const active = snap.state === "connecting" || snap.state === "live" || snap.state === "closing";

  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-6 px-4 py-8">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">{t("voice.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("voice.subtitle")}</p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link to={Paths.BOARD}>{t("voice.back")}</Link>
        </Button>
      </div>

      {/* Hidden player: the assistant's voice arrives on a WebRTC track. */}
      <audio ref={audioRef} autoPlay className="hidden" data-testid="voice-audio" />

      {status.isLoading ? (
        <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" aria-label={t("common.loading")} />
      ) : !ready ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="rounded-md border border-border p-4 text-sm text-muted-foreground">
            {status.data?.enabled ? t("voice.unavailable.noKey") : t("voice.unavailable.disabled")}
          </p>
          {status.data?.enabled && <OwnerKeyForm />}
        </div>
      ) : !supported ? (
        <p role="status" className="rounded-md border border-border p-4 text-sm text-muted-foreground">
          {t("voice.unavailable.browser")}
        </p>
      ) : (
        <>
          <div className="flex flex-col items-center gap-4">
            <button
              type="button"
              onClick={() => (active ? session?.stop() : void session?.start())}
              disabled={snap.state === "closing"}
              aria-pressed={active}
              aria-label={active ? t("voice.stop") : t("voice.start")}
              className={cn(
                "flex size-28 items-center justify-center rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                active ? "border-destructive bg-destructive/10 text-destructive" : "border-primary bg-primary/10 text-primary",
                snap.state === "live" && !snap.muted && "animate-pulse",
              )}
            >
              {snap.state === "connecting" || snap.state === "closing" ? (
                <Loader2 className="size-10 animate-spin" />
              ) : active ? (
                <PhoneOff className="size-10" />
              ) : (
                <Mic className="size-10" />
              )}
            </button>
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t(`voice.state.${snap.state}`)}
            </p>
            {snap.state === "live" && (
              <Button variant="outline" size="sm" onClick={() => session?.setMuted(!snap.muted)} aria-pressed={snap.muted}>
                {snap.muted ? <MicOff /> : <Mic />}
                {snap.muted ? t("voice.unmute") : t("voice.mute")}
              </Button>
            )}
          </div>

          {snap.error && (
            <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
              {t(snap.error)}
            </p>
          )}
          {snap.notice && <p className="text-center text-xs text-muted-foreground">{t(snap.notice)}</p>}

          {snap.transcript.length > 0 && (
            <ol className="flex flex-col gap-2" aria-label={t("voice.transcript")}>
              {snap.transcript.map((entry, i) => (
                <li
                  key={i}
                  className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                    entry.role === "user" ? "self-end bg-primary/10" : "self-start bg-muted",
                  )}
                >
                  {entry.text}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The owner stores the install's OpenAI key right here — the same vault entry the composer's
 * microphone uses (`POST /api/transcribe/keys`, owner-only), which the voice mode falls back to.
 * The value goes from the field to the server and is never shown again; only "is there one" is.
 */
function OwnerKeyForm() {
  const t = useT();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [key, setKey] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  if (user?.role !== "owner") return null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    setFailed(false);
    try {
      await post("/transcribe/keys", { openaiKey: key.trim() });
      setKey("");
      await queryClient.invalidateQueries({ queryKey: VOICE_STATUS_KEY });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <label htmlFor="voice-openai-key" className="text-sm font-medium">{t("voice.key.label")}</label>
      <div className="flex gap-2">
        <SecretInput
          id="voice-openai-key"
          name="voice-openai-key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-…"
        />
        <Button type="submit" disabled={saving || !key.trim()}>{t("common.save")}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("voice.key.hint")}</p>
      {failed && <p role="alert" className="text-sm text-destructive">{t("voice.key.failed")}</p>}
    </form>
  );
}

const IDLE: LiveVoiceSnapshot = { state: "idle", muted: false, transcript: [], error: null, notice: null };

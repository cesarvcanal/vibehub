import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Mic, MicOff, Phone, Volume2, X } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { SecretInput } from "@/components/ui/secret-input";
import { useAuth } from "@/providers/auth";
import { post } from "@/lib/api";
import { Paths } from "@/lib/paths";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { LiveVoiceSession, aiActivity, type LiveVoiceDeps, type LiveVoiceDiag, type LiveVoiceSnapshot } from "./liveVoice";
import { SIGNAL_THRESHOLD, displayLevel, useMicLevel, type MakeAudioContext } from "./micLevel";
import { VoiceOrb, type OrbMode } from "./VoiceOrb";
import { VOICE_STATUS_KEY, useVoiceStatus, type VoiceReturnState } from "./status";

/**
 * VOICE MODE (POC) — `/voice`. A spoken conversation with GPT-Live, like ChatGPT's voice mode:
 * the orb in the middle, one button starts and ends it, the mic stays open, and you can talk over
 * the assistant to interrupt it. Not connected to Claude Code or to any card — opened from a card's
 * composer, it only remembers the way back. Hidden unless the server has `VIBEHUB_VOICE_LIVE=1`
 * and an OpenAI key.
 */

export { VOICE_STATUS_KEY };

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
  /** Tests swap Web Audio for the level meter; the app never passes this. */
  makeAudioContext?: MakeAudioContext;
}

/** What the orb shows, from the session and who is making sound. PURE. */
export function orbMode(snap: LiveVoiceSnapshot, now: number): OrbMode {
  if (snap.state === "error") return "error";
  if (snap.state === "connecting" || snap.state === "closing") return "connecting";
  if (snap.state !== "live") return "idle";
  if (snap.muted) return aiActivity(snap.diag, now) === "speaking" ? "speaking" : "muted";
  return aiActivity(snap.diag, now) === "speaking" ? "speaking" : "listening";
}

export function VoiceModePage({ makeDeps = defaultDeps, makeAudioContext }: VoiceModePageProps) {
  const t = useT();
  const status = useVoiceStatus();
  const location = useLocation();
  const from = (location.state as VoiceReturnState | null)?.from;
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
  // The stream exists from the mic grant until teardown; `diag.micTrack` changing re-reads it.
  const micStream = React.useMemo(() => (active ? session?.micStream() ?? null : null), [active, session, snap.diag.micTrack]);
  const rms = useMicLevel(micStream, makeAudioContext);
  // The assistant's own audio, measured the same way, once its track arrived.
  const remoteStream = React.useMemo(
    () => (snap.state === "live" && snap.diag.remoteAudio ? session?.remoteStream() ?? null : null),
    [snap.state, snap.diag.remoteAudio, session],
  );
  const remoteRms = useMicLevel(remoteStream, makeAudioContext);
  const mode = orbMode(snap, Date.now());
  const orbLevel =
    mode === "speaking"
      ? displayLevel(remoteRms ?? snap.diag.remoteLevel ?? 0.15)
      : mode === "listening"
        ? displayLevel(rms ?? 0)
        : 0;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-6 px-4 py-6">
      <div className="flex items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to={from ?? Paths.BOARD}>
            <ArrowLeft />
            {from ? t("voice.backToCard") : t("voice.back")}
          </Link>
        </Button>
        <div className="text-right">
          <h1 className="text-sm font-semibold">{t("voice.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("voice.subtitle")}</p>
        </div>
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
          <div className="flex flex-col items-center gap-5">
            <VoiceOrb level={orbLevel} mode={mode} size={280} className="mt-2" />
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t(`voice.state.${snap.state}`)}
            </p>
            {snap.state === "live" && <AiStatus diag={snap.diag} />}
            {active && <MicMeter rms={rms} muted={snap.muted} />}

            {/* The call bar: mute on the left, start/end on the right — like a phone call. */}
            <div className="flex items-center gap-4">
              {snap.state === "live" && (
                <button
                  type="button"
                  onClick={() => session?.setMuted(!snap.muted)}
                  aria-pressed={snap.muted}
                  aria-label={snap.muted ? t("voice.unmute") : t("voice.mute")}
                  title={snap.muted ? t("voice.unmute") : t("voice.mute")}
                  className={cn(
                    "flex size-14 items-center justify-center rounded-full border border-border bg-card transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    snap.muted && "border-destructive/50 bg-destructive/10 text-destructive",
                  )}
                >
                  {snap.muted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
                </button>
              )}
              <button
                type="button"
                onClick={() => (active ? session?.stop() : void session?.start())}
                disabled={snap.state === "closing"}
                aria-pressed={active}
                aria-label={active ? t("voice.stop") : t("voice.start")}
                title={active ? t("voice.stop") : t("voice.start")}
                className={cn(
                  "flex size-14 items-center justify-center rounded-full text-white shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                  active ? "bg-destructive hover:bg-destructive/90" : "bg-sky-500 hover:bg-sky-600",
                )}
              >
                {snap.state === "connecting" || snap.state === "closing" ? (
                  <Loader2 className="size-6 animate-spin" />
                ) : active ? (
                  <X className="size-6" />
                ) : (
                  <Phone className="size-6" />
                )}
              </button>
              {snap.state === "live" && snap.diag.playback === "blocked" && (
                <Button variant="outline" size="sm" onClick={() => session?.resumePlayback()}>
                  <Volume2 />
                  {t("voice.playAudio")}
                </Button>
              )}
            </div>
          </div>

          {snap.error && (
            <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
              {t(snap.error)}
            </p>
          )}
          {snap.notice && <p className="text-center text-xs text-muted-foreground">{t(snap.notice)}</p>}

          {snap.state !== "idle" && <DiagPanel diag={snap.diag} />}

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

const IDLE: LiveVoiceSnapshot = LiveVoiceSession.idleSnapshot;

const BAR_WEIGHTS = [0.35, 0.6, 0.85, 1, 0.85, 0.6, 0.35];

/**
 * The LOCAL microphone: bars from the Web Audio analyser, and in words whether it picks up sound.
 * Says nothing about the model having received it — that is the AI line and the diagnostics.
 */
function MicMeter({ rms, muted }: { rms: number | null; muted: boolean }) {
  const t = useT();
  const level = muted || rms === null ? 0 : displayLevel(rms);
  const label = muted
    ? t("voice.mic.muted")
    : rms === null
      ? t("voice.mic.noMeter")
      : rms >= SIGNAL_THRESHOLD
        ? t("voice.mic.signal")
        : t("voice.mic.silent");
  return (
    <div className="flex flex-col items-center gap-1" data-testid="mic-meter" data-level={level.toFixed(2)}>
      <div className="flex h-8 items-end gap-1" aria-hidden="true">
        {BAR_WEIGHTS.map((w, i) => (
          <span
            key={i}
            className={cn("w-1.5 rounded-full transition-[height] duration-75", muted ? "bg-muted-foreground/30" : "bg-primary")}
            style={{ height: `${Math.max(8, Math.round(level * w * 100))}%` }}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {muted ? <MicOff className="mr-1 inline size-3" /> : <Mic className="mr-1 inline size-3" />}
        {label}
      </p>
    </div>
  );
}

/** What the model is doing — from the session's own events and RTP, not from the local meter. */
function AiStatus({ diag }: { diag: LiveVoiceDiag }) {
  const t = useT();
  const activity = aiActivity(diag, Date.now());
  return (
    <p className="text-sm font-medium" data-testid="ai-status" data-activity={activity}>
      {t(`voice.ai.${activity}`)}
    </p>
  );
}

function fmtBytes(n: number | null): string {
  if (n === null) return "—";
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/**
 * The connection, for the person debugging "it says listening but nothing happens". States and
 * counters only: no audio, no transcript text, no SDP, no key.
 */
function DiagPanel({ diag }: { diag: LiveVoiceDiag }) {
  const t = useT();
  const rows: [string, string][] = [
    [t("voice.diag.peer"), diag.peer ?? "—"],
    [t("voice.diag.ice"), diag.ice ?? "—"],
    [t("voice.diag.channel"), diag.channel ?? "—"],
    [t("voice.diag.micTrack"), diag.micTrack ?? "—"],
    [t("voice.diag.sent"), fmtBytes(diag.sentBytes)],
    [t("voice.diag.remoteAudio"), diag.remoteAudio ? t("voice.diag.yes") : t("voice.diag.no")],
    [t("voice.diag.received"), fmtBytes(diag.receivedBytes)],
    [t("voice.diag.remoteLevel"), diag.remoteLevel === null ? "—" : diag.remoteLevel.toFixed(3)],
    [t("voice.diag.playback"), t(`voice.diag.playback.${diag.playback}`)],
    [t("voice.diag.lastError"), diag.lastErrorCode ?? "—"],
  ];
  const events = Object.entries(diag.events).sort(([a], [b]) => a.localeCompare(b));
  return (
    <details open className="rounded-md border border-border p-3 text-xs" data-testid="voice-diag">
      <summary className="cursor-pointer font-medium">{t("voice.diag.title")}</summary>
      <p className="mt-2 text-muted-foreground">{t("voice.diag.hint")}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-mono">{v}</dd>
          </React.Fragment>
        ))}
        <dt className="text-muted-foreground">{t("voice.diag.events")}</dt>
        <dd className="font-mono">
          {events.length === 0 ? "—" : events.map(([type, n]) => `${type} ×${n}`).join(", ")}
        </dd>
      </dl>
    </details>
  );
}

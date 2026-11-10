import * as React from "react";
import { AudioLines, Download, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatAudioTime, uploadDisplayName, uploadImageUrl } from "@/features/board/lib/markdown";
import { useT } from "@/i18n";

/**
 * An attached audio (a WhatsApp voice note, a meeting recording), played right in the bubble.
 *
 * The browser's own `<audio controls>` was the first version: a grey pill sized by the browser,
 * dropped in the middle of the sentence, reading `0:00 / 0:00` because the upload route did not
 * answer ranges (fixed in the back — see `parseUploadRange`). This player is the panel's own: one
 * round button, the name, the time and a seek bar, in the same card shape as the documents beside it.
 *
 * `preload="none"`: every read is a `docker exec` on the shared runner, so a conversation with twenty
 * voice notes must not fetch anything on open; the duration shows from the first play. Who
 * transcribes is the agent (vibehub_transcribe_audio), not the chat.
 *
 * A failure becomes a line saying the audio could not be played, with the download — never a button
 * that does nothing. It does not claim "unsupported format": Chrome reports a 404 (a file the sweep
 * removed, a runner that is down) with the same MEDIA_ERR_SRC_NOT_SUPPORTED as a codec it lacks, so
 * the error code cannot tell the two apart. An AbortError from `play()` is not a failure either: it
 * is a Pause clicked before the first bytes arrived.
 */
export function AudioAttachment({ cardId, file }: { cardId: string; file: string }) {
  const t = useT();
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [position, setPosition] = React.useState(0);
  const [duration, setDuration] = React.useState(Number.NaN);
  const [failed, setFailed] = React.useState(false);
  const src = uploadImageUrl(cardId, file);
  const name = uploadDisplayName(file);
  const total = formatAudioTime(duration);
  const elapsed = formatAudioTime(position) ?? "0:00";
  const started = playing || position > 0;

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch((err: unknown) => {
        if ((err as { name?: string } | null)?.name !== "AbortError") setFailed(true);
      });
    } else audio.pause();
  };

  return (
    <span
      data-testid="chat-audio"
      className="flex w-80 max-w-full items-center gap-3 rounded-lg border border-border/70 bg-background/60 p-2 pr-3 whitespace-normal"
    >
      {failed ? (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <AudioLines className="h-5 w-5" aria-hidden />
        </span>
      ) : (
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? t("chat.pauseAudio") : t("chat.playAudio")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {playing ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" />}
        </button>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground" title={name}>{name}</span>
          {!failed && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {started ? (total ? `${elapsed} / ${total}` : elapsed) : (total ?? "")}
            </span>
          )}
        </span>
        {failed ? (
          <span className="text-xs text-muted-foreground">{t("chat.audioFailed")}</span>
        ) : (
          <input
            type="range"
            min={0}
            max={total ? duration : 0}
            step="any"
            value={total ? Math.min(position, duration) : 0}
            disabled={!total}
            aria-label={t("chat.seekAudio")}
            onChange={(e) => {
              const audio = audioRef.current;
              if (audio) audio.currentTime = Number(e.target.value);
            }}
            className={cn("h-1.5 w-full cursor-pointer accent-primary", !total && "cursor-default opacity-50")}
          />
        )}
      </span>
      <a
        href={src}
        download={name}
        title={t("chat.downloadAudio")}
        aria-label={t("chat.downloadAudio")}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Download className="h-4 w-4" aria-hidden />
      </a>
      <audio
        ref={audioRef}
        src={src}
        preload="none"
        aria-label={t("chat.attachedAudio")}
        className="hidden"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={(e) => {
          setPlaying(false);
          e.currentTarget.currentTime = 0;
          setPosition(0);
        }}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

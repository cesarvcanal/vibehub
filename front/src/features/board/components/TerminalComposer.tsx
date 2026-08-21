import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, Mic, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/apiError";
import { AUDIO_MAX_BYTES, TRANSCRIBE_KEY, boardApi } from "@/features/board/api";

/**
 * A text field under the terminal: write (or speak, or paste, or drop an image) HERE, review, then
 * send.
 *
 * Raw xterm is a poor place to compose anything longer than a command — on a phone keyboard it is
 * hopeless, and even on a desktop a pasted image path or a transcription wants a look before it
 * goes. So input ACCUMULATES in this field and only reaches the session when you confirm: Enter or
 * the Send button. Shift+Enter breaks the line, like the terminal itself.
 *
 * Everything that arrives from somewhere other than the keyboard lands the same way — appended, not
 * sent. A pasted or dropped IMAGE is uploaded and its runner path appended; a RECORDING is
 * transcribed and its text appended. Speak three times and you get one message, because dictation
 * is not a series of commands: it is one thought, said in pieces, and the field is where it becomes
 * a sentence you are willing to stand behind.
 */
export interface TerminalComposerProps {
  /** Delivers the text to the session. The trailing carriage return is added here. */
  onSend: (text: string) => void;
  /** Uploads an image and resolves with its path inside the runner (null = nothing to append). */
  onUploadImage?: (file: File) => Promise<string | null>;
  /** The card recordings are transcribed against. Omit and there is no microphone at all. */
  cardId?: string;
  placeholder?: string;
  className?: string;
}

/** Image files in a paste or drop payload, ignoring everything else. */
export function imageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  if (out.length === 0) {
    for (const f of Array.from(data.files ?? [])) if (f.type.startsWith("image/")) out.push(f);
  }
  return out;
}

/** Appends a fragment to what is already typed, separated by a single space. PURE. */
export function appendFragment(current: string, fragment: string): string {
  const t = fragment.trim();
  if (!t) return current;
  return current ? `${current} ${t}` : t;
}

/**
 * Container formats to try, best first. Safari records `audio/mp4` and NOTHING else — it does not
 * support WebM at all — so a hard-coded `audio/webm` is a microphone that silently produces empty
 * recordings on every iPhone. `undefined` means "let the browser pick", which is the right answer
 * when it claims to support none of these.
 */
const AUDIO_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];

export function pickAudioMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return undefined;
  return AUDIO_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** Hard stop for a recording. Past this it is not a message, it is a phone call. */
export const AUDIO_MAX_RECORD_MS = 5 * 60 * 1000;

/**
 * Amplitude 0..1 from a time-domain buffer (`getByteTimeDomainData`, where 128 is silence). RMS
 * with a fixed gain, so a normal speaking voice fills the bars without anyone having to shout. PURE.
 */
export function levelFromTimeDomain(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = ((data[i] as number) - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 4);
}

/** Per-bar sensitivity: the middle one reacts most, which is what makes it read as a voice. */
export const BAR_GAINS = [0.55, 0.85, 1, 0.85, 0.55] as const;
/** Resting height, so the bars never vanish into nothing and look broken. */
const BAR_FLOOR = 0.12;

/** Bar heights (0..1) for a level. PURE. */
export function barHeights(level: number, gains: readonly number[] = BAR_GAINS): number[] {
  return gains.map((g) => Math.max(BAR_FLOOR, Math.min(1, level * g)));
}

type RecordingState = "idle" | "recording" | "processing";

export function TerminalComposer({
  onSend,
  onUploadImage,
  cardId,
  placeholder,
  className,
}: TerminalComposerProps) {
  const [text, setText] = React.useState("");
  const ref = React.useRef<HTMLTextAreaElement | null>(null);

  const append = React.useCallback((fragment: string) => {
    setText((prev) => appendFragment(prev, fragment));
  }, []);

  const send = (): void => {
    const value = text.trim();
    if (!value) return;
    onSend(`${value}\r`);
    setText("");
  };

  const upload = (files: File[]): void => {
    if (!onUploadImage) return;
    for (const file of files) {
      void onUploadImage(file).then((path) => {
        if (path) append(path);
      });
    }
  };

  /* ----------------------------------------------------------- voice input */

  // Cheap and cacheable: whether this install has a key at all decides between a working button and
  // a disabled one that says why, which is much better than a button that fails when pressed.
  const { data: voice } = useQuery({
    queryKey: TRANSCRIBE_KEY,
    queryFn: boardApi.transcribeStatus,
    enabled: Boolean(cardId),
    staleTime: 60_000,
  });
  const canRecord = Boolean(cardId && voice?.available);

  const [recording, setRecording] = React.useState<RecordingState>("idle");
  const [levels, setLevels] = React.useState<number[]>(() => barHeights(0));
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const capTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by Cancel: the recording is thrown away in `onstop` instead of being transcribed.
  const discardRef = React.useRef(false);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const analyserRef = React.useRef<AnalyserNode | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const appendRef = React.useRef(append);
  appendRef.current = append;
  const cardRef = React.useRef(cardId);
  cardRef.current = cardId;

  const stopTracks = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const stopVisualiser = React.useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    analyserRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx) void ctx.close().catch(() => undefined);
    setLevels(barHeights(0));
  }, []);

  /** Live level bars. Entirely optional — without an AudioContext the recording is unaffected. */
  const startVisualiser = React.useCallback((stream: MediaStream) => {
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        const live = analyserRef.current;
        if (!live) return;
        live.getByteTimeDomainData(data);
        setLevels(barHeights(levelFromTimeDomain(data)));
        frameRef.current = requestAnimationFrame(loop);
      };
      loop();
    } catch {
      /* no visualiser: the bars simply rest, and the recording carries on */
    }
  }, []);

  const clearCap = React.useCallback(() => {
    if (capTimerRef.current !== null) {
      clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
  }, []);

  /** Stop and transcribe. Also what the five-minute cap fires. */
  const finishRecording = React.useCallback(() => {
    clearCap();
    discardRef.current = false;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, [clearCap]);

  /** Stop and throw away: nothing is uploaded, nothing is transcribed, nothing is written. */
  const cancelRecording = React.useCallback(() => {
    clearCap();
    discardRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, [clearCap]);

  const transcribe = React.useCallback(async (blob: Blob) => {
    const id = cardRef.current;
    if (!id) return;
    if (blob.size === 0) return; // the browser gave us nothing — say nothing
    if (blob.size > AUDIO_MAX_BYTES) {
      toast.error("That recording is over 20 MB.");
      return;
    }
    // Recognition takes seconds, and a composer that just sits there looks broken.
    const pending = toast.loading("Transcribing…");
    try {
      const { text: spoken } = await boardApi.transcribeCardAudio(id, blob);
      // Appended, never sent: voice is the least reliable input there is, and the whole point of
      // this field is that you read it before the agent does.
      if (spoken) appendRef.current(spoken);
      else toast.error("Nothing was said in that recording.");
    } catch (error) {
      toast.error(apiErrorMessage(error, "Could not transcribe that recording"));
    } finally {
      toast.dismiss(pending);
    }
  }, []);

  const startRecording = React.useCallback(async () => {
    if (recording !== "idle" || !cardRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error("This browser cannot record audio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      startVisualiser(stream);
      const mimeType = pickAudioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopTracks();
        stopVisualiser();
        const discarded = discardRef.current;
        discardRef.current = false;
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });
        chunksRef.current = [];
        if (discarded) {
          setRecording("idle");
          return;
        }
        setRecording("processing");
        void transcribe(blob).finally(() => setRecording("idle"));
      };
      recorder.start();
      setRecording("recording");
      capTimerRef.current = setTimeout(finishRecording, AUDIO_MAX_RECORD_MS);
    } catch {
      toast.error("Could not reach the microphone — is permission blocked?");
      stopTracks();
      stopVisualiser();
    }
  }, [recording, startVisualiser, stopTracks, stopVisualiser, transcribe, finishRecording]);

  // Leaving the card mid-recording must not leave the microphone light on, and must not fire a
  // transcription into a screen that is gone: this cancels, it does not finish.
  React.useEffect(() => {
    return () => {
      clearCap();
      discardRef.current = true;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      stopTracks();
      stopVisualiser();
    };
  }, [clearCap, stopTracks, stopVisualiser]);

  const hint =
    placeholder ??
    (canRecord
      ? "Write or record — Enter sends, Shift+Enter for a new line"
      : "Write here — Enter sends, Shift+Enter for a new line");

  return (
    <div data-testid="terminal-composer" className={cn("flex shrink-0 items-end gap-2", className)}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        onPaste={(e) => {
          const files = imageFiles(e.clipboardData);
          if (files.length === 0) return; // plain text: the textarea's own paste
          e.preventDefault();
          upload(files);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          upload(imageFiles(e.dataTransfer));
        }}
        placeholder={hint}
        rows={1}
        aria-label="Message to the terminal"
        className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-border/60 bg-card/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
      />

      {cardId ? (
        <VoiceControl
          state={recording}
          available={canRecord}
          levels={levels}
          onStart={() => void startRecording()}
          onFinish={finishRecording}
          onCancel={cancelRecording}
        />
      ) : null}

      <Button type="button" size="sm" disabled={!text.trim()} onClick={send}>
        Send
      </Button>
    </div>
  );
}

/**
 * The microphone, in its three shapes.
 *
 * Recording deliberately has TWO exits, not one toggle: Cancel throws the audio away and Finish
 * transcribes it. A single "stop" button forces you to guess which one it is at the moment you have
 * just said something you did not mean to.
 */
function VoiceControl({
  state,
  available,
  levels,
  onStart,
  onFinish,
  onCancel,
}: {
  state: RecordingState;
  available: boolean;
  levels: number[];
  onStart: () => void;
  onFinish: () => void;
  onCancel: () => void;
}) {
  if (state === "processing") {
    return (
      <div
        data-testid="composer-mic-processing"
        role="status"
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-3 text-muted-foreground"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="text-[11px]">transcribing…</span>
      </div>
    );
  }

  if (state === "recording") {
    return (
      <div className="flex h-9 shrink-0 items-center gap-1 rounded-md border border-destructive/50 bg-card/80 px-1">
        <button
          type="button"
          data-testid="composer-mic-cancel"
          aria-label="Discard recording"
          title="Discard — nothing is transcribed and nothing is written"
          onClick={onCancel}
          className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div data-testid="composer-mic-bars" aria-hidden className="flex h-6 items-end gap-[3px] px-1">
          {levels.map((level, i) => (
            <span
              key={i}
              className="w-[3px] rounded-full bg-destructive"
              style={{ height: `${4 + level * 12}px` }}
            />
          ))}
        </div>
        <button
          type="button"
          data-testid="composer-mic-finish"
          aria-label="Finish recording"
          title="Finish — transcribes into the field; nothing is sent until you press Enter"
          onClick={onFinish}
          className="flex h-6 w-6 items-center justify-center rounded-full bg-destructive text-destructive-foreground transition-opacity hover:opacity-90"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      data-testid="composer-mic"
      aria-label="Record a message"
      title={
        available
          ? "Record a message — it is transcribed into the field, not sent"
          : "Voice input is not configured — add an OpenAI key in Settings"
      }
      className="h-9 w-9 shrink-0 text-muted-foreground"
      disabled={!available}
      onClick={onStart}
    >
      <Mic className="h-4 w-4" />
    </Button>
  );
}

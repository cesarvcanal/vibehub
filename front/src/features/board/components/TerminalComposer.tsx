import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, Mic, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/lib/useIsMobile";
import { apiErrorMessage } from "@/lib/apiError";
import { AUDIO_MAX_BYTES, TRANSCRIBE_KEY, boardApi } from "@/features/board/api";
import { t as translate, useT } from "@/i18n";

/**
 * A text field under the terminal: write (or speak, or paste, or drop an image) HERE, review, then
 * send.
 *
 * Raw xterm is a poor place to compose anything longer than a command — on a phone keyboard it is
 * hopeless, and even on a desktop a pasted image path or a transcription wants a look before it
 * goes. So input ACCUMULATES in this field and only reaches the session when you confirm: ENTER.
 * Shift+Enter breaks the line, like the terminal itself.
 *
 * There is no Send button. It was a third control competing for a phone's width with the field and
 * the microphone, to do what Enter already does on every keyboard including the on-screen one — so
 * the field took the width back and the promise moved into the `aria-label`, where the people who
 * need telling actually read it.
 *
 * Everything that arrives from somewhere other than the keyboard lands the same way — appended, not
 * sent. A RECORDING is transcribed and its text appended. Speak three times and you get one
 * message, because dictation is not a series of commands: it is one thought, said in pieces, and
 * the field is where it becomes a sentence you are willing to stand behind.
 *
 * ## Images are attachments, not paths
 *
 * Pasting a screenshot used to type `/work/.uploads/<card>/1712-shot.png` into the field: you
 * pasted a picture and got a filename, and there was no way to tell what you had pasted, or that
 * you had pasted twice. Now the image appears AS AN IMAGE the moment it lands — a thumbnail, with
 * its upload running behind it — and the path only exists at send time, appended to the message so
 * the agent can read the file. Press Enter while an upload is still flying and the message waits
 * for it rather than going out half-formed.
 *
 * ## The field remembers
 *
 * A half-written message is not lost by walking to another card: drafts (text AND attachments) are
 * kept per card and restored on the way back — see `draftStore` below.
 */
export interface TerminalComposerProps {
  /**
   * Hands the composed message over — the text alone, with no trailing carriage return: this is a
   * MESSAGE, not a keystroke, and whoever delivers it decides how it is submitted. A rejected
   * promise leaves the text in the field rather than pretending it went.
   */
  onSend: (text: string) => void | Promise<unknown>;
  /** Uploads an image and resolves with its path inside the runner (null = the upload failed). */
  onUploadImage?: (file: File) => Promise<string | null>;
  /** The card recordings are transcribed against. Omit and there is no microphone at all. */
  cardId?: string;
  /**
   * Empty by default, and that is the point: the field sits under a terminal that is already full
   * of words, and a grey sentence explaining what a text box is competes with the agent's output
   * every second of the day. The `aria-label` still says what it is, for anyone who needs telling.
   */
  placeholder?: string;
  /**
   * Is the card this composer belongs to the one on screen?
   *
   * Card views are no longer torn down when you look at another card — they stay mounted so the
   * session stays attached — which means "leaving the card" stopped being an unmount. A recording
   * has to end anyway: a microphone that keeps listening on a card you walked away from is the one
   * thing here that must never outlive the screen it belongs to.
   */
  active?: boolean;
  className?: string;
  /**
   * Take the keyboard on mount. THIS field is where a card is written from — opening a card and
   * finding the caret in the raw terminal is how a first message gets typed into the wrong place.
   * Off on a phone, where focusing a field throws the on-screen keyboard over half the screen.
   */
  autoFocus?: boolean;
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

/* ------------------------------------------------------------- attachments */

/** An image sitting in the field, from the instant it is pasted to the moment it is sent. */
export interface Attachment {
  id: string;
  name: string;
  /** `blob:` URL for the thumbnail. In memory only — it dies with the tab, the path does not. */
  previewUrl?: string;
  /** Where it landed inside the runner. Only a `ready` attachment has one. */
  path?: string;
  status: "uploading" | "ready" | "error";
}

/**
 * The text that actually goes to the agent: what was typed, then the paths of every image that
 * uploaded. The paths go LAST so the sentence still reads as a sentence — "look at this bug" comes
 * before the file, the way it does when a person writes it by hand. PURE.
 */
export function composeMessage(text: string, attachments: readonly Attachment[]): string {
  const paths = attachments.filter((a) => a.status === "ready" && a.path).map((a) => a.path as string);
  return [text.trim(), ...paths].filter(Boolean).join(" ");
}

/** true = something is still uploading, so a send has to wait for it. PURE. */
export function hasPendingUpload(attachments: readonly Attachment[]): boolean {
  return attachments.some((a) => a.status === "uploading");
}

/** Nothing typed and no image that made it: there is no message here. PURE. */
export function isEmptyDraft(text: string, attachments: readonly Attachment[]): boolean {
  return !text.trim() && !attachments.some((a) => a.status !== "error");
}

/* ------------------------------------------------------------------ drafts */

export const DRAFTS_KEY = "vibehub.composerDrafts";

/** What survives a reload: the words, and the images that finished uploading (paths, not blobs). */
export interface StoredDraft {
  text: string;
  attachments: { id: string; name: string; path: string }[];
}

/**
 * Drafts, per card, in TWO layers.
 *
 * The in-memory map is the one that matters while the app is open: it keeps the whole attachment,
 * blob preview included, so hopping to another card and back shows exactly the field you left —
 * thumbnails and all. localStorage is the reload layer, and a `blob:` URL cannot survive one, so
 * only the finished uploads (name + runner path) are written there.
 *
 * Nothing here is a cache to invalidate: the composer writes on every keystroke and clears on send.
 */
const memoryDrafts = new Map<string, { text: string; attachments: Attachment[] }>();

function readStoredDrafts(): Record<string, StoredDraft> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, StoredDraft>) : {};
  } catch {
    return {}; // private mode, quota, a corrupted value: a draft is never worth an exception
  }
}

function writeStoredDrafts(drafts: Record<string, StoredDraft>): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* nothing to do: the in-memory draft still works for this session */
  }
}

/** Remembers a card's unsent field. Called on every change — cheap, and the point of the feature. */
export function saveDraft(cardId: string, text: string, attachments: readonly Attachment[]): void {
  const list = [...attachments];
  if (!text.trim() && list.length === 0) {
    clearDraft(cardId);
    return;
  }
  memoryDrafts.set(cardId, { text, attachments: list });
  const drafts = readStoredDrafts();
  drafts[cardId] = {
    text,
    attachments: list
      .filter((a) => a.status === "ready" && a.path)
      .map((a) => ({ id: a.id, name: a.name, path: a.path as string })),
  };
  writeStoredDrafts(drafts);
}

/** The draft to restore for a card: the live one if this session wrote it, else the stored one. */
export function loadDraft(cardId: string): { text: string; attachments: Attachment[] } {
  const live = memoryDrafts.get(cardId);
  if (live) return { text: live.text, attachments: [...live.attachments] };
  const stored = readStoredDrafts()[cardId];
  if (!stored) return { text: "", attachments: [] };
  return {
    text: typeof stored.text === "string" ? stored.text : "",
    // No `previewUrl`: a blob from a previous page load points at nothing. The chip falls back to
    // the file's name, which is still enough to know what is attached.
    attachments: (Array.isArray(stored.attachments) ? stored.attachments : [])
      .filter((a) => a && typeof a.path === "string")
      .map((a) => ({ id: a.id, name: a.name, path: a.path, status: "ready" as const })),
  };
}

/** Tests only: forget every draft, in both layers. */
export function resetDraftsForTesting(): void {
  memoryDrafts.clear();
  try {
    localStorage.removeItem(DRAFTS_KEY);
  } catch {
    /* nothing stored */
  }
}

/** Forgets a card's draft — on send, and when the card itself is gone. */
export function clearDraft(cardId: string): void {
  memoryDrafts.delete(cardId);
  const drafts = readStoredDrafts();
  if (!(cardId in drafts)) return;
  delete drafts[cardId];
  writeStoredDrafts(drafts);
}

/** Ids that do not depend on `crypto.randomUUID` (absent in some jsdom/webview combinations). */
let attachmentSeq = 0;
function nextAttachmentId(): string {
  attachmentSeq += 1;
  return `att-${Date.now().toString(36)}-${attachmentSeq}`;
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

/** `m:ss` for a recording's elapsed time. Minutes are not padded; seconds always are. PURE. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${String(seconds).padStart(2, "0")}`;
}

type RecordingState = "idle" | "recording" | "processing";

export function TerminalComposer({
  onSend,
  onUploadImage,
  cardId,
  placeholder,
  active = true,
  className,
  autoFocus = true,
}: TerminalComposerProps) {
  const t = useT();
  const isMobile = useIsMobile();
  // The draft key. A composer with no card (the runner console) keeps its field in memory only.
  const draftKey = cardId ?? "";
  const initial = React.useMemo(() => (draftKey ? loadDraft(draftKey) : { text: "", attachments: [] }), [draftKey]);
  const [text, setText] = React.useState(initial.text);
  const [attachments, setAttachments] = React.useState<Attachment[]>(initial.attachments);
  const [sending, setSending] = React.useState(false);
  /**
   * Enter was pressed while an image was still uploading. The message is not dropped and it is not
   * sent without its picture: it goes the moment the last upload lands (see the effect below).
   */
  const [sendWhenReady, setSendWhenReady] = React.useState(false);
  const ref = React.useRef<HTMLTextAreaElement | null>(null);

  // Switching cards swaps the whole field for that card's draft — including the one just restored
  // on mount, which is why this runs on `draftKey` and not only on the state initialiser.
  React.useEffect(() => {
    const draft = draftKey ? loadDraft(draftKey) : { text: "", attachments: [] };
    setText(draft.text);
    setAttachments(draft.attachments);
    setSendWhenReady(false);
  }, [draftKey]);

  // Persisted on every change: what makes leaving the card safe. Uploads in flight are written too
  // (as nothing, since they have no path yet) — the store only ever keeps what can be restored.
  React.useEffect(() => {
    if (!draftKey) return;
    saveDraft(draftKey, text, attachments);
  }, [draftKey, text, attachments]);

  /**
   * The field takes the keyboard when the card opens — and again when you come BACK to this card.
   *
   * Card views are not unmounted any more (the deck keeps every card you opened attached), so
   * "mounted" stopped meaning "just opened": without `active` in here, returning to a card would
   * leave the caret wherever it was and the first thing you typed would go nowhere.
   */
  React.useEffect(() => {
    if (!autoFocus || isMobile || !active) return;
    // After the terminal's own mount focus (the websocket grabs it on open), or the caret lands in
    // xterm and the first thing typed goes into the raw session.
    const id = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [autoFocus, isMobile, draftKey, active]);

  const append = React.useCallback((fragment: string) => {
    setText((prev) => appendFragment(prev, fragment));
  }, []);

  const removeAttachment = React.useCallback((id: string) => {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  /**
   * The one place a message leaves this component. Everything it needs is already decided: the
   * paths are appended by `composeMessage`, and the field is only cleared once the caller has
   * accepted the message — a queue that rejected it leaves the words where you can see them.
   */
  const deliver = React.useCallback(
    async (value: string, attached: Attachment[]) => {
      const body = composeMessage(value, attached);
      if (!body) return;
      setSending(true);
      try {
        await onSend(body);
        attached.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
        setText("");
        setAttachments([]);
        if (draftKey) clearDraft(draftKey);
        if (!isMobile) ref.current?.focus();
      } catch {
        /* the caller has already said what went wrong; the draft stays put */
      } finally {
        setSending(false);
      }
    },
    [draftKey, isMobile, onSend],
  );

  const send = (): void => {
    if (sending) return;
    if (isEmptyDraft(text, attachments)) return;
    // An upload still in flight: remember the intent instead of sending the text without its image.
    if (hasPendingUpload(attachments)) {
      setSendWhenReady(true);
      return;
    }
    void deliver(text, attachments);
  };

  // The deferred send, fired by the last upload finishing.
  React.useEffect(() => {
    if (!sendWhenReady || sending) return;
    if (hasPendingUpload(attachments)) return;
    setSendWhenReady(false);
    if (isEmptyDraft(text, attachments)) return;
    void deliver(text, attachments);
  }, [sendWhenReady, sending, attachments, text, deliver]);

  /**
   * A pasted or dropped image appears IMMEDIATELY as a thumbnail and uploads behind it. The preview
   * comes from the local file, so it is on screen in the same frame as the paste — the upload only
   * decides whether the chip ends up carrying a path or an error.
   */
  const upload = (files: File[]): void => {
    if (!onUploadImage) return;
    for (const file of files) {
      const id = nextAttachmentId();
      const previewUrl = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
      setAttachments((prev) => [
        ...prev,
        { id, name: file.name || t("composer.pastedImage"), previewUrl, status: "uploading" },
      ]);
      void onUploadImage(file).then(
        (path) =>
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, path: path ?? undefined, status: path ? "ready" : "error" } : a)),
          ),
        () => setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "error" } : a))),
      );
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
  /**
   * How long the current recording has been running. Without it a phone recording is a red button
   * and nothing else — you cannot tell a five-second thought from a two-minute one you forgot to
   * stop, and the five-minute cap arrives as a surprise.
   */
  const [elapsedMs, setElapsedMs] = React.useState(0);
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
      toast.error(translate("composer.recordingTooBig"));
      return;
    }
    // Recognition takes seconds, and a composer that just sits there looks broken.
    const pending = toast.loading(translate("composer.transcribing"));
    try {
      const { text: spoken } = await boardApi.transcribeCardAudio(id, blob);
      // Appended, never sent: voice is the least reliable input there is, and the whole point of
      // this field is that you read it before the agent does.
      if (spoken) appendRef.current(spoken);
      else toast.error(translate("composer.nothingSaid"));
    } catch (error) {
      toast.error(apiErrorMessage(error, translate("composer.transcribeError")));
    } finally {
      toast.dismiss(pending);
    }
  }, []);

  const startRecording = React.useCallback(async () => {
    if (recording !== "idle" || !cardRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error(translate("composer.cannotRecord"));
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
      toast.error(translate("composer.micBlocked"));
      stopTracks();
      stopVisualiser();
    }
  }, [recording, startVisualiser, stopTracks, stopVisualiser, transcribe, finishRecording]);

  React.useEffect(() => {
    if (recording !== "recording") {
      setElapsedMs(0);
      return;
    }
    const started = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - started), 250);
    return () => clearInterval(id);
  }, [recording]);

  // Switching to another card mid-recording ends it the same way the Cancel button does. Nothing is
  // uploaded and nothing is written: a thought you stopped saying halfway through is not a message,
  // and the microphone must not stay live behind a screen you are no longer looking at.
  React.useEffect(() => {
    if (active) return;
    if (recorderRef.current?.state === "recording") cancelRecording();
  }, [active, cancelRecording]);

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

  /**
   * Grow with the text, up to `max-h-48`. The field starts at three lines because that is roughly
   * what a dictated thought is, and shrinking back down when the text is deleted matters as much
   * as growing: a box stuck at ten lines is ten lines stolen from the terminal.
   */
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const recordingNow = recording === "recording";

  return (
    <div
      data-testid="terminal-composer"
      className={cn("flex shrink-0 flex-col gap-1.5", className)}
    >
      {/* What you pasted, as what you pasted. Above the field, so it never fights the caret. */}
      {attachments.length > 0 ? (
        <AttachmentStrip
          attachments={attachments}
          waiting={sendWhenReady}
          onRemove={removeAttachment}
        />
      ) : null}

      {/* The field and the microphone. Vertically centred: the field grows with the text and a
          bottom-aligned 48px circle drifts away from it as it does. */}
      <div data-testid="composer-row" className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
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
          placeholder={placeholder ?? t("composer.placeholder")}
          rows={3}
          aria-label={t("composer.aria")}
          /*
           * `text-base` below `md` is not a type choice, it is the iOS keyboard fix: Safari zooms
           * the page in on any focused field under 16px and never zooms back out, which is exactly
           * the "everything goes strange when I open the keyboard" the owner hit. The desktop keeps
           * the 14px it always had.
           */
          className="max-h-48 min-h-24 w-full resize-none overflow-y-auto rounded-md border border-border bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 md:text-sm"
        />
        {/* While recording with nothing typed, the empty field is where the voice goes: the bars
            live there rather than crowding the microphone. They vanish the moment there is text. */}
        {recordingNow && !text ? (
          <div
            data-testid="composer-field-bars"
            aria-hidden
            className="pointer-events-none absolute left-3 top-3 flex items-end gap-[3px]"
          >
            {levels.map((level, i) => (
              <span
                key={i}
                className="w-[3px] rounded-full bg-destructive"
                style={{ height: `${4 + level * 14}px` }}
              />
            ))}
          </div>
        ) : null}
      </div>

      {cardId ? (
        <VoiceControl
          state={recording}
          available={canRecord}
          levels={levels}
          mobile={isMobile}
          elapsed={formatElapsed(elapsedMs)}
          onStart={() => void startRecording()}
          onFinish={finishRecording}
          onCancel={cancelRecording}
        />
      ) : null}
      </div>
    </div>
  );
}

/**
 * The row of pasted images.
 *
 * A thumbnail, not a filename: the whole reason this exists is that a screenshot pasted into a text
 * field used to become `/work/.uploads/…/1712-shot.png`, which tells you nothing about which of the
 * three screenshots you just took it is. The upload runs behind the picture — a spinner over the
 * corner while it flies, and a chip that says so if it fails, in which case it is simply not part
 * of the message (and can be dropped with the ✕ like any other).
 */
function AttachmentStrip({
  attachments,
  waiting,
  onRemove,
}: {
  attachments: readonly Attachment[];
  /** Enter was pressed and the message is waiting on these uploads. */
  waiting: boolean;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  return (
    <div data-testid="composer-attachments" className="flex flex-wrap items-center gap-2">
      {attachments.map((a) => (
        <div
          key={a.id}
          data-testid="composer-attachment"
          data-status={a.status}
          title={a.name}
          className={cn(
            "group relative h-16 w-16 shrink-0 overflow-hidden rounded-md border bg-muted/40",
            a.status === "error" ? "border-destructive/60" : "border-border/60",
          )}
        >
          {a.previewUrl ? (
            <img src={a.previewUrl} alt={a.name} className="h-full w-full object-cover" />
          ) : (
            // Restored after a reload: the blob is gone, the file is not. Its name is the picture.
            <div className="flex h-full w-full items-center justify-center px-1 text-center text-[9px] leading-tight text-muted-foreground">
              <span className="line-clamp-3 break-all">{a.name}</span>
            </div>
          )}

          {a.status === "uploading" ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60">
              <Loader2 className="h-4 w-4 animate-spin text-foreground" />
            </div>
          ) : null}
          {a.status === "error" ? (
            <div className="absolute inset-x-0 bottom-0 bg-destructive/80 px-1 py-0.5 text-center text-[9px] text-destructive-foreground">
              {t("composer.uploadFailed")}
            </div>
          ) : null}

          <button
            type="button"
            data-testid="composer-attachment-remove"
            aria-label={t("composer.removeImage", { name: a.name })}
            onClick={() => onRemove(a.id)}
            className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 md:h-4 md:w-4"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      {waiting ? (
        <span data-testid="composer-waiting-upload" className="text-[11px] text-muted-foreground">
          {t("composer.sendingAfterUpload")}
        </span>
      ) : null}
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
  mobile,
  elapsed,
  onStart,
  onFinish,
  onCancel,
}: {
  state: RecordingState;
  available: boolean;
  levels: number[];
  /** A phone: 48px targets, and the level bars move into the field instead of into the button. */
  mobile: boolean;
  /** `m:ss` since the recording started. */
  elapsed: string;
  onStart: () => void;
  onFinish: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  if (state === "processing") {
    return (
      <div
        data-testid="composer-mic-processing"
        role="status"
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-3 text-muted-foreground",
          mobile ? "h-12 rounded-full" : "h-9",
        )}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="text-[11px]">{t("composer.transcribingShort")}</span>
      </div>
    );
  }

  if (state === "recording") {
    return (
      <div
        data-testid="composer-mic-recording"
        className={cn(
          "flex shrink-0 items-center gap-1 border border-destructive/50 bg-card/80",
          // Recording is the one state worth seeing from across the room: red, and a ring that
          // breathes. On a phone the whole strip is 44 tall so the two exits stay thumb-sized.
          mobile ? "rec-ring h-12 gap-1.5 rounded-full px-2" : "h-9 rounded-md px-1",
        )}
      >
        <button
          type="button"
          data-testid="composer-mic-cancel"
          aria-label={t("composer.discard")}
          title={t("composer.discardHint")}
          onClick={onCancel}
          className={cn(
            "flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            mobile ? "h-10 w-10" : "h-6 w-6",
          )}
        >
          <X className={mobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
        </button>
        {mobile ? (
          <span
            data-testid="composer-mic-elapsed"
            className="min-w-[2.5rem] text-center font-mono text-[13px] tabular-nums text-destructive"
          >
            {elapsed}
          </span>
        ) : (
          <div data-testid="composer-mic-bars" aria-hidden className="flex h-6 items-end gap-[3px] px-1">
            {levels.map((level, i) => (
              <span
                key={i}
                className="w-[3px] rounded-full bg-destructive"
                style={{ height: `${4 + level * 12}px` }}
              />
            ))}
          </div>
        )}
        <button
          type="button"
          data-testid="composer-mic-finish"
          aria-label={t("composer.finish")}
          title={t("composer.finishHint")}
          onClick={onFinish}
          className={cn(
            "flex items-center justify-center rounded-full bg-destructive text-destructive-foreground transition-opacity hover:opacity-90",
            mobile ? "h-10 w-10" : "h-6 w-6",
          )}
        >
          <Check className={mobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
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
      aria-label={t("composer.record")}
      title={available ? t("composer.recordHint") : t("composer.voiceUnavailable")}
      className="h-12 w-12 shrink-0 rounded-full text-muted-foreground md:h-9 md:w-9 md:rounded-md"
      disabled={!available}
      onClick={onStart}
    >
      <Mic className="h-4 w-4" />
    </Button>
  );
}

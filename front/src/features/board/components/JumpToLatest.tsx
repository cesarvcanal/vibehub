import * as React from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

/**
 * STICKY-BOTTOM + "JUMP TO LATEST" — the standard chat scroll behaviour, shared by the native chat
 * (SdkChatView) and the transcript chat (ChatView):
 *
 *  - at the bottom, the conversation follows new content on its own (sticky);
 *  - scrolled UP, nothing yanks the reader down — a discreet floating arrow appears instead;
 *  - new content arriving while scrolled up puts a "new message" label on the arrow;
 *  - clicking scrolls smoothly to the end; reaching the end hides the button.
 */

/** How close to the end still counts as "at the bottom" (px). */
export const STICK_THRESHOLD_PX = 120;

export interface StickToBottom {
  /** Put this on the scrollable element. */
  scrollerRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Wire to the scroller's onScroll. */
  onScroll: () => void;
  /** The reader is at (or near) the end. */
  atBottom: boolean;
  /** New content landed while the reader was scrolled up. */
  newSince: boolean;
  /** Scroll to the end (smooth) and re-arm the sticky follow. */
  scrollToBottom: () => void;
}

/**
 * `content` is whatever changing means "the conversation gained content" (the rows array). While
 * the reader is at the bottom the effect keeps them there; while they are scrolled up it only
 * remembers that something new arrived.
 */
export function useStickToBottom(content: unknown): StickToBottom {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const stickRef = React.useRef(true);
  const [atBottom, setAtBottom] = React.useState(true);
  const [newSince, setNewSince] = React.useState(false);
  const first = React.useRef(true);

  const onScroll = React.useCallback((): void => {
    const el = scrollerRef.current;
    if (!el) return;
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    stickRef.current = at;
    setAtBottom(at);
    if (at) setNewSince(false);
  }, []);

  const scrollToBottom = React.useCallback((): void => {
    const el = scrollerRef.current;
    if (el) {
      if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      else el.scrollTop = el.scrollHeight;
    }
    stickRef.current = true;
    setAtBottom(true);
    setNewSince(false);
  }, []);

  React.useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Scrolled up: never yank — just note that the conversation moved on (skip the mount pass,
    // which is the replay drawing what was already there).
    if (!first.current) setNewSince(true);
  }, [content]);
  React.useEffect(() => {
    first.current = false;
  }, []);

  return { scrollerRef, onScroll, atBottom, newSince, scrollToBottom };
}

/**
 * The floating arrow. Render INSIDE a `relative` wrapper around the scroller; it sits just above
 * the composer edge and only exists while the reader is away from the end.
 */
export function JumpToLatest({ stick }: { stick: StickToBottom }) {
  const t = useT();
  if (stick.atBottom) return null;
  return (
    <button
      type="button"
      data-testid="jump-latest"
      aria-label={t("chat.jumpLatest")}
      onClick={stick.scrollToBottom}
      className={cn(
        "absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/70",
        "bg-background/95 px-2.5 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur",
        "hover:text-foreground",
      )}
    >
      <ArrowDown className="h-3.5 w-3.5" />
      {stick.newSince ? (
        <span data-testid="jump-latest-new" className="font-medium text-foreground">
          {t("chat.newMessage")}
        </span>
      ) : null}
    </button>
  );
}

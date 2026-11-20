import * as React from "react";
import { useT } from "@/i18n";

export const REVIEW_WIDTH_STORAGE_KEY = "vibehub.reviewPanelWidth";
const MIN_WIDTH_PX = 384;
const TERMINAL_MIN_WIDTH_PX = 320;
const KEYBOARD_STEP_PX = 32;

function readStoredWidth(): number | null {
  const stored = Number(localStorage.getItem(REVIEW_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

export function ReviewColumn({ children }: { children: React.ReactNode }) {
  const t = useT();
  const columnRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<AbortController | null>(null);
  const [width, setWidth] = React.useState<number | null>(readStoredWidth);

  React.useEffect(() => () => dragRef.current?.abort(), []);

  const clampWidth = (wanted: number): number => {
    const rowWidth = columnRef.current!.parentElement!.clientWidth;
    return Math.round(Math.max(MIN_WIDTH_PX, Math.min(wanted, rowWidth - TERMINAL_MIN_WIDTH_PX)));
  };
  const saveWidth = (next: number) => {
    setWidth(next);
    localStorage.setItem(REVIEW_WIDTH_STORAGE_KEY, String(next));
  };
  const widthAt = (clientX: number) => clampWidth(columnRef.current!.getBoundingClientRect().right - clientX);

  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const drag = new AbortController();
    dragRef.current = drag;
    window.addEventListener("pointermove", (move) => setWidth(widthAt(move.clientX)), { signal: drag.signal });
    window.addEventListener("pointerup", (up) => {
      saveWidth(widthAt(up.clientX));
      drag.abort();
    }, { signal: drag.signal });
  };

  const resizeByKey = (event: React.KeyboardEvent) => {
    const direction = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const current = width ?? columnRef.current!.getBoundingClientRect().width;
    saveWidth(clampWidth(current + direction * KEYBOARD_STEP_PX));
  };

  const resetWidth = () => {
    setWidth(null);
    localStorage.removeItem(REVIEW_WIDTH_STORAGE_KEY);
  };

  return (
    <div
      ref={columnRef}
      data-testid="review-column"
      style={width === null ? undefined : ({ "--review-width": `${width}px` } as React.CSSProperties)}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col lg:w-[var(--review-width,30rem)] lg:max-w-[calc(100%_-_20rem)] lg:flex-none xl:w-[var(--review-width,50%)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("review.panel.resize")}
        title={t("review.panel.resize")}
        aria-valuenow={width ?? undefined}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={resizeByKey}
        onDoubleClick={resetWidth}
        className="group absolute -left-2 top-0 z-10 hidden h-full w-2 cursor-col-resize touch-none focus-visible:outline-none lg:block"
      >
        <span className="mx-auto block h-full w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-sky-400/60 group-focus-visible:bg-sky-400" />
      </div>
      {children}
    </div>
  );
}

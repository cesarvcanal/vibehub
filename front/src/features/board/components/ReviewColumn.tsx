import * as React from "react";
import { useT } from "@/i18n";

export const REVIEW_WIDTH_STORAGE_KEY = "vibehub.reviewPanelWidth";
const MIN_WIDTH_PX = 384;
const BESIDE_PANE_MIN_WIDTH_PX = 320;
const KEYBOARD_STEP_PX = 32;
const WIDTH_DELTA_BY_KEY = new Map([["ArrowLeft", KEYBOARD_STEP_PX], ["ArrowRight", -KEYBOARD_STEP_PX]]);

function readStoredWidth(): number | null {
  const stored = Number(localStorage.getItem(REVIEW_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

interface ColumnMeasure {
  columnWidth: number;
  rowWidth: number;
}

export function ReviewColumn({ besidePanes, children }: { besidePanes: number; children: React.ReactNode }) {
  const t = useT();
  const columnRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<AbortController | null>(null);
  const [width, setWidth] = React.useState<number | null>(readStoredWidth);
  const [measure, setMeasure] = React.useState<ColumnMeasure | null>(null);
  const besideReserve = besidePanes * BESIDE_PANE_MIN_WIDTH_PX;

  React.useEffect(() => () => dragRef.current?.abort(), []);

  React.useLayoutEffect(() => {
    const column = columnRef.current!;
    const row = column.parentElement!;
    const measureColumn = () => setMeasure({ columnWidth: Math.round(column.getBoundingClientRect().width), rowWidth: row.clientWidth });
    measureColumn();
    const observer = new ResizeObserver(measureColumn);
    observer.observe(column);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  const clampWidth = (wanted: number): number => {
    const rowWidth = columnRef.current!.parentElement!.clientWidth;
    return Math.round(Math.max(MIN_WIDTH_PX, Math.min(wanted, rowWidth - besideReserve)));
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
    const widthDelta = WIDTH_DELTA_BY_KEY.get(event.key);
    if (widthDelta === undefined) return;
    event.preventDefault();
    const current = width ?? columnRef.current!.getBoundingClientRect().width;
    saveWidth(clampWidth(current + widthDelta));
  };

  const resetWidth = () => {
    setWidth(null);
    localStorage.removeItem(REVIEW_WIDTH_STORAGE_KEY);
  };

  return (
    <div
      ref={columnRef}
      data-testid="review-column"
      style={{ "--review-beside-reserve": `${besideReserve}px`, ...(width === null ? {} : { "--review-width": `${width}px` }) } as React.CSSProperties}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col lg:w-[var(--review-width,30rem)] lg:max-w-[calc(100%_-_var(--review-beside-reserve))] lg:flex-none xl:w-[var(--review-width,50%)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("review.panel.resize")}
        title={t("review.panel.resize")}
        aria-valuemin={MIN_WIDTH_PX}
        aria-valuemax={measure ? measure.rowWidth - besideReserve : undefined}
        aria-valuenow={width ?? measure?.columnWidth}
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

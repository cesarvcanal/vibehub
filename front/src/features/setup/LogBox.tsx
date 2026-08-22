import * as React from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import type { LogLine } from "@/features/setup/useRunnerLogs";

/** Auto-scrolling output pane. Sticks to the bottom unless you scroll up to read something. */
export function LogBox({
  lines,
  empty,
  className,
}: {
  lines: LogLine[];
  empty?: string;
  className?: string;
}) {
  const t = useT();
  const ref = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);

  React.useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-label={t("log.aria")}
      className={cn("terminal-surface h-56 overflow-auto p-3", className)}
    >
      {lines.length === 0 ? (
        <p className="text-muted-foreground">{empty ?? t("log.waiting")}</p>
      ) : (
        lines.map((line) => (
          <div
            key={line.id}
            className={cn("whitespace-pre-wrap break-words", line.error && "text-destructive")}
          >
            {line.text}
          </div>
        ))
      )}
    </div>
  );
}

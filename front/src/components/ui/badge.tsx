import * as React from "react";
import { cn } from "@/lib/utils";

/** Healthy is green; the brand blue is reserved for things you can interact with. */
export type BadgeTone = "ok" | "warn" | "critical" | "muted" | "info";

const TONES: Record<BadgeTone, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  critical: "border-destructive/40 bg-destructive/10 text-destructive",
  muted: "border-border/60 bg-card/40 text-muted-foreground",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-400",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "muted", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

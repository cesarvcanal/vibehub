import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The mark: a prompt `>_` cut out of a rounded tile filled with the brand gradient. Same shape
 * language as the favicon, same blue -> purple ramp as `.brand-gradient`.
 *
 * The gradient id is per-instance (`useId`) so two lockups on one page never collide.
 */
function Mark({ className }: { className?: string }) {
  const id = React.useId();
  const fill = `brand-mark-${id.replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 44 44" aria-hidden className={cn("shrink-0 select-none", className)}>
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="hsl(190 92% 55%)" />
          <stop offset="50%" stopColor="hsl(212 90% 56%)" />
          <stop offset="100%" stopColor="hsl(265 72% 60%)" />
        </linearGradient>
      </defs>
      <rect width="44" height="44" rx="12" fill={`url(#${fill})`} />
      <path
        d="M14 15l7 7-7 7"
        fill="none"
        stroke="#fff"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M24.5 29h6.5" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
    </svg>
  );
}

export interface LogoProps {
  /**
   * `md` is the header lockup (44px mark, 26px wordmark). `side` is the ~72% version used where a
   * panel needs the brand without the full header, e.g. the top of a sidebar.
   */
  size?: "md" | "side";
  className?: string;
}

/** Brand lockup: the mark, then "vibehub" with the second half carrying the brand gradient. */
export function Logo({ size = "md", className }: LogoProps) {
  const side = size === "side";
  return (
    <span className={cn("flex select-none items-center", side ? "gap-2" : "gap-3", className)}>
      <Mark className={side ? "h-8 w-8" : "h-11 w-11"} />
      <span
        className={cn(
          "font-extrabold leading-none tracking-tight",
          side ? "text-[19px]" : "text-[26px]",
        )}
      >
        vibe<span className="brand-gradient-text">hub</span>
      </span>
    </span>
  );
}

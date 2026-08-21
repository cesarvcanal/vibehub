import { cn } from "@/lib/utils";

/** Wordmark: a prompt chevron and the name, set in the mono face the rest of the tool uses. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex select-none items-center gap-2", className)}>
      <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4 text-primary">
        <path
          d="M4 6l5 6-5 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M13 18h7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <span className="font-mono text-sm font-semibold tracking-tight">vibehub</span>
    </span>
  );
}

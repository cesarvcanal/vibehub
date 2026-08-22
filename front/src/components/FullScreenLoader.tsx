import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

/**
 * Shown while we still do not know whether there is a session or whether the install is fresh.
 * Deliberately quiet — a spinner that flashes for 80ms is worse than a calm placeholder.
 */
export function FullScreenLoader({ label }: { label?: string }) {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center px-6"
    >
      <div className="flex items-center gap-3 font-mono text-sm text-muted-foreground">
        <span
          className={cn("inline-block h-2 w-2 rounded-full bg-primary")}
          style={{ animation: "vh-pulse 1.2s ease-in-out infinite" }}
        />
        {label ?? t("common.loading")}
      </div>
    </div>
  );
}

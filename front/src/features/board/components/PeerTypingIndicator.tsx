import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/** "cesar" → "Cesar": usernames are lowercase handles; the sentence reads as a name. PURE. */
function displayName(name: string): string {
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/**
 * "Cesar está digitando…" — another person writing in THIS card right now, drawn right above the
 * composer with three bouncing dots (the Aceternity LoaderOne motion, see `typing-dot` in
 * tailwind.config.js). `names` comes already filtered and sorted (lib/peerTyping.ts `typingNames`).
 *
 * The `aria-live` region is ALWAYS mounted, empty when nobody types: screen readers announce a
 * change inside a live region, not a region that is inserted already holding its text.
 */
export function PeerTypingIndicator({ names, className }: { names: readonly string[]; className?: string }) {
  const t = useT();
  const shown = names.map(displayName);
  const label =
    shown.length === 0
      ? ""
      : shown.length === 1
      ? t("sdk.peerTyping.single", { name: shown[0]! })
      : shown.length === 2
        ? t("sdk.peerTyping.pair", { a: shown[0]!, b: shown[1]! })
        : t("sdk.peerTyping.more", { name: shown[0]!, n: shown.length - 1 });
  return (
    <div role="status" aria-live="polite">
      {label ? (
        <div
          data-testid="sdk-peer-typing"
          className={cn("flex items-center gap-2 px-1 text-xs text-muted-foreground", className)}
        >
          <span className="flex items-end gap-[3px]" aria-hidden="true">
            {[0, 200, 400].map((delay) => (
              <span
                key={delay}
                className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-gradient-to-b from-neutral-400 to-neutral-300 motion-reduce:animate-none dark:from-neutral-300 dark:to-neutral-500"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          <span className="min-w-0 truncate">{label}…</span>
        </div>
      ) : null}
    </div>
  );
}

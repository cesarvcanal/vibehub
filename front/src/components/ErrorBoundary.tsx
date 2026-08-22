import * as React from "react";
import { t as translate } from "@/i18n";

/**
 * The last line of defence between a render-time exception and a BLANK PAGE.
 *
 * React 18 unmounts the whole tree when a render throws and nothing catches it. With no boundary
 * anywhere the result is not an error — it is an empty document with the app's dark background and
 * nothing on it, no message, no button, no hint that reloading is the way out. That is what a
 * "black screen that will not go away" actually is, and it is indistinguishable from a hung server,
 * which is why it costs so much time: the reflex is to reload, and a reload that hits the same data
 * lands on the same blank page.
 *
 * So: catch it, SAY it, and offer the reload. The message is the real error text — this is a
 * self-hosted developer tool and its user is the person who can fix the bug.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The console is where the stack is actually readable, and it is the one place a report can be
    // copied from. Never swallow it.
    console.error("[vibehub] render crashed", error, info.componentStack);
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-lg space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <h1 className="text-sm font-semibold text-amber-500">{translate("error.crashTitle")}</h1>
          <p className="text-xs leading-relaxed text-muted-foreground">{translate("error.crashBody")}</p>
          <pre className="max-h-40 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] text-muted-foreground">
            {error.message || String(error)}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            {translate("error.crashReload")}
          </button>
        </div>
      </div>
    );
  }
}

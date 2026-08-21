import * as React from "react";
import { wsUrl } from "@/lib/ws";

export interface LogLine {
  id: number;
  text: string;
  /** Rendered in the destructive colour. */
  error?: boolean;
}

export type LogConnection = "idle" | "connecting" | "open" | "closed";

const MAX_LINES = 500;

/**
 * Live tail of `WS /api/runner/logs`.
 *
 * Provisioning pulls an image and installs a toolchain — it is slow and it fails in interesting
 * ways, so the operator gets the real output rather than a spinner and a shrug. Lines are capped
 * so a chatty build cannot grow the DOM without bound.
 */
export function useRunnerLogs(enabled: boolean) {
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const [connection, setConnection] = React.useState<LogConnection>("idle");
  const nextId = React.useRef(0);

  const append = React.useCallback((text: string, error = false) => {
    setLines((prev) => {
      const line = { id: nextId.current++, text, error };
      const next = prev.length >= MAX_LINES ? [...prev.slice(1), line] : [...prev, line];
      return next;
    });
  }, []);

  const clear = React.useCallback(() => setLines([]), []);

  React.useEffect(() => {
    if (!enabled) return;
    if (typeof WebSocket === "undefined") return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl("/api/runner/logs"));
    } catch {
      setConnection("closed");
      return;
    }
    setConnection("connecting");

    socket.onopen = () => setConnection("open");
    socket.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw) return;
      // The server may send bare text or a small JSON envelope; accept both.
      if (raw.startsWith("{")) {
        try {
          const parsed = JSON.parse(raw) as { line?: string; error?: string; done?: boolean };
          if (parsed.error) return append(parsed.error, true);
          if (typeof parsed.line === "string") return append(parsed.line);
          if (parsed.done) return append("— provisioning finished —");
          return;
        } catch {
          /* not JSON after all: fall through and print it raw */
        }
      }
      for (const line of raw.split("\n")) {
        if (line.trim()) append(line.replace(/\r$/, ""));
      }
    };
    socket.onerror = () => setConnection("closed");
    socket.onclose = () => setConnection("closed");

    return () => {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      setConnection("idle");
    };
  }, [enabled, append]);

  return { lines, connection, append, clear };
}

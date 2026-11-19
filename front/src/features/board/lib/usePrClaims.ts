import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { PrClaim, PrLiveEvent } from "@/api/types";
import { projectPullsKey } from "@/features/board/api";
import { wsUrl } from "@/lib/ws";
import { t } from "@/i18n";

const FIRST_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export function usePrClaims(projectId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const [claims, setClaims] = React.useState<PrClaim[]>([]);
  const [holding, setHolding] = React.useState<number | null>(null);
  const live = React.useRef<{ socket: WebSocket | null; holding: number | null }>({ socket: null, holding: null });

  const sendFrame = (type: "claim" | "release", prNumber: number) => {
    const { socket } = live.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, prNumber }));
  };

  const setHeld = (prNumber: number | null) => {
    live.current.holding = prNumber;
    setHolding(prNumber);
  };

  React.useEffect(() => {
    if (!enabled) return;
    const connection: { closed: boolean; failures: number; retry?: ReturnType<typeof setTimeout> } = { closed: false, failures: 0 };
    const connect = () => {
      const socket = new WebSocket(wsUrl(`/api/projects/${projectId}/prs/live`));
      live.current.socket = socket;
      socket.onopen = () => {
        connection.failures = 0;
        const held = live.current.holding;
        if (held !== null) socket.send(JSON.stringify({ type: "claim", prNumber: held }));
      };
      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as PrLiveEvent;
        switch (event.type) {
          case "claims":
            setClaims(event.claims);
            return;
          case "pulls-changed":
            void queryClient.invalidateQueries({ queryKey: projectPullsKey(projectId) });
            return;
          case "claim-refused":
            if (live.current.holding === event.prNumber) setHeld(null);
            toast.info(t("prs.claimRefused", { name: event.username, number: event.prNumber }));
            return;
          case "error":
            toast.error(event.error);
            return;
        }
      };
      socket.onclose = () => {
        if (connection.closed) return;
        const delay = Math.min(FIRST_RECONNECT_MS * 2 ** connection.failures, MAX_RECONNECT_MS);
        connection.failures += 1;
        connection.retry = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      connection.closed = true;
      clearTimeout(connection.retry);
      live.current.socket?.close();
      live.current.socket = null;
      setHeld(null);
      setClaims([]);
    };
  }, [enabled, projectId, queryClient]);

  const claim = (prNumber: number) => {
    const previous = live.current.holding;
    if (previous !== null && previous !== prNumber) sendFrame("release", previous);
    setHeld(prNumber);
    sendFrame("claim", prNumber);
  };

  const release = (prNumber: number) => {
    if (live.current.holding !== prNumber) return;
    setHeld(null);
    sendFrame("release", prNumber);
  };

  return { claims, holding, claim, release };
}

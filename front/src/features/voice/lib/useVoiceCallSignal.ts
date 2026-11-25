import * as React from "react";

export interface UseVoiceCallSignalOptions {
  connected: boolean;
  callLive: boolean;
  sendFrame: (frame: object) => void;
}

export function useVoiceCallSignal({ connected, callLive, sendFrame }: UseVoiceCallSignalOptions): void {
  const callSignalled = React.useRef(false);
  React.useEffect(() => {
    if (!connected) {
      callSignalled.current = false;
      return;
    }
    if (callLive === callSignalled.current) return;
    try {
      sendFrame({ type: "voice_call", active: callLive });
    } catch {
      return;
    }
    callSignalled.current = callLive;
  }, [connected, callLive, sendFrame]);
}

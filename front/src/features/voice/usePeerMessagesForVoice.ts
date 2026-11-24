import * as React from "react";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { peerMessages, typedContext } from "./voiceContext";

export interface UsePeerMessagesForVoiceOptions {
  live: boolean;
  rows: SdkRow[];
  viewer: string | undefined;
  announce: (note: string) => void;
}

export function usePeerMessagesForVoice({ live, rows, viewer, announce }: UsePeerMessagesForVoiceOptions): void {
  const heard = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    if (!live) {
      heard.current = null;
      return;
    }
    const messages = peerMessages(rows, viewer);
    if (heard.current === null) {
      heard.current = new Set(messages.map((message) => message.key));
      return;
    }
    const known = heard.current;
    const arrived = messages.filter((message) => !known.has(message.key));
    for (const message of arrived) {
      known.add(message.key);
      const note = typedContext(message.text, message.author);
      if (note) announce(note);
    }
  }, [live, rows, viewer, announce]);
}

import * as React from "react";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { peerMessages, typedContext } from "@/features/voice/voiceContext";

export interface UsePeerMessagesForVoiceOptions {
  live: boolean;
  rows: SdkRow[];
  viewer: string | undefined;
  sentFromThisTab: ReadonlySet<string>;
  announce: (note: string) => void;
}

const authoredKey = (author: string, text: string): string => `${author}\u0000${text}`;

export function usePeerMessagesForVoice({ live, rows, viewer, sentFromThisTab, announce }: UsePeerMessagesForVoiceOptions): {
  announceQueued: (author: string, text: string) => void;
} {
  const heard = React.useRef<Set<string> | null>(null);
  const heardWhileQueued = React.useRef(new Set<string>());
  const liveRef = React.useRef(live);
  liveRef.current = live;

  React.useEffect(() => {
    if (!live) {
      heard.current = null;
      heardWhileQueued.current.clear();
      return;
    }
    const messages = peerMessages(rows, viewer, sentFromThisTab);
    if (heard.current === null) {
      heard.current = new Set(messages.map((message) => message.key));
      return;
    }
    const known = heard.current;
    const arrived = messages.filter((message) => !known.has(message.key));
    for (const message of arrived) {
      known.add(message.key);
      if (heardWhileQueued.current.delete(authoredKey(message.author, message.text))) continue;
      const note = typedContext(message.text, { author: message.author });
      if (note) announce(note);
    }
  }, [live, rows, viewer, sentFromThisTab, announce]);

  const announceQueued = React.useCallback(
    (author: string, text: string): void => {
      if (!liveRef.current) return;
      const note = typedContext(text, { author, queued: true });
      if (!note) return;
      heardWhileQueued.current.add(authoredKey(author, text));
      announce(note);
    },
    [announce],
  );
  return { announceQueued };
}

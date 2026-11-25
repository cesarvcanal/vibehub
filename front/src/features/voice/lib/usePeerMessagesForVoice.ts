import * as React from "react";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { peerMessages, typedContext, type PeerMessage } from "@/features/voice/voiceContext";

export interface UsePeerMessagesForVoiceOptions {
  live: boolean;
  rows: SdkRow[];
  viewer: string | undefined;
  sentFromThisTab: ReadonlyMap<string, number>;
  announce: (note: string) => void;
}

interface QueuedAnnouncement {
  author: string;
  text: string;
}

const leftTheQueue = (message: PeerMessage, queued: QueuedAnnouncement): boolean =>
  queued.author === message.author && message.text.startsWith(queued.text);

export function usePeerMessagesForVoice({ live, rows, viewer, sentFromThisTab, announce }: UsePeerMessagesForVoiceOptions): {
  announceQueued: (author: string, text: string) => void;
} {
  const heard = React.useRef<Set<string> | null>(null);
  const heardWhileQueued = React.useRef<QueuedAnnouncement[]>([]);
  const liveRef = React.useRef(live);
  liveRef.current = live;

  React.useEffect(() => {
    if (!live) {
      heard.current = null;
      heardWhileQueued.current = [];
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
      const queuedIndex = heardWhileQueued.current.findIndex((queued) => leftTheQueue(message, queued));
      if (queuedIndex >= 0) {
        heardWhileQueued.current = heardWhileQueued.current.filter((_, index) => index !== queuedIndex);
        continue;
      }
      const note = typedContext(message.text, { author: message.author });
      if (note) announce(note);
    }
  }, [live, rows, viewer, sentFromThisTab, announce]);

  const announceQueued = React.useCallback(
    (author: string, text: string): void => {
      if (!liveRef.current) return;
      const note = typedContext(text, { author, queued: true });
      if (!note) return;
      heardWhileQueued.current = [...heardWhileQueued.current, { author, text }];
      announce(note);
    },
    [announce],
  );
  return { announceQueued };
}

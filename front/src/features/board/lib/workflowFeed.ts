import * as React from "react";
import type { WorkflowFeedItem } from "./sdkChat";

/**
 * THE FEED CHANNEL of a workflow subagent, between the chat socket (SdkChatView) and the panel
 * (WorkflowPanel). The feed is on demand and only for this tab: the panel asks for `{type:"workflow_feed"}`
 * and the back answers only it (back/src/services/sdk/manager.ts). The answer is not conversation — it
 * does not go through the reducer nor become a row; it is delivered here, to whoever is listening.
 *
 * A context instead of a prop: the workflow row is drawn by a memoized `SdkChatRow`, and passing the
 * channel through there would touch every place that draws a row.
 */

export interface WorkflowFeedResponse {
  type: "workflow_feed";
  runId: string;
  agentId: string;
  items: WorkflowFeedItem[];
  error?: string;
}

export interface WorkflowFeedRequestFrame {
  type: "workflow_feed";
  runId: string;
  agentId: string;
}

export interface WorkflowFeedChannel {
  /** Requests the feed. `false` = it did not go out (socket closed): the requester tries again on the next cycle. */
  request(runId: string, agentId: string): boolean;
  /** Listens to the answers; returns the "stop listening". */
  subscribe(listener: (response: WorkflowFeedResponse) => void): () => void;
  /** Delivers an answer that arrived through the socket to whoever is listening. */
  deliver(response: WorkflowFeedResponse): void;
}

export function createWorkflowFeedChannel(send: (frame: WorkflowFeedRequestFrame) => void): WorkflowFeedChannel {
  const listeners = new Set<(response: WorkflowFeedResponse) => void>();
  return {
    request(runId, agentId) {
      try {
        send({ type: "workflow_feed", runId, agentId });
        return true;
      } catch {
        return false;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    deliver(response) {
      for (const listener of listeners) listener(response);
    },
  };
}

/** Without a provider (a panel drawn outside the chat), there is no feed: the panel shows only what the board brings. */
export const WorkflowFeedContext = React.createContext<WorkflowFeedChannel | null>(null);

/** Reads a feed answer coming from the socket. Any malformed shape becomes `null`. PURE. */
export function parseWorkflowFeedResponse(event: {
  type?: string; runId?: unknown; agentId?: unknown; items?: unknown; error?: unknown;
}): WorkflowFeedResponse | null {
  if (event.type !== "workflow_feed" || typeof event.runId !== "string" || typeof event.agentId !== "string") return null;
  const items = Array.isArray(event.items)
    ? event.items.filter((i): i is WorkflowFeedItem => !!i && typeof i === "object" && typeof (i as { kind?: unknown }).kind === "string" && typeof (i as { at?: unknown }).at === "number")
    : [];
  return {
    type: "workflow_feed",
    runId: event.runId,
    agentId: event.agentId,
    items,
    ...(typeof event.error === "string" ? { error: event.error } : {}),
  };
}

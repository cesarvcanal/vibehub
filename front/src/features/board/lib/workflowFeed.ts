import * as React from "react";
import type { WorkflowFeedItem } from "./sdkChat";

/**
 * O CANAL DO FEED de um subagente do workflow, entre o socket do chat (SdkChatView) e o painel
 * (WorkflowPanel). O feed é sob demanda e só desta aba: o painel pede `{type:"workflow_feed"}` e o
 * back responde só a ela (back/src/services/sdk/manager.ts). A resposta não é conversa — não passa
 * pelo reducer nem vira linha; ela é entregue aqui, a quem estiver escutando.
 *
 * Um contexto em vez de prop: a linha do workflow é desenhada por um `SdkChatRow` memoizado, e
 * passar o canal por lá mexeria em todo lugar que desenha uma linha.
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
  /** Pede o feed. Sem socket aberto não sai nada — o próximo pedido (a cada 4s) tenta de novo. */
  request(runId: string, agentId: string): void;
  /** Escuta as respostas; devolve o "pare de escutar". */
  subscribe(listener: (response: WorkflowFeedResponse) => void): () => void;
  /** Entrega uma resposta que chegou pelo socket a quem escuta. */
  deliver(response: WorkflowFeedResponse): void;
}

export function createWorkflowFeedChannel(send: (frame: WorkflowFeedRequestFrame) => void): WorkflowFeedChannel {
  const listeners = new Set<(response: WorkflowFeedResponse) => void>();
  return {
    request(runId, agentId) {
      try {
        send({ type: "workflow_feed", runId, agentId });
      } catch {
        /* socket fechado: o painel segue com o que tem, e o próximo pedido tenta de novo */
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

/** Sem provedor (um painel desenhado fora do chat), não há feed: o painel mostra só o que o quadro traz. */
export const WorkflowFeedContext = React.createContext<WorkflowFeedChannel | null>(null);

/** Lê uma resposta de feed vinda do socket. Qualquer forma torta vira `null`. PURE. */
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

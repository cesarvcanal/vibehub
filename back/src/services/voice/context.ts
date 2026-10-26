import { readHistory, type HistoryEvent } from "../sdk/history.js";

/**
 * What the voice assistant knows of the card's conversation when a call starts INSIDE that chat.
 *
 * GPT-Live's `instructions` are fixed at creation, and it has no way to read the chat by itself: so
 * the recent thread — typed messages, the card agent's answers, earlier spoken turns — goes into the
 * instructions here, on the server, from the same log the chat replays. Newest last, the oldest
 * dropped first when it does not fit. Never tool calls or their output (noise, and sometimes
 * secrets the agent printed); never logged.
 */

/** Budget for the thread in the instructions — a few minutes of conversation, not the whole card. */
export const CONTEXT_MAX_CHARS = 6_000;
/** One message longer than this is cut: a 3-page answer says enough in its first lines. */
export const CONTEXT_ITEM_MAX_CHARS = 700;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One history event as a line of the thread, or null when it is not conversation. PURE. */
function line(event: HistoryEvent): string | null {
  switch (event.type) {
    case "user": {
      const who = event.from?.kind === "agent" ? `Outro card (${event.from.name || "agente"})` : "Pessoa (digitou)";
      return `${who}: ${clip(event.text, CONTEXT_ITEM_MAX_CHARS)}`;
    }
    case "assistant_text":
      return `Agente do card (Claude): ${clip((event as { text: string }).text, CONTEXT_ITEM_MAX_CHARS)}`;
    case "voice_turn":
      return `${event.role === "user" ? "Pessoa (falou)" : "Você (voz)"}: ${clip(event.text, CONTEXT_ITEM_MAX_CHARS)}`;
    default:
      return null;
  }
}

/** The thread as text that fits {@link CONTEXT_MAX_CHARS}, newest kept. Empty when nothing was said. PURE. */
export function formatVoiceContext(events: HistoryEvent[], maxChars: number = CONTEXT_MAX_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const l = line(events[i]!);
    if (!l) continue;
    if (used + l.length + 1 > maxChars) break;
    lines.push(l);
    used += l.length + 1;
  }
  return lines.reverse().join("\n");
}

export async function cardVoiceContext(cardId: string): Promise<string> {
  return formatVoiceContext(await readHistory(cardId));
}

/**
 * What the voice assistant is told, quietly, about the chat while a call is up (sent as
 * `session.thinking.append`, see liveVoice.ts). GPT-Live has no text or file input: what the person
 * types goes to the card's agent through the chat, and the voice only learns THAT it happened — so
 * it can talk about it, and never claims to have seen an attachment. In Portuguese, like the call's
 * instructions (back/src/services/voice/live.ts), whatever the interface language.
 */

/** An image attached in the composer travels as its path in the runner (TerminalComposer `composeMessage`). */
const UPLOAD_RE = /\/work\/\.uploads\/\S+/g;

/** A message typed during the call, for the voice. Null when there is nothing to say. PURE. */
export function typedContext(raw: string): string | null {
  const images = raw.match(UPLOAD_RE)?.length ?? 0;
  const text = raw.replace(UPLOAD_RE, " ").replace(/\s+/g, " ").trim();
  if (!text && images === 0) return null;
  const parts = ["A pessoa escreveu no chat do card (isso vai para o agente do card, não para você)"];
  if (text) parts[0] += `: «${text}»`;
  if (images > 0) {
    parts.push(
      images === 1
        ? "Anexou 1 imagem, que só o agente do card vê — você não vê o conteúdo dela."
        : `Anexou ${images} imagens, que só o agente do card vê — você não vê o conteúdo delas.`,
    );
  }
  return parts.join(". ");
}

/** The card agent's answer that landed during the call, for the voice. PURE. */
export function agentContext(text: string): string {
  return `O agente do card respondeu no chat: «${text.replace(/\s+/g, " ").trim()}»`;
}

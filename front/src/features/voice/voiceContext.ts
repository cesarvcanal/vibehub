/**
 * What the voice assistant is told about the chat while a call is up (see liveVoice.ts). GPT-Live
 * has no text or file input: what the person types goes to the card's agent through the chat, and
 * the voice only learns THAT it happened — so it can talk about it, and never claims to have seen an
 * attachment. A typed message is said aloud (`session.commentary.append`): as quiet context the voice
 * never mentioned it and the text looked ignored (production, 2026-11-16). The agent's answers stay
 * quiet (`session.thinking.append`). In Portuguese, like the call's instructions
 * (back/src/services/voice/live.ts), whatever the interface language.
 */

/** An image attached in the composer travels as its path in the runner (TerminalComposer `composeMessage`). */
const UPLOAD_RE = /\/work\/\.uploads\/\S+/g;

/**
 * A message typed during the call, as the voice should announce it — GPT-Live paraphrases it aloud.
 * Null when there is nothing to say. PURE.
 */
export function typedContext(raw: string): string | null {
  const images = raw.match(UPLOAD_RE)?.length ?? 0;
  const text = raw.replace(UPLOAD_RE, " ").replace(/\s+/g, " ").trim();
  if (!text && images === 0) return null;
  const parts = [text ? `Chegou uma mensagem de texto no chat: «${text}»` : "Chegou uma mensagem no chat"];
  if (images > 0) {
    parts.push(
      images === 1
        ? "Veio com 1 imagem, que só o agente do card vê — você não vê o conteúdo dela"
        : `Veio com ${images} imagens, que só o agente do card vê — você não vê o conteúdo delas`,
    );
  }
  parts.push("Ela foi para o agente do card");
  return parts.join(". ");
}

/** The card agent's answer that landed during the call, for the voice. PURE. */
export function agentContext(text: string): string {
  return `O agente do card respondeu no chat: «${text.replace(/\s+/g, " ").trim()}»`;
}

export const SERVER_BACK_CONTEXT =
  "A conexão do chat com o servidor do vibehub caiu e voltou, o que costuma ser o servidor reiniciando num deploy. " +
  "A chamada continua e os pedidos ao agente do card seguem pelo chat: diga à pessoa, em poucas palavras, que o servidor voltou.";

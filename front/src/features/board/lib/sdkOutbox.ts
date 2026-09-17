/**
 * THE OUTBOX — as mensagens que este navegador enviou e o servidor ainda não confirmou.
 *
 * O bug que isto fecha (produção, 2026-09-17): o chat nativo desenhava a mensagem como "enviada"
 * porque `socket.send()` não reclamou. Só que `readyState === OPEN` não é entrega: um socket
 * meio-aberto (a conexão morreu sem FIN — VPN caindo, proxy soltando, o back reiniciando) aceita
 * `send()` e joga os bytes no vácuo, e o navegador só percebe minutos ou horas depois. A tela
 * ficava girando "Pensando…" para sempre e, no F5, a mensagem simplesmente não existia — o
 * servidor nunca a viu, e a única cópia dela era o estado React que o F5 apagou.
 *
 * Agora toda mensagem nasce aqui, em disco (localStorage, por card), ANTES de ir pro socket, e só
 * sai quando o back responde `user_ack` — que o back só manda depois de gravar no histórico. Um
 * `user_nack` (o back recusou: o driver do card tinha morrido) ou um silêncio longo demais
 * (`OUTBOX_ACK_TIMEOUT_MS`) deixam a bolha marcada como NÃO ENTREGUE, com reenviar/descartar — e o
 * texto continua na tela, recuperável, mesmo depois de recarregar a página ou trocar de máquina
 * (nesse caso, a máquina que enviou é quem guarda o rascunho).
 *
 * Tudo aqui é puro ou trivialmente falsificável: as regras são testes, não capturas de tela.
 */

/** Uma mensagem enviada por este navegador e ainda sem recibo do servidor. */
export interface OutboxMessage {
  /** O id do recibo (`cid` no protocolo) — o que o `user_ack`/`user_nack` cita de volta. */
  cid: string;
  /** O texto como a pessoa escreveu (o que a bolha mostra e o reenvio repete). */
  text: string;
  /** Quando saiu daqui (epoch ms) — o relógio do timeout de recibo. */
  at: number;
  /** Uma correção de mensagem já enviada carrega o original (o supersede do back). */
  original?: string;
}

/**
 * Quanto tempo uma mensagem pode ficar sem recibo antes de a tela admitir que não sabe.
 *
 * Generoso o suficiente para uma gravação em disco lenta e uma rede ruim, curto o suficiente para
 * a pessoa não perder minutos olhando um spinner mentiroso. Passado o prazo a mensagem NÃO é
 * descartada: ela é reetiquetada, e o socket é reconectado (é o jeito de descobrir que ele morreu).
 */
export const OUTBOX_ACK_TIMEOUT_MS = 12_000;

const OUTBOX_PREFIX = "vibehub.sdkOutbox.";

/** Um id de recibo por envio. `rand` é injetável para o teste ser determinístico. PURE. */
export function newCid(now: number = Date.now(), rand: () => number = Math.random): string {
  return `${now.toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`;
}

/** Nunca lança: um localStorage bloqueado só significa "sem durabilidade nesta sessão". */
export function readOutbox(cardId: string): OutboxMessage[] {
  try {
    const raw = localStorage.getItem(OUTBOX_PREFIX + cardId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is OutboxMessage =>
        Boolean(m) &&
        typeof (m as OutboxMessage).cid === "string" &&
        typeof (m as OutboxMessage).text === "string",
    ).map((m) => (typeof m.at === "number" ? m : { ...m, at: Date.now() }));
  } catch {
    return [];
  }
}

export function writeOutbox(cardId: string, messages: readonly OutboxMessage[]): void {
  try {
    if (messages.length === 0) localStorage.removeItem(OUTBOX_PREFIX + cardId);
    else localStorage.setItem(OUTBOX_PREFIX + cardId, JSON.stringify(messages));
  } catch {
    /* a bolha ainda vale para esta tela */
  }
}

/** Acrescenta (ou substitui, num reenvio com o mesmo cid) uma mensagem. PURE. */
export function addToOutbox(messages: readonly OutboxMessage[], message: OutboxMessage): OutboxMessage[] {
  return [...messages.filter((m) => m.cid !== message.cid), message];
}

/** Tira uma mensagem do outbox — ela está gravada no servidor (ou a pessoa descartou). PURE. */
export function dropFromOutbox(messages: readonly OutboxMessage[], cid: string): OutboxMessage[] {
  return messages.filter((m) => m.cid !== cid);
}

/** As mensagens cujo recibo não chegou no prazo. PURE. */
export function overdueMessages(
  messages: readonly OutboxMessage[],
  now: number,
  timeoutMs: number = OUTBOX_ACK_TIMEOUT_MS,
): OutboxMessage[] {
  return messages.filter((m) => now - m.at >= timeoutMs);
}

/** Identidade de texto insensível a espaços — a mesma dobra que o dedupe do back usa. PURE. */
export function normalizeOutboxText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * RECONCILIAÇÃO no reconnect: o replay do servidor é a verdade sobre o que foi gravado.
 *
 * Cada entrada do outbox cai em um de dois lados: `delivered` (o replay tem uma mensagem com o
 * mesmo texto — o recibo foi que se perdeu, não a mensagem) ou `missing` (o servidor não tem: é
 * uma mensagem que morreu no caminho e a pessoa precisa vê-la marcada, com o texto intacto).
 *
 * O casamento é por TEXTO porque é o que o replay carrega: o `cid` é um recibo de conexão, não um
 * id de mensagem, e uma mensagem gravada volta do disco sem ele. Cada linha do replay casa com no
 * máximo uma entrada, então mandar o mesmo texto duas vezes não "entrega" as duas de graça. PURE.
 */
export function reconcileOutbox(
  sentTexts: readonly string[],
  messages: readonly OutboxMessage[],
): { delivered: OutboxMessage[]; missing: OutboxMessage[] } {
  const counts = new Map<string, number>();
  for (const text of sentTexts) {
    const key = normalizeOutboxText(text);
    if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const delivered: OutboxMessage[] = [];
  const missing: OutboxMessage[] = [];
  for (const message of messages) {
    const key = normalizeOutboxText(message.text);
    const left = counts.get(key) ?? 0;
    if (left > 0) {
      counts.set(key, left - 1);
      delivered.push(message);
    } else {
      missing.push(message);
    }
  }
  return { delivered, missing };
}

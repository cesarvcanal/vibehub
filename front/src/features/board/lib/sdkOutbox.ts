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
 * `user_nack` (o back recusou: o driver do card tinha morrido; ou o driver recebeu mas a gravação
 * no histórico falhou, `reason: "history-write-failed"` — um F5 a perderia, então a cópia fica, e
 * o reenvio com o mesmo `cid` e o mesmo driver no ar só refaz a gravação e ganha o `user_ack`
 * dela, nunca um segundo turno) ou um silêncio longo demais (`OUTBOX_ACK_TIMEOUT_MS`) deixam a
 * bolha marcada como NÃO ENTREGUE, com reenviar/descartar — e o
 * texto continua na tela, recuperável, mesmo depois de recarregar a página ou trocar de máquina
 * (nesse caso, a máquina que enviou é quem guarda o rascunho).
 *
 * Tudo aqui é puro ou trivialmente falsificável: as regras são testes, não capturas de tela.
 */

import { normalizeMessage, parseOrigin, type MessageOrigin } from "@/features/board/lib/chat";

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
  /**
   * Já foi dada por NÃO ENTREGUE (o back recusou, ou o prazo do recibo venceu).
   *
   * A entrada continua na fila — é a cópia recuperável que a bolha "reenviar/descartar" usa — mas o
   * veredito já foi dado UMA vez: sem esta marca, a mensagem seguiria vencida para sempre e o
   * watchdog derrubaria o socket a cada tique, de segundo em segundo (o loop de "Iniciando o
   * agente…" de 2026-09-17). Um reenvio limpa a marca e o relógio volta a correr.
   */
  undelivered?: boolean;
  /**
   * QUEM escreveu. A cópia mora no navegador, não na conta: se a aba troca de conta antes do
   * recibo, a bolha redesenhada no reconnect continua sendo de quem a escreveu — sem isto ela
   * aparecia como "minha" para a conta nova (o bug do F5, 2026-10-06).
   */
  from?: MessageOrigin;
  /**
   * Quantas mensagens com ESTE texto o servidor já tinha gravadas DEPOIS de `since` quando esta
   * saiu (sem `since`: na conversa inteira) — ver `sendMark`.
   *
   * A reconciliação casa por texto contra o replay, e o replay traz a conversa toda que cabe na
   * janela — um "sim" de ontem dava o "sim" de hoje (perdido num socket meio-aberto) por entregue,
   * e ele sumia em silêncio. Com a contagem, só uma ocorrência ALÉM das que já existiam prova a
   * entrega. Entradas gravadas antes deste campo não o têm e casam como antes (contra qualquer
   * ocorrência).
   */
  seenBefore?: number;
  /**
   * A ÂNCORA da contagem: o `at` (relógio do SERVIDOR) da mensagem mais nova que a tela conhecia
   * quando esta saiu. Só ocorrências gravadas depois dele contam, dos dois lados — ver `sendMark`.
   */
  since?: number;
  /**
   * NUNCA saiu deste navegador (uma espera da fila de outra conta, ver `foreignToOutbox`): não há
   * entrega a reconhecer, e o mesmo texto no replay é de outra pessoa ou de outro momento. Só um
   * Reenviar de verdade (`retryOutbox`) a torna um envio.
   */
  unsent?: boolean;
}

/**
 * Uma mensagem que o servidor TEM, como a reconciliação a lê: o texto e quando ELE a gravou.
 *
 * `at` é o carimbo do histórico que o replay carrega. Falta num envio desta conexão confirmado
 * pelo `user_ack` (o recibo não traz hora) e no histórico gravado antes do carimbo existir.
 */
export interface ServerText {
  text: string;
  at?: number;
}

/** O que um envio leva consigo para a reconciliação poder reconhecê-lo depois. */
export type SendMark = Pick<OutboxMessage, "since" | "seenBefore">;

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
    ).map((m) => ({
      ...m,
      at: typeof m.at === "number" ? m.at : Date.now(),
      // localStorage é entrada não confiável: um autor malformado vira "sem autor", nunca lixo.
      from: parseOrigin(m.from),
      seenBefore: typeof m.seenBefore === "number" && m.seenBefore >= 0 ? m.seenBefore : undefined,
      since: typeof m.since === "number" && Number.isFinite(m.since) ? m.since : undefined,
      unsent: m.unsent === true ? true : undefined,
    }));
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

/**
 * As mensagens cujo recibo não chegou no prazo E que ainda não foram cobradas.
 *
 * O `undelivered` é o que torna a cobrança ÚNICA: a mensagem vencida não sai da fila (a pessoa
 * ainda pode reenviar), então sem a marca ela continuaria vencida em todo tique — e o watchdog
 * derruba o socket a cada cobrança. Era esse o loop "chat → Iniciando o agente… → histórico
 * inteiro → chat" a cada segundo.
 *
 * `answerableSince` é o PISO do relógio: o instante em que a conexão passou a poder responder (o
 * `ready` do servidor). O prazo é uma acusação — "mandei e ninguém respondeu" — e ela só vale se
 * havia alguém em condições de responder. O `onopen` do navegador dispara no aperto de mão do
 * websocket, mas o back só passa a ATENDER frames depois de um setup de vários segundos (install
 * do driver por SSH+docker, sonda de transcript com timeout de 15s — sozinha maior que este prazo
 * —, replay do histórico, spawn do driver); até lá o frame espera bufferado e é entregue DEPOIS.
 * Contar esse tempo contra a mensagem é o que marcava "não entregue" o que o servidor recebeu, e
 * fazia o "Reenviar" mandar a segunda cópia (produção, 2026-09-28). PURE.
 */
export function overdueMessages(
  messages: readonly OutboxMessage[],
  now: number,
  timeoutMs: number = OUTBOX_ACK_TIMEOUT_MS,
  answerableSince: number = 0,
): OutboxMessage[] {
  return messages.filter((m) => !m.undelivered && now - Math.max(m.at, answerableSince) >= timeoutMs);
}

/** Dá por não entregues as mensagens citadas — o veredito já saiu, não se cobra de novo. PURE. */
export function markUndelivered(
  messages: readonly OutboxMessage[],
  cids: readonly string[],
): OutboxMessage[] {
  const wanted = new Set(cids);
  let changed = false;
  const next = messages.map((m) => {
    if (!wanted.has(m.cid) || m.undelivered === true) return m;
    changed = true;
    return { ...m, undelivered: true };
  });
  return changed ? next : (messages as OutboxMessage[]);
}

/**
 * Um reenvio: mesmas palavras, mesmo recibo, relógio zerado e o veredito anterior apagado.
 *
 * E a MARCA refeita contra a tela de agora (`mark`, ver `sendMark`): é este o envio que a próxima
 * reconciliação precisa reconhecer, e a conversa andou desde o primeiro — inclusive o caso de uma
 * espera de outra conta (`unsent`), que só agora sai de fato. PURE.
 */
export function retryOutbox(
  messages: readonly OutboxMessage[],
  entry: OutboxMessage,
  now: number,
  mark: SendMark,
): OutboxMessage[] {
  const { unsent: _neverSent, ...sent } = entry;
  return addToOutbox(messages, { ...sent, ...mark, at: now, undelivered: false });
}

/**
 * A MARCA de um envio: o que o servidor já tinha com estas palavras, no instante em que elas saem.
 *
 * O replay é uma JANELA (o fim do histórico, `HISTORY_REPLAY_LIMIT` eventos no back) e ela anda:
 * contar as ocorrências na tela inteira dava 6 "ok" no envio contra 3 no replay do reconnect — os
 * antigos saíram da janela — e a mensagem entregue voltava "não entregue", com um Reenviar que
 * duplicava o turno. Então a contagem é ANCORADA no relógio do servidor: `since` é o `at` mais
 * novo que a tela conhecia, e `seenBefore` conta só o que fica depois dele — o que, no próximo
 * replay, terá `at > since`. A janela descarta sempre o mais VELHO, então isso sobrevive a ela
 * (salvo se andar mais que a janela inteira entre o envio e o reconnect: aí a entrega sai como
 * "não entregue", na tela com reenviar — o erro do lado que não perde palavras).
 *
 * Depois da âncora, na tela, só podem estar envios desta conexão já confirmados (o `user_ack` não
 * traz hora): eles contam, porque voltam no replay carimbados depois dela. Sem nenhum `at` na tela
 * (histórico antigo, ou conversa vazia) não há âncora, e conta-se tudo, como sempre foi. PURE.
 */
export function sendMark(known: readonly ServerText[], text: string): SendMark {
  let since: number | undefined;
  let anchor = -1;
  known.forEach((m, i) => {
    if (typeof m.at === "number" && (since === undefined || m.at >= since)) {
      since = m.at;
      anchor = i;
    }
  });
  const key = normalizeMessage(text);
  const seenBefore = known.reduce(
    (n, m, i) => (i > anchor && m.at === undefined && normalizeMessage(m.text) === key ? n + 1 : n),
    0,
  );
  return { since, seenBefore };
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
 * máximo uma entrada, então mandar o mesmo texto duas vezes não "entrega" as duas de graça.
 *
 * E a entrada só casa com uma ocorrência POSTERIOR às que já existiam quando ela saiu (a marca de
 * `sendMark`): das ocorrências gravadas depois de `since` — todas, sem âncora —, as `seenBefore`
 * primeiras já existiam, e só uma além delas pode ser desta mensagem. Uma entrada que nunca saiu
 * deste navegador (`unsent`) não casa com nada: é sempre `missing`. PURE.
 */
export function reconcileOutbox(
  sent: readonly ServerText[],
  messages: readonly OutboxMessage[],
): { delivered: OutboxMessage[]; missing: OutboxMessage[] } {
  const keys = sent.map((m) => normalizeMessage(m.text));
  /** As linhas do replay que já casaram com alguma entrada (cada uma prova UMA entrega). */
  const claimed = new Set<number>();
  const delivered: OutboxMessage[] = [];
  const missing: OutboxMessage[] = [];
  for (const message of messages) {
    const match = message.unsent === true ? -1 : deliveryOf(message, sent, keys, claimed);
    if (match < 0) {
      missing.push(message);
      continue;
    }
    claimed.add(match);
    delivered.push(message);
  }
  return { delivered, missing };
}

/** A linha do replay que prova a entrega de `message`, ou -1 — ver `reconcileOutbox`. PURE. */
function deliveryOf(
  message: OutboxMessage,
  sent: readonly ServerText[],
  keys: readonly string[],
  claimed: ReadonlySet<number>,
): number {
  const key = normalizeMessage(message.text);
  if (key === "") return -1;
  const { since } = message;
  let before = message.seenBefore ?? 0;
  for (let i = 0; i < sent.length; i += 1) {
    if (keys[i] !== key) continue;
    // Com âncora, só o que o servidor gravou depois dela — o que a janela nunca descarta primeiro.
    const at = sent[i]!.at;
    if (since !== undefined && !(at !== undefined && at > since)) continue;
    if (before > 0) {
      before -= 1; // já existia quando a mensagem saiu: não é ela
      continue;
    }
    if (!claimed.has(i)) return i;
  }
  return -1;
}

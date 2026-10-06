/**
 * A FILA — o que você escreveu enquanto o Claude ainda estava trabalhando.
 *
 * Antes, uma mensagem mandada no meio de um turno ia DIRETO pro CLI, que a dobrava no turno em
 * andamento (o `turn_absorbed` do driver): a bolha subia na conversa na hora, com a etiqueta
 * "entrou no turno em andamento", e a partir dali a mensagem era do modelo — não dava pra corrigir
 * uma palavra, não dava pra desistir, e o que você escreveu virava um adendo no meio de um
 * raciocínio que já estava em curso.
 *
 * Agora ela ESPERA, do lado de fora da conversa, logo acima do campo de texto — onde o Claude Code
 * e o Cursor a põem. Enquanto está aqui ela ainda é sua: dá pra editar (ela volta pro campo) e dá
 * pra tirar. Ela só SOBE pro chat no instante em que é entregue de verdade, quando o turno anterior
 * termina — e aí vira uma bolha como qualquer outra, com o recibo do outbox (ver ./sdkOutbox.ts)
 * garantindo que o servidor a gravou.
 *
 * Mora no localStorage pelo mesmo motivo do outbox: um F5 no meio de um turno longo não pode
 * apagar o que você já tinha escrito.
 *
 * Tudo aqui é puro ou trivialmente falsificável — as regras são testes, não capturas de tela.
 */

import { parseOrigin, type MessageOrigin } from "@/features/board/lib/chat";
import type { OutboxMessage } from "@/features/board/lib/sdkOutbox";

/** Uma mensagem escrita, ainda não entregue, ainda editável. */
export interface QueuedMessage {
  /** Identidade local desta espera — some quando a mensagem é despachada. */
  id: string;
  /** O texto como a pessoa escreveu. */
  text: string;
  /** Quando entrou na fila (epoch ms) — a ordem é a da entrada. */
  at: number;
  /**
   * Está NO CAMPO, sendo reescrita — e por isso não pode ser entregue.
   *
   * Ela continua na fila, no lugar dela: é o que mantém a promessa de durabilidade (um F5 no meio
   * da correção devolve o texto original em vez de perdê-lo) e a ordem (cancelar a edição não
   * manda a mensagem pro fim da fila). O despacho simplesmente pula quem está aqui.
   */
  editing?: boolean;
  /**
   * QUEM escreveu. A fila mora no navegador, não na conta: sem isto, uma espera da conta anterior
   * saía pela conexão da conta nova depois de uma troca de conta — e o servidor a gravava no nome
   * errado (ver `foreignToOutbox`).
   */
  from?: MessageOrigin;
}

const QUEUE_PREFIX = "vibehub.sdkQueue.";

/** Um id por espera. `rand` é injetável para o teste ser determinístico. PURE. */
export function newQueueId(now: number = Date.now(), rand: () => number = Math.random): string {
  return `q${now.toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`;
}

/** Nunca lança: um localStorage bloqueado só significa "sem durabilidade nesta sessão". */
export function readQueue(cardId: string): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(QUEUE_PREFIX + cardId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is QueuedMessage =>
          Boolean(m) &&
          typeof (m as QueuedMessage).id === "string" &&
          typeof (m as QueuedMessage).text === "string",
      )
      .map((m) => ({
        ...m,
        at: typeof m.at === "number" ? m.at : Date.now(),
        // localStorage é entrada não confiável: um autor malformado vira "sem autor", nunca lixo.
        from: parseOrigin(m.from),
      }));
  } catch {
    return [];
  }
}

export function writeQueue(cardId: string, messages: readonly QueuedMessage[]): void {
  try {
    if (messages.length === 0) localStorage.removeItem(QUEUE_PREFIX + cardId);
    else localStorage.setItem(QUEUE_PREFIX + cardId, JSON.stringify(messages));
  } catch {
    /* a fila ainda vale para esta tela */
  }
}

/**
 * Entra no FIM da fila — a ordem de entrega é a ordem em que você escreveu.
 *
 * Uma mensagem que volta de uma edição também entra por aqui: ela saiu da fila quando o lápis foi
 * clicado (estava no campo, sendo reescrita) e a que volta é outra, com o texto novo. PURE.
 */
export function enqueue(messages: readonly QueuedMessage[], message: QueuedMessage): QueuedMessage[] {
  return [...messages.filter((m) => m.id !== message.id), message];
}

/** Tira uma da fila — despachada, editada (voltou pro campo) ou descartada. PURE. */
export function dequeue(messages: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return messages.filter((m) => m.id !== id);
}

/** A próxima a ir: a primeira que não está sendo reescrita. PURE. */
export function headOfQueue(messages: readonly QueuedMessage[]): QueuedMessage | null {
  return messages.find((m) => m.editing !== true) ?? null;
}

/** A última que você escreveu — a que a seta pra cima abre pra editar. PURE. */
export function lastQueued(messages: readonly QueuedMessage[]): QueuedMessage | null {
  const open = messages.filter((m) => m.editing !== true);
  return open.length === 0 ? null : open[open.length - 1]!;
}

/**
 * Põe UMA mensagem no campo (e tira de lá qualquer outra): só existe um campo de texto.
 *
 * Clicar o lápis de uma segunda mensagem devolve a primeira à fila, no lugar dela, com o texto que
 * ela tinha — o que estava sendo digitado nela se perde, mas a mensagem não. PURE.
 */
export function markEditing(messages: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return messages.map((m) => {
    const editing = m.id === id;
    if ((m.editing === true) === editing) return m;
    return editing ? { ...m, editing: true } : { ...m, editing: false };
  });
}

/** Ninguém está no campo: o que estava sendo reescrito volta a ser entregável, onde estava. PURE. */
export function releaseEditing(messages: readonly QueuedMessage[]): QueuedMessage[] {
  return messages.some((m) => m.editing === true)
    ? messages.map((m) => (m.editing === true ? { ...m, editing: false } : m))
    : (messages as QueuedMessage[]);
}

/**
 * Terminou de reescrever: o texto novo entra NO LUGAR do antigo — mesma posição na fila, porque
 * uma correção não é uma mensagem nova e não pode furar a ordem de quem veio depois.
 *
 * Uma mensagem que não está mais na fila (a pessoa a descartou enquanto editava) entra como nova,
 * no fim: um Enter nunca pode fazer palavras sumirem. PURE.
 */
export function updateQueued(
  messages: readonly QueuedMessage[],
  id: string,
  text: string,
  at: number,
): QueuedMessage[] {
  if (!messages.some((m) => m.id === id)) return [...messages, { id, text, at }];
  return messages.map((m) => (m.id === id ? { ...m, text, at, editing: false } : m));
}

/**
 * A TROCA DE CONTA com mensagens esperando: o que é de OUTRA conta não pode sair por esta conexão
 * (o servidor carimba o autor pela conexão, e a mensagem ficaria no nome de quem não a escreveu).
 * Ela vira uma cópia "não entregue" no outbox — continua na tela, com o nome de quem escreveu, e
 * pode ser descartada; só a conta dona dela pode reenviá-la.
 *
 * Sem autor (gravada antes desta versão) segue com quem está na aba, como sempre foi; sem leitor
 * conhecido ainda (`/auth/me` em voo) nada é separado — não se decide no escuro. PURE.
 */
export function foreignToOutbox(
  messages: readonly QueuedMessage[],
  viewer: string | undefined,
): { own: QueuedMessage[]; foreign: OutboxMessage[] } {
  if (viewer === undefined) return { own: [...messages], foreign: [] };
  const own: QueuedMessage[] = [];
  const foreign: OutboxMessage[] = [];
  for (const m of messages) {
    if (m.from && m.from.name !== viewer) {
      foreign.push({ cid: m.id, text: m.text, at: m.at, from: m.from, undelivered: true });
    } else {
      own.push(m);
    }
  }
  return { own, foreign };
}

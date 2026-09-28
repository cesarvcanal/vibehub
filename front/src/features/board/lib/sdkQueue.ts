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

/** Uma mensagem escrita, ainda não entregue, ainda editável. */
export interface QueuedMessage {
  /** Identidade local desta espera — some quando a mensagem é despachada. */
  id: string;
  /** O texto como a pessoa escreveu. */
  text: string;
  /** Quando entrou na fila (epoch ms) — a ordem é a da entrada. */
  at: number;
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
      .map((m) => (typeof m.at === "number" ? m : { ...m, at: Date.now() }));
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

/** A próxima a ir, ou `null` com a fila vazia. PURE. */
export function headOfQueue(messages: readonly QueuedMessage[]): QueuedMessage | null {
  return messages[0] ?? null;
}

/** A última que você escreveu — a que a seta pra cima abre pra editar. PURE. */
export function lastQueued(messages: readonly QueuedMessage[]): QueuedMessage | null {
  return messages.length === 0 ? null : messages[messages.length - 1]!;
}

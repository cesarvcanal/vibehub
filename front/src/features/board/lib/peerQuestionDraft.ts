/**
 * O RASCUNHO DE OUTRA PESSOA num cartão de pergunta — as duas metades, fora do componente para
 * serem testadas sem socket nem DOM.
 *
 * Por que existe: num card com duas pessoas, as duas podiam escrever respostas diferentes para a
 * mesma pergunta e clicar em "Responder" — só a primeira vale, e a outra nem sabia que havia outra.
 * Agora cada uma vê, em tempo real, o que a outra está marcando e escrevendo no cartão.
 *
 * ENTRADA: `peer_question_draft` (o back repassa das outras abas do card; ver back/services/sdk/
 * manager.ts), guardado como `id da pergunta → nome → rascunho`. Rascunho vazio = a pessoa apagou.
 *
 * SAÍDA: o que esta aba conta às outras. Em tempo real mas sem um frame por tecla: o primeiro sai
 * na hora e, enquanto a pessoa segue digitando, no máximo um a cada `DRAFT_SEND_EVERY_MS` — sempre
 * com o último estado (o rascunho é o conteúdo inteiro, então perder os do meio não perde nada).
 */

export interface QuestionDraft {
  picked: string[][];
  other: string[];
}

/** `id da pergunta → nome de quem escreve → rascunho`. */
export type PeerQuestionDrafts = Readonly<Record<string, Readonly<Record<string, QuestionDraft>>>>;

/** Enquanto a pessoa digita, um rascunho novo sai no máximo com esta frequência. */
export const DRAFT_SEND_EVERY_MS = 150;

/** Nada marcado, nada escrito. PURE. */
export function isEmptyDraft(draft: QuestionDraft): boolean {
  return draft.picked.every((sel) => sel.length === 0) && draft.other.every((text) => text.trim() === "");
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** O frame recebido, conferido. `null` quando falta o essencial. PURE. */
export function readPeerQuestionDraft(frame: { id?: unknown; name?: unknown; picked?: unknown; other?: unknown }):
  { id: string; name: string; draft: QuestionDraft } | null {
  if (typeof frame.id !== "string" || frame.id === "" || typeof frame.name !== "string" || frame.name === "") return null;
  const picked = Array.isArray(frame.picked) ? frame.picked.map(strings) : [];
  return { id: frame.id, name: frame.name, draft: { picked, other: strings(frame.other) } };
}

/**
 * Um `peer_question_draft` aplicado. Só a pergunta tocada ganha objeto novo — as outras seguem as
 * mesmas (o memo das linhas do chat depende disso). Nada a mudar = o MESMO objeto. PURE.
 */
export function applyPeerQuestionDraft(drafts: PeerQuestionDrafts, id: string, name: string, draft: QuestionDraft): PeerQuestionDrafts {
  const current = drafts[id];
  if (isEmptyDraft(draft)) {
    if (!current || !(name in current)) return drafts;
    const { [name]: _gone, ...rest } = current;
    if (Object.keys(rest).length > 0) return { ...drafts, [id]: rest };
    const { [id]: _question, ...others } = drafts;
    return others;
  }
  return { ...drafts, [id]: { ...current, [name]: draft } };
}

/** Quem está respondendo esta pergunta, sem o próprio leitor (a mesma conta em duas abas), em ordem. PURE. */
export function peerDraftsOf(byName: Readonly<Record<string, QuestionDraft>> | undefined, viewer: string | undefined):
  Array<{ name: string; draft: QuestionDraft }> {
  if (!byName) return [];
  return Object.keys(byName)
    .filter((name) => name !== viewer)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, draft: byName[name]! }));
}

export interface DraftSender {
  /** O rascunho de agora num cartão (vazio = apagou tudo). */
  push: (id: string, draft: QuestionDraft) => void;
  /** Esquece os envios pendentes (a tela saiu do card). */
  dispose: () => void;
}

/**
 * O envio desta aba, com o teto por pergunta. `send` pode lançar (socket fechado): o rascunho é de
 * melhor esforço e nunca pode quebrar o cartão — o próximo toque manda o estado inteiro de novo.
 */
export function createDraftSender(send: (id: string, draft: QuestionDraft) => void, everyMs: number = DRAFT_SEND_EVERY_MS): DraftSender {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, QuestionDraft>();
  const emit = (id: string, draft: QuestionDraft): void => {
    try { send(id, draft); } catch { /* offline: o reconnect e o próximo toque reenviam */ }
  };
  const open = (id: string): void => {
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      const next = pending.get(id);
      if (!next) return;
      pending.delete(id);
      emit(id, next);
      open(id);
    }, everyMs));
  };
  return {
    push: (id, draft) => {
      if (timers.has(id)) {
        pending.set(id, draft);
        return;
      }
      emit(id, draft);
      open(id);
    },
    dispose: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pending.clear();
    },
  };
}

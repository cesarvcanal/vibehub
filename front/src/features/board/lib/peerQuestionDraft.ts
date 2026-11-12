/**
 * ANOTHER PERSON'S DRAFT on a question card — both halves, kept out of the component so they can
 * be tested without a socket or a DOM.
 *
 * Why it exists: on a card with two people, both could write different answers to the same
 * question and click "Responder" — only the first one counts, and the other did not even know there
 * was another. Now each one sees, in real time, what the other is ticking and writing on the card.
 *
 * INBOUND: `peer_question_draft` (the back relays it from the card's other tabs; see back/services/sdk/
 * manager.ts), stored as `question id → name → draft`. Empty draft = the person erased it.
 *
 * OUTBOUND: what this tab tells the others. In real time but without one frame per key: the first
 * goes out right away and, while the person keeps typing, at most one every `DRAFT_SEND_EVERY_MS` —
 * always with the latest state (the draft is the whole content, so losing the ones in between loses
 * nothing).
 */

export interface QuestionDraft {
  picked: string[][];
  other: string[];
  /** When the person made this change (epoch ms): between two versions of the same draft, the newer one wins. */
  at?: number;
  /** The person closed the tab: what they ticked still stands, they are just not answering right now. */
  away?: boolean;
}

/** `question id → name of who is writing → draft`. */
export type PeerQuestionDrafts = Readonly<Record<string, Readonly<Record<string, QuestionDraft>>>>;

/** While the person types, a new draft goes out at most this often. */
export const DRAFT_SEND_EVERY_MS = 150;

/** Nothing ticked, nothing written. PURE. */
export function isEmptyDraft(draft: QuestionDraft): boolean {
  return draft.picked.every((sel) => sel.length === 0) && draft.other.every((text) => text.trim() === "");
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** The received frame, checked. `null` when the essentials are missing. PURE. */
export function readPeerQuestionDraft(frame: { id?: unknown; name?: unknown; picked?: unknown; other?: unknown; at?: unknown; away?: unknown }):
  { id: string; name: string; draft: QuestionDraft } | null {
  if (typeof frame.id !== "string" || frame.id === "" || typeof frame.name !== "string" || frame.name === "") return null;
  const picked = Array.isArray(frame.picked) ? frame.picked.map(strings) : [];
  const draft: QuestionDraft = { picked, other: strings(frame.other) };
  if (typeof frame.at === "number" && Number.isFinite(frame.at)) draft.at = frame.at;
  if (frame.away === true) draft.away = true;
  return { id: frame.id, name: frame.name, draft };
}

/**
 * A `peer_question_draft` applied. Only the touched question gets a new object — the others stay
 * the same (the chat rows' memo depends on that). Nothing to change = the SAME object. PURE.
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

/** Who is answering this question, without the reader themself (the same account in two tabs), in order. PURE. */
export function peerDraftsOf(byName: Readonly<Record<string, QuestionDraft>> | undefined, viewer: string | undefined):
  Array<{ name: string; draft: QuestionDraft }> {
  if (!byName) return [];
  return Object.keys(byName)
    .filter((name) => name !== viewer)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, draft: byName[name]! }));
}

export interface DraftSender {
  /** The current draft on a card (empty = erased everything). */
  push: (id: string, draft: QuestionDraft) => void;
  /** Forgets the pending sends (the screen left the card). */
  dispose: () => void;
}

/**
 * This tab's send, with the per-question cap. `send` may throw (socket closed): the draft is
 * best-effort and can never break the card — the next touch sends the whole state again.
 */
export function createDraftSender(send: (id: string, draft: QuestionDraft) => void, everyMs: number = DRAFT_SEND_EVERY_MS): DraftSender {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, QuestionDraft>();
  const emit = (id: string, draft: QuestionDraft): void => {
    try { send(id, draft); } catch { /* offline: the reconnect and the next touch resend */ }
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

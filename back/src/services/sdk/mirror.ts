import { spawn, type ChildProcess } from "node:child_process";
import { chatSource, parseChatEvents } from "../chat/chat.js";
import { matchOrigin, primeProvenance } from "../chat/provenance.js";
import { publishExternalMessage } from "./history.js";
import { chatEventToHistory, dedupeLookupKeys, dedupeNoteKeys } from "./transcript.js";
import type { HistoryEvent } from "./history.js";
import type { DriverEvent } from "./protocol.js";
import { logger } from "../../utils/logger.js";

/**
 * TRANSCRIPT MIRROR — what keeps the NATIVE chat honest while the conversation happens in the TUI.
 *
 * The native chat's socket hears the SDK driver's stdout and nothing else. The moment the person
 * switches to the Terminal tab and types at the prompt (a real incident: the chat felt slow, the user
 * went to the terminal, and the native chat never showed that conversation), everything moves to
 * the transcript — a file the native view never read. This mirror is the missing tail: while at
 * least one native chat is connected to a card, ONE follow process per card (the same
 * `buildFollowCommand` loop the legacy chat runs, reaper marker included) tails the card's newest
 * transcript, converts the NEW lines into history events and hands them to
 * `publishExternalMessage` — which appends them to the sdk history (so they survive a reconnect)
 * and fans them out to every open native chat (so they are on screen NOW).
 *
 * WHAT IS FILTERED, and why (see `mirrorNewEvents`):
 *  - the follow loop starts by re-printing the tail: everything at or before the mirror's cutoff
 *    is already on screen via the connect replay — only strictly newer events pass;
 *  - `tail -F` can re-print lines when the newest file changes: each transcript event id passes
 *    exactly once (`seen`);
 *  - the DRIVER's own turns are also written to the transcript (the SDK logs its session in the
 *    same directory): everything the driver already said on stdout would come around again through
 *    the file, so the route reports every driver event and user send into `noteDriverEvent`, and
 *    the mirror drops transcript events matching those keys (tool-use id — exact; kind+text for
 *    the rest).
 *
 * The mirror is REFCOUNTED per card: the first native chat connect starts it, the last disconnect
 * stops it (stdin.end() first — the follow loop's parent-liveness check — then kill, exactly like
 * the legacy chat route tears its follower down).
 */

/** How many recently seen transcript ids / driver keys are kept for dedupe. */
export const MIRROR_DEDUPE_MAX = 800;

/** The pure dedupe state of one card's mirror. */
export interface MirrorState {
  /** Events at or before this instant replayed already (the connect replay covered them). */
  cutoffAt: number;
  /** Transcript event ids already mirrored (or replayed) — each passes exactly once. */
  seen: Set<string>;
  /** Dedupe keys of what the driver already emitted on stdout (tool ids, kind+text). */
  driverKeys: Set<string>;
}

/**
 * `driverKeys` é RECEBIDO, não criado: ele pertence ao card (ver `driverKeysFor`), não a este
 * espelho. Um espelho nasce no primeiro connect e morre no último disconnect, mas o que o driver
 * já foi mandado dizer segue tendo sido dito — com ou sem alguém olhando.
 */
export function createMirrorState(
  cutoffAt: number,
  seenIds: Iterable<string> = [],
  driverKeys: Set<string> = new Set(),
): MirrorState {
  return { cutoffAt, seen: new Set(seenIds), driverKeys };
}

/** Sets have insertion order: dropping the oldest entries is how the dedupe memory stays bounded. */
function capSet(set: Set<string>, max: number = MIRROR_DEDUPE_MAX): void {
  while (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest === undefined) return;
    set.delete(oldest);
  }
}

/** Records what the driver said (stdout event) or was told (a user send) into the dedupe set. PURE-ish. */
export function noteDriverEvent(state: MirrorState, event: DriverEvent | { type: "user"; text: string }): void {
  noteDriverKeys(state.driverKeys, event);
}

/** O mesmo registro, sobre o Set cru — é ele que o card guarda entre um espelho e o próximo. PURE-ish. */
function noteDriverKeys(keys: Set<string>, event: DriverEvent | { type: "user"; text: string }): void {
  for (const key of dedupeNoteKeys(event as { type: HistoryEvent["type"]; text?: string; id?: string })) {
    keys.delete(key); // re-adding moves it to the newest slot
    keys.add(key);
  }
  capSet(keys);
}

/**
 * Filters one chunk of transcript events down to what the native chat has NOT seen yet, converted
 * to history events stamped `source:"terminal"` (plus the sender, when the provenance log knows
 * it). Mutates the state's dedupe sets; emits in transcript order.
 */
export function mirrorNewEvents(state: MirrorState, jsonl: string, cardId: string): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const event of parseChatEvents(jsonl)) {
    if (!(event.at > state.cutoffAt)) continue;
    if (state.seen.has(event.id)) continue;
    state.seen.add(event.id);
    capSet(state.seen);
    const converted = chatEventToHistory(event);
    if (!converted) continue;
    // The driver already said this on stdout — including the case where Claude Code rewrote a slash
    // command on its way into the transcript (see dedupeLookupKeys).
    const keys = dedupeLookupKeys(converted as { type: HistoryEvent["type"]; text?: string; id?: string });
    if (keys.some((k) => state.driverKeys.has(k))) continue;
    const mirrored: HistoryEvent = { ...converted, source: "terminal" };
    if (mirrored.type === "user" && !mirrored.from) {
      const from = matchOrigin(cardId, mirrored.text, mirrored.at ?? 0);
      if (from) mirrored.from = from;
    }
    // CONVERSA QUE O CHAT NÃO PRODUZIU: ela entrou no transcript por outro processo do CLI (a aba
    // Terminal). Quem mantém uma corrente aberta precisa saber — ver `onOutsideTurn`. O aviso sai
    // daqui, e não de quem lê o stdout do follow, porque é AQUI que se decide que a linha é nova,
    // externa e de uma pessoa: o leitor só repassa o que esta função já julgou.
    if (mirrored.type === "user") noteOutsideTurn(cardId);
    out.push(mirrored);
  }
  return out;
}

/* ---------------------------------------------------------------- runtime */

interface CardMirror {
  refs: number;
  state: MirrorState;
  child: ChildProcess | null;
}

const mirrors = new Map<string, CardMirror>();

/**
 * A memória de dedupe de um CARD — o que o driver dele já disse, ou já foi mandado dizer.
 *
 * Ela mora aqui, e não dentro do espelho, porque as duas vidas são diferentes: o espelho começa no
 * primeiro chat conectado e acaba no último que fecha, enquanto o driver fala desde o boot. O sweep
 * de retomada (`resumeInterruptedTurns`, logo depois do `listen`) injeta um turno quando nenhum
 * browser conectou ainda — e com a memória presa ao espelho essa chave era jogada fora, o espelho
 * nascia cego, e a linha que o CLI escreveu no transcript voltava como se fosse conversa nova: a
 * mensagem de sistema do deploy aparecia DUAS vezes (produção, 2026-09-28).
 */
const driverKeysByCard = new Map<string, Set<string>>();

/** A memória do card, criada na primeira vez que alguém tem algo a lembrar. */
export function driverKeysFor(cardId: string): Set<string> {
  const known = driverKeysByCard.get(cardId);
  if (known) return known;
  const keys = new Set<string>();
  driverKeysByCard.set(cardId, keys);
  return keys;
}

/**
 * A CONVERSA ANDOU FORA DO CHAT — quem precisa saber se inscreve aqui.
 *
 * O espelho é o único que enxerga isso: ele lê o transcript e reconhece o que o driver já disse, de
 * modo que o que sobra veio de OUTRO processo do CLI (a aba Terminal, falando com a MESMA sessão).
 * O driver do chat mantém a conversa em memória enquanto a corrente está aberta; sem este aviso a
 * próxima mensagem dele continua de um ponto velho e deixa o turno do terminal órfão — e mensagem
 * órfã não tem ponto de volta, então editá-la não rebobinava (ver `staleView` no sdk-driver.mjs).
 *
 * O sentido é mirror → manager, nunca o contrário: `manager.ts` já importa este módulo, e um
 * import de volta fecharia um ciclo.
 */
const outsideListeners = new Map<string, Set<() => void>>();

/** Avisa que o card teve conversa vinda de fora do chat. Nunca deixa um ouvinte derrubar o espelho. */
function noteOutsideTurn(cardId: string): void {
  for (const listener of outsideListeners.get(cardId) ?? []) {
    try { listener(); } catch { /* um ouvinte quebrado não para o espelho */ }
  }
}

/** Escuta a conversa que entra por fora neste card. Devolve o cancelamento. */
export function onOutsideTurn(cardId: string, listener: () => void): () => void {
  const set = outsideListeners.get(cardId) ?? new Set<() => void>();
  outsideListeners.set(cardId, set);
  set.add(listener);
  return () => {
    const live = outsideListeners.get(cardId);
    if (!live) return;
    live.delete(listener);
    if (live.size === 0) outsideListeners.delete(cardId);
  };
}

/** O card acabou (driver encerrado, card apagado): a memória dele vai junto. */
export function forgetDriverKeys(cardId: string): void {
  driverKeysByCard.delete(cardId);
}

/** Reports a driver event/user send of a card into its dedupe memory — haja espelho ou não. */
export function noteDriverEventFor(cardId: string, event: DriverEvent | { type: "user"; text: string }): void {
  noteDriverKeys(driverKeysFor(cardId), event);
}

/** Test hook: forget every live mirror (children are killed). */
export function resetMirrors(): void {
  for (const mirror of mirrors.values()) stopChild(mirror);
  mirrors.clear();
  driverKeysByCard.clear();
}

function stopChild(mirror: CardMirror): void {
  const child = mirror.child;
  mirror.child = null;
  if (!child) return;
  // stdin FIRST: the follow loop inside the runner watches its stdin for EOF (its parent-liveness
  // check) — this reaches across the docker exec even when killing the local client would not.
  try { child.stdin?.end(); } catch { /* already gone */ }
  try { child.kill(); } catch { /* already gone */ }
}

export interface AcquireMirrorOpts {
  /** Events at or before this instant are the connect replay's business, not the mirror's. */
  cutoffAt?: number;
  /** Transcript ids the connect replay already drew — pre-seeds the dedupe on the FIRST acquire. */
  seenIds?: Iterable<string>;
}

/**
 * Starts (or joins) the card's transcript mirror. Returns the release; the LAST release stops the
 * follow process. Never throws — a card whose mirror cannot start still has its driver socket, and
 * the failure is logged rather than taking the chat down.
 */
export async function acquireTranscriptMirror(cardId: string, opts: AcquireMirrorOpts = {}): Promise<() => void> {
  const existing = mirrors.get(cardId);
  if (existing) {
    existing.refs += 1;
    return () => release(cardId);
  }
  // O espelho ADOTA a memória do card: o que o driver já foi mandado dizer antes de alguém abrir
  // esta tela (o turno do sweep de boot, por exemplo) segue reconhecível quando voltar pelo arquivo.
  const mirror: CardMirror = {
    refs: 1,
    state: createMirrorState(opts.cutoffAt ?? Date.now(), opts.seenIds, driverKeysFor(cardId)),
    child: null,
  };
  mirrors.set(cardId, mirror);
  try {
    await primeProvenance(cardId).catch(() => undefined);
    const source = await chatSource(cardId);
    const child = spawn(source.command.file, source.command.args, { stdio: ["pipe", "pipe", "ignore"] });
    mirror.child = child;
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      const batch = lines.join("\n");
      if (batch.trim() === "") return;
      for (const event of mirrorNewEvents(mirror.state, batch, cardId)) {
        void publishExternalMessage(cardId, event);
      }
    });
    child.on("close", () => {
      // The follow died on its own (runner restart, reaper): live mirroring stops until the next
      // connect; the replay merge covers whatever happened in between.
      if (mirrors.get(cardId) === mirror) mirror.child = null;
    });
    logger.debug({ card: cardId }, "sdk transcript mirror attached");
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not start the sdk transcript mirror");
  }
  return () => release(cardId);
}

function release(cardId: string): void {
  const mirror = mirrors.get(cardId);
  if (!mirror) return;
  mirror.refs -= 1;
  if (mirror.refs > 0) return;
  mirrors.delete(cardId);
  stopChild(mirror);
  logger.debug({ card: cardId }, "sdk transcript mirror released");
}

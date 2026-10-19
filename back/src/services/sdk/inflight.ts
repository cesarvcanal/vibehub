import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

/**
 * IN-FLIGHT TURN MARKERS — the durable record that a card's SDK driver has a turn RUNNING.
 *
 * The incident this closes (2x em produção, 2026-08-31): a deploy do painel reinicia o app-vibehub;
 * o driver SDK é filho do back (docker exec) e morre junto — e um turno em voo simplesmente sumia,
 * sem aviso, porque o próprio lado que avisaria (o back) estava morrendo. O card ficava mudo.
 *
 * The manager writes ONE marker file per card (`<dataDir>/sdk-inflight/<cardId>.json`) when a user
 * turn enters the driver's stdin and removes it when the driver's `result` closes the last turn in
 * flight — so the marker's very EXISTENCE at boot means "a turn was interrupted by the restart".
 * The boot sweep (see ./resume.ts) turns those orphans into a visible system line in the card's
 * history and (once, never in a loop) an automatic resume.
 *
 * `attempts` + `progressed` are the loop-guard: 0 = a normal user turn; >=1 = this turn IS already
 * an automatic resume — it earns another one only if it made progress, up to MAX_AUTO_RESUMES.
 *
 * `owner` + o BATIMENTO: o deploy do tech.multi é BLUE/GREEN — o container novo sobe e fica saudável
 * com o antigo AINDA no ar, rodando o turno. "Existe marcador no boot" deixou de significar "o turno
 * morreu": o sweep do novo retomava um turno vivo, dois CLIs falavam na mesma sessão e o espelho do
 * back antigo gravava a fala de retomada como conversa do terminal — a mensagem de sistema duplicada
 * (produção, 2026-10-08). Cada processo assina os marcadores que escreve e toca um arquivo de
 * batimento (`sdk-inflight/owners/<owner>`) enquanto vive; o marcador só é órfão quando o dono deixa
 * de bater — o blue/green mata o antigo com SIGKILL — ou larga o batimento num SIGTERM
 * (`releaseInflightOwnerSync`, de um `docker stop`/restart).
 */

/** Where the markers live, under the data dir (same durability story as sdk-history). */
export const SDK_INFLIGHT_DIR = "sdk-inflight";

/** How much of the user's message the marker keeps — context for logs/notes, not a transcript. */
export const INFLIGHT_PREVIEW_MAX = 200;

export interface InflightMarker {
  /** When the (first) turn now in flight entered the driver's stdin (epoch ms). */
  startedAt: number;
  /** Head of the LAST user message sent — what the interrupted work was about. */
  preview?: string;
  /** Automatic resumes already spent on this chain of turns (0 = a person's own turn). */
  attempts: number;
  /**
   * The resumed turn PRODUCED something (text or a tool call) before it died. It is what tells a
   * deploy that happened to land mid-work (resume again) from a resume that dies on arrival — the
   * loop the guard exists for (see ./resume.ts).
   */
  progressed?: boolean;
  /** O processo do back que escreveu o marcador. Ausente = escrito por uma versão sem dono. */
  owner?: string;
  /**
   * TRABALHO EM SEGUNDO PLANO vivo quando o marcador foi gravado: as tarefas do CLI (Bash com
   * run_in_background, subagente, monitor) e um retorno agendado (ScheduleWakeup). Elas morrem com o
   * driver num deploy, e o turno que as esperava nunca vem — sem isto o card parava calado no meio
   * da entrega (produção, 2026-10-19). `idle` = nenhum turno rodava, só o segundo plano; `since` =
   * desde quando o segundo plano está vivo (o teto que separa espera de deploy de `npm run dev`).
   */
  background?: InflightBackground;
}

export interface InflightBackground {
  tasks: string[];
  since: number;
  idle: boolean;
}

/** A identidade DESTE processo do back — nasce no boot e assina os marcadores que ele escreve. */
export const INFLIGHT_OWNER = randomUUID();

/** De quanto em quanto tempo o processo vivo toca o seu batimento. */
export const OWNER_HEARTBEAT_MS = 3_000;

/**
 * Um batimento mais velho que isto é de um processo que morreu sem largar — o caso NORMAL do
 * blue/green, que remove o container antigo com `docker rm -f` (SIGKILL, sem SIGTERM). É o tempo que
 * a retomada espera depois da troca: curto o bastante para a pessoa, longo o bastante para uma pausa
 * do event loop não passar por morte.
 */
export const OWNER_STALE_MS = 12_000;

/** O mesmo nome nos dois lados: só um id com cara de UUID vira caminho. */
const OWNER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownerFile(owner: string): string {
  return dataPath(SDK_INFLIGHT_DIR, "owners", owner);
}

/** Same id rule as sdk-history: the card id names a file, so only id-shaped values touch the fs. */
const CARD_ID_RE = /^[0-9a-zA-Z-]{8,64}$/;

function markerFile(cardId: string): string {
  if (!CARD_ID_RE.test(cardId)) throw new Error(`invalid card id for sdk inflight marker: '${cardId}'`);
  return dataPath(SDK_INFLIGHT_DIR, `${cardId}.json`);
}

/** Trim a message to the preview the marker stores. PURE. */
export function inflightPreview(text: string): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > INFLIGHT_PREVIEW_MAX ? `${flat.slice(0, INFLIGHT_PREVIEW_MAX - 1)}…` : flat;
}

/**
 * One card's marker operations, IN THE ORDER they were asked for. Callers fire-and-forget (`void`),
 * and a write's mkdir+writeFile can otherwise land AFTER a later rm — a finished turn's marker
 * resurrected, and the next boot resuming work that was already done.
 */
const markerQueues = new Map<string, Promise<void>>();
function inOrder(cardId: string, op: () => Promise<void>): Promise<void> {
  const next = (markerQueues.get(cardId) ?? Promise.resolve()).then(op);
  markerQueues.set(cardId, next);
  void next.then(() => { if (markerQueues.get(cardId) === next) markerQueues.delete(cardId); });
  return next;
}

/** Write (or overwrite) a card's marker. Never throws — the send must not fail on a disk hiccup. */
export function writeInflightMarker(cardId: string, marker: InflightMarker): Promise<void> {
  return inOrder(cardId, () => writeMarkerNow(cardId, marker));
}

async function writeMarkerNow(cardId: string, marker: InflightMarker): Promise<void> {
  try {
    const file = markerFile(cardId);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify({ ...marker, owner: INFLIGHT_OWNER }), "utf8");
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not write the sdk inflight marker");
  }
}

/** Remove a card's marker (the turn closed, or the sweep consumed it). Idempotent, never throws. */
export function clearInflightMarker(cardId: string): Promise<void> {
  return inOrder(cardId, () => clearMarkerNow(cardId));
}

async function clearMarkerNow(cardId: string): Promise<void> {
  try {
    await rm(markerFile(cardId), { force: true });
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not clear the sdk inflight marker");
  }
}

/** Read one card's marker, or null. Malformed content reads as null (and is cleaned up by the sweep). */
export async function readInflightMarker(cardId: string): Promise<InflightMarker | null> {
  let raw: string;
  try {
    raw = await readFile(markerFile(cardId), "utf8");
  } catch {
    return null;
  }
  return parseMarker(raw);
}

/** Every marker on disk — the boot sweep's input. A missing dir is simply "no orphans". */
export async function listInflightMarkers(): Promise<Array<{ cardId: string; marker: InflightMarker }>> {
  let names: string[];
  try {
    names = await readdir(dataPath(SDK_INFLIGHT_DIR));
  } catch {
    return [];
  }
  const out: Array<{ cardId: string; marker: InflightMarker }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const cardId = name.slice(0, -".json".length);
    if (!CARD_ID_RE.test(cardId)) continue;
    const marker = await readInflightMarker(cardId);
    if (marker) out.push({ cardId, marker });
    else await clearInflightMarker(cardId); // torn/foreign file: not a turn, just leftover bytes
  }
  return out;
}

/** Parse one marker file's content. Anything not marker-shaped is null. PURE. */
export function parseMarker(raw: string): InflightMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Partial<InflightMarker>;
  if (typeof m.startedAt !== "number" || !Number.isFinite(m.startedAt)) return null;
  const attempts = typeof m.attempts === "number" && Number.isInteger(m.attempts) && m.attempts >= 0 ? m.attempts : 0;
  return {
    startedAt: m.startedAt,
    preview: typeof m.preview === "string" ? m.preview : undefined,
    attempts,
    owner: typeof m.owner === "string" && m.owner !== "" ? m.owner : undefined,
    ...(m.progressed === true ? { progressed: true } : {}),
    ...(parseBackground(m.background) ?? {}),
  };
}

/** O bloco de segundo plano de um marcador, ou nada quando ele não tem a forma esperada. PURE. */
function parseBackground(raw: unknown): { background: InflightBackground } | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<InflightBackground>;
  if (!Array.isArray(b.tasks) || typeof b.since !== "number" || !Number.isFinite(b.since)) return null;
  const tasks = b.tasks.filter((t): t is string => typeof t === "string" && t !== "");
  if (tasks.length === 0) return null;
  return { background: { tasks, since: b.since, idle: b.idle === true } };
}

/** Um batimento DESTE processo. Nunca lança: sem batimento, o pior caso é o comportamento antigo. */
export async function touchInflightOwner(): Promise<void> {
  try {
    const file = ownerFile(INFLIGHT_OWNER);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, String(Date.now()), "utf8");
  } catch (err) {
    logger.warn({ detail: (err as Error).message }, "could not touch the sdk inflight owner heartbeat");
  }
}

/** Bate já e a cada `OWNER_HEARTBEAT_MS`, sem segurar o processo de pé. Devolve o desligamento. */
export function startInflightOwnerHeartbeat(): () => void {
  void touchInflightOwner();
  const timer = setInterval(() => { void touchInflightOwner(); }, OWNER_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * O adeus do dono: some o batimento, e o processo novo de um deploy passa a ver os marcadores deste
 * como órfãos. SÍNCRONO de propósito — roda dentro do SIGTERM, que dá segundos, não promessas.
 */
export function releaseInflightOwnerSync(): void {
  try { rmSync(ownerFile(INFLIGHT_OWNER), { force: true }); } catch { /* best-effort by design */ }
}

/** Recolhe os batimentos de processos mortos — cada deploy blue/green deixa um (SIGKILL não larga). */
export async function pruneStaleInflightOwners(): Promise<void> {
  let owners: string[];
  try {
    owners = await readdir(dataPath(SDK_INFLIGHT_DIR, "owners"));
  } catch {
    return; // sem diretório, nada a recolher
  }
  for (const owner of owners) {
    if (owner === INFLIGHT_OWNER || !OWNER_RE.test(owner)) continue;
    if (await isInflightOwnerAlive(owner)) continue;
    await rm(ownerFile(owner), { force: true }).catch(() => undefined);
  }
}

/** O processo que assinou um marcador ainda está vivo? Batimento ausente ou velho = não. */
export async function isInflightOwnerAlive(owner: string): Promise<boolean> {
  if (!OWNER_RE.test(owner)) return false;
  try {
    const { mtimeMs } = await stat(ownerFile(owner));
    return Date.now() - mtimeMs < OWNER_STALE_MS;
  } catch {
    return false;
  }
}

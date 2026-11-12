import * as registry from "../board/registry.js";
import { getSettings, type Settings } from "../settings/settings.js";
import { HISTORY_REPLAY_LIMIT, appendHistory, readHistory } from "./history.js";
import {
  INFLIGHT_OWNER,
  clearInflightMarker,
  isInflightOwnerAlive,
  listInflightMarkers,
  readInflightMarker,
  releaseInflightOwnerSync,
  type InflightMarker,
} from "./inflight.js";
import { installCardSdkDriver, sdkDriverCommand } from "./driver.js";
import { restoreMissingWorkspace } from "../board/workspace.js";
import { reportCardStatusFromDriver } from "../board/agentState.js";
import { BACKGROUND_HOLD_MAX_MS, SYSTEM_ORIGIN, driverTurnRunning, ensureDriverSession, injectSystemTurn, shutdownAllDrivers } from "./manager.js";
import { stopAllMirrors } from "./mirror.js";
import { transcriptDirFor } from "../maestro/cardSession.js";
import { effectiveAccountSlug } from "../board/registry.js";
import { logger } from "../../utils/logger.js";
import { defusedCommandList } from "../../utils/ultraWords.js";

/**
 * BOOT RESUME — a deploy do painel não pode mais matar um turno do chat nativo EM SILÊNCIO.
 *
 * O incidente (2x em 2026-08-31): push na main → auto-deploy reinicia o app-vibehub → o driver SDK
 * (filho do back via docker exec) morre junto, no meio de um trabalho longo — e o card ficava mudo,
 * sem uma linha sequer dizendo o que aconteceu. O back não podia avisar: era ele que estava morrendo.
 *
 * A resposta é durável, não heróica: o manager grava um MARCADOR por card enquanto um turno está em
 * voo (services/sdk/inflight.ts). Este sweep roda UMA vez no boot e, para cada marcador órfão:
 *
 *  1. escreve uma linha de sistema visível no sdk-history do card ("o turno foi interrompido por uma
 *     atualização do painel…") — o silêncio acaba aqui, mesmo com tudo o mais desligado;
 *  2. com `sdkAutoResume` ligado (default) e attempts == 0: sobe o driver de novo (resume da sessão
 *     persistida no card) e injeta um turno de CONTINUAÇÃO com proveniência de sistema — a mensagem
 *     nunca parece fala do usuário (mecanismo de origem do #48), e chega ao driver como turno de
 *     usuário NORMAL (nunca embrulhada em notificação — a lição do "No response requested.");
 *  3. attempts >= 1 (o turno interrompido JÁ ERA um resume automático): retoma DE NOVO só se ele
 *     avançou (`progressed`: a IA escreveu ou rodou alguma coisa antes de morrer) e ainda não gastou
 *     MAX_AUTO_RESUMES. Num dia de muitos deploys o trabalho segue até o fim (produção, 2026-10-19:
 *     a segunda atualização seguida largava a tarefa pela metade); o que não avança é o loop de
 *     verdade — a retomada que morre ao chegar — e esse para com a linha de sistema e o estado
 *     parado explícito. O teto cobre o caso que avança E derruba o painel a cada volta, logo depois
 *     de voltar: a retomada que ficou de pé por SETTLED_RESUME_MS recomeça a cadeia (nextResumeAttempt).
 *  4. o turno estava PARADO num cartão de pergunta: nada a retomar — só a linha, e o cartão fica
 *     aberto para a pessoa responder (a resposta vai como mensagem, com o segundo plano que morreu;
 *     ver manager.ts).
 *
 * Melhor esforço por card: um card que falha não impede os outros, e falha alguma derruba o boot.
 *
 * ÓRFÃO DE VERDADE, não só "existe marcador": o deploy do tech.multi é BLUE/GREEN — este processo
 * nasce com o antigo AINDA rodando o turno. Retomar ali punha dois CLIs na mesma sessão e o espelho
 * do antigo gravava a fala de retomada como conversa do terminal: a mensagem de sistema aparecia
 * duas vezes (produção, 2026-10-08). O sweep espera o dono do marcador parar de bater — a troca do
 * blue/green remove o antigo com `docker rm -f` (SIGKILL) — ou largar o batimento num SIGTERM
 * (`handOffSdkOnShutdown`). Se o turno acabar lá enquanto isso, o marcador some e não há o que retomar.
 */

/** De quanto em quanto tempo o sweep reconsulta um marcador cujo dono ainda vive. */
const OWNER_POLL_MS = 2_000;

/** A mensagem de continuação injetada no driver — proveniência de sistema, texto curto e direto. */
export const RESUME_CONTINUATION_TEXT =
  "Continue de onde parou: o processo anterior foi interrompido por um reinício do servidor do painel (deploy). " +
  "Retome a tarefa em andamento e conclua o que estava fazendo.";

/**
 * A continuação de um turno que tinha trabalho em segundo plano: a interrupção (deploy ou queda do
 * driver) matou essas tarefas e o
 * aviso de término delas nunca virá. Sem dizer isso, o agente "retomava" esperando por um resultado
 * que não chega — ou nem havia retomada, e o card parava calado no meio da entrega. PURE.
 */
export function resumeContinuationText(marker: InflightMarker, base: string = RESUME_CONTINUATION_TEXT): string {
  const tasks = marker.background?.tasks ?? [];
  if (tasks.length === 0) return base;
  // O comando citado não é pedido deste turno: com a palavra reservada nele, a retomada subia a max.
  const list = defusedCommandList(tasks.slice(0, 8));
  return `${base} A interrupção também encerrou o que estava rodando em segundo plano — ` +
    `o resultado disso não vai chegar:\n${list}\nConfira o estado atual, rode de novo o que ainda for ` +
    `necessário e siga até o fim.`;
}

/**
 * Só segundo plano, e há muito tempo (um `npm run dev`, um `tail -f`): não é uma entrega no meio
 * do caminho, é um processo de fundo. Acordar o agente a cada deploy por causa dele seria ruído. PURE.
 */
export function isStaleBackgroundOnly(marker: InflightMarker, now: number): boolean {
  const bg = marker.background;
  return !!bg && bg.idle && now - bg.since > BACKGROUND_HOLD_MAX_MS;
}


/** Retomadas automáticas seguidas, no máximo, que morrem logo depois de avançar. */
export const MAX_AUTO_RESUMES = 5;

/**
 * A retomada que avançou e ficou de pé por este tempo trabalhou de verdade: o deploy que a matou é
 * dos outros, e ela não gasta o teto. Num dia de deploy a cada ~5 min, a 5ª retomada de um trabalho
 * longo parava o card no meio com `progressed: true` (produção, troca-de-effort-f121, 2026-11-10).
 * O teto fica para o turno que derruba o painel logo depois de voltar.
 */
export const SETTLED_RESUME_MS = 2 * 60_000;

/**
 * O número da próxima retomada automática do turno interrompido, ou null quando não há outra. A que
 * avançou e assentou recomeça a cadeia em 1 — ainda precisa avançar para ganhar a seguinte. PURA.
 */
export function nextResumeAttempt(marker: InflightMarker, now: number): number | null {
  if (marker.attempts === 0) return 1;
  if (marker.progressed !== true) return null;
  if (now - marker.startedAt >= SETTLED_RESUME_MS) return 1;
  return marker.attempts < MAX_AUTO_RESUMES ? marker.attempts + 1 : null;
}

/** As linhas de sistema que o card ganha, conforme o caso. */
export const NOTE_RESUMING =
  "O turno foi interrompido por uma atualização do painel — retomando automaticamente…";
export const NOTE_NOT_AGAIN =
  "O turno foi interrompido de novo por uma atualização do painel, sem avançar desde a última retomada " +
  "(ou depois de muitas retomadas seguidas). Para evitar um loop, não vou retomar automaticamente outra " +
  "vez — mande uma mensagem para continuar.";
export const NOTE_BACKGROUND_STALE =
  "Uma atualização do painel encerrou as tarefas que rodavam em segundo plano neste card havia horas " +
  "(sem turno em andamento). Não vou retomar sozinho — mande uma mensagem se precisar delas de volta.";
export const NOTE_AUTO_OFF =
  "O turno foi interrompido por uma atualização do painel. A retomada automática está desligada " +
  "(sdkAutoResume) — mande uma mensagem para continuar.";

export const NOTE_AWAITING_ANSWER =
  "O turno foi interrompido por uma atualização do painel enquanto o agente esperava a sua resposta. " +
  "A pergunta continua aberta: responda o cartão e ele segue de onde parou.";

/** A linha que segue um "retomando…" que não deu certo — o card não fica prometendo para sempre. */
export const NOTE_RESUME_FAILED =
  "A retomada automática falhou antes de chegar ao Claude. Mande uma mensagem para continuar.";

/** As palavras de uma retomada: o que o card lê e o que o agente recebe, conforme a causa. */
interface ResumeTexts {
  cause: "restart" | "crash";
  resuming: string;
  notAgain: string;
  backgroundStale: string;
  autoOff: string;
  /** O turno estava parado num cartão de pergunta: não há retomada, a pessoa responde o cartão. */
  awaitingAnswer: string;
  continuation: string;
}

const DEPLOY_TEXTS: ResumeTexts = {
  cause: "restart",
  resuming: NOTE_RESUMING,
  notAgain: NOTE_NOT_AGAIN,
  backgroundStale: NOTE_BACKGROUND_STALE,
  autoOff: NOTE_AUTO_OFF,
  awaitingAnswer: NOTE_AWAITING_ANSWER,
  continuation: RESUME_CONTINUATION_TEXT,
};

/** A queda do driver com o back de pé — não houve atualização do painel, e o card não pode dizer que houve. */
export const CRASH_TEXTS: ResumeTexts = {
  cause: "crash",
  resuming: "O processo do Claude deste card caiu no meio do turno — retomando automaticamente…",
  notAgain:
    "O processo do Claude deste card caiu de novo, sem avançar desde a última retomada (ou depois de muitas " +
    "retomadas seguidas). Para evitar um loop, não vou retomar automaticamente outra vez — mande uma mensagem para continuar.",
  backgroundStale:
    "O processo do Claude deste card caiu e encerrou as tarefas que rodavam em segundo plano havia horas " +
    "(sem turno em andamento). Não vou retomar sozinho — mande uma mensagem se precisar delas de volta.",
  autoOff:
    "O processo do Claude deste card caiu no meio do turno. A retomada automática está desligada " +
    "(sdkAutoResume) — mande uma mensagem para continuar.",
  awaitingAnswer:
    "O processo do Claude deste card caiu enquanto o agente esperava a sua resposta. " +
    "A pergunta continua aberta: responda o cartão e ele segue de onde parou.",
  continuation:
    "Continue de onde parou: o processo anterior do Claude deste card caiu no meio do trabalho (foi encerrado " +
    "de fora, sem reinício do painel). Retome a tarefa em andamento e conclua o que estava fazendo.",
};

/** Este processo recebeu SIGTERM (handOffSdkOnShutdown). */
let shuttingDown = false;

/** Quanto a retomada de uma queda espera: o runner que derrubou o driver (memória, reinício) respira antes. */
export const CRASH_RESUME_DELAY_MS = 10_000;

/** Test seams: every side effect the sweep performs, replaceable as one bundle. */
export interface ResumeDeps {
  listMarkers: typeof listInflightMarkers;
  clearMarker: typeof clearInflightMarker;
  getCard: typeof registry.getCard;
  getProject: typeof registry.getProject;
  settings: typeof getSettings;
  installDriver: typeof installCardSdkDriver;
  restoreWorkspace: typeof restoreMissingWorkspace;
  commandFor: typeof sdkDriverCommand;
  ensureSession: typeof ensureDriverSession;
  inject: typeof injectSystemTurn;
  /** `lostBackground`: o segundo plano que morreu, gravado na nota para ir junto da resposta do cartão. */
  appendNote: (cardId: string, text: string, extra?: { lostBackground?: string[] }) => Promise<void>;
  readMarker: typeof readInflightMarker;
  /** A identidade deste processo: o marcador que ela assina é um turno vivo DAQUI, não um órfão. */
  selfOwner: string;
  ownerAlive: typeof isInflightOwnerAlive;
  /** Um driver deste card está com turno rodando agora (o sucessor que a pessoa já usou). */
  turnRunning: (cardId: string) => boolean;
  /** Este processo recebeu SIGTERM: quem retoma agora é o processo novo, não este. */
  stopping: () => boolean;
  /** A bolinha vai a `waiting` — a queda que não virou retomada (o manager a segurou em `working`). */
  reportIdle: (cardId: string) => void;
  /**
   * O turno começado em `since` está esperando a pessoa num cartão de pergunta aberto? Com ele, o
   * trabalho em paralelo que o reinício matou (subagentes sem resultado).
   */
  awaitingAnswer: (cardId: string, since: number) => Promise<{ open: boolean; lostParallel: string[] }>;
  /** O card acende o "precisa de você": o cartão aberto espera a pessoa. */
  markAwaitingDecision: (cardId: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
}

const realDeps: ResumeDeps = {
  listMarkers: listInflightMarkers,
  clearMarker: clearInflightMarker,
  getCard: registry.getCard,
  getProject: registry.getProject,
  settings: getSettings,
  installDriver: installCardSdkDriver,
  restoreWorkspace: restoreMissingWorkspace,
  commandFor: sdkDriverCommand,
  ensureSession: ensureDriverSession,
  inject: injectSystemTurn,
  appendNote: (cardId, text, extra) =>
    appendHistory(cardId, { type: "system_note", text, ...(extra?.lostBackground?.length ? { lostBackground: extra.lostBackground } : {}), at: Date.now() }),
  readMarker: readInflightMarker,
  selfOwner: INFLIGHT_OWNER,
  ownerAlive: isInflightOwnerAlive,
  turnRunning: driverTurnRunning,
  stopping: () => shuttingDown,
  reportIdle: (cardId) => reportCardStatusFromDriver(cardId, "waiting"),
  awaitingAnswer: awaitingAnswerInHistory,
  markAwaitingDecision: (cardId) => registry.setCardAwaitingDecision(cardId, Date.now()),
  wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
};

/**
 * Os cartões de pergunta feitos desde `since` que nenhum `question_result` encerrou — o que o turno
 * interrompido esperava da pessoa. PURA.
 */
export function openQuestionIds(events: ReadonlyArray<{ type: string; id?: unknown; at?: number }>, since: number): string[] {
  const open = new Set<string>();
  for (const event of events) {
    if (typeof event.id !== "string") continue;
    if (event.type === "user_question" && (event.at ?? 0) >= since) open.add(event.id);
    else if (event.type === "question_result") open.delete(event.id);
  }
  return [...open];
}

/**
 * Os subagentes (Agent/Task) chamados desde `since` que não voltaram — rodavam em paralelo e morreram
 * com o reinício. PURA.
 */
function unfinishedSubagents(
  events: ReadonlyArray<{ type: string; id?: unknown; name?: unknown; input?: unknown; at?: number }>,
  since: number,
): string[] {
  const open = new Map<string, string>();
  for (const event of events) {
    if (typeof event.id !== "string" || (event.at ?? 0) < since) continue;
    if (event.type === "tool_use" && (event.name === "Agent" || event.name === "Task")) {
      const input = (event.input ?? {}) as { description?: unknown };
      open.set(event.id, `subagente: ${typeof input.description === "string" && input.description ? input.description : event.id}`);
    } else if (event.type === "tool_result") open.delete(event.id);
  }
  return [...open.values()];
}

/** O histórico do card diz se o turno começado em `since` está esperando a resposta de um cartão. */
export async function awaitingAnswerInHistory(cardId: string, since: number): Promise<{ open: boolean; lostParallel: string[] }> {
  const events = await readHistory(cardId, HISTORY_REPLAY_LIMIT, { strict: true });
  return { open: openQuestionIds(events, since).length > 0, lostParallel: unfinishedSubagents(events, since) };
}

/**
 * Espera o marcador deixar de ter dono vivo. Devolve o marcador ÓRFÃO (a versão relida, que é a
 * que vale), ou null quando não há nada a retomar: o turno terminou no dono, ou o marcador passou
 * a ser deste processo (alguém mandou mensagem aqui enquanto o antigo ainda saía).
 */
async function orphanedMarker(cardId: string, first: InflightMarker, deps: ResumeDeps): Promise<InflightMarker | null> {
  let marker: InflightMarker | null = first;
  let announced = false;
  while (marker) {
    // Sem dono = escrito por uma versão anterior a este mecanismo: órfão como sempre foi.
    if (!marker.owner) return marker;
    if (marker.owner === deps.selfOwner) return null;
    if (!(await deps.ownerAlive(marker.owner))) return marker;
    if (!announced) {
      announced = true;
      logger.info({ card: cardId, owner: marker.owner }, "sdk turn still alive in the previous instance — waiting for it to hand off");
    }
    await deps.wait(OWNER_POLL_MS);
    marker = await deps.readMarker(cardId);
  }
  return null;
}

interface ResumeSummary {
  /** Cards whose interrupted turn was resumed automatically. */
  resumed: string[];
  /** Cards that only got the system line (attempts spent, flag off, sdkDriver off, card gone). */
  noted: string[];
}

/**
 * The one boot sweep. Never throws; returns what it did (for the log and for the tests).
 * Chamar DEPOIS do listen — o resume não deve atrasar o servidor a aceitar conexões.
 */
export async function resumeInterruptedTurns(deps: ResumeDeps = realDeps): Promise<ResumeSummary> {
  const summary: ResumeSummary = { resumed: [], noted: [] };
  let markers: Array<{ cardId: string; marker: InflightMarker }>;
  try {
    markers = await deps.listMarkers();
  } catch (err) {
    logger.warn({ detail: (err as Error).message }, "could not list sdk inflight markers at boot");
    return summary;
  }
  if (markers.length === 0) return summary;

  let settings: Settings;
  try {
    settings = await deps.settings();
  } catch (err) {
    logger.warn({ detail: (err as Error).message }, "could not read settings for the sdk boot resume");
    return summary;
  }

  // Cada card na sua própria tarefa: o turno vivo de um card não atrasa a retomada de outro.
  // O install do driver no runner é um só, compartilhado por todos.
  let install: Promise<void> | null = null;
  const installOnce = (): Promise<void> => (install ??= deps.installDriver());
  await Promise.all(markers.map(async ({ cardId, marker: first }) => {
    let marker: InflightMarker | null;
    try {
      marker = await orphanedMarker(cardId, first, deps);
    } catch (err) {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not tell whether an sdk inflight marker is orphaned");
      return;
    }
    if (!marker) return;
    const outcome = await resumeCard(cardId, marker, settings, deps, installOnce, DEPLOY_TEXTS);
    if (outcome === "resumed") summary.resumed.push(cardId);
    else if (outcome === "noted") {
      summary.noted.push(cardId);
      // O `working` no board é do processo que morreu com o turno: nenhum hook nem driver daqui vai
      // apagá-lo (produção, card a28ffa23, 2026-10-20). Só no "noted": o "skipped" é card parado de
      // propósito (um relato o desibernaria) ou conversa que seguiu num turno vivo, dono da bolinha.
      settleUnresumed(cardId, outcome, deps);
    }
  }));
  return summary;
}

/** O que coube a UM card cujo turno morreu (ver `resumeCard`). */
type ResumeOutcome = "resumed" | "noted" | "skipped";

/**
 * UM card cujo turno morreu: a linha visível e, se as regras deixam, a retomada. A mesma para o
 * boot (deploy) e para a queda do driver; só as palavras mudam. Nunca lança. "skipped" = nada a
 * dizer nem a retomar: o card sumiu ou foi parado de propósito (marcador varrido em silêncio), ou a
 * conversa andou durante a preparação.
 */
async function resumeCard(
  cardId: string,
  marker: InflightMarker,
  settings: Settings,
  deps: ResumeDeps,
  installOnce: () => Promise<void>,
  texts: ResumeTexts,
): Promise<ResumeOutcome> {
  let announced = false;
  try {
    const card = await deps.getCard(cardId);
    const project = card ? await deps.getProject(card.projectId) : undefined;
    if (!card || !project) {
      // The card is gone (deleted between the marker and this boot): nothing to tell, no one to tell it to.
      await deps.clearMarker(cardId);
      return "skipped";
    }
    if (!registry.hasLiveSession(card)) {
      // Pausado ou hibernado depois da queda: o card foi parado DE PROPÓSITO — a pausa não teve driver
      // vivo para limpar o marcador (ele já tinha caído). Retomar seria desfazer a decisão da pessoa.
      await deps.clearMarker(cardId);
      return "skipped";
    }
    if (!settings.sdkDriver || !settings.sdkAutoResume) {
      await deps.appendNote(cardId, texts.autoOff);
      await deps.clearMarker(cardId);
      logger.info({ audit: true, action: "sdk.resume.off", card: card.worktreeSlug }, "interrupted sdk turn noted — auto-resume off");
      return "noted";
    }
    if (isStaleBackgroundOnly(marker, Date.now())) {
      await deps.appendNote(cardId, texts.backgroundStale);
      await deps.clearMarker(cardId);
      logger.info({ audit: true, action: "sdk.resume.background_stale", card: card.worktreeSlug }, "long-lived background work ended by the restart — noted, not resumed");
      return "noted";
    }
    const waiting = await awaitingAnswer(cardId, marker, deps);
    if (waiting) {
      // Parado num cartão de pergunta, o turno não tem o que retomar: ele espera a pessoa. A retomada
      // fechava o cartão ("respondeu por mensagem") e o agente perguntava de novo num cartão em
      // branco — o que já estava marcado se perdia (produção, 2026-11-03). Aberto, o clique vai ao
      // modelo como mensagem (a resposta da órfã, manager.ts) — com o que os outros marcaram e, se o
      // reinício matou algo em segundo plano, com a lista do que morreu (gravada nesta nota).
      // O que morreu junto — segundo plano e subagentes em paralelo — vai ao modelo com a resposta.
      const lostBackground = [...(marker.background?.tasks ?? []), ...waiting.lostParallel];
      await deps.appendNote(cardId, texts.awaitingAnswer, lostBackground.length ? { lostBackground } : undefined);
      await deps.clearMarker(cardId);
      await deps.markAwaitingDecision(cardId).catch(() => undefined);
      logger.info({ audit: true, action: "sdk.resume.awaiting_answer", card: card.worktreeSlug }, "interrupted sdk turn was waiting on a question card — left open, not resumed");
      return "noted";
    }
    const attempt = nextResumeAttempt(marker, Date.now());
    if (attempt === null) {
      await deps.appendNote(cardId, texts.notAgain);
      await deps.clearMarker(cardId);
      logger.warn(
        { audit: true, action: "sdk.resume.loop_guard", card: card.worktreeSlug, attempts: marker.attempts, progressed: !!marker.progressed },
        "interrupted sdk turn NOT resumed again — loop guard",
      );
      return "noted";
    }
    await deps.appendNote(cardId, texts.resuming);
    announced = true;
    await installOnce();
    await deps.restoreWorkspace(card.id);
    // O resume usa a chave persistida no card (resumeSessionId — gravada pelo manager a cada
    // session/result). O probe de transcript do connect não roda aqui: é o mesmo alvo na prática,
    // e o boot não deve depender de um ls no runner para cada card.
    const command = await deps.commandFor(project, card);
    // A preparação leva segundos (install, workspace, comando): se nesse meio-tempo a conversa
    // SEGUIU — a pessoa escreveu num driver que o reconnect subiu, e o marcador já é o turno dela —
    // a continuação cairia em cima do turno de alguém. Conferido aqui, logo antes de injetar.
    if (deps.stopping()) return "skipped"; // o marcador fica: é o recado para o processo novo
    if (await conversationMovedOn(cardId, marker, deps)) {
      logger.info({ audit: true, action: "sdk.resume.superseded", card: card.worktreeSlug }, "the conversation moved on while the resume was being prepared — not injected");
      return "skipped";
    }
    const session = deps.ensureSession({
      cardId: card.id,
      label: card.worktreeSlug,
      command,
      transcriptDir: transcriptDirFor(project, card, effectiveAccountSlug(card, project)),
    });
    // SEM progresso — o marcador do turno retomado só ganha `progressed` quando a IA produzir algo
    // (manager); se morrer antes disso, o próximo boot só anota.
    deps.inject(session, resumeContinuationText(marker, texts.continuation), SYSTEM_ORIGIN, attempt);
    logger.info(
      {
        audit: true, action: "sdk.resume", card: card.worktreeSlug, cause: texts.cause,
        interruptedAt: marker.startedAt, preview: marker.preview, attempt,
        background: marker.background?.tasks,
      },
      "interrupted sdk turn resumed",
    );
    return "resumed";
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not resume an interrupted sdk turn");
    // Depois de um "retomando…" na tela, o silêncio seria a mesma parada calada de sempre.
    if (announced) await deps.appendNote(cardId, NOTE_RESUME_FAILED).catch(() => undefined);
    // The marker stays only when nothing was written: with the note already down, keeping the
    // marker would note the same interruption again on the next boot. Best-effort cleanup:
    await deps.clearMarker(cardId).catch(() => undefined);
    return "noted";
  }
}

/**
 * O turno do marcador estava esperando a resposta de um cartão? Devolve o trabalho em paralelo que
 * morreu junto, ou null. Na dúvida (disco ilegível), null: retoma como antes.
 */
async function awaitingAnswer(cardId: string, marker: InflightMarker, deps: ResumeDeps): Promise<{ lostParallel: string[] } | null> {
  try {
    const found = await deps.awaitingAnswer(cardId, marker.startedAt);
    return found.open ? { lostParallel: found.lostParallel } : null;
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not read the history for open question cards — resuming as usual");
    return null;
  }
}

/** A conversa andou desde este marcador: outro turno no disco, ou um turno rodando num driver vivo. */
async function conversationMovedOn(cardId: string, marker: InflightMarker, deps: ResumeDeps): Promise<boolean> {
  const now = await deps.readMarker(cardId);
  return !now || now.startedAt !== marker.startedAt || deps.turnRunning(cardId);
}

/**
 * O DRIVER CAIU com o back de pé (OOM, kill, o docker exec que morreu) e havia trabalho em voo. O
 * marcador é deste processo, vivo — o sweep de boot nunca o veria como órfão, e o turno só voltaria
 * no próximo deploy, fora de hora. Espera um pouco (o runner que derrubou o driver respira), relê o
 * marcador e só retoma se NADA andou nesse meio-tempo: o mesmo turno (a pessoa não mandou outra
 * mensagem num driver sucessor) e nenhum turno rodando. Daí em diante, as regras do boot.
 */
export async function resumeAfterDriverCrash(
  cardId: string,
  crashed: InflightMarker,
  deps: ResumeDeps = realDeps,
): Promise<ResumeOutcome> {
  let outcome: ResumeOutcome = "skipped";
  try {
    await deps.wait(CRASH_RESUME_DELAY_MS);
    // SIGTERM na espera: o marcador é o recado para o processo novo, que retoma ele mesmo.
    if (deps.stopping()) return "skipped";
    // Conferido já aqui também: uma queda superada não ganha nem a linha "retomando…".
    if (!(await conversationMovedOn(cardId, crashed, deps))) {
      outcome = await resumeCard(cardId, crashed, await deps.settings(), deps, () => deps.installDriver(), CRASH_TEXTS);
    }
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not resume after an sdk driver crash");
    // Deixado, o marcador deste processo vivo seria retomado no próximo deploy, fora de hora.
    await deps.clearMarker(cardId).catch(() => undefined);
  }
  // O manager segurou a bolinha em `working` à espera deste veredito.
  settleUnresumed(cardId, outcome, deps);
  return outcome;
}

/**
 * O turno morto que NÃO virou retomada: sem turno vivo noutro driver, a bolinha vai a `waiting` — o
 * "turno terminou" de verdade, uma vez. Num SIGTERM quem decide é o processo novo.
 */
function settleUnresumed(cardId: string, outcome: ResumeOutcome, deps: ResumeDeps): void {
  if (outcome !== "resumed" && !deps.stopping() && !deps.turnRunning(cardId)) deps.reportIdle(cardId);
}

/**
 * O adeus deste processo num SIGTERM (`docker stop`, restart; a troca do blue/green é SIGKILL e não
 * passa aqui — lá o batimento envelhece sozinho). NESTA ordem, que é a que fecha a duplicata:
 *  1. os espelhos param: daqui em diante nada que o processo novo escrever no transcript volta como
 *     "terminal" por este lado;
 *  2. os drivers encerram (os marcadores ficam: são o recado para o novo);
 *  3. o batimento some: só agora o sweep do novo passa a ver os marcadores deste como órfãos.
 * Síncrono — o docker stop dá segundos, não promessas.
 */
export function handOffSdkOnShutdown(): void {
  shuttingDown = true; // uma retomada de queda em espera não sobe mais nada (ver resumeAfterDriverCrash)
  try { stopAllMirrors(); } catch { /* best-effort by design */ }
  try { shutdownAllDrivers(); } catch { /* best-effort by design */ }
  releaseInflightOwnerSync();
}

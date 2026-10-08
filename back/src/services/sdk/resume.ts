import * as registry from "../board/registry.js";
import { getSettings } from "../settings/settings.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { appendHistory } from "./history.js";
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
import { ensureDriverSession, injectSystemTurn, shutdownAllDrivers } from "./manager.js";
import { stopAllMirrors } from "./mirror.js";
import { transcriptDirFor } from "../maestro/maestro.js";
import { effectiveAccountSlug } from "../board/registry.js";
import { logger } from "../../utils/logger.js";

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
 *  3. attempts >= 1 (o turno interrompido JÁ ERA um resume automático): só a linha de sistema e o
 *     estado parado explícito — nunca um loop de deploy→resume→deploy→resume.
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
export const OWNER_POLL_MS = 2_000;

/** A mensagem de continuação injetada no driver — proveniência de sistema, texto curto e direto. */
export const RESUME_CONTINUATION_TEXT =
  "Continue de onde parou: o processo anterior foi interrompido por um reinício do servidor do painel (deploy). " +
  "Retome a tarefa em andamento e conclua o que estava fazendo.";

/** Quem assina a linha e o turno injetado: o painel, nunca uma pessoa. */
export const SYSTEM_ORIGIN: MessageOrigin = { kind: "system", name: "vibehub" };

/** As linhas de sistema que o card ganha, conforme o caso. */
export const NOTE_RESUMING =
  "O turno foi interrompido por uma atualização do painel — retomando automaticamente…";
export const NOTE_NOT_AGAIN =
  "O turno foi interrompido de novo por uma atualização do painel. Para evitar um loop, não vou retomar " +
  "automaticamente outra vez — mande uma mensagem para continuar.";
export const NOTE_AUTO_OFF =
  "O turno foi interrompido por uma atualização do painel. A retomada automática está desligada " +
  "(sdkAutoResume) — mande uma mensagem para continuar.";

/** Test seams: every side effect the sweep performs, replaceable as one bundle. */
export interface ResumeDeps {
  listMarkers: typeof listInflightMarkers;
  clearMarker: typeof clearInflightMarker;
  getCard: typeof registry.getCard;
  getProject: typeof registry.getProject;
  settings: typeof getSettings;
  installDriver: typeof installCardSdkDriver;
  commandFor: typeof sdkDriverCommand;
  ensureSession: typeof ensureDriverSession;
  inject: typeof injectSystemTurn;
  appendNote: (cardId: string, text: string) => Promise<void>;
  readMarker: typeof readInflightMarker;
  /** A identidade deste processo: o marcador que ela assina é um turno vivo DAQUI, não um órfão. */
  selfOwner: string;
  ownerAlive: typeof isInflightOwnerAlive;
  wait: (ms: number) => Promise<void>;
}

const realDeps: ResumeDeps = {
  listMarkers: listInflightMarkers,
  clearMarker: clearInflightMarker,
  getCard: registry.getCard,
  getProject: registry.getProject,
  settings: getSettings,
  installDriver: installCardSdkDriver,
  commandFor: sdkDriverCommand,
  ensureSession: ensureDriverSession,
  inject: injectSystemTurn,
  appendNote: (cardId, text) => appendHistory(cardId, { type: "system_note", text, at: Date.now() }),
  readMarker: readInflightMarker,
  selfOwner: INFLIGHT_OWNER,
  ownerAlive: isInflightOwnerAlive,
  wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
};

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

export interface ResumeSummary {
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

  let settings: Awaited<ReturnType<typeof getSettings>>;
  try {
    settings = await deps.settings();
  } catch (err) {
    logger.warn({ detail: (err as Error).message }, "could not read settings for the sdk boot resume");
    return summary;
  }

  // Cada card na sua própria tarefa: o turno vivo de um card não atrasa a retomada de outro.
  // O install do driver no runner é um só, compartilhado por todos.
  let install: Promise<void> | null = null;
  await Promise.all(markers.map(async ({ cardId, marker: first }) => {
    let marker: InflightMarker | null;
    try {
      marker = await orphanedMarker(cardId, first, deps);
    } catch (err) {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not tell whether an sdk inflight marker is orphaned");
      return;
    }
    if (!marker) return;
    try {
      const card = await deps.getCard(cardId);
      const project = card ? await deps.getProject(card.projectId) : undefined;
      if (!card || !project) {
        // The card is gone (deleted between the marker and this boot): nothing to tell, no one to tell it to.
        await deps.clearMarker(cardId);
        return;
      }
      if (!settings.sdkDriver || !settings.sdkAutoResume) {
        await deps.appendNote(cardId, NOTE_AUTO_OFF);
        await deps.clearMarker(cardId);
        summary.noted.push(cardId);
        logger.info({ audit: true, action: "sdk.resume.off", card: card.worktreeSlug }, "interrupted sdk turn noted — auto-resume off");
        return;
      }
      if (marker.attempts >= 1) {
        await deps.appendNote(cardId, NOTE_NOT_AGAIN);
        await deps.clearMarker(cardId);
        summary.noted.push(cardId);
        logger.warn(
          { audit: true, action: "sdk.resume.loop_guard", card: card.worktreeSlug, attempts: marker.attempts },
          "interrupted sdk turn NOT resumed again — loop guard",
        );
        return;
      }
      await deps.appendNote(cardId, NOTE_RESUMING);
      await (install ??= deps.installDriver());
      // O resume usa a chave persistida no card (resumeSessionId — gravada pelo manager a cada
      // session/result). O probe de transcript do connect não roda aqui: é o mesmo alvo na prática,
      // e o boot não deve depender de um ls no runner para cada card.
      const command = await deps.commandFor(project, card);
      const session = deps.ensureSession({
        cardId: card.id,
        label: card.worktreeSlug,
        command,
        transcriptDir: transcriptDirFor(project, card, effectiveAccountSlug(card, project)),
      });
      // attempts: marker.attempts + 1 — o marcador do turno retomado nasce já gastando a única
      // retomada automática; se ESTE turno morrer por outro deploy, o próximo boot só anota.
      deps.inject(session, RESUME_CONTINUATION_TEXT, SYSTEM_ORIGIN, marker.attempts + 1);
      summary.resumed.push(cardId);
      logger.info(
        {
          audit: true, action: "sdk.resume", card: card.worktreeSlug,
          interruptedAt: marker.startedAt, preview: marker.preview,
        },
        "interrupted sdk turn resumed after the panel restart",
      );
    } catch (err) {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not resume an interrupted sdk turn");
      // The marker stays only when nothing was written: with the note already down, keeping the
      // marker would note the same interruption again on the next boot. Best-effort cleanup:
      await deps.clearMarker(cardId).catch(() => undefined);
    }
  }));
  return summary;
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
  try { stopAllMirrors(); } catch { /* best-effort by design */ }
  try { shutdownAllDrivers(); } catch { /* best-effort by design */ }
  releaseInflightOwnerSync();
}

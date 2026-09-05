import * as registry from "../board/registry.js";
import { getSettings } from "../settings/settings.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { appendHistory } from "./history.js";
import { clearInflightMarker, listInflightMarkers, type InflightMarker } from "./inflight.js";
import { installCardSdkDriver, sdkDriverCommand } from "./driver.js";
import { ensureDriverSession, injectSystemTurn } from "./manager.js";
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
 */

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
};

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

  let driverInstalled = false;
  for (const { cardId, marker } of markers) {
    try {
      const card = await deps.getCard(cardId);
      const project = card ? await deps.getProject(card.projectId) : undefined;
      if (!card || !project) {
        // The card is gone (deleted between the marker and this boot): nothing to tell, no one to tell it to.
        await deps.clearMarker(cardId);
        continue;
      }
      if (!settings.sdkDriver || !settings.sdkAutoResume) {
        await deps.appendNote(cardId, NOTE_AUTO_OFF);
        await deps.clearMarker(cardId);
        summary.noted.push(cardId);
        logger.info({ audit: true, action: "sdk.resume.off", card: card.worktreeSlug }, "interrupted sdk turn noted — auto-resume off");
        continue;
      }
      if (marker.attempts >= 1) {
        await deps.appendNote(cardId, NOTE_NOT_AGAIN);
        await deps.clearMarker(cardId);
        summary.noted.push(cardId);
        logger.warn(
          { audit: true, action: "sdk.resume.loop_guard", card: card.worktreeSlug, attempts: marker.attempts },
          "interrupted sdk turn NOT resumed again — loop guard",
        );
        continue;
      }
      await deps.appendNote(cardId, NOTE_RESUMING);
      if (!driverInstalled) {
        await deps.installDriver();
        driverInstalled = true;
      }
      // O resume usa a chave persistida no card (resumeSessionId — gravada pelo manager a cada
      // session/result). O probe de transcript do connect não roda aqui: é o mesmo alvo na prática,
      // e o boot não deve depender de um ls no runner para cada card.
      const command = await deps.commandFor(project, card);
      const session = deps.ensureSession({ cardId: card.id, label: card.worktreeSlug, command });
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
  }
  return summary;
}

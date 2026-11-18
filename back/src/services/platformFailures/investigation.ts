import type { PublicUser } from "../../auth/users.js";
import { creatorAccountSlug } from "../../auth/userGit.js";
import * as registry from "../board/registry.js";
import { recordCardActor } from "../board/actor.js";
import { SEND_READY_WAIT_MS, sendToTerminal } from "../maestro/maestro.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { getSettings } from "../settings/settings.js";
import {
  PlatformFailureStateError, claimPlatformFailureInvestigation, getPlatformFailure, releasePlatformFailureInvestigation,
  setPlatformFailureInvestigationCard, settlePlatformFailureInvestigation,
} from "./platformFailures.js";
import type { PlatformFailure, PlatformFailureStatus } from "./types.js";

interface PlatformFailureInvestigation {
  failure: PlatformFailure;
  card: { id: string; projectId: string; title: string };
}

const PLATFORM_FAILURE_ORIGIN: MessageOrigin = { kind: "system", name: "falha da plataforma" };
const CARD_TITLE_SYMPTOM_CHARS = 80;
const investigationsStarting = new Map<string, Promise<PlatformFailureInvestigation>>();

export function buildInvestigationBrief(failure: PlatformFailure): string {
  return [
    "# Falha da plataforma: investigar e corrigir o vibehub",
    "",
    "O vibehub registrou uma falha dele mesmo e o dono da instalação pediu a investigação. O relato abaixo é a sua ÚNICA entrada: não leia outros cards.",
    "",
    `- Sintoma: ${failure.symptom}`,
    `- Componente: ${failure.component}`,
    `- Origem do registro: ${failure.source}`,
    `- ${failure.occurrences} ocorrência(s)`,
    "",
    "Evidência:",
    "```",
    failure.evidence,
    "```",
    ...(failure.reproduction ? ["", `Como reproduzir: ${failure.reproduction}`] : []),
    ...(failure.hypothesis ? ["", `Hipótese (não confirmada): ${failure.hypothesis}`] : []),
    "",
    "## Ordem de trabalho",
    "1. Confirme se é bug, reproduzindo com um teste que falha. Se NÃO for (comportamento esperado, erro do usuário, problema do provedor), explique o porquê aqui no chat, avise o dono com vibehub_notify e conclua o card sem PR.",
    "2. Sendo bug, corrija em TDD seguindo o AGENTS.md, inclusive o fechamento com simplificação e code review independentes.",
    "3. Abra o PR com vibehub_deliver sem `authorized`.",
    "4. Avise o dono quando o PR estiver pronto, com a review apta e o CI verde, e espere a ordem dele. Nunca mergeie por conta própria. Com a ordem, use vibehub_deliver com `authorized: true` e `concludeWhenMerged: true`.",
    "5. O repositório é público: nada além do comportamento do vibehub entra em commit, PR ou comentário (nem nomes, dados ou trechos de outros repositórios).",
  ].join("\n");
}

function summarizeCard(card: registry.Card): PlatformFailureInvestigation["card"] {
  return { id: card.id, projectId: card.projectId, title: card.title };
}

export async function settleInvestigationOfCard(cardId: string): Promise<PlatformFailure | null> {
  const card = await registry.getCard(cardId);
  const hasMergedPr = (card?.prs ?? []).some((pr) => pr.mergedAt !== undefined);
  return await settlePlatformFailureInvestigation(cardId, { merged: hasMergedPr });
}

async function createInvestigationCard(failure: PlatformFailure, owner: PublicUser, selfProjectId: string): Promise<registry.Card> {
  const accountSlug = await creatorAccountSlug(owner.id);
  const card = await registry.createCard(
    { projectId: selfProjectId, title: `Falha da plataforma: ${failure.symptom.slice(0, CARD_TITLE_SYMPTOM_CHARS)}` },
    accountSlug ? { accountSlug } : {},
  );
  await setPlatformFailureInvestigationCard(failure.id, card.id);
  return card;
}

async function sendInvestigationBrief(
  failure: PlatformFailure, statusBeforeClaim: PlatformFailureStatus, owner: PublicUser, card: registry.Card,
): Promise<PlatformFailureInvestigation> {
  try {
    await sendToTerminal(card.id, buildInvestigationBrief(failure), {
      by: `platform-failure:${failure.id}`,
      origin: PLATFORM_FAILURE_ORIGIN,
      wake: true,
      requireAgent: true,
      guardInteractiveMenu: true,
      readyWaitMs: SEND_READY_WAIT_MS,
      viaNativeChat: true,
      beforeDeliver: () => recordCardActor(owner, card.id),
    });
  } catch (err) {
    await releasePlatformFailureInvestigation(failure.id, statusBeforeClaim);
    throw err;
  }
  return { failure: { ...failure, investigationCardId: card.id }, card: summarizeCard(card) };
}

async function investigatePlatformFailure(failureId: string, owner: PublicUser): Promise<PlatformFailureInvestigation> {
  const { selfProjectId } = await getSettings();
  const selfProject = selfProjectId ? await registry.getProject(selfProjectId) : undefined;
  if (!selfProject) {
    await getPlatformFailure(failureId);
    throw new PlatformFailureStateError("the vibehub project is not configured or no longer exists — pick it in Settings");
  }
  const { failure, statusBeforeClaim } = await claimPlatformFailureInvestigation(failureId);
  const wasAlreadyInvestigating = statusBeforeClaim === "investigating";
  const previousCard = failure.investigationCardId ? await registry.getCard(failure.investigationCardId) : undefined;
  const ongoingCard = previousCard?.column === "done" ? undefined : previousCard;
  if (wasAlreadyInvestigating && ongoingCard) return { failure, card: summarizeCard(ongoingCard) };
  if (wasAlreadyInvestigating && previousCard) {
    const settledFailure = await settleInvestigationOfCard(previousCard.id);
    if (settledFailure?.status === "resolved") return { failure: settledFailure, card: summarizeCard(previousCard) };
    return await investigatePlatformFailure(failureId, owner);
  }
  const investigationCard = ongoingCard ?? await createInvestigationCard(failure, owner, selfProject.id);
  return await sendInvestigationBrief(failure, statusBeforeClaim, owner, investigationCard);
}

export function startPlatformFailureInvestigation(failureId: string, owner: PublicUser): Promise<PlatformFailureInvestigation> {
  const startingInvestigation = investigationsStarting.get(failureId);
  if (startingInvestigation) return startingInvestigation;
  const investigation = investigatePlatformFailure(failureId, owner).finally(() => investigationsStarting.delete(failureId));
  investigationsStarting.set(failureId, investigation);
  return investigation;
}

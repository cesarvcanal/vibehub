import { randomUUID } from "node:crypto";
import { dataPath } from "../../config/env.js";
import { JsonStore } from "../../store/jsonStore.js";
import { logger } from "../../utils/logger.js";
import { getSettings } from "../settings/settings.js";
import { buildFailureSignature } from "./signature.js";
import type { PlatformFailure, PlatformFailureReport, PlatformFailureStatus } from "./types.js";

export const ACTIVE_FAILURES_CAP = 50;
const AFFECTED_CARDS_CAP = 20;
const RESOLVED_FAILURE_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const RESOLVED_GRACE_MS = 60 * 60_000;
export const SLOW_TURN_DISMISSAL_MS = 7 * 24 * 60 * 60_000;

const ACTIVE_STATUSES: readonly PlatformFailureStatus[] = ["open", "investigating", "concluded_without_fix"];
const INVESTIGABLE_STATUSES: readonly PlatformFailureStatus[] = ["open", "concluded_without_fix"];

export class PlatformFailureNotFoundError extends Error {}
export class PlatformFailureStateError extends Error {}

interface PlatformFailuresDoc {
  failures: PlatformFailure[];
}

const store = new JsonStore<PlatformFailuresDoc>(dataPath("platform-failures.json"), () => ({ failures: [] }));

function findFailureIn(doc: PlatformFailuresDoc, id: string): PlatformFailure {
  const failure = doc.failures.find((candidate) => candidate.id === id);
  if (!failure) throw new PlatformFailureNotFoundError(`platform failure ${id} not found`);
  return failure;
}

function noteAffectedCard(failure: PlatformFailure, cardId: string | undefined): void {
  if (!cardId) return;
  const otherCardIds = failure.affectedCardIds.filter((affectedCardId) => affectedCardId !== cardId);
  failure.affectedCardIds = [...otherCardIds, cardId].slice(-AFFECTED_CARDS_CAP);
}

export async function recordPlatformFailure(report: PlatformFailureReport, now: number = Date.now()): Promise<PlatformFailure | null> {
  if (!(await getSettings()).selfProjectId) return null;
  const signature = buildFailureSignature(report);
  const outcome = await store.mutate((doc) => {
    doc.failures = doc.failures.filter((failure) => !(failure.status === "resolved" && now - failure.lastSeenAt > RESOLVED_FAILURE_RETENTION_MS));
    const sameSignatureFailure = doc.failures.find((failure) => failure.signature === signature && failure.status !== "resolved");
    const isDismissalExpired = sameSignatureFailure?.status === "dismissed" && sameSignatureFailure.source === "slow_turn"
      && now - (sameSignatureFailure.dismissedAt ?? 0) > SLOW_TURN_DISMISSAL_MS;
    if (isDismissalExpired) doc.failures = doc.failures.filter((failure) => failure !== sameSignatureFailure);
    const knownFailure = isDismissalExpired ? undefined : sameSignatureFailure;
    if (knownFailure?.status === "dismissed") return { failure: null, capReached: false };
    const repeatedFailure = knownFailure ?? doc.failures.find((failure) =>
      failure.signature === signature && failure.status === "resolved" && now - (failure.resolvedAt ?? 0) <= RESOLVED_GRACE_MS);
    if (repeatedFailure) {
      repeatedFailure.occurrences += 1;
      repeatedFailure.lastSeenAt = now;
      noteAffectedCard(repeatedFailure, report.cardId);
      return { failure: { ...repeatedFailure }, capReached: false };
    }
    const activeFailures = doc.failures.filter((failure) => ACTIVE_STATUSES.includes(failure.status));
    if (activeFailures.length >= ACTIVE_FAILURES_CAP) return { failure: null, capReached: true };
    const createdFailure: PlatformFailure = {
      id: randomUUID(),
      signature,
      source: report.source,
      status: "open",
      component: report.component,
      symptom: report.symptom,
      evidence: report.evidence,
      ...(report.reproduction ? { reproduction: report.reproduction } : {}),
      ...(report.hypothesis ? { hypothesis: report.hypothesis } : {}),
      occurrences: 1,
      affectedCardIds: report.cardId ? [report.cardId] : [],
      firstSeenAt: now,
      lastSeenAt: now,
    };
    doc.failures.push(createdFailure);
    return { failure: { ...createdFailure }, capReached: false };
  });
  if (outcome.capReached) {
    logger.warn({ cap: ACTIVE_FAILURES_CAP, component: report.component }, "platform failure dropped: too many open failures");
  }
  return outcome.failure;
}

export async function listActivePlatformFailures(): Promise<PlatformFailure[]> {
  const doc = await store.load();
  return doc.failures
    .filter((failure) => ACTIVE_STATUSES.includes(failure.status))
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .map((failure) => ({ ...failure }));
}

export async function getPlatformFailure(id: string): Promise<PlatformFailure> {
  return { ...findFailureIn(await store.load(), id) };
}

export async function dismissPlatformFailure(id: string, now: number = Date.now()): Promise<PlatformFailure> {
  return await store.mutate((doc) => {
    const failure = findFailureIn(doc, id);
    if (failure.status === "investigating") {
      throw new PlatformFailureStateError(`platform failure ${id} is being investigated in card ${failure.investigationCardId ?? "(starting)"}`);
    }
    failure.status = "dismissed";
    failure.dismissedAt = now;
    return { ...failure };
  });
}

interface InvestigationClaim {
  failure: PlatformFailure;
  statusBeforeClaim: PlatformFailureStatus;
}

export async function claimPlatformFailureInvestigation(id: string): Promise<InvestigationClaim> {
  return await store.mutate((doc) => {
    const failure = findFailureIn(doc, id);
    const statusBeforeClaim = failure.status;
    if (statusBeforeClaim === "investigating") return { failure: { ...failure }, statusBeforeClaim };
    if (!INVESTIGABLE_STATUSES.includes(statusBeforeClaim)) {
      throw new PlatformFailureStateError(`platform failure ${id} is ${statusBeforeClaim} and cannot be investigated`);
    }
    failure.status = "investigating";
    return { failure: { ...failure }, statusBeforeClaim };
  });
}

export async function releasePlatformFailureInvestigation(id: string, statusBeforeClaim: PlatformFailureStatus): Promise<PlatformFailure> {
  return await store.mutate((doc) => {
    const failure = findFailureIn(doc, id);
    failure.status = statusBeforeClaim === "concluded_without_fix" ? "concluded_without_fix" : "open";
    return { ...failure };
  });
}

export async function setPlatformFailureInvestigationCard(id: string, cardId: string): Promise<PlatformFailure> {
  return await store.mutate((doc) => {
    const failure = findFailureIn(doc, id);
    failure.investigationCardId = cardId;
    return { ...failure };
  });
}

export async function settlePlatformFailureInvestigation(cardId: string, outcome: { merged: boolean }, now: number = Date.now()): Promise<PlatformFailure | null> {
  return await store.mutate((doc) => {
    const failure = doc.failures.find((candidate) => candidate.status === "investigating" && candidate.investigationCardId === cardId);
    if (!failure) return null;
    failure.status = outcome.merged ? "resolved" : "concluded_without_fix";
    if (outcome.merged) failure.resolvedAt = now;
    return { ...failure };
  });
}

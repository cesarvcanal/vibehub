import { randomUUID } from "node:crypto";
import { dataPath } from "../../config/env.js";
import { JsonStore } from "../../store/jsonStore.js";
import { logger } from "../../utils/logger.js";
import { getSettings } from "../settings/settings.js";
import { PLATFORM_FAILURE_LOG_MARK } from "./backendError.js";
import { buildFailureSignature } from "./signature.js";
import type {
  FailureInvestigationReportInput, FailureNarrative, FailureNarrativeUnavailableReason, PlatformFailure, PlatformFailureReport, PlatformFailureSource, PlatformFailureStatus,
} from "./types.js";

export const ACTIVE_FAILURES_CAP = 50;
export const ACTIVE_SCREEN_ERRORS_CAP = 20;
const AFFECTED_CARDS_CAP = 20;
const RESOLVED_FAILURE_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const RESOLVED_GRACE_MS = 60 * 60_000;
export const TURN_DISMISSAL_MS = 7 * 24 * 60 * 60_000;

const ACTIVE_STATUSES: readonly PlatformFailureStatus[] = ["open", "investigating", "concluded_without_fix"];
const TURN_SOURCES: readonly PlatformFailureSource[] = ["slow_turn", "stalled_turn"];
const INVESTIGABLE_STATUSES: readonly PlatformFailureStatus[] = ["open", "concluded_without_fix"];

export class PlatformFailureNotFoundError extends Error {}
export class PlatformFailureStateError extends Error {}

interface PlatformFailuresDoc {
  failures: PlatformFailure[];
}

export interface PlatformFailureChange {
  failure: PlatformFailure;
  newForCardId?: string;
  isCreated?: true;
}

type PlatformFailureChangeListener = (change: PlatformFailureChange) => void;

const failureChangeListeners = new Set<PlatformFailureChangeListener>();

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

export function onPlatformFailureChange(listener: PlatformFailureChangeListener): () => void {
  failureChangeListeners.add(listener);
  return () => {
    failureChangeListeners.delete(listener);
  };
}

function announceFailureChange(change: PlatformFailureChange): void {
  for (const listener of failureChangeListeners) {
    try {
      listener({ ...change, failure: { ...change.failure } });
    } catch (err) {
      logger.warn({ ...PLATFORM_FAILURE_LOG_MARK, failure: change.failure.id, detail: (err as Error).message }, "could not announce a platform failure change");
    }
  }
}

export async function recordPlatformFailure(report: PlatformFailureReport, now: number = Date.now()): Promise<PlatformFailure | null> {
  if (!(await getSettings()).selfProjectId) return null;
  const signature = buildFailureSignature(report);
  const outcome = await store.mutate((doc) => {
    doc.failures = doc.failures.filter((failure) => !(failure.status === "resolved" && now - failure.lastSeenAt > RESOLVED_FAILURE_RETENTION_MS));
    const sameSignatureFailure = doc.failures.find((failure) => failure.signature === signature && failure.status !== "resolved");
    const isDismissalExpired = sameSignatureFailure?.status === "dismissed" && TURN_SOURCES.includes(sameSignatureFailure.source)
      && now - (sameSignatureFailure.dismissedAt ?? 0) > TURN_DISMISSAL_MS;
    if (isDismissalExpired) doc.failures = doc.failures.filter((failure) => failure !== sameSignatureFailure);
    const knownFailure = isDismissalExpired ? undefined : sameSignatureFailure;
    if (knownFailure?.status === "dismissed") return { failure: null, capReached: false, isNewForCard: false, isCreated: false };
    const repeatedFailure = knownFailure ?? doc.failures.find((failure) =>
      failure.signature === signature && failure.status === "resolved" && now - (failure.resolvedAt ?? 0) <= RESOLVED_GRACE_MS);
    if (repeatedFailure) {
      const isNewForCard = report.cardId !== undefined && !repeatedFailure.affectedCardIds.includes(report.cardId);
      repeatedFailure.occurrences += 1;
      repeatedFailure.lastSeenAt = now;
      noteAffectedCard(repeatedFailure, report.cardId);
      return { failure: { ...repeatedFailure }, capReached: false, isNewForCard, isCreated: false };
    }
    const isScreenError = report.source === "screen_error";
    const activeFailuresOfSameCap = doc.failures.filter((failure) =>
      ACTIVE_STATUSES.includes(failure.status) && (failure.source === "screen_error") === isScreenError);
    const capOfSource = isScreenError ? ACTIVE_SCREEN_ERRORS_CAP : ACTIVE_FAILURES_CAP;
    if (activeFailuresOfSameCap.length >= capOfSource) return { failure: null, capReached: true, capOfSource, isNewForCard: false, isCreated: false };
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
      ...(report.explanation ? { explanation: report.explanation } : {}),
      ...(report.cardId ? { originCardId: report.cardId } : {}),
      occurrences: 1,
      affectedCardIds: report.cardId ? [report.cardId] : [],
      firstSeenAt: now,
      lastSeenAt: now,
    };
    doc.failures.push(createdFailure);
    return { failure: { ...createdFailure }, capReached: false, isNewForCard: report.cardId !== undefined, isCreated: true };
  });
  if (outcome.capReached) {
    logger.warn({ ...PLATFORM_FAILURE_LOG_MARK, cap: outcome.capOfSource, source: report.source, component: report.component }, "platform failure dropped: too many open failures");
  }
  if (outcome.failure && (outcome.isNewForCard || outcome.isCreated)) {
    announceFailureChange({
      failure: outcome.failure,
      ...(outcome.isNewForCard ? { newForCardId: report.cardId } : {}),
      ...(outcome.isCreated ? { isCreated: true as const } : {}),
    });
  }
  return outcome.failure;
}

export async function setPlatformFailureNarrative(
  id: string, narrativeOutcome: { narrative: FailureNarrative } | { narrativeUnavailable: FailureNarrativeUnavailableReason },
): Promise<PlatformFailure> {
  const describedFailure = await store.mutate((doc) => {
    const failure = findFailureIn(doc, id);
    if ("narrative" in narrativeOutcome) {
      failure.narrative = narrativeOutcome.narrative;
      delete failure.narrativeUnavailable;
    } else {
      failure.narrativeUnavailable = narrativeOutcome.narrativeUnavailable;
    }
    return { ...failure };
  });
  announceFailureChange({ failure: describedFailure });
  return describedFailure;
}

export async function isPlatformFailureDismissed(report: Pick<PlatformFailureReport, "source" | "component" | "symptom">): Promise<boolean> {
  const signature = buildFailureSignature(report);
  return (await store.load()).failures.some((failure) => failure.signature === signature && failure.status === "dismissed");
}

export async function listActivePlatformFailures(): Promise<PlatformFailure[]> {
  const doc = await store.load();
  return doc.failures
    .filter((failure) => ACTIVE_STATUSES.includes(failure.status))
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .map((failure) => ({ ...failure }));
}

export async function listActivePlatformFailuresOfCard(cardId: string): Promise<PlatformFailure[]> {
  return (await listActivePlatformFailures()).filter((failure) => failure.affectedCardIds.includes(cardId));
}

export async function getPlatformFailure(id: string): Promise<PlatformFailure> {
  return { ...findFailureIn(await store.load(), id) };
}

export async function dismissPlatformFailure(id: string, now: number = Date.now()): Promise<PlatformFailure> {
  const dismissedFailure = await store.mutate((doc) => {
    const failure = findFailureIn(doc, id);
    if (failure.status === "investigating") {
      throw new PlatformFailureStateError(`platform failure ${id} is being investigated in card ${failure.investigationCardId ?? "(starting)"}`);
    }
    failure.status = "dismissed";
    failure.dismissedAt = now;
    return { ...failure };
  });
  announceFailureChange({ failure: dismissedFailure });
  return dismissedFailure;
}

interface InvestigationClaim {
  failure: PlatformFailure;
  statusBeforeClaim: PlatformFailureStatus;
}

export async function claimPlatformFailureInvestigation(id: string): Promise<InvestigationClaim> {
  const claim = await store.mutate((doc) => {
    const failure = findFailureIn(doc, id);
    const statusBeforeClaim = failure.status;
    if (statusBeforeClaim === "investigating") return { failure: { ...failure }, statusBeforeClaim };
    if (!INVESTIGABLE_STATUSES.includes(statusBeforeClaim)) {
      throw new PlatformFailureStateError(`platform failure ${id} is ${statusBeforeClaim} and cannot be investigated`);
    }
    failure.status = "investigating";
    return { failure: { ...failure }, statusBeforeClaim };
  });
  if (claim.statusBeforeClaim !== "investigating") announceFailureChange({ failure: claim.failure });
  return claim;
}

export async function releasePlatformFailureInvestigation(id: string, statusBeforeClaim: PlatformFailureStatus): Promise<PlatformFailure> {
  const releasedFailure = await store.mutate((doc) => {
    const failure = findFailureIn(doc, id);
    failure.status = statusBeforeClaim === "concluded_without_fix" ? "concluded_without_fix" : "open";
    return { ...failure };
  });
  announceFailureChange({ failure: releasedFailure });
  return releasedFailure;
}

export async function setPlatformFailureInvestigationCard(id: string, cardId: string): Promise<PlatformFailure> {
  return await store.mutate((doc) => {
    const failure = findFailureIn(doc, id);
    failure.investigationCardId = cardId;
    return { ...failure };
  });
}

export async function saveFailureInvestigationReport(
  cardId: string, report: FailureInvestigationReportInput, now: number = Date.now(),
): Promise<PlatformFailure> {
  const reportedFailure = await store.mutate((doc) => {
    const failure = doc.failures.find((candidate) => candidate.status === "investigating" && candidate.investigationCardId === cardId);
    if (!failure) throw new PlatformFailureStateError(`card ${cardId} is not investigating any platform failure`);
    failure.investigationReport = { ...report, reportedAt: now };
    return { ...failure };
  });
  announceFailureChange({ failure: reportedFailure });
  return reportedFailure;
}

export async function settlePlatformFailureInvestigation(cardId: string, outcome: { merged: boolean }, now: number = Date.now()): Promise<PlatformFailure | null> {
  const settledFailure = await store.mutate((doc) => {
    const failure = doc.failures.find((candidate) => candidate.status === "investigating" && candidate.investigationCardId === cardId);
    if (!failure) return null;
    failure.status = outcome.merged ? "resolved" : "concluded_without_fix";
    if (outcome.merged) failure.resolvedAt = now;
    return { ...failure };
  });
  if (settledFailure) announceFailureChange({ failure: settledFailure });
  return settledFailure;
}

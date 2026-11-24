import { logger } from "../../utils/logger.js";
import { PLATFORM_FAILURE_LOG_MARK } from "./backendError.js";
import { listActivePlatformFailuresOfCard, onPlatformFailureChange, type PlatformFailureChange } from "./platformFailures.js";
import type { PlatformFailure } from "./types.js";

export interface PlatformFailureNotice {
  id: string;
  source: PlatformFailure["source"];
  status: PlatformFailure["status"];
  explanation?: string;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  details?: Pick<PlatformFailure, "symptom" | "component" | "evidence" | "reproduction" | "hypothesis" | "narrative" | "narrativeUnavailable" | "investigationReport" | "previousInvestigationReport">;
}

export type CardFailureNoticeFrame =
  | { type: "platform_failures"; notices: PlatformFailureNotice[] }
  | { type: "platform_failure"; notice: PlatformFailureNotice };

export function buildCardFailureNotice(failure: PlatformFailure, cardId: string, viewerIsOwner: boolean): PlatformFailureNotice {
  const canSeeDetails = viewerIsOwner || failure.originCardId === cardId;
  return {
    id: failure.id,
    source: failure.source,
    status: failure.status,
    ...(failure.explanation ? { explanation: failure.explanation } : {}),
    occurrences: failure.occurrences,
    firstSeenAt: failure.firstSeenAt,
    lastSeenAt: failure.lastSeenAt,
    ...(canSeeDetails ? {
      details: {
        symptom: failure.symptom,
        component: failure.component,
        evidence: failure.evidence,
        ...(failure.reproduction ? { reproduction: failure.reproduction } : {}),
        ...(failure.hypothesis ? { hypothesis: failure.hypothesis } : {}),
        ...(failure.narrative ? { narrative: failure.narrative } : {}),
        ...(failure.narrativeUnavailable ? { narrativeUnavailable: failure.narrativeUnavailable } : {}),
        ...(failure.investigationReport ? { investigationReport: failure.investigationReport } : {}),
        ...(failure.previousInvestigationReport ? { previousInvestigationReport: failure.previousInvestigationReport } : {}),
      },
    } : {}),
  };
}

export function streamCardFailureNotices(cardId: string, viewerIsOwner: boolean, send: (frame: CardFailureNoticeFrame) => void): () => void {
  const shownFailureIds = new Set<string>();
  const isChangeOfThisCard = ({ failure, newForCardId }: PlatformFailureChange) => newForCardId === undefined
    ? shownFailureIds.has(failure.id) || failure.affectedCardIds.includes(cardId)
    : newForCardId === cardId;
  const stopListening = onPlatformFailureChange((change) => {
    if (!isChangeOfThisCard(change)) return;
    shownFailureIds.add(change.failure.id);
    send({ type: "platform_failure", notice: buildCardFailureNotice(change.failure, cardId, viewerIsOwner) });
  });
  void listActivePlatformFailuresOfCard(cardId).then(
    (failures) => {
      for (const failure of failures) shownFailureIds.add(failure.id);
      send({ type: "platform_failures", notices: failures.map((failure) => buildCardFailureNotice(failure, cardId, viewerIsOwner)) });
    },
    (err: unknown) => logger.warn({ ...PLATFORM_FAILURE_LOG_MARK, card: cardId, detail: (err as Error).message }, "could not read the platform failures of a card"),
  );
  return stopListening;
}

import { logger } from "../../utils/logger.js";
import { listActivePlatformFailuresOfCard, onCardFailureChange } from "./platformFailures.js";
import type { PlatformFailure } from "./types.js";

export interface PlatformFailureNotice {
  id: string;
  source: PlatformFailure["source"];
  status: PlatformFailure["status"];
  explanation?: string;
  occurrences: number;
  firstSeenAt: number;
  details?: Pick<PlatformFailure, "symptom" | "component" | "evidence" | "reproduction" | "hypothesis">;
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
    ...(canSeeDetails ? {
      details: {
        symptom: failure.symptom,
        component: failure.component,
        evidence: failure.evidence,
        ...(failure.reproduction ? { reproduction: failure.reproduction } : {}),
        ...(failure.hypothesis ? { hypothesis: failure.hypothesis } : {}),
      },
    } : {}),
  };
}

export function streamCardFailureNotices(cardId: string, viewerIsOwner: boolean, send: (frame: CardFailureNoticeFrame) => void): () => void {
  const stopListening = onCardFailureChange(cardId, (failure) => {
    send({ type: "platform_failure", notice: buildCardFailureNotice(failure, cardId, viewerIsOwner) });
  });
  void listActivePlatformFailuresOfCard(cardId).then(
    (failures) => send({ type: "platform_failures", notices: failures.map((failure) => buildCardFailureNotice(failure, cardId, viewerIsOwner)) }),
    (err: unknown) => logger.warn({ card: cardId, detail: (err as Error).message }, "could not read the platform failures of a card"),
  );
  return stopListening;
}

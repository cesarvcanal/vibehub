import type { PlatformFailureNotice } from "@/api/types";
import type { Translate } from "@/i18n";

export function explainFailure(failure: Pick<PlatformFailureNotice, "source" | "explanation" | "details">, t: Translate): string {
  return failure.details?.narrative?.whatHappened ?? failure.explanation ?? t(`platformFailures.plain.${failure.source}`);
}

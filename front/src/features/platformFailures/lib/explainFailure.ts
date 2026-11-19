import type { PlatformFailureNotice } from "@/api/types";
import type { Translate } from "@/i18n";

export function explainFailure(failure: Pick<PlatformFailureNotice, "source" | "explanation">, t: Translate): string {
  return failure.explanation ?? t(`platformFailures.plain.${failure.source}`);
}

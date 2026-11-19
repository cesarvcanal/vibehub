import * as React from "react";
import { toast } from "sonner";
import { t as translate } from "@/i18n";
import type { PlatformFailure } from "@/api/types";
import { explainFailure } from "./explainFailure";
import { findUnseenFailureIds } from "./unseenFailures";

const SEEN_FAILURES_STORAGE_KEY = "vibehub.platformFailures.seen";

export function readSeenFailureIds(): Set<string> {
  try {
    const storedValue: unknown = JSON.parse(sessionStorage.getItem(SEEN_FAILURES_STORAGE_KEY) ?? "[]");
    const storedIds = Array.isArray(storedValue) ? storedValue : [];
    return new Set(storedIds.filter((storedId): storedId is string => typeof storedId === "string"));
  } catch {
    return new Set();
  }
}

function saveSeenFailureIds(seenIds: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(SEEN_FAILURES_STORAGE_KEY, JSON.stringify([...seenIds]));
  } catch {
    return;
  }
}

export function useAnnounceUnseenFailures(failures: readonly PlatformFailure[], setFailuresDialogOpen: (isOpen: boolean) => void): void {
  React.useEffect(() => {
    const seenIds = readSeenFailureIds();
    const unseenIds = findUnseenFailureIds(failures, seenIds);
    if (unseenIds.length === 0) return;
    const [onlyUnseenFailure] = unseenIds.length === 1 ? failures.filter((failure) => failure.id === unseenIds[0]) : [];
    const announcement = onlyUnseenFailure
      ? translate("platformFailures.newToastOne", { explanation: explainFailure(onlyUnseenFailure, translate) })
      : translate("platformFailures.newToast", { n: unseenIds.length, count: unseenIds.length });
    toast(announcement, {
      action: { label: translate("platformFailures.open"), onClick: () => setFailuresDialogOpen(true) },
    });
    saveSeenFailureIds(new Set([...seenIds, ...unseenIds]));
  }, [failures, setFailuresDialogOpen]);
}

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/providers/auth";
import { useT } from "@/i18n";
import type { PlatformFailureNotice } from "@/api/types";
import { explainFailure } from "../lib/explainFailure";
import { buildSnoozeKey, pickVisibleNotices, readSnoozedNoticeKeys, saveSnoozedNoticeKeys } from "../lib/snoozedNotices";
import { FailureDetails } from "./FailureDetails";

export function CardFailureNotice({ cardId, notices }: { cardId: string; notices: readonly PlatformFailureNotice[] }) {
  const t = useT();
  const { isOwner } = useAuth();
  const [snoozedKeys, setSnoozedKeys] = React.useState(readSnoozedNoticeKeys);
  const [isDetailsOpen, setDetailsOpen] = React.useState(false);
  const visibleNotices = pickVisibleNotices(notices, snoozedKeys, cardId);
  const [latestNotice] = visibleNotices;
  if (!latestNotice && isDetailsOpen) setDetailsOpen(false);
  if (!latestNotice) return null;

  const snoozeLatestNotice = () => {
    const nextSnoozedKeys = new Set([...snoozedKeys, buildSnoozeKey(cardId, latestNotice)]);
    saveSnoozedNoticeKeys(nextSnoozedKeys);
    setSnoozedKeys(nextSnoozedKeys);
  };
  const otherNoticeCount = visibleNotices.length - 1;
  return (
    <>
      <div
        data-testid="platform-failure-notice"
        role="status"
        className="mt-1.5 flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        <span className="min-w-0 flex-1">{explainFailure(latestNotice, t)}</span>
        {latestNotice.status === "open" ? null : (
          <span className="shrink-0 text-muted-foreground">{t(`platformFailures.status.${latestNotice.status}`)}</span>
        )}
        {otherNoticeCount > 0 ? <span className="shrink-0 text-muted-foreground">{t("platformFailures.moreNotices", { n: otherNoticeCount })}</span> : null}
        <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={() => setDetailsOpen(true)}>
          {t("platformFailures.seeDetails")}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={snoozeLatestNotice}>
          {t("platformFailures.notNow")}
        </Button>
      </div>
      <Dialog open={isDetailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("platformFailures.cardTitle")}</DialogTitle>
            <DialogDescription>{t("platformFailures.cardDescription")}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-[60vh] space-y-3 overflow-auto">
            {visibleNotices.map((notice) => <FailureDetails key={notice.id} failure={notice} isOwner={isOwner} />)}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}

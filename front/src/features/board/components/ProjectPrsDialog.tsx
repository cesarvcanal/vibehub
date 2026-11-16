import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/apiError";
import type { ProjectPull } from "@/api/types";
import { boardApi, projectPullsKey } from "@/features/board/api";
import { useT } from "@/i18n";

/**
 * THE PROJECT'S OPEN PRs, and the button that analyses one. The list is read from GitHub every time
 * the dialog opens (nothing is kept by vibehub), so a PR opened by hand is already here. "Analyse"
 * creates the PR's analysis card on the server — which reviews with the installed skills and fixes
 * what is clear on the PR itself — and opens it; a PR already under analysis offers its card instead.
 */

export interface ProjectPrsDialogProps {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenCard: (cardId: string) => void;
}

export function ProjectPrsDialog({ projectId, projectName, open, onOpenChange, onOpenCard }: ProjectPrsDialogProps) {
  const t = useT();
  const qc = useQueryClient();
  const pulls = useQuery({
    queryKey: projectPullsKey(projectId),
    queryFn: () => boardApi.listProjectPulls(projectId),
    enabled: open,
  });

  const analyse = useMutation({
    mutationFn: (prNumber: number) => boardApi.startPrAnalysis(projectId, prNumber),
    onSuccess: ({ card }) => {
      void qc.invalidateQueries({ queryKey: projectPullsKey(projectId) });
      void qc.invalidateQueries({ queryKey: ["board"] });
      onOpenChange(false);
      onOpenCard(card.id);
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const openCard = (cardId: string) => {
    onOpenChange(false);
    onOpenCard(cardId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="project-prs-dialog">
        <DialogHeader>
          <DialogTitle>{t("prs.title")}</DialogTitle>
          <DialogDescription>{t("prs.hint", { name: projectName })}</DialogDescription>
        </DialogHeader>

        {pulls.isPending ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : pulls.isError ? (
          <p className="text-sm text-destructive">{apiErrorMessage(pulls.error)}</p>
        ) : pulls.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("prs.empty")}</p>
        ) : (
          <ul className="max-h-[60vh] space-y-2 overflow-y-auto">
            {pulls.data.map((pull) => (
              <PullRow
                key={pull.number}
                pull={pull}
                busy={analyse.isPending}
                onAnalyse={() => analyse.mutate(pull.number)}
                onOpenAnalysis={openCard}
              />
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PullRow({ pull, busy, onAnalyse, onOpenAnalysis }: {
  pull: ProjectPull;
  busy: boolean;
  onAnalyse: () => void;
  onOpenAnalysis: (cardId: string) => void;
}) {
  const t = useT();
  const { analysisCardId } = pull;
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <a href={pull.url} target="_blank" rel="noreferrer" className="shrink-0 text-sm text-muted-foreground hover:underline">
            #{pull.number}
          </a>
          <span className="min-w-0 truncate text-sm font-medium">{pull.title}</span>
          {pull.draft ? <Badge>{t("prs.draft")}</Badge> : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {t("prs.meta", { author: pull.author, branch: pull.branch, base: pull.base })}
        </p>
        {pull.fromFork ? <p className="text-xs text-muted-foreground">{t("prs.fork")}</p> : null}
      </div>
      {analysisCardId ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          aria-label={t("prs.openAnalysisOf", { number: pull.number })}
          onClick={() => onOpenAnalysis(analysisCardId)}
        >
          {t("prs.openAnalysis")}
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          aria-label={t("prs.analyseOf", { number: pull.number })}
          disabled={busy || pull.fromFork}
          onClick={onAnalyse}
        >
          {t("prs.analyse")}
        </Button>
      )}
    </li>
  );
}

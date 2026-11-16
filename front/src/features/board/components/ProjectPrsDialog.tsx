import * as React from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { GitPullRequest, Loader2, Lock, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/apiError";
import { SELECT_CLASS } from "@/components/ui/select";
import type { AnalysisPerson, AnalysisRoles, ProjectPull } from "@/api/types";
import { analysisPeopleKey, boardApi, projectPullsKey } from "@/features/board/api";
import { defaultReviewerId, isPrAuthor } from "@/features/board/lib/analysisRoles";
import { repoAccessRefusal } from "@/features/board/lib/repoAccess";
import { useAuth } from "@/providers/auth";
import { t as translate, useT } from "@/i18n";

/**
 * THE PROJECT'S OPEN PRs, and the button that analyses one. The list is read from GitHub every time
 * the dialog opens (nothing is kept by vibehub), so a PR opened by hand is already here. "Analyse"
 * creates the PR's analysis card on the server — which reviews with the installed skills and fixes
 * what is clear on the PR itself. "Analyse" first opens, in the row, the choice of the REVIEWER (the card
 * works on their behalf; whoever opened the PR is never offered) and an optional CO-AUTHOR (credited on
 * its commits). Started, the dialog STAYS OPEN: several PRs are usually started in a row,
 * and closing on each one (as it first did) made that a loop of reopening it. Each start says so in a
 * toast that opens its card; only the row being started waits, never the whole list.
 */

export interface ProjectPrsDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenCard: (cardId: string) => void;
}

export function ProjectPrsDialog({ projectId, open, onOpenChange, onOpenCard }: ProjectPrsDialogProps) {
  const t = useT();
  const qc = useQueryClient();
  const pulls = useQuery({
    queryKey: projectPullsKey(projectId),
    queryFn: () => boardApi.listProjectPulls(projectId),
    enabled: open,
  });
  // The PRs whose start is on its way: per row, so one slow start never locks the others.
  const [starting, setStarting] = React.useState<ReadonlySet<number>>(new Set());

  const openCard = (cardId: string) => {
    onOpenChange(false);
    onOpenCard(cardId);
  };

  const people = useQuery({
    queryKey: analysisPeopleKey(projectId),
    queryFn: () => boardApi.listAnalysisPeople(projectId),
    enabled: open,
  });
  // The row whose reviewer and co-author are being chosen.
  const [choosing, setChoosing] = React.useState<number | null>(null);

  const analyse = useMutation({
    mutationFn: ({ prNumber, roles }: { prNumber: number; roles: AnalysisRoles }) => boardApi.startPrAnalysis(projectId, prNumber, roles),
    onMutate: ({ prNumber }) => {
      setChoosing(null);
      setStarting((current) => new Set(current).add(prNumber));
    },
    onSuccess: ({ card, created }, { prNumber }) => {
      void qc.invalidateQueries({ queryKey: projectPullsKey(projectId) });
      void qc.invalidateQueries({ queryKey: ["board"] });
      const action = { label: translate("prs.openAnalysis"), onClick: () => openCard(card.id) };
      // Already open (a stale list, or someone else a moment before): that card keeps its own roles.
      if (created) toast.success(translate("prs.started", { number: prNumber }), { action });
      else toast.info(translate("prs.alreadyOpen", { number: prNumber }), { action });
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
    onSettled: (_data, _error, { prNumber }) =>
      setStarting((current) => {
        const next = new Set(current);
        next.delete(prNumber);
        return next;
      }),
  });

  const count = pulls.data?.length;
  const noAccess = pulls.isError ? repoAccessRefusal(pulls.error) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-xl" data-testid="project-prs-dialog">
        <DialogHeader className="flex-row items-start gap-3 space-y-0 pr-6">
          <div className="min-w-0 flex-1 space-y-1">
            <DialogTitle className="flex items-baseline gap-2">
              {t("prs.title")}
              {count ? <span className="text-sm font-normal text-muted-foreground">{count}</span> : null}
            </DialogTitle>
            <DialogDescription>{t("prs.hint")}</DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={t("prs.refresh")}
            title={t("prs.refresh")}
            disabled={pulls.isFetching}
            onClick={() => void pulls.refetch()}
          >
            <RotateCw className={pulls.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          </Button>
        </DialogHeader>

        {pulls.isPending ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : noAccess ? (
          // The GitHub account the list was read with does not see the repository: it says what to do.
          <div className="flex flex-col items-center gap-1 py-8 text-center">
            <Lock className="mb-1 h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">{t("prs.noAccess")}</p>
            <p className="text-sm text-muted-foreground">{t("prs.noAccessDetail", { login: noAccess.login, repo: noAccess.repo })}</p>
            <p className="text-sm text-muted-foreground">{t("prs.noAccessHint")}</p>
          </div>
        ) : pulls.isError ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {apiErrorMessage(pulls.error)}
          </p>
        ) : pulls.data.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-8 text-center">
            <GitPullRequest className="mb-1 h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">{t("prs.empty")}</p>
            <p className="text-sm text-muted-foreground">{t("prs.emptyHint")}</p>
          </div>
        ) : (
          <ul className="-mx-2 max-h-[60vh] divide-y divide-border/60 overflow-y-auto">
            {pulls.data.map((pull) => (
              <PullRow
                key={pull.number}
                pull={pull}
                starting={starting.has(pull.number)}
                choosing={choosing === pull.number}
                people={people}
                onChoose={() => setChoosing(pull.number)}
                onCancel={() => setChoosing(null)}
                onStart={(roles) => analyse.mutate({ prNumber: pull.number, roles })}
                onOpenAnalysis={openCard}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Why a PR cannot be analysed, when it cannot. */
function blockedReason(pull: ProjectPull): string | null {
  if (pull.fromFork) return "prs.fork";
  if (pull.unsupportedBranch) return "prs.unsupportedBranch";
  return null;
}

function PullRow({ pull, starting, choosing, people, onChoose, onCancel, onStart, onOpenAnalysis }: {
  pull: ProjectPull;
  starting: boolean;
  choosing: boolean;
  /** Who can review or co-author. */
  people: UseQueryResult<AnalysisPerson[]>;
  onChoose: () => void;
  onCancel: () => void;
  onStart: (roles: AnalysisRoles) => void;
  onOpenAnalysis: (cardId: string) => void;
}) {
  const t = useT();
  const { analysisCardId } = pull;
  const blocked = blockedReason(pull);
  return (
    <li className="px-2 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <a
              href={pull.url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-sm tabular-nums text-muted-foreground hover:text-foreground hover:underline"
            >
              #{pull.number}
            </a>
            <span className="min-w-0 truncate text-sm font-medium" title={pull.title}>{pull.title}</span>
            {pull.draft ? <Badge>{t("prs.draft")}</Badge> : null}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">{pull.author}</span>
            <span className="min-w-0 truncate" title={`${pull.branch} → ${pull.base}`}>{pull.branch} → {pull.base}</span>
          </div>
        </div>
        {analysisCardId ? (
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone="info">{t("prs.analysing")}</Badge>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-label={t("prs.openAnalysisOf", { number: pull.number })}
              onClick={() => onOpenAnalysis(analysisCardId)}
            >
              {t("prs.openAnalysis")}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            {blocked ? <span className="text-xs text-muted-foreground">{t(blocked)}</span> : null}
            {starting ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("prs.starting")}
              </span>
            ) : null}
            {choosing ? null : (
              <Button
                type="button"
                size="sm"
                aria-label={t("prs.analyseOf", { number: pull.number })}
                disabled={starting || blocked !== null}
                onClick={onChoose}
              >
                {t("prs.analyse")}
              </Button>
            )}
          </div>
        )}
      </div>
      {choosing ? (
        // Mounted only once the people are there, so its first render already picks the default reviewer.
        people.data ? (
          <RolesPicker pull={pull} people={people.data} onCancel={onCancel} onStart={onStart} />
        ) : people.isError ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-destructive">
            <span className="min-w-0 flex-1">{apiErrorMessage(people.error)}</span>
            <Button type="button" size="sm" variant="ghost" disabled={people.isFetching} onClick={() => void people.refetch()}>
              {t("common.tryAgain")}
            </Button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">{t("common.loading")}</p>
        )
      ) : null}
    </li>
  );
}

/** The reviewer and the co-author of one PR's analysis, chosen right under its row. */
function RolesPicker({ pull, people, onCancel, onStart }: {
  pull: ProjectPull;
  people: AnalysisPerson[];
  onCancel: () => void;
  onStart: (roles: AnalysisRoles) => void;
}) {
  const t = useT();
  const { user } = useAuth();
  const ids = React.useId();
  const [reviewer, setReviewer] = React.useState(() => defaultReviewerId(people, user?.id, pull));
  const [coauthor, setCoauthor] = React.useState("");
  // Whoever opened the PR neither reviews it nor co-authors it; the reviewer may be the co-author.
  const choices = people.map((person) => (
    <option key={person.id} value={person.id} disabled={isPrAuthor(person, pull)}>
      {isPrAuthor(person, pull) ? t("prs.prAuthor", { name: person.username }) : person.username}
    </option>
  ));
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md bg-muted/40 p-2">
      <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-reviewer`}>
        {t("prs.reviewer")}
        <select id={`${ids}-reviewer`} className={SELECT_CLASS} value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
          <option value="" disabled>{t("prs.pickReviewer")}</option>
          {choices}
        </select>
      </label>
      <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-coauthor`}>
        {t("prs.coauthor")}
        <select id={`${ids}-coauthor`} className={SELECT_CLASS} value={coauthor} onChange={(e) => setCoauthor(e.target.value)}>
          <option value="">{t("prs.noCoauthor")}</option>
          {choices}
        </select>
      </label>
      <div className="flex gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button
          type="button"
          size="sm"
          disabled={!reviewer}
          onClick={() => onStart({ reviewerUserId: reviewer, ...(coauthor ? { coauthorUserId: coauthor } : {}) })}
        >
          {t("prs.start")}
        </Button>
      </div>
    </div>
  );
}

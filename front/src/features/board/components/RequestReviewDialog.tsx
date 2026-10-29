import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { get, post } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import type { CardPr, PeopleResponse, Person, Review, StartReviewBody } from "@/api/types";
import { CARDS_PREFIX_KEY } from "@/features/board/api";
import { SELECT_CLASS } from "@/features/board/components/NewCardDialog";
import {
  cardPeopleKey, cardReviewKey, startErrorCode, startErrorRoles,
} from "@/features/board/lib/review";
import { useAuth } from "@/providers/auth";
import { t as translate, useT } from "@/i18n";

/**
 * ASKING for the review of a PR: who reviews, who fixes, who else co-authored, who merges.
 *
 * It follows the share dialog: a native select per role, over the people who reach this card
 * (`GET /api/cards/:id/people` — members can call it, `GET /api/users` is the owner's). Nothing is
 * decided here beyond the roles; the server runs the AIs, and the merge stays a person's click.
 *
 *  - **reviewer** runs the review's AI on THEIR own Claude account, so somebody without one
 *    (`canReview: false`) is listed but cannot be picked;
 *  - **author** is who the fixes are committed as — the card's current actor, when it has one;
 *  - **co-author** is optional, and is LEFT OUT of the request when empty (`""` is refused);
 *  - **merger** is the only person who will be able to merge.
 *
 * The reviewer can never be the author: the dialog says so and holds the button, and the server
 * refuses it anyway.
 */

interface Roles {
  reviewer: string;
  author: string;
  coauthor: string;
  merger: string;
}

/**
 * What the dialog starts with, so the common case is one click: you review and merge (unless you
 * are the author, or have no Claude account to review on), and the card's actor fixes. A person who
 * is not among the card's people cannot hold a role, so they never come out as a default. PURE.
 */
function suggestedRoles(people: Person[], meId: string | undefined, actorUserId: string | undefined): Roles {
  const me = people.find((p) => p.id === meId);
  const author = actorUserId && people.some((p) => p.id === actorUserId) ? actorUserId : "";
  return {
    reviewer: me && me.canReview && me.id !== author ? me.id : "",
    author,
    coauthor: "",
    merger: me?.id ?? "",
  };
}

export interface RequestReviewDialogProps {
  cardId: string;
  pr: CardPr;
  /** Who works the card now — suggested as the author. Absent = nobody recorded: the author is picked. */
  actorUserId?: string;
  open: boolean;
  onClose: () => void;
}

export function RequestReviewDialog({ cardId, pr, actorUserId, open, onClose }: RequestReviewDialogProps) {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();
  const ids = React.useId();

  const people = useQuery({
    queryKey: cardPeopleKey(cardId),
    queryFn: () => get<PeopleResponse>(`/cards/${encodeURIComponent(cardId)}/people`).then((r) => r.people),
    enabled: open,
  });

  // Only what the person changed is kept; the rest follows the suggestion, so it settles on its own
  // once the session and the people have both arrived.
  const [picked, setPicked] = React.useState<Partial<Roles>>({});
  const [failure, setFailure] = React.useState<{ error: unknown } | null>(null);
  const suggested = React.useMemo(
    () => suggestedRoles(people.data ?? [], user?.id, actorUserId),
    [people.data, user?.id, actorUserId],
  );
  const roles: Roles = { ...suggested, ...picked };

  const start = useMutation({
    mutationFn: (body: StartReviewBody) => post<{ review: Review }>(`/cards/${encodeURIComponent(cardId)}/review`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CARDS_PREFIX_KEY });
      void qc.invalidateQueries({ queryKey: cardReviewKey(cardId) });
      toast.success(translate("review.started", { n: pr.number }));
      onClose();
    },
    onError: (error) => setFailure({ error }),
  });

  // A dialog forgets what was typed and what the server said when it closes, and again when it opens:
  // an answer that arrives while it is CLOSED (a request still in flight) lands after the first reset,
  // and must not greet the next opening as if it were that one's.
  const { reset } = start;
  React.useEffect(() => {
    if (!open) setPicked((current) => (Object.keys(current).length ? {} : current));
    setFailure(null);
    reset();
  }, [open, reset]);

  const pick = (role: keyof Roles) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setPicked((current) => ({ ...current, [role]: e.target.value }));
    setFailure(null);
  };

  const reviewerIsAuthor = roles.reviewer !== "" && roles.reviewer === roles.author;
  const canStart = roles.reviewer !== "" && roles.author !== "" && roles.merger !== "" && !reviewerIsAuthor && !start.isPending;

  const submit = () => {
    if (!canStart) return;
    start.mutate({
      prNumber: pr.number,
      reviewerUserId: roles.reviewer,
      authorUserId: roles.author,
      // Left OUT when nobody: the server reads "" as a malformed id, not as "no co-author".
      ...(roles.coauthor ? { coauthorUserId: roles.coauthor } : {}),
      mergerUserId: roles.merger,
    });
  };

  const problem = reviewerIsAuthor ? t("review.error.revisor_igual_autor") : failure ? refusalMessage(failure.error) : null;

  const field = (role: keyof Roles, label: string, children: React.ReactNode) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${ids}-${role}`}>{label}</Label>
      <select
        id={`${ids}-${role}`}
        className={SELECT_CLASS}
        value={roles[role]}
        onChange={pick(role)}
        disabled={start.isPending}
      >
        {children}
      </select>
    </div>
  );
  const choices = (people.data ?? []).map((p) => (
    <option key={p.id} value={p.id}>{p.username}</option>
  ));

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md" data-testid="request-review-dialog">
        <DialogHeader>
          <DialogTitle>{t("review.dialog.title", { n: pr.number })}</DialogTitle>
          <DialogDescription>{t("review.dialog.hint")}</DialogDescription>
        </DialogHeader>

        {people.isPending ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : people.isError ? (
          <p role="alert" className="text-sm text-destructive">{t("review.dialog.peopleError")}</p>
        ) : (
          <div className="space-y-3">
            {field(
              "reviewer",
              t("review.dialog.reviewer"),
              <>
                <option value="">{t("review.dialog.pick")}</option>
                {people.data.map((p) => (
                  // Listed but not pickable: the review's AI runs on the reviewer's own Claude account.
                  <option key={p.id} value={p.id} disabled={!p.canReview}>
                    {p.canReview ? p.username : t("review.dialog.noAccount", { name: p.username })}
                  </option>
                ))}
              </>,
            )}
            {field("author", t("review.dialog.author"), <><option value="">{t("review.dialog.pick")}</option>{choices}</>)}
            {field("coauthor", t("review.dialog.coauthor"), <><option value="">{t("review.dialog.nobody")}</option>{choices}</>)}
            {field("merger", t("review.dialog.merger"), <><option value="">{t("review.dialog.pick")}</option>{choices}</>)}

            {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {people.isSuccess ? (
            <Button type="button" disabled={!canStart} onClick={submit}>
              {start.isPending ? t("review.dialog.starting") : t("review.dialog.start")}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The sentence for a refusal of the start route: its own text for each code the server answers with
 * (naming WHO when the server named them), the server's words for anything else.
 */
function refusalMessage(error: unknown): string {
  const code = startErrorCode(error);
  if (!code) return apiErrorMessage(error);
  if (code !== "papel_sem_work" && code !== "pessoa_sem_acesso") return translate(`review.error.${code}`);
  const who = startErrorRoles(error).map((role) => translate(`review.role.${role}`)).join(", ");
  return translate(who ? `review.error.${code}` : `review.error.${code}.generic`, { who });
}

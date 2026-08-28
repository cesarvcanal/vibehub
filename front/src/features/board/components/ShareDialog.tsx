import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { get, post, del } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import type { Share, ShareLevel, SharesResponse, User, UsersResponse } from "@/api/types";
import { SELECT_CLASS } from "@/features/board/components/NewCardDialog";
import { t as translate, useT } from "@/i18n";

/**
 * SHARING one card — or one whole project — with somebody who works with you.
 *
 * The list is the install's MEMBERS, one row each, because the question being asked is "who works
 * on this?" and not "which permission object should exist". A row is either off (they cannot see
 * it) or on at a level:
 *  - **work** — their terminal types into the same session yours does. This is the default: sharing
 *    a card is usually asking somebody to come and do the work.
 *  - **view** — they read it. The terminal streams, nothing they press reaches the agent.
 *
 * Sharing a PROJECT is the standing version of the same thing: every card in it, including the ones
 * created after the share. The owner never appears here — they already see everything.
 */

export type ShareKind = "card" | "project";

export const sharesKey = (kind: ShareKind, id: string) => ["shares", kind, id] as const;
export const SHARE_USERS_KEY = ["users"] as const;

const PATH: Record<ShareKind, string> = { card: "cards", project: "projects" };

export interface ShareDialogProps {
  kind: ShareKind;
  targetId: string;
  /** What is being shared, for the dialog's own sentence. */
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareDialog({ kind, targetId, title, open, onOpenChange }: ShareDialogProps) {
  const t = useT();
  const qc = useQueryClient();
  const base = `/${PATH[kind]}/${encodeURIComponent(targetId)}/shares`;

  const users = useQuery({
    queryKey: SHARE_USERS_KEY,
    queryFn: () => get<UsersResponse>("/users").then((r) => r.users),
    enabled: open,
  });
  const shares = useQuery({
    queryKey: sharesKey(kind, targetId),
    queryFn: () => get<SharesResponse>(base).then((r) => r.shares),
    enabled: open,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: sharesKey(kind, targetId) });
    // The board of whoever is watching changes shape too (a member gains or loses a card).
    void qc.invalidateQueries({ queryKey: ["board"] });
  };

  const add = useMutation({
    mutationFn: (body: { userId: string; level: ShareLevel }) => post<{ share: Share }>(base, body),
    onSuccess: (result) => {
      invalidate();
      toast.success(translate("share.granted", { name: result.share.username, title }));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => del<{ ok: true }>(`${base}/${encodeURIComponent(userId)}`),
    onSuccess: () => {
      invalidate();
      toast.success(translate("share.revoked"));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const members: User[] = (users.data ?? []).filter((u) => u.role === "member");
  const levelOf = (userId: string): ShareLevel | null =>
    (shares.data ?? []).find((s) => s.userId === userId)?.level ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>{kind === "card" ? t("share.cardTitle") : t("share.projectTitle")}</DialogTitle>
          <DialogDescription>
            {kind === "card" ? t("share.cardHint", { title }) : t("share.projectHint", { title })}
          </DialogDescription>
        </DialogHeader>

        {users.isPending || shares.isPending ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : members.length === 0 ? (
          // Nothing to choose from is not an empty list, it is a missing step — say which one.
          <p className="text-sm text-muted-foreground">{t("share.noMembers")}</p>
        ) : (
          <ul className="space-y-2">
            {members.map((u) => {
              const level = levelOf(u.id);
              const busy = add.isPending || remove.isPending;
              return (
                <li key={u.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{u.username}</span>
                  <select
                    aria-label={t("share.accessOf", { name: u.username })}
                    className={`${SELECT_CLASS} w-36`}
                    value={level ?? "none"}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (next === "none") remove.mutate(u.id);
                      else add.mutate({ userId: u.id, level: next as ShareLevel });
                    }}
                  >
                    <option value="none">{t("share.levelNone")}</option>
                    <option value="work">{t("share.levelWork")}</option>
                    <option value="view">{t("share.levelView")}</option>
                  </select>
                </li>
              );
            })}
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

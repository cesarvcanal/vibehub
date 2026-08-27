import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { get, patch, post, del } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import { useAuth } from "@/providers/auth";
import type { Role, User, UsersResponse } from "@/api/types";
import { SELECT_CLASS } from "@/features/board/components/NewCardDialog";
import { t as translate, useT } from "@/i18n";

/**
 * ACCESS — the people who can sign in to this install.
 *
 * The owner creates an account by typing a username and a password and handing them over. There is
 * no invitation email and no self sign-up: this is a self-hosted tool for a handful of people, and
 * a mail server would be more machinery than the problem has.
 *
 * A member sees exactly one thing in here: their own password. The list, the create form and the
 * role select are the owner's, and the server enforces the same split on every route — this only
 * decides what is worth drawing.
 */

export const USERS_KEY = ["users"] as const;

export interface AccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AccessDialog({ open, onOpenChange }: AccessDialogProps) {
  const t = useT();
  const qc = useQueryClient();
  const { user: me, isOwner } = useAuth();

  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: () => get<UsersResponse>("/users").then((r) => r.users),
    enabled: open && isOwner,
  });

  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<Role>("member");
  /** Which user's password is being reset right now (the row with the field open), and to what. */
  const [resetting, setResetting] = React.useState<string | null>(null);
  const [resetPassword, setResetPassword] = React.useState("");
  const [ownPassword, setOwnPassword] = React.useState("");

  const create = useMutation({
    mutationFn: (body: { username: string; password: string; role: Role }) =>
      post<{ user: User }>("/users", body),
    onSuccess: (result) => {
      setUsername("");
      setPassword("");
      setRole("member");
      void qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success(translate("access.created", { name: result.user.username }));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; password?: string; role?: Role }) =>
      patch<{ user: User }>(`/users/${encodeURIComponent(id)}`, body),
    onSuccess: () => {
      setResetting(null);
      setResetPassword("");
      void qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success(translate("access.updated"));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => del<{ ok: true }>(`/users/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success(translate("access.removed"));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const changeOwn = useMutation({
    mutationFn: (body: { password: string }) => post<{ ok: true }>("/auth/password", body),
    onSuccess: () => {
      setOwnPassword("");
      toast.success(translate("access.ownPasswordChanged"));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const list = users.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("access.title")}</DialogTitle>
          <DialogDescription>
            {isOwner ? t("access.description") : t("access.memberDescription")}
          </DialogDescription>
        </DialogHeader>

        {isOwner ? (
          <>
            <section className="space-y-2" data-testid="access-users">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("access.people")}
              </h3>
              {users.isPending ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
              ) : list.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("access.empty")}</p>
              ) : (
                <ul className="space-y-2">
                  {list.map((u) => (
                    <li key={u.id} className="rounded-lg border border-border/60 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{u.username}</span>
                        {u.id === me?.id ? (
                          <span className="text-xs text-muted-foreground">{t("access.you")}</span>
                        ) : null}
                        <span className="flex-1" />
                        <select
                          aria-label={t("access.roleOf", { name: u.username })}
                          className={`${SELECT_CLASS} w-32`}
                          value={u.role}
                          disabled={update.isPending}
                          onChange={(e) => update.mutate({ id: u.id, role: e.target.value as Role })}
                        >
                          <option value="owner">{t("access.roleOwner")}</option>
                          <option value="member">{t("access.roleMember")}</option>
                        </select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          title={t("access.resetPassword")}
                          aria-label={t("access.resetPasswordFor", { name: u.username })}
                          onClick={() => {
                            setResetPassword("");
                            setResetting(resetting === u.id ? null : u.id);
                          }}
                        >
                          <KeyRound className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          title={t("access.remove")}
                          aria-label={t("access.removeUser", { name: u.username })}
                          disabled={remove.isPending}
                          onClick={() => {
                            // One confirm, because this cannot be undone and the row is one click
                            // away from the role select next to it.
                            if (window.confirm(translate("access.removeConfirm", { name: u.username }))) {
                              remove.mutate(u.id);
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      {resetting === u.id ? (
                        <form
                          className="mt-2 flex items-center gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            update.mutate({ id: u.id, password: resetPassword });
                          }}
                        >
                          <Input
                            type="password"
                            autoComplete="new-password"
                            aria-label={t("access.newPassword")}
                            placeholder={t("access.newPassword")}
                            value={resetPassword}
                            onChange={(e) => setResetPassword(e.target.value)}
                          />
                          <Button type="submit" size="sm" disabled={update.isPending || resetPassword.length < 8}>
                            {t("common.save")}
                          </Button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <form
              className="space-y-3 border-t border-border/60 pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate({ username: username.trim(), password, role });
              }}
            >
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("access.invite")}
              </h3>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="access-username">{t("access.username")}</Label>
                  <Input
                    id="access-username"
                    value={username}
                    autoComplete="off"
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="mussa"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="access-password">{t("access.password")}</Label>
                  <Input
                    id="access-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="access-role">{t("access.role")}</Label>
                  <select
                    id="access-role"
                    className={SELECT_CLASS}
                    value={role}
                    onChange={(e) => setRole(e.target.value as Role)}
                  >
                    <option value="member">{t("access.roleMember")}</option>
                    <option value="owner">{t("access.roleOwner")}</option>
                  </select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("access.inviteHint")}</p>
              <div className="flex justify-end">
                <Button type="submit" disabled={create.isPending || !username.trim() || password.length < 8}>
                  <UserPlus className="h-4 w-4" />
                  {create.isPending ? t("common.saving") : t("access.createUser")}
                </Button>
              </div>
            </form>
          </>
        ) : null}

        <form
          className="space-y-3 border-t border-border/60 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            changeOwn.mutate({ password: ownPassword });
          }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("access.ownPassword")}
          </h3>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="access-own-password">{t("access.newPassword")}</Label>
              <Input
                id="access-own-password"
                type="password"
                autoComplete="new-password"
                value={ownPassword}
                onChange={(e) => setOwnPassword(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={changeOwn.isPending || ownPassword.length < 8}>
              {changeOwn.isPending ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

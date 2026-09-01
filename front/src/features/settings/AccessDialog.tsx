import * as React from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Plus, Trash2, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { get, patch, post, del } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import { useAuth } from "@/providers/auth";
import { sharesKey } from "@/features/board/components/ShareDialog";
import { PROJECTS_KEY, boardApi } from "@/features/board/api";
import type { Role, Share, ShareLevel, SharesResponse, User, UsersResponse } from "@/api/types";
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
                      {/* WHAT this member can reach, right on their row — the answer César went
                          looking for and could not find. Project-level shares only: card-level
                          ones stay in each card's own Share… dialog. */}
                      {u.role === "member" ? <SharedProjectsEditor userId={u.id} username={u.username} /> : null}
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
                    placeholder="alex"
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

        <div className="border-t border-border/60 pt-4">
          <OwnPasswordForm />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The PROJECTS one member can reach, editable in place — the visual CRUD of sharing.
 *
 * Sharing already existed per project (the row's context menu and the header's share button), but
 * "what does Mussa see?" had no answer anywhere: it was scattered over N dialogs. This reads every
 * project's share list (the same owner-only routes those dialogs use, same cache keys) and turns
 * the answer around: per PERSON, which projects, at which level, with add and remove right here.
 */
function SharedProjectsEditor({ userId, username }: { userId: string; username: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [adding, setAdding] = React.useState("");
  const [level, setLevel] = React.useState<ShareLevel>("work");

  const projects = useQuery({ queryKey: PROJECTS_KEY, queryFn: boardApi.listProjects });
  const list = projects.data ?? [];

  // One small read per project, through the SAME keys the per-project dialog uses, so the two
  // surfaces never disagree about who has what.
  const shareQueries = useQueries({
    queries: list.map((p) => ({
      queryKey: sharesKey("project", p.id),
      queryFn: () => get<SharesResponse>(`/projects/${encodeURIComponent(p.id)}/shares`).then((r) => r.shares),
    })),
  });

  const shared = list
    .map((p, i) => {
      const share = (shareQueries[i]?.data ?? []).find((s) => s.userId === userId);
      return share ? { project: p, level: share.level } : null;
    })
    .filter((x): x is { project: (typeof list)[number]; level: ShareLevel } => x !== null);
  const sharedIds = new Set(shared.map((s) => s.project.id));
  const addable = list.filter((p) => !sharedIds.has(p.id));

  const invalidate = (projectId: string) => {
    void qc.invalidateQueries({ queryKey: sharesKey("project", projectId) });
    void qc.invalidateQueries({ queryKey: ["board"] });
  };

  const add = useMutation({
    mutationFn: ({ projectId, level }: { projectId: string; level: ShareLevel }) =>
      post<{ share: Share }>(`/projects/${encodeURIComponent(projectId)}/shares`, { userId, level }),
    onSuccess: (_r, vars) => {
      setAdding("");
      invalidate(vars.projectId);
      toast.success(translate("access.projectShared", { name: username }));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (projectId: string) =>
      del<{ ok: true }>(`/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(userId)}`),
    onSuccess: (_r, projectId) => {
      invalidate(projectId);
      toast.success(translate("access.projectUnshared", { name: username }));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const busy = add.isPending || remove.isPending;
  const levelLabel = (l: ShareLevel) => (l === "work" ? t("share.levelWork") : t("share.levelView"));

  return (
    <div className="mt-2 space-y-2 border-t border-border/40 pt-2" data-testid={`shared-projects-${userId}`}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {t("access.sharedProjects")}
      </p>
      {shared.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("access.noSharedProjects")}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {shared.map(({ project, level }) => (
            <li
              key={project.id}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 py-0.5 pl-2 pr-0.5 text-xs"
            >
              <span className="max-w-[10rem] truncate font-medium">{project.name}</span>
              <span className="text-muted-foreground">· {levelLabel(level)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-muted-foreground hover:text-foreground"
                aria-label={t("access.unshareProject", { project: project.name, name: username })}
                disabled={busy}
                onClick={() => remove.mutate(project.id)}
              >
                <X className="h-3 w-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {addable.length > 0 ? (
        <div className="flex items-center gap-1.5">
          <select
            aria-label={t("access.addProjectFor", { name: username })}
            className={`${SELECT_CLASS} h-8 flex-1 text-xs`}
            value={adding}
            disabled={busy}
            onChange={(e) => setAdding(e.target.value)}
          >
            <option value="">{t("access.addProject")}</option>
            {addable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label={t("access.addLevelFor", { name: username })}
            className={`${SELECT_CLASS} h-8 w-28 text-xs`}
            value={level}
            disabled={busy}
            onChange={(e) => setLevel(e.target.value as ShareLevel)}
          >
            <option value="work">{t("share.levelWork")}</option>
            <option value="view">{t("share.levelView")}</option>
          </select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8"
            disabled={busy || !adding}
            aria-label={t("access.shareProjectWith", { name: username })}
            onClick={() => adding && add.mutate({ projectId: adding, level })}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Your own password — the ONE account thing everybody has, whatever their role. It lives here and
 * inside the footer's "Edit user" dialog, which is the same form with a smaller door.
 */
export function OwnPasswordForm() {
  const t = useT();
  const [ownPassword, setOwnPassword] = React.useState("");

  const changeOwn = useMutation({
    mutationFn: (body: { password: string }) => post<{ ok: true }>("/auth/password", body),
    onSuccess: () => {
      setOwnPassword("");
      toast.success(translate("access.ownPasswordChanged"));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  return (
    <form
      className="space-y-3"
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
  );
}

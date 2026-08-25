import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQuery } from "@tanstack/react-query";
import {
  ACCOUNT_USAGE_KEY,
  CLAUDE_MODELS,
  DEFAULT_ACCOUNT_SLUG,
  accountLabel,
  boardApi,
  projectAccountSlug,
  projectBaseBranch,
  type BoardAccount,
  type BoardProject,
} from "@/features/board/api";
import { pillPercent } from "@/features/board/lib/usage";
import type { NewCard } from "@/api/types";
import { useT } from "@/i18n";

/** The native select, styled like the rest of the form controls. */
export const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background/60 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

/**
 * New card. The title is the only thing that matters — the branch, worktree and tmux session are
 * derived from it inside the runner. Account, model and branch are folded away under "Options"
 * because the answer is almost always "whatever the project uses".
 *
 * Submitting fires the creation and closes IMMEDIATELY rather than waiting for the server. Creating
 * a card can mean cloning a repository, and blocking the dialog on that turned "spin up four cards"
 * into four separate waits — the whole point of a board of agents is that you queue work up faster
 * than it completes. The request still runs; a failure arrives as a toast, which is readable
 * whether or not the dialog is still on screen.
 */
export function NewCardDialog({
  open,
  onOpenChange,
  projects,
  initialProjectId,
  accounts,
  defaultAccountLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every project, so a card created from a no-project context can pick one. */
  projects: BoardProject[];
  /** Which project the card belongs to. null = created from the homepage / a global "+": ask which. */
  initialProjectId: string | null;
  accounts: BoardAccount[];
  /** Display name of the runner's built-in profile. */
  defaultAccountLabel: string;
  /** Fired and forgotten — the dialog does not wait for it. */
  onSubmit: (input: NewCard) => void;
}) {
  const t = useT();
  const [title, setTitle] = React.useState("");
  // When the caller knew the project we keep it fixed and hidden; when it did not (homepage / global
  // "+"), the person picks one — defaulting to the first so a card is always one field from done.
  const askProject = initialProjectId === null;
  const [projectId, setProjectId] = React.useState(initialProjectId ?? projects[0]?.id ?? "");
  const selectedProject = projects.find((p) => p.id === projectId);
  const inheritedAccount = projectAccountSlug(selectedProject);
  const defaultBranch = projectBaseBranch(selectedProject);
  const [account, setAccount] = React.useState("");
  const [model, setModel] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [showOptions, setShowOptions] = React.useState(false);

  /**
   * Plan usage, so the account choice is INFORMED rather than a name picked from a list. Read only
   * while the dialog is open, and no harder than the server caches it — picking the account is
   * exactly the moment the number matters, and exactly the moment it was missing.
   */
  const { data: usage } = useQuery({
    queryKey: ACCOUNT_USAGE_KEY,
    queryFn: boardApi.accountsUsage,
    enabled: open,
    staleTime: 55_000,
    retry: false,
  });

  /** `Tech — 31%`, or just the name when that account has no numbers to show. PURE-ish. */
  const withPercent = (label: string, slug: string) => {
    const percent = pillPercent(usage?.bySlug?.[slug]);
    return percent ? `${label} — ${percent}` : label;
  };

  const reset = React.useCallback(() => {
    setTitle("");
    setProjectId(initialProjectId ?? projects[0]?.id ?? "");
    setAccount("");
    setModel("");
    setBranch("");
    setShowOptions(false);
  }, [initialProjectId, projects]);

  /**
   * The one way out that is not a submit. Cancel used to call `onOpenChange` directly, skipping the
   * reset in the Dialog's own handler — so a title you thought better of was still sitting there
   * the next time you opened it, and the fastest way to create a card was to accidentally create
   * the wrong one.
   */
  const close = React.useCallback(() => {
    reset();
    onOpenChange(false);
  }, [reset, onOpenChange]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || !projectId) return;
    onSubmit({
      projectId,
      title: trimmed,
      ...(account ? { accountSlug: account } : {}),
      ...(model ? { model } : {}),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
    });
    // Close on submit, not on success: the next card can be typed while this one is still cloning.
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("newCard.title")}</DialogTitle>
          <DialogDescription>
            {t("newCard.description")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          {askProject ? (
            <div className="space-y-1.5">
              <Label htmlFor="new-card-project">{t("newCard.project")}</Label>
              <select
                id="new-card-project"
                className={SELECT_CLASS}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="new-card-title">{t("newCard.titleLabel")}</Label>
            <Input
              id="new-card-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("newCard.titlePlaceholder")}
            />
          </div>

          <button
            type="button"
            onClick={() => setShowOptions((v) => !v)}
            aria-expanded={showOptions}
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
          >
            {showOptions ? t("newCard.hideOptions") : t("newCard.options")}
          </button>

          {showOptions ? (
            <div className="space-y-4 rounded-md border border-border/60 bg-card/40 p-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-card-account">{t("newCard.account")}</Label>
                <select
                  id="new-card-account"
                  className={SELECT_CLASS}
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                >
                  <option value="">
                    {withPercent(
                      t("newCard.inherit", { name: inheritedAccount ?? defaultAccountLabel }),
                      inheritedAccount ?? DEFAULT_ACCOUNT_SLUG,
                    )}
                  </option>
                  {accounts.map((a) => (
                    <option key={a.slug} value={a.slug}>
                      {withPercent(accountLabel(a), a.slug)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="new-card-model">{t("newCard.model")}</Label>
                <select
                  id="new-card-model"
                  className={SELECT_CLASS}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">{t("newCard.accountDefault")}</option>
                  {CLAUDE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="new-card-branch">{t("newCard.branch")}</Label>
                <Input
                  id="new-card-branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder={
                    defaultBranch
                      ? t("newCard.branchPlaceholderBase", { branch: defaultBranch })
                      : t("newCard.branchPlaceholder")
                  }
                  className="font-mono"
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!title.trim()}>
              {t("newCard.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

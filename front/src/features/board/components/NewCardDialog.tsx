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
import { SELECT_CLASS } from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import {
  ACCOUNT_USAGE_KEY,
  CLAUDE_MODELS,
  DEFAULT_ACCOUNT_SLUG,
  accountLabel,
  boardApi,
  projectAccountSlug,
  projectBaseBranch,
  splitRepo,
  type BoardAccount,
  type BoardProject,
} from "@/features/board/api";
import { pillPercent } from "@/features/board/lib/usage";
import { isBranchName, newCardBranchIssue } from "@/features/board/lib/branches";
import { useRepoBranches } from "@/features/board/lib/useRepoBranches";
import { keepDialogOpenOnPickerEscape } from "@/features/board/lib/useBranchPicker";
import BranchPicker from "@/features/board/components/BranchPicker";
import type { NewCard } from "@/api/types";
import { useT } from "@/i18n";

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
  ownAccountSlug,
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
  /**
   * The signed-in person's own Claude account. The server creates the card ON it when no account is
   * picked, so "inherit" means THEIRS — and without one, the card lands on the default account.
   */
  ownAccountSlug?: string;
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
  // What "no account picked" resolves to: the creator's own, else the project's, else the default.
  // Tied to the runner's default account ("default") is having one, but the server stamps nothing
  // for it — the card then inherits like before, so only a real slug wins over the project's.
  const personalAccount = ownAccountSlug === DEFAULT_ACCOUNT_SLUG ? undefined : ownAccountSlug;
  const inheritedAccount = personalAccount ?? projectAccountSlug(selectedProject);
  const ownAccount = personalAccount ? accounts.find((a) => a.slug === personalAccount) : undefined;
  // "Your account" whenever the card lands on the person's: their own slug, or the default one
  // when the project does not point elsewhere.
  const landsOnOwn = Boolean(personalAccount) || (Boolean(ownAccountSlug) && !inheritedAccount);
  const defaultBranch = projectBaseBranch(selectedProject);
  const [account, setAccount] = React.useState("");
  const [model, setModel] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [base, setBase] = React.useState("");
  const [locked, setLocked] = React.useState(false);
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

  /**
   * THE REPOSITORY'S REAL BRANCHES, so "cut from" is a list and not a guess. Only fetched once the
   * options are open: most cards are created without ever unfolding them, and this is a round trip
   * to GitHub. A project with no repo (scratch), or a request that fails, falls back to a free text
   * field — the card still gets created, it just stops being able to check the name.
   */
  const { owner, repo: repoName } = splitRepo(selectedProject?.repoFullName ?? "");
  const connection = selectedProject?.githubConnectionId ?? "";
  const repoBranches = useRepoBranches({
    connection,
    owner,
    repo: repoName,
    enabled: open && showOptions,
  });
  const { branches } = repoBranches;

  const effectiveBase = base.trim() || defaultBranch || "";
  const branchIssue = newCardBranchIssue(branch, effectiveBase, branches);
  /** A base typed by hand (no list) is taken on trust; one picked from the list cannot be wrong. */
  const baseInvalid = base.trim() !== "" && !isBranchName(base);
  const blocked = branchIssue === "invalid" || branchIssue === "isBase" || baseInvalid;

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
    setBase("");
    setLocked(false);
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
    if (!trimmed || !projectId || blocked) return;
    onSubmit({
      projectId,
      title: trimmed,
      ...(account ? { accountSlug: account } : {}),
      ...(model ? { model } : {}),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
      ...(base.trim() ? { base: base.trim() } : {}),
      // Sent only when ON: the card record stores the lock or nothing, and so does the request.
      ...(locked ? { locked: true } : {}),
    });
    // Close on submit, not on success: the next card can be typed while this one is still cloning.
    close();
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
      {/* Vertical scroll only. grid-cols-1 makes the dialog's grid track minmax(0, 1fr): with the default
          track, a select whose longest option is wider than the dialog stretched the form past it and
          the dialog grew a sideways scroll. Wide (2xl) so the options sit in pairs instead of a tall
          single column that hits the 90vh cap. */}
      <DialogContent
        className="grid-cols-1 max-h-[90vh] max-w-2xl overflow-y-auto overflow-x-hidden"
        onEscapeKeyDown={keepDialogOpenOnPickerEscape}
      >
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
            <div className="grid grid-cols-1 gap-4 rounded-md border border-border/60 bg-card/40 p-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="new-card-account">{t("newCard.account")}</Label>
                <select
                  id="new-card-account"
                  className={SELECT_CLASS}
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                >
                  <option value="">
                    {withPercent(
                      landsOnOwn
                        ? t("newCard.ownAccount", {
                            name: ownAccount ? accountLabel(ownAccount) : personalAccount ?? defaultAccountLabel,
                          })
                        : t("newCard.inherit", { name: inheritedAccount ?? defaultAccountLabel }),
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

              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="new-card-model">{t("newCard.model")}</Label>
                <select
                  id="new-card-model"
                  className={SELECT_CLASS}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">{t("newCard.modelDefault")}</option>
                  {CLAUDE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* CUT FROM comes first: it is the question you answer before naming anything, and a
                  list of the repository's real branches is the whole point — "dev" exists in some
                  repos and not others, and typing it wrong fails minutes later inside the runner. */}
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="new-card-base">{t("newCard.base")}</Label>
                {branches?.length ? (
                  <BranchPicker
                    id="new-card-base"
                    value={base}
                    onSelect={setBase}
                    branches={branches}
                    defaultBranch={repoBranches.defaultBranch}
                    refreshing={repoBranches.refreshing}
                    refreshFailed={repoBranches.failed}
                    truncated={repoBranches.truncated}
                    onOpen={repoBranches.refreshIfStale}
                    onRefresh={repoBranches.forceRefresh}
                    noChoiceLabel={t("newCard.baseInherit", { branch: defaultBranch ?? "" })}
                  />
                ) : (
                  <Input
                    id="new-card-base"
                    value={base}
                    onChange={(e) => setBase(e.target.value)}
                    placeholder={t("newCard.basePlaceholder", { branch: defaultBranch ?? "dev" })}
                    className="font-mono"
                    aria-invalid={baseInvalid || undefined}
                  />
                )}
                {baseInvalid ? (
                  <p className="text-[11px] text-destructive">{t("newCard.branchInvalid")}</p>
                ) : null}
              </div>

              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="new-card-branch">{t("newCard.branch")}</Label>
                <Input
                  id="new-card-branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder={
                    effectiveBase
                      ? t("newCard.branchPlaceholderBase", { branch: effectiveBase })
                      : t("newCard.branchPlaceholder")
                  }
                  className="font-mono"
                  aria-invalid={branchIssue === "invalid" || branchIssue === "isBase" || undefined}
                  aria-describedby={branchIssue ? "new-card-branch-issue" : undefined}
                />
                {/* One line, and it says which of the three it is: two stop the card, one just
                    tells you the card will OPEN on a branch instead of creating it. */}
                {branchIssue ? (
                  <p
                    id="new-card-branch-issue"
                    className={
                      branchIssue === "exists"
                        ? "text-[11px] text-amber-600 dark:text-amber-400"
                        : "text-[11px] text-destructive"
                    }
                  >
                    {branchIssue === "invalid"
                      ? t("newCard.branchInvalid")
                      : branchIssue === "isBase"
                        ? t("newCard.branchIsBase", { branch: effectiveBase })
                        : t("newCard.branchExists")}
                  </p>
                ) : null}
              </div>

              {/* The LOCK. Deliberately next to the base, because the base is what it locks the card
                  to: the delivery becomes a PR against that branch and nothing else. */}
              <label htmlFor="new-card-locked" className="flex cursor-pointer items-start gap-2 sm:col-span-2">
                <input
                  id="new-card-locked"
                  type="checkbox"
                  checked={locked}
                  onChange={(e) => setLocked(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm leading-none">{t("newCard.locked")}</span>
                  <span className="block text-xs text-muted-foreground">{t("newCard.lockedHint")}</span>
                </span>
              </label>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!title.trim() || blocked}>
              {t("newCard.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

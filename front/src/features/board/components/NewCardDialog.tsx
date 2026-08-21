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
import { CLAUDE_MODELS, accountLabel, type BoardAccount } from "@/features/board/api";
import type { NewCard } from "@/api/types";

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
  projectId,
  accounts,
  defaultAccountLabel,
  inheritedAccount,
  defaultBranch,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  accounts: BoardAccount[];
  /** Display name of the runner's built-in profile. */
  defaultAccountLabel: string;
  /** Account the project passes down, if any. */
  inheritedAccount?: string;
  /** Branch the project cuts worktrees from — shown as the placeholder. */
  defaultBranch?: string;
  /** Fired and forgotten — the dialog does not wait for it. */
  onSubmit: (input: NewCard) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [account, setAccount] = React.useState("");
  const [model, setModel] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [showOptions, setShowOptions] = React.useState(false);

  const reset = React.useCallback(() => {
    setTitle("");
    setAccount("");
    setModel("");
    setBranch("");
    setShowOptions(false);
  }, []);

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
    if (!trimmed) return;
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
          <DialogTitle>New card</DialogTitle>
          <DialogDescription>
            Just the task. The branch, worktree and terminal session are derived from the title
            inside the runner.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-card-title">Title</Label>
            <Input
              id="new-card-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. fix the totals on the closing screen"
            />
          </div>

          <button
            type="button"
            onClick={() => setShowOptions((v) => !v)}
            aria-expanded={showOptions}
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
          >
            {showOptions ? "Hide options" : "Options"}
          </button>

          {showOptions ? (
            <div className="space-y-4 rounded-md border border-border/60 bg-card/40 p-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-card-account">Claude account</Label>
                <select
                  id="new-card-account"
                  className={SELECT_CLASS}
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                >
                  <option value="">
                    Inherit ({inheritedAccount ?? defaultAccountLabel})
                  </option>
                  {accounts.map((a) => (
                    <option key={a.slug} value={a.slug}>
                      {accountLabel(a)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="new-card-model">Model</Label>
                <select
                  id="new-card-model"
                  className={SELECT_CLASS}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">Account default</option>
                  {CLAUDE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="new-card-branch">Branch</Label>
                <Input
                  id="new-card-branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder={defaultBranch ? `derived from the title (base ${defaultBranch})` : "derived from the title"}
                  className="font-mono"
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim()}>
              Create card
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

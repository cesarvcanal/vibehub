import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Brain, Loader2, RefreshCw, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/providers/auth";
import { apiErrorMessage } from "@/lib/apiError";
import { applyOutcomeMessage } from "@/features/board/lib/applyOutcome";
import { BRAIN_KEY, CARDS_PREFIX_KEY, boardApi } from "@/features/board/api";

/**
 * The brain: one shared CLAUDE.md, planted at the root of every Claude profile in the runner.
 *
 * It is the only instruction every card gets for free, in any directory, on any project — the house
 * rules ("commit style", "never touch prod", "the tests are the definition of done") that you would
 * otherwise paste into a dozen terminals a day. That is why it earns a button of its own next to
 * Accounts and MCP rather than living in a settings page nobody opens.
 *
 * Two things make the editing safe. The text is only ever seeded from the server when the dialog
 * opens, so a poll can never overwrite what you are typing. And Save does not only persist: the
 * server pushes the new text into every profile and restarts the terminals it can — the ones that
 * are mid-turn are flagged and pick it up when they finish, never interrupted. The toast reports
 * both numbers, because a deferred restart is invisible otherwise.
 */

/**
 * Who last changed the house rules, and when. PURE.
 *
 * Written out as `dd/mm/yyyy hh:mm:ss` rather than through `toLocaleString`, so the same install
 * reads the same way for everyone looking at it and a test can assert the string instead of the
 * browser's locale. `undefined` means nobody has ever saved: the seed text is what is running.
 */
export function formatBrainStamp(updatedAt: string | undefined, by?: string): string {
  if (!updatedAt) return "using the built-in default (never saved)";
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return "saved";
  const pad = (n: number) => String(n).padStart(2, "0");
  const when =
    `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  return by ? `saved ${when} by ${by}` : `saved ${when}`;
}

export function BrainManager() {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  // null = "the user has not typed in this opening yet", which is what lets the seeding effect below
  // run exactly once per open instead of fighting the editor.
  const [text, setText] = React.useState<string | null>(null);
  // OFF by default: "apply everywhere" writes the file, and restarting terminals to make it take
  // effect is a bigger act than the button admits to. Opt in.
  const [restartIdle, setRestartIdle] = React.useState(false);
  // Whoever is signed in — the server does not always record an author, and an unattributed change
  // to the rules every card obeys is worse than a best guess that is right in a single-operator
  // install (which is almost all of them).
  const { user } = useAuth();

  const { data: brain, isLoading } = useQuery({
    queryKey: BRAIN_KEY,
    queryFn: boardApi.brain,
    enabled: open,
  });

  React.useEffect(() => {
    if (open && text === null && brain) setText(brain.text);
  }, [open, text, brain]);

  /** Every board query, so a flagged card shows its pending line without waiting for the poll. */
  const refreshBoards = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: BRAIN_KEY });
    void queryClient.invalidateQueries({ queryKey: CARDS_PREFIX_KEY });
  }, [queryClient]);

  const saveMutation = useMutation({
    mutationFn: () => boardApi.saveBrain(text ?? ""),
    onSuccess: (result) => {
      refreshBoards();
      setText(result.text);
      toast.success(applyOutcomeMessage(result, "Brain"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not save the brain")),
  });

  // Back to the text the server ships with. Same route family as a save, so it reports the same
  // way — this is a write, not a local "clear the box".
  const resetMutation = useMutation({
    mutationFn: () => boardApi.resetBrain(),
    onSuccess: (result) => {
      refreshBoards();
      setText(result.text);
      toast.success(applyOutcomeMessage(result, "Brain reset to the default —"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not reset the brain")),
  });

  /**
   * The manual re-push, for when a runner was down at save time. Claude reads the brain only at
   * start-up, so the switch restarts the IDLE terminals to make it take effect on what is already
   * running; the server skips anything mid-turn rather than interrupting it.
   */
  const applyMutation = useMutation({
    mutationFn: async () => {
      const applied = await boardApi.applyBrain();
      if (!restartIdle) return { applied, restarted: null };
      return { applied, restarted: await boardApi.restartAllCards() };
    },
    onSuccess: ({ applied, restarted }) => {
      const where = `Applied to ${applied.runners ?? 0} profile(s)`;
      toast.success(
        restarted
          ? `${where}. ${restarted.restarted} terminal(s) restarted, ${restarted.skipped} left working.`
          : `${where}.`,
      );
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not apply the brain")),
  });

  const busy = saveMutation.isPending || resetMutation.isPending;
  const dirty = brain != null && text != null && text !== brain.text;
  const isDefault = brain != null && text != null && text === brain.defaultText;

  return (
    <>
      {/* Icon only, beside Accounts and MCP: three settings that share one quiet corner. */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        aria-label="Brain"
        title="Brain — instructions every card gets"
        onClick={() => setOpen(true)}
      >
        <Brain className="h-4 w-4" />
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Drop the draft on close so reopening re-seeds from the server rather than showing a
          // stale edit somebody abandoned.
          if (!next) setText(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl">
          <DialogHeader>
            <DialogTitle>Brain — instructions every card gets</DialogTitle>
            <DialogDescription>
              One CLAUDE.md, written at the root of every Claude profile in the runner, so it loads
              in every terminal in every directory. Saving pushes it everywhere: idle terminals
              restart now, busy ones pick it up when they finish.
            </DialogDescription>
          </DialogHeader>

          {isLoading && text === null ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <textarea
                aria-label="Brain text"
                spellCheck={false}
                value={text ?? ""}
                onChange={(e) => setText(e.target.value)}
                className="h-[55vh] w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />

              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border/60 pt-3">
                <span className="truncate text-[11px] text-muted-foreground">
                  {formatBrainStamp(brain?.updatedAt, brain?.by ?? user?.username)}
                </span>

                <div className="flex flex-wrap items-center gap-2">
                  <label
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                    title="Restarts only the terminals that are idle — a card mid-turn is never interrupted"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-primary"
                      aria-label="Restart idle terminals"
                      checked={restartIdle}
                      onChange={(e) => setRestartIdle(e.target.checked)}
                    />
                    Restart idle terminals
                  </label>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    // Nothing to reset to when the text already IS the default.
                    disabled={busy || isDefault}
                    title="Replace the text with the one vibehub ships with"
                    onClick={() => resetMutation.mutate()}
                  >
                    {resetMutation.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                    Reset to default
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={applyMutation.isPending}
                    title="Rewrite it in every runner profile, without saving a new text"
                    onClick={() => applyMutation.mutate()}
                  >
                    {applyMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    Apply everywhere
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    // An empty brain is not a brain: the server rejects it, and pressing Save only
                    // to be told so is a round trip that teaches nothing.
                    disabled={busy || !dirty || !(text ?? "").trim()}
                    onClick={() => saveMutation.mutate()}
                  >
                    {saveMutation.isPending ? <Loader2 className="animate-spin" /> : <Save />}
                    Save
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

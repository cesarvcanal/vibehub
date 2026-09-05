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
import { BRAIN_KEY, CARDS_PREFIX_KEY, PROJECTS_KEY, projectBrainKey, boardApi } from "@/features/board/api";
import type { ProjectBrainWriteResult } from "@/api/types";
import { t as translate, useT } from "@/i18n";

/**
 * The brain: shared instructions the terminals read at start-up — in TWO scopes.
 *
 * GLOBAL is one shared CLAUDE.md, planted at the root of every Claude profile in the runner: the
 * house rules every card gets for free, in any directory, on any project. PER PROJECT is a second
 * text, delivered as CLAUDE.local.md at the root of each of THAT project's card worktrees — loaded
 * natively as project memory by both the TUI session and the native chat, and never by another
 * project's cards. The selector at the top of the dialog switches between the two.
 *
 * Two things make the editing safe. The text is only ever seeded from the server when the dialog
 * opens (or the scope switches), so a poll can never overwrite what you are typing. And Save does
 * not only persist: the server pushes the new text into the runner and restarts the terminals it
 * can — the ones mid-turn are flagged and pick it up when they finish, never interrupted. A project
 * save only ever touches (and restarts) that project's cards.
 *
 * The project brain also holds the "## Aprendizados" section that `vibehub_brain_learn` appends to
 * — it is ordinary text here, so pruning what the agents recorded is just editing and saving.
 */

/** The selector value that means "the global brain" — projects are addressed by their id. */
const GLOBAL_SCOPE = "@global";

/**
 * Who last changed the house rules, and when. PURE.
 *
 * Written out as `dd/mm/yyyy hh:mm:ss` rather than through `toLocaleString`, so the same install
 * reads the same way for everyone looking at it and a test can assert the string instead of the
 * browser's locale. `undefined` means nobody has ever saved: the seed text is what is running.
 */
export function formatBrainStamp(updatedAt: string | undefined, by?: string): string {
  if (!updatedAt) return translate("brain.stampNever");
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return translate("brain.stampSaved");
  const pad = (n: number) => String(n).padStart(2, "0");
  const when =
    `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  return by ? translate("brain.stampBy", { when, by }) : translate("brain.stampAt", { when });
}

export function BrainManager({ trigger = "icon" }: { trigger?: "icon" | "row" } = {}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  // Which brain the editor shows: the global one, or one project's (by id).
  const [scope, setScope] = React.useState<string>(GLOBAL_SCOPE);
  const isGlobal = scope === GLOBAL_SCOPE;
  // null = "the user has not typed in this opening yet", which is what lets the seeding effect below
  // run exactly once per open/scope instead of fighting the editor.
  const [text, setText] = React.useState<string | null>(null);
  // OFF by default: "apply everywhere" writes the file, and restarting terminals to make it take
  // effect is a bigger act than the button admits to. Opt in.
  const [restartIdle, setRestartIdle] = React.useState(false);
  // Whoever is signed in — the server does not always record an author, and an unattributed change
  // to the rules every card obeys is worse than a best guess that is right in a single-operator
  // install (which is almost all of them).
  const { user } = useAuth();

  const { data: projects } = useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: boardApi.listProjects,
    enabled: open,
  });

  const { data: globalBrain, isLoading: globalLoading } = useQuery({
    queryKey: BRAIN_KEY,
    queryFn: boardApi.brain,
    enabled: open && isGlobal,
  });

  const { data: projectBrain, isLoading: projectLoading } = useQuery({
    queryKey: projectBrainKey(scope),
    queryFn: () => boardApi.projectBrain(scope),
    enabled: open && !isGlobal,
  });

  const brain = isGlobal ? globalBrain : projectBrain;
  const isLoading = isGlobal ? globalLoading : projectLoading;
  const projectName = projects?.find((p) => p.id === scope)?.name ?? "";
  const subject = isGlobal ? translate("brain.subject") : translate("brain.projectSubject", { name: projectName });

  React.useEffect(() => {
    if (open && text === null && brain) setText(brain.text);
  }, [open, text, brain]);

  /** Every board query, so a flagged card shows its pending line without waiting for the poll. */
  const refreshBoards = React.useCallback(() => {
    // BRAIN_KEY is a prefix of every projectBrainKey, so one invalidation covers both scopes.
    void queryClient.invalidateQueries({ queryKey: BRAIN_KEY });
    void queryClient.invalidateQueries({ queryKey: CARDS_PREFIX_KEY });
  }, [queryClient]);

  const saveMutation = useMutation({
    mutationFn: (): Promise<ProjectBrainWriteResult> =>
      isGlobal ? boardApi.saveBrain(text ?? "") : boardApi.saveProjectBrain(scope, text ?? ""),
    onSuccess: (result) => {
      refreshBoards();
      setText(result.text);
      toast.success(applyOutcomeMessage(result, subject));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.brainSaveError"))),
  });

  // Global: back to the text the server ships with. Project: CLEAR it (a project has no seed — an
  // empty save removes the CLAUDE.local.md from its worktrees). Both are writes, and report as such.
  const resetMutation = useMutation({
    mutationFn: (): Promise<ProjectBrainWriteResult> =>
      isGlobal ? boardApi.resetBrain() : boardApi.saveProjectBrain(scope, ""),
    onSuccess: (result) => {
      refreshBoards();
      setText(result.text);
      toast.success(
        applyOutcomeMessage(result, isGlobal ? translate("brain.resetSubject") : translate("brain.clearedSubject", { name: projectName })),
      );
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.brainResetError"))),
  });

  /**
   * The manual re-push, for when a runner was down at save time. Claude reads the brain only at
   * start-up, so the switch restarts the IDLE terminals to make it take effect on what is already
   * running; the server skips anything mid-turn rather than interrupting it.
   */
  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!isGlobal) {
        const appliedCards = await boardApi.applyProjectBrain(scope);
        return { appliedCards, applied: null, restarted: null } as const;
      }
      const applied = await boardApi.applyBrain();
      if (!restartIdle) return { applied, appliedCards: null, restarted: null } as const;
      return { applied, appliedCards: null, restarted: await boardApi.restartAllCards() } as const;
    },
    onSuccess: ({ applied, appliedCards, restarted }) => {
      if (appliedCards) {
        toast.success(translate("brain.appliedPlain", { where: translate("brain.appliedToCards", { n: appliedCards.cards ?? 0 }) }));
        return;
      }
      const where = translate("brain.appliedTo", { n: applied?.runners ?? 0 });
      toast.success(
        restarted
          ? translate("brain.appliedRestarted", {
              where,
              restarted: restarted.restarted,
              skipped: restarted.skipped,
            })
          : translate("brain.appliedPlain", { where }),
      );
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.brainApplyError"))),
  });

  const busy = saveMutation.isPending || resetMutation.isPending;
  const dirty = brain != null && text != null && text !== brain.text;
  const isDefault = isGlobal && globalBrain != null && text != null && text === globalBrain.defaultText;
  // A project brain that is empty on the server AND in the editor has nothing to clear.
  const isEmptyProject = !isGlobal && (brain?.text ?? "") === "" && !(text ?? "").trim();
  // The global brain must never be emptied (the server rejects it); clearing a PROJECT brain is a
  // legitimate save — that is exactly how it is removed.
  const savable = dirty && (isGlobal ? !!(text ?? "").trim() : true);

  return (
    <>
      {/* Icon only, beside Accounts and MCP: three settings that share one quiet corner. */}
      {trigger === "row" ? (
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start gap-2"
          title={t("brain.buttonTitle")}
          onClick={() => setOpen(true)}
        >
          <Brain className="h-4 w-4 text-muted-foreground" />
          {t("brain.aria")}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          aria-label={t("brain.aria")}
          title={t("brain.buttonTitle")}
          onClick={() => setOpen(true)}
        >
          <Brain className="h-4 w-4" />
        </Button>
      )}

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
            <DialogTitle>{t("brain.title")}</DialogTitle>
            <DialogDescription>
              {isGlobal ? t("brain.description") : t("brain.projectDescription")}
            </DialogDescription>
          </DialogHeader>

          {/* Scope: the global brain, or one project's. Switching drops the draft on purpose —
              each scope's text seeds from the server, never from another scope's editor. */}
          <select
            aria-label={t("brain.scopeAria")}
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setText(null);
            }}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value={GLOBAL_SCOPE}>{t("brain.scopeGlobal")}</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {isLoading && text === null ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <textarea
                aria-label={t("brain.textAria")}
                spellCheck={false}
                value={text ?? ""}
                placeholder={isGlobal ? undefined : t("brain.projectPlaceholder")}
                onChange={(e) => setText(e.target.value)}
                className="h-[50vh] w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />

              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border/60 pt-3">
                <span className="truncate text-[11px] text-muted-foreground">
                  {!isGlobal && !brain?.updatedAt
                    ? t("brain.projectStampNever")
                    : formatBrainStamp(brain?.updatedAt, brain?.by ?? user?.username)}
                </span>

                <div className="flex flex-wrap items-center gap-2">
                  {isGlobal && (
                    <label
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                      title={t("brain.restartIdleHint")}
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-primary"
                        aria-label={t("brain.restartIdle")}
                        checked={restartIdle}
                        onChange={(e) => setRestartIdle(e.target.checked)}
                      />
                      {t("brain.restartIdle")}
                    </label>
                  )}

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    // Nothing to reset to when the text already IS the default (global), and
                    // nothing to clear when the project brain is already empty.
                    disabled={busy || isDefault || isEmptyProject}
                    title={isGlobal ? t("brain.resetTitle") : t("brain.clearTitle")}
                    onClick={() => resetMutation.mutate()}
                  >
                    {resetMutation.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                    {isGlobal ? t("brain.reset") : t("brain.clear")}
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={applyMutation.isPending}
                    title={isGlobal ? t("brain.applyTitle") : t("brain.applyProjectTitle")}
                    onClick={() => applyMutation.mutate()}
                  >
                    {applyMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    {t("brain.applyEverywhere")}
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    // An empty GLOBAL brain is not a brain: the server rejects it, and pressing
                    // Save only to be told so is a round trip that teaches nothing. An empty
                    // PROJECT save is the legitimate way to clear one.
                    disabled={busy || !savable}
                    onClick={() => saveMutation.mutate()}
                  >
                    {saveMutation.isPending ? <Loader2 className="animate-spin" /> : <Save />}
                    {t("common.save")}
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

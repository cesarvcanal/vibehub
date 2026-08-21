import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  GitBranch,
  Loader2,
  Menu,
  MonitorPlay,
  Pause,
  RotateCw,
  TerminalSquare,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { XTerminal } from "@/features/board/components/XTerminal";
import { VncPanel } from "@/features/board/components/VncPanel";
import { nextPosition, statusDot } from "@/features/board/lib/board";
import { boardTitle, useDocumentTitle } from "@/features/board/lib/documentTitle";
import type { ConnectionState } from "@/features/board/lib/reconnect";
import {
  ACCOUNTS_KEY,
  CLAUDE_MODELS,
  UPLOAD_MAX_BYTES,
  accountLabel,
  boardApi,
  cardKey,
  cardOpensInstantly,
  cardSession,
  cardWorktree,
  cardsKey,
  projectAccountSlug,
  type BoardCard,
  type BoardProject,
} from "@/features/board/api";
import type { CardColumn } from "@/api/types";

/** Small, quiet select in the card bar — configuration, not a call to action. */
const PILL =
  "h-6 max-w-[9rem] shrink-0 truncate rounded-full border border-border/60 bg-muted/40 px-2 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * One card, full screen: a thin bar and a terminal.
 *
 * ## Instant open
 *
 * The websocket attaches with `tmux new-session -A`, a complete attach-or-create, so a card whose
 * worktree and session already exist in the runner does not need to wait for anything: the terminal
 * mounts immediately and `POST /open` runs alongside it, purely to refresh the record. Only a card
 * that has NEVER been opened (no `openedAt`, no `preparedAt`) waits — that call may have to clone a
 * whole repository, which is worth a message rather than a blank screen.
 *
 * Whether it is one case or the other is decided from the board's cache when the user arrived from
 * the board, and from a light `GET /api/cards/:id` when they arrived from a link. Never guessed.
 */
export function CardTerminalView({
  project,
  cardId,
  onBack,
  onNewCard,
  onOpenMenu,
}: {
  project: BoardProject;
  cardId: string;
  onBack: () => void;
  onNewCard: () => void;
  /**
   * Opens the navigation drawer. Only rendered on narrow screens, where the card list beside the
   * terminal is hidden and going "back to the board" is otherwise the only way to reach another
   * card — which is a long way round when the whole point is hopping between agents.
   */
  onOpenMenu?: () => void;
}) {
  const queryClient = useQueryClient();
  const boardKey = cardsKey(project.id);

  // Read-only view of the board cache: the sidebar owns the fetch and the polling.
  const { data: cards } = useQuery({
    queryKey: boardKey,
    queryFn: () => boardApi.listCards(project.id),
    enabled: false,
  });

  // Decided ONCE, on mount, before anything can refetch underneath us.
  const [cachedInstant] = React.useState(() =>
    cardOpensInstantly(queryClient.getQueryData<BoardCard[]>(boardKey)?.find((c) => c.id === cardId)),
  );
  const [cacheMiss] = React.useState(
    () => !queryClient.getQueryData<BoardCard[]>(boardKey)?.some((c) => c.id === cardId),
  );

  // Deep link or refresh: read the record itself. This route does NOT touch the runner, so it
  // answers in milliseconds and tells us whether we may attach straight away.
  const { data: fetchedCard, isLoading: fetchingCard } = useQuery({
    queryKey: cardKey(cardId),
    queryFn: () => boardApi.getCard(cardId),
    enabled: cacheMiss,
  });

  const instant = cachedInstant || cardOpensInstantly(fetchedCard);
  const undecided = cacheMiss && fetchingCard;

  const mirror = React.useCallback(
    (updated: BoardCard) => {
      queryClient.setQueryData<BoardCard[]>(boardKey, (prev) =>
        prev ? prev.map((c) => (c.id === updated.id ? updated : c)) : prev,
      );
      queryClient.setQueryData(cardKey(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: boardKey });
    },
    [queryClient, boardKey],
  );

  const openMutation = useMutation({
    mutationFn: () => boardApi.openCard(cardId),
    onSuccess: mirror,
    onError: (error) => {
      // In instant mode the terminal is already on screen, so a failed open is a warning, not a wall.
      if (instant) toast.error(apiErrorMessage(error, "Could not refresh the card in the runner"));
    },
  });

  const open = openMutation.mutate;
  React.useEffect(() => {
    open();
  }, [open]);

  const card: BoardCard | null =
    cards?.find((c) => c.id === cardId) ?? openMutation.data ?? fetchedCard ?? null;

  useDocumentTitle(boardTitle(project.name, card?.title));

  /* ------------------------------------------------------------- mutations */

  const titleMutation = useMutation({
    mutationFn: (title: string) => boardApi.patchCard(cardId, { title }),
    onSuccess: mirror,
    onError: (error) => toast.error(apiErrorMessage(error, "Could not rename the card")),
  });

  const pauseMutation = useMutation({
    mutationFn: () => boardApi.pauseCard(cardId),
    onSuccess: (updated) => {
      mirror(updated);
      toast.success("Paused — reopening the card resumes the same conversation.");
      onBack();
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not pause the card")),
  });

  const moveMutation = useMutation({
    mutationFn: (patch: { column: CardColumn; position: number }) => boardApi.patchCard(cardId, patch),
    onSuccess: mirror,
    onError: (error) => toast.error(apiErrorMessage(error, "Could not move the card")),
  });

  const [reconnectNonce, setReconnectNonce] = React.useState(0);
  const restartMutation = useMutation({
    mutationFn: () => boardApi.restartCard(cardId),
    onSuccess: (updated) => {
      mirror(updated);
      // Only bump AFTER the server confirms, so the reattach cannot race the session being killed.
      setReconnectNonce((n) => n + 1);
      toast.success("Restarting — the conversation is resumed.");
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not restart the terminal")),
  });

  const accountMutation = useMutation({
    mutationFn: (accountSlug: string | null) => boardApi.patchCard(cardId, { accountSlug }),
    onSuccess: (updated) => {
      mirror(updated);
      toast.success("Account switched — the conversation continues.");
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not switch the account")),
  });

  const modelMutation = useMutation({
    mutationFn: (model: string | null) => boardApi.patchCard(cardId, { model }),
    onSuccess: (updated) => {
      mirror(updated);
      const label = CLAUDE_MODELS.find((m) => m.id === updated.model)?.label ?? "the account default";
      toast.success(`Switched to ${label} — the conversation continues.`);
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not switch the model")),
  });

  const { data: accountsData } = useQuery({ queryKey: ACCOUNTS_KEY, queryFn: boardApi.listAccounts });
  const accounts = accountsData?.accounts ?? [];
  const inheritedAccount = projectAccountSlug(project) ?? accountsData?.defaultLabel ?? "default";

  /* ------------------------------------------------------------------ state */

  const [editingTitle, setEditingTitle] = React.useState<string | null>(null);
  const [shellOpen, setShellOpen] = React.useState(false);
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const [connection, setConnection] = React.useState<ConnectionState>("connecting");

  const dot = statusDot(card?.status);
  const hasLiveSession = Boolean(card?.openedAt && !card.pausedAt);
  const canFinish = Boolean(card && card.column !== "done");
  const showTerminal = instant || openMutation.isSuccess;

  /**
   * Changing the account or the model kills the session server-side; changing this key makes the
   * terminal drop and reattach, which recreates it with the new environment in the SAME
   * conversation. The restart nonce is appended only once somebody has restarted.
   */
  const reconnectKey =
    `${card?.accountSlug ?? "-"}:${card?.model ?? "-"}` + (reconnectNonce ? `:r${reconnectNonce}` : "");

  function saveTitle() {
    if (editingTitle === null) return;
    const next = editingTitle.trim();
    setEditingTitle(null);
    if (!next || !card || next === card.title) return;
    titleMutation.mutate(next);
  }

  function finish(target: BoardCard) {
    const previous = { column: target.column, position: target.position ?? 0 };
    moveMutation.mutate({ column: "done", position: nextPosition(cards ?? [], "done") });
    toast.success(`“${target.title}” finished.`, {
      action: { label: "Undo", onClick: () => moveMutation.mutate(previous) },
    });
    onBack();
  }

  function askRestart() {
    if (
      card?.status === "working" &&
      !window.confirm("The agent is working — restarting interrupts it. Continue?")
    ) {
      return;
    }
    restartMutation.mutate();
  }

  /**
   * An image pasted or dropped on the terminal is uploaded and its path is typed into the prompt.
   * The path is absolute and inside the runner: that is the only form the agent can actually read,
   * since uploads land outside the card's worktree.
   */
  const uploadImage = React.useCallback(
    async (file: File): Promise<string | null> => {
      if (!file.type.startsWith("image/")) return null;
      if (file.size > UPLOAD_MAX_BYTES) {
        toast.error("That image is over 10 MB.");
        return null;
      }
      const pending = toast.loading("Uploading image…");
      try {
        const { path } = await boardApi.uploadCardImage(cardId, file);
        toast.success("Image attached", { description: file.name });
        return path;
      } catch (error) {
        toast.error(apiErrorMessage(error, "Could not upload the image"));
        return null;
      } finally {
        toast.dismiss(pending);
      }
    },
    [cardId],
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col gap-1.5">
      {/* The card bar: identity on the left, actions in the middle, configuration at the far end. */}
      <div
        data-testid="card-bar"
        className="flex min-h-[2rem] min-w-0 shrink-0 items-center gap-3 border-b border-border/60 pb-1.5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {onOpenMenu ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground lg:hidden"
              aria-label="Open the card list"
              onClick={onOpenMenu}
            >
              <Menu className="h-4 w-4" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-muted-foreground"
            onClick={onBack}
          >
            <ArrowLeft /> Board
          </Button>
          {dot ? (
            <span
              role="status"
              aria-label={dot.label}
              title={dot.label}
              className={cn(
                "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
                dot.tone === "ok" ? "bg-emerald-400" : "bg-amber-400",
                dot.live && "motion-safe:animate-[vh-pulse_1.6s_ease-in-out_infinite]",
              )}
            />
          ) : null}
          {editingTitle !== null ? (
            <input
              aria-label="Card title"
              autoFocus
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                else if (e.key === "Escape") setEditingTitle(null);
              }}
              onBlur={saveTitle}
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          ) : (
            <button
              type="button"
              title="Click to rename"
              disabled={!card}
              onClick={() => card && setEditingTitle(card.title)}
              className="min-w-0 truncate rounded px-1 text-left hover:bg-card/60 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <h2 className="truncate text-sm font-semibold tracking-tight">
                {card?.title ?? "Opening card…"}
              </h2>
            </button>
          )}
          <span className="shrink-0 truncate text-xs text-muted-foreground/80">· {project.name}</span>
        </div>

        {hasLiveSession || canFinish ? (
          <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/50 bg-card/40 p-0.5">
            {hasLiveSession ? (
              <BarAction
                label="Pause"
                hint="Ends the session in the runner — zero usage while parked. Reopening resumes the same conversation."
                busy={pauseMutation.isPending}
                icon={<Pause className="h-3.5 w-3.5" />}
                onClick={() => pauseMutation.mutate()}
              />
            ) : null}
            {hasLiveSession ? (
              <BarAction
                label="Restart"
                hint="Kills and recreates the Claude process in the same worktree. The conversation is resumed and MCPs, brain and model are re-read."
                busy={restartMutation.isPending}
                icon={<RotateCw className="h-3.5 w-3.5" />}
                onClick={askRestart}
              />
            ) : null}
            {canFinish ? (
              <BarAction
                label="Done"
                hint="Moves the card to Done and returns to the board"
                busy={moveMutation.isPending}
                icon={<Check className="h-3.5 w-3.5" />}
                onClick={() => card && finish(card)}
              />
            ) : null}
          </div>
        ) : null}

        <div className="flex shrink-0 items-center gap-1.5">
          {card ? (
            <select
              aria-label="Model"
              title="Model for this session (default = the account's)"
              className={PILL}
              value={card.model ?? ""}
              disabled={modelMutation.isPending}
              onChange={(e) => modelMutation.mutate(e.target.value || null)}
            >
              <option value="">Default model</option>
              {CLAUDE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : null}
          {card ? (
            <select
              aria-label="Claude account"
              title="Switch account — the session restarts on the same conversation"
              className={PILL}
              value={card.accountSlug ?? ""}
              disabled={accountMutation.isPending}
              onChange={(e) => accountMutation.mutate(e.target.value || null)}
            >
              <option value="">{inheritedAccount} (inherited)</option>
              {accounts.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {accountLabel(a)}
                </option>
              ))}
            </select>
          ) : null}
          {showTerminal ? <ConnectionIndicator state={connection} /> : null}
        </div>
      </div>

      {/* Body */}
      {!instant && openMutation.isError ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-2">
            <p>{apiErrorMessage(openMutation.error, "Could not prepare this card in the runner")}</p>
            <Button size="sm" variant="outline" onClick={() => openMutation.mutate()}>
              Try again
            </Button>
          </div>
        </div>
      ) : undecided ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the card…
        </div>
      ) : !showTerminal ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Preparing the worktree and session…
          </div>
          <p className="max-w-md text-center text-xs opacity-70">
            The first card in a project clones the whole repository into the runner, which can take a
            few minutes. Every card after that opens in seconds.
          </p>
        </div>
      ) : (
        <div
          data-testid="card-workarea"
          className={cn("flex min-h-0 flex-1 flex-col gap-2", browserOpen && "lg:flex-row")}
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <XTerminal
              wsPath={`/api/cards/${encodeURIComponent(cardId)}/terminal`}
              reconnectKey={reconnectKey}
              onStatus={setConnection}
              onUploadImage={uploadImage}
              ariaLabel={`Terminal for ${card?.title ?? "card"}`}
            />
            {shellOpen ? (
              <div className="flex h-[35%] min-h-[160px] shrink-0 flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Shell · same worktree
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground"
                    aria-label="Close shell"
                    onClick={() => setShellOpen(false)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {/* A separate tmux session on the server; closing this pane only drops the socket. */}
                <XTerminal
                  wsPath={`/api/cards/${encodeURIComponent(cardId)}/terminal?shell=1`}
                  ariaLabel="Shell"
                />
              </div>
            ) : null}
          </div>
          {browserOpen ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <VncPanel cardId={cardId} onClose={() => setBrowserOpen(false)} />
            </div>
          ) : null}
        </div>
      )}

      {/* Footer: where this card lives in the runner, and the two extra panes. */}
      <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden font-mono text-[11px] text-muted-foreground">
        {card ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            {card.branch ?? `card/${cardWorktree(card) ?? ""}`}
            {card.base ? ` · from ${card.base}` : ""}
            {cardSession(card) ? ` · ${cardSession(card)}` : ""}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onNewCard}>
          New card
          <span className="kbd ml-1">⌘K</span>
        </Button>
        <Button
          variant={browserOpen ? "secondary" : "outline"}
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={!showTerminal}
          aria-pressed={browserOpen}
          onClick={() => setBrowserOpen((v) => !v)}
        >
          <MonitorPlay className="h-3.5 w-3.5" /> Browser
        </Button>
        <Button
          variant={shellOpen ? "secondary" : "outline"}
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={!showTerminal}
          aria-pressed={shellOpen}
          onClick={() => setShellOpen((v) => !v)}
        >
          <TerminalSquare className="h-3.5 w-3.5" /> Shell
        </Button>
      </div>
    </div>
  );
}

function BarAction({
  label,
  hint,
  icon,
  busy,
  onClick,
}: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          disabled={busy}
          onClick={onClick}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Connection state, as a dot. Reconnection is automatic, so there is nothing to press — the only
 * thing worth showing is whether bytes are flowing.
 */
function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const spec =
    state === "open"
      ? { className: "bg-emerald-400", label: "connected" }
      : state === "reconnecting"
        ? { className: "bg-amber-400 motion-safe:animate-[vh-pulse_1s_ease-in-out_infinite]", label: "reconnecting" }
        : state === "connecting"
          ? { className: "bg-muted-foreground/60", label: "connecting" }
          : { className: "bg-destructive", label: "disconnected" };
  return (
    <span
      role="status"
      aria-label={`Terminal ${spec.label}`}
      title={`Terminal ${spec.label}`}
      className="inline-flex shrink-0 items-center"
    >
      <span className={cn("inline-block h-2 w-2 rounded-full", spec.className)} />
    </span>
  );
}

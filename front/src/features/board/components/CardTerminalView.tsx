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
import { XTerminal } from "@/features/board/components/XTerminal";
import { VncPanel } from "@/features/board/components/VncPanel";
import { TerminalComposer } from "@/features/board/components/TerminalComposer";
import type { XTerminalHandle } from "@/features/board/components/XTerminal";
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
  defaultAccountLabelOr,
  projectAccountSlug,
  type BoardCard,
  type BoardProject,
} from "@/features/board/api";
import type { CardColumn } from "@/api/types";

/** Small, quiet select in the card bar — configuration, not a call to action. */
const PILL =
  "h-6 max-w-[10rem] shrink-0 truncate rounded-full border border-border/60 bg-muted/40 px-2 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * One card's terminal — the middle column of the board screen, between the card list and nothing.
 *
 * The bar above it is three zones of deliberately different weight: IDENTITY on the left (the dot
 * and the editable title, the only thing in prominent type), ACTIONS grouped in the middle, and
 * CONFIGURATION at the far end in the quietest form the page has — pills and a two-pixel dot. That
 * ordering is the whole design: the title is what you are looking at, the model is not.
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
  onOpenMenu,
}: {
  project: BoardProject;
  cardId: string;
  onBack: () => void;
  /**
   * Accepted so the page can keep passing it, but no longer rendered here: "New card" lives on the
   * board's own chrome and in ⌘K, and a second copy in this footer only competed with Browser and
   * Shell — the two things that belong to THIS card.
   */
  onNewCard?: () => void;
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
  // What the empty option stands for: the project's account if it pins one, otherwise the install's
  // name for the runner's built-in profile.
  const inheritedAccount = projectAccountSlug(project) ?? defaultAccountLabelOr(accountsData?.defaultLabel);

  /* ------------------------------------------------------------------ state */

  const [editingTitle, setEditingTitle] = React.useState<string | null>(null);
  const [shellOpen, setShellOpen] = React.useState(false);
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const termRef = React.useRef<XTerminalHandle | null>(null);
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
   *
   * There is no success toast. The path appearing in the prompt IS the confirmation, and a toast
   * on top of it was two notifications for one event — only "uploading" and a failure say anything
   * the screen does not already show.
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
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* The card bar: identity on the left, actions in the middle, configuration at the far end. */}
      <div
        data-testid="card-bar"
        className="flex min-h-[2.25rem] min-w-0 shrink-0 items-center gap-3 border-b border-border/60 pb-1.5"
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
          {/* Narrow screens only: from `lg` up the board is a permanent column beside this one, so
              a button whose whole job is "go back to it" is a control pointing at what you can see. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-muted-foreground lg:hidden"
            onClick={onBack}
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Board
          </Button>
          {dot ? (
            <span
              role="status"
              aria-label={dot.label}
              title={dot.label}
              className={cn(
                "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
                dot.tone === "ok" ? "bg-emerald-400" : "bg-amber-400",
                dot.live && "dot-live",
              )}
            />
          ) : null}
          {editingTitle !== null ? (
            <input
              aria-label="Card title"
              autoFocus
              // Select-all on focus: renaming almost always means replacing, and having to clear the
              // old title first is a keystroke tax on the common case.
              onFocus={(e) => e.currentTarget.select()}
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                else if (e.key === "Escape") setEditingTitle(null);
              }}
              onBlur={saveTitle}
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-base font-semibold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          ) : (
            <button
              type="button"
              title="Click to rename"
              disabled={!card}
              onClick={() => card && setEditingTitle(card.title)}
              className="min-w-0 truncate rounded px-1 text-left hover:bg-card/60 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <h2 className="truncate text-base font-semibold tracking-tight">
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
                icon={<Pause className="mr-1 h-3.5 w-3.5" />}
                onClick={() => pauseMutation.mutate()}
              />
            ) : null}
            {hasLiveSession ? (
              <BarAction
                label="Restart"
                hint="Kills and recreates the Claude process in the same worktree. The conversation is resumed and MCPs, brain and model are re-read."
                busy={restartMutation.isPending}
                icon={<RotateCw className="mr-1 h-3.5 w-3.5" />}
                onClick={askRestart}
              />
            ) : null}
            {canFinish ? (
              <BarAction
                label="Done"
                hint="Moves the card to Done and returns to the board"
                busy={moveMutation.isPending}
                icon={<Check className="mr-1 h-3.5 w-3.5" />}
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
              {/* No model of its own = whatever the account's plan gives it. The server does not
                  publish which one that is, so the label says what it means rather than guessing. */}
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
              <option value="">{inheritedAccount} (default)</option>
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
        // Terminal LEFT, browser RIGHT, half each. Chromium is landscape and a browser stacked under
        // a terminal wastes the width; on a narrow screen the two stack instead.
        <div
          data-testid="card-workarea"
          className={cn("flex min-h-0 flex-1 flex-col", browserOpen && "lg:flex-row lg:gap-2")}
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <XTerminal
              ref={termRef}
              zoomControl
              wsPath={`/api/cards/${encodeURIComponent(cardId)}/terminal`}
              reconnectKey={reconnectKey}
              onStatus={setConnection}
              onUploadImage={uploadImage}
              ariaLabel={`Terminal for ${card?.title ?? "card"}`}
            />
            {/* Compose here, send when ready — the field accumulates until Enter or Send. */}
            <TerminalComposer
              className="mt-1.5"
              cardId={cardId}
              onSend={(text) => {
                termRef.current?.sendText(text);
                termRef.current?.focus();
              }}
              onUploadImage={uploadImage}
            />
            {shellOpen ? (
              <div className="flex h-[35%] min-h-[180px] shrink-0 flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Shell · bash in the worktree
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground"
                    aria-label="Close shell"
                    title="Close shell"
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
      <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden pt-0.5 font-mono text-xs text-muted-foreground">
        {card ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            card/{cardWorktree(card) ?? ""} · base {card.base} · tmux {cardSession(card) ?? ""}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button
          variant={browserOpen ? "secondary" : "outline"}
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={!showTerminal}
          aria-pressed={browserOpen}
          onClick={() => setBrowserOpen((v) => !v)}
        >
          <MonitorPlay className="mr-1 h-3.5 w-3.5" /> Browser
        </Button>
        <Button
          variant={shellOpen ? "secondary" : "outline"}
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={!showTerminal}
          aria-pressed={shellOpen}
          onClick={() => setShellOpen((v) => !v)}
        >
          <TerminalSquare className="mr-1 h-3.5 w-3.5" /> Shell
        </Button>
      </div>
    </div>
  );
}

/**
 * One action in the bar's middle zone.
 *
 * The explanation is a NATIVE `title`, not a tooltip component: this sits two pixels from a live
 * terminal, and a floating panel that appears on hover is something you dismiss, not something you
 * read. And no spinner — the button is disabled while the request is in flight, which is the same
 * information without the label jumping.
 */
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
    <Button
      variant="ghost"
      size="sm"
      className="h-6 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
      title={hint}
      disabled={busy}
      onClick={onClick}
    >
      {icon}
      {label}
    </Button>
  );
}

/**
 * Connection state, as a dot. Reconnection is automatic, so there is nothing to press — the only
 * thing worth showing is whether bytes are flowing, and the words go in the title where they do not
 * compete with the card's name.
 */
function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const spec =
    state === "open"
      ? { className: "bg-emerald-500", label: "connected" }
      : state === "reconnecting"
        ? { className: "bg-amber-500 dot-live", label: "reconnecting" }
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

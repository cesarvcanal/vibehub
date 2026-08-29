import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Loader2,
  Menu,
  MessageSquare,
  MonitorPlay,
  MoreHorizontal,
  Pause,
  RotateCw,
  TerminalSquare,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth";
import { useIsMobile } from "@/lib/useIsMobile";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { XTerminal } from "@/features/board/components/XTerminal";
import { ChatView } from "@/features/board/components/ChatView";
import { SdkChatView } from "@/features/board/components/SdkChatView";
import { VncPanel } from "@/features/board/components/VncPanel";
import { PreviewMenu } from "@/features/board/components/PreviewMenu";
import { TerminalComposer } from "@/features/board/components/TerminalComposer";
import { CardOutbox } from "@/features/board/components/CardOutbox";
import { nextPosition, statusDot } from "@/features/board/lib/board";
import { boardTitle, useDocumentTitle } from "@/features/board/lib/documentTitle";
import type { ConnectionState } from "@/features/board/lib/reconnect";
import { readCardMode, writeCardMode, type CardViewMode } from "@/features/board/lib/chat";
import {
  ACCOUNTS_KEY,
  ACCOUNT_USAGE_KEY,
  CLAUDE_MODELS,
  DEFAULT_ACCOUNT_SLUG,
  accountInUseSlug,
  UPLOAD_MAX_BYTES,
  accountInUseName,
  accountLabel,
  boardApi,
  cardKey,
  cardMessagesKey,
  cardNeedsOpen,
  cardOpensInstantly,
  cardRunnerHint,
  cardSessionKey,
  cardsKey,
  defaultAccountLabelOr,
  modelInUse,
  projectAccountSlug,
  whitelistModel,
  type BoardCard,
  type BoardProject,
} from "@/features/board/api";
import { AccountUsageBars, useMinuteTick } from "@/features/board/components/AccountUsageBars";
import { pillPercent } from "@/features/board/lib/usage";
import type { CardColumn } from "@/api/types";
import { t as translate, useT } from "@/i18n";

/**
 * Small, quiet pill in the card bar — configuration, not a call to action.
 *
 * These were native `<select>`s. A native menu on macOS opens OVER the control, anchored on the
 * checked row, so clicking a pill at the top of the bar drops a list on top of where you clicked;
 * a menu that opens BELOW the trigger is the whole reason these are Radix menus now.
 */
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
  active = true,
  onBack,
  onOpenMenu,
  onClose,
}: {
  project: BoardProject;
  cardId: string;
  /**
   * Is this the card ON TOP of the deck?
   *
   * Several card views are mounted at once — that is what makes switching cards instant — but only
   * one of them is on screen. Everything that reaches OUT of this component belongs to the visible
   * one alone: the tab title, the phone's scroll lock, the keyboard focus, and the polls that only
   * feed this bar. The websocket is deliberately NOT in that list: keeping the session attached
   * while you are looking at another card is the whole point.
   */
  active?: boolean;
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
  /**
   * This card no longer has a session worth holding open — it was paused from here. The deck drops
   * it, so its socket stops reconnecting into a session that is gone.
   */
  onClose?: () => void;
}) {
  const t = useT();
  // A member has been given this card to work on, not the install around it: the two pills below
  // read the owner's accounts and plan usage, and those routes answer 403 to anybody else.
  const { isOwner } = useAuth();
  const isMobile = useIsMobile();
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
  /**
   * Whether this open has any work to do — decided from the same snapshot, at the same moment, and
   * never revisited: a card that was live when you opened it does not need the runner touched, and
   * an answer that changed its mind two seconds later would fire the call for nothing. See
   * `cardNeedsOpen`.
   */
  const [cachedNeedsOpen] = React.useState(() =>
    cardNeedsOpen(queryClient.getQueryData<BoardCard[]>(boardKey)?.find((c) => c.id === cardId)),
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
      if (instant) toast.error(apiErrorMessage(error, translate("cardView.refreshError")));
    },
  });

  /**
   * The open call, made only when it can change something.
   *
   * It used to run on every mount "to refresh the record". That refresh costs a full provisioning
   * script in the runner, serialized per project — so opening four live cards put four scripts in a
   * queue that the ONE card actually being provisioned then had to wait behind. What the record
   * needs is already true for a card that is open and live, and the terminal's own websocket
   * provisions by itself if the session turns out to be gone.
   */
  const needsOpen = cacheMiss ? cardNeedsOpen(fetchedCard) : cachedNeedsOpen;
  const open = openMutation.mutate;
  const asked = React.useRef(false);
  React.useEffect(() => {
    if (asked.current) return;
    // A deep link has to wait for the record before it can tell — `undecided` is that wait.
    if (cacheMiss && fetchingCard) return;
    asked.current = true;
    if (!needsOpen) return;
    open();
  }, [open, needsOpen, cacheMiss, fetchingCard]);

  const card: BoardCard | null =
    cards?.find((c) => c.id === cardId) ?? openMutation.data ?? fetchedCard ?? null;

  /**
   * The card was DELETED — from the board, the sidebar, another tab.
   *
   * A pane in the deck outlives the screen that opened it, so it has to notice this itself:
   * otherwise a terminal nobody can see keeps reconnecting to a session that was destroyed with the
   * worktree. Guarded by "we saw it in the list at least once", because a card created a moment ago
   * is legitimately missing from a list that has not refetched yet — closing on that would fight
   * the navigation that just opened it.
   */
  const seenInList = React.useRef(false);
  const goneRef = React.useRef({ onBack, onClose });
  goneRef.current = { onBack, onClose };
  const present = cards?.some((c) => c.id === cardId);
  React.useEffect(() => {
    if (present === undefined) return;
    if (present) {
      seenInList.current = true;
      return;
    }
    if (!seenInList.current) return;
    goneRef.current.onBack();
    goneRef.current.onClose?.();
  }, [present]);

  // Only the visible card names the tab; the panes behind it are not what you are looking at.
  useDocumentTitle(boardTitle(project.name, card?.title), active);

  /* ------------------------------------------------------------- mutations */

  const titleMutation = useMutation({
    mutationFn: (title: string) => boardApi.patchCard(cardId, { title }),
    onSuccess: mirror,
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardRenameError"))),
  });

  /** Native chat (beta) opt-in — per card, so one guinea-pig card can try the SDK driver alone. */
  const sdkChatMutation = useMutation({
    mutationFn: (sdkChat: boolean) => boardApi.patchCard(cardId, { sdkChat }),
    onSuccess: mirror,
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const pauseMutation = useMutation({
    mutationFn: () => boardApi.pauseCard(cardId),
    onSuccess: (updated) => {
      mirror(updated);
      toast.success(translate("toast.cardPaused"));
      onBack();
      // Pausing ENDS the session in the runner. Staying in the deck would leave a socket retrying
      // against nothing, so the pane goes with it.
      onClose?.();
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardPauseError"))),
  });

  const moveMutation = useMutation({
    mutationFn: (patch: { column: CardColumn; position: number }) => boardApi.patchCard(cardId, patch),
    onSuccess: mirror,
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.cardMoveError"))),
  });

  const [reconnectNonce, setReconnectNonce] = React.useState(0);
  const restartMutation = useMutation({
    mutationFn: () => boardApi.restartCard(cardId),
    onSuccess: (updated) => {
      mirror(updated);
      // Only bump AFTER the server confirms, so the reattach cannot race the session being killed.
      setReconnectNonce((n) => n + 1);
      toast.success(translate("cardView.restarting"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("cardView.restartError"))),
  });

  const accountMutation = useMutation({
    mutationFn: (accountSlug: string | null) => boardApi.patchCardSession(cardId, { accountSlug }),
    onSuccess: ({ card: updated, session: change }) => {
      mirror(updated);
      // The pill shows what is in USE, so it has to re-read the session the switch just changed.
      void queryClient.invalidateQueries({ queryKey: cardSessionKey(updated.id) });
      // Same as the model: the profile is chosen when Claude starts, so a live session has to be
      // restarted for the switch to be real — or flagged, when Claude is mid-task.
      if (change === "restarted") setReconnectNonce((n) => n + 1);
      toast.success(
        translate(change === "pending" ? "cardView.accountSwitchPending" : "cardView.accountSwitched"),
      );
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("cardView.accountSwitchError"))),
  });

  const modelMutation = useMutation({
    mutationFn: (model: string | null) => boardApi.patchCardSession(cardId, { model }),
    onSuccess: ({ card: updated, session: change }) => {
      mirror(updated);
      void queryClient.invalidateQueries({ queryKey: cardSessionKey(updated.id) });
      const label =
        CLAUDE_MODELS.find((m) => m.id === updated.model)?.label ?? translate("cardView.accountDefault");
      // The model only reaches Claude when the process STARTS, so the message follows what the
      // server actually did with the session — it used to promise a switch that never happened.
      if (change === "restarted") setReconnectNonce((n) => n + 1);
      toast.success(
        translate(
          change === "pending" ? "cardView.modelSwitchPending" : "cardView.modelSwitched",
          { label },
        ),
      );
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("cardView.modelSwitchError"))),
  });

  /**
   * What the session is REALLY running. Polled while the card is open, because the model can change
   * underneath us — the first reply is what reveals it, and `/model` inside the terminal changes it
   * without anything on this screen being touched. A server that does not offer the route yet
   * simply leaves the pills on their fallbacks, so this never retries into a wall.
   */
  const { data: session } = useQuery({
    queryKey: cardSessionKey(cardId),
    queryFn: () => boardApi.cardSessionInfo(cardId),
    // Only while this card is the one on screen: the pills it feeds are in THIS bar, and a deck of
    // six hidden cards each polling every five seconds is traffic nobody can see the result of.
    refetchInterval: active ? 5_000 : false,
    enabled: active,
    retry: false,
  });

  // The install's Claude accounts are the OWNER's: which profile a card runs on, and how much of
  // whose plan is left, is their business and their route (403 for anybody else). A member
  // working on a card they were given simply does not get the two pills.
  const { data: accountsData } = useQuery({
    queryKey: ACCOUNTS_KEY, queryFn: boardApi.listAccounts, enabled: isOwner,
  });
  const accounts = accountsData?.accounts ?? [];
  // What the empty option stands for: the project's account if it pins one, otherwise the install's
  // name for the runner's built-in profile.
  const inheritedAccount = projectAccountSlug(project) ?? defaultAccountLabelOr(accountsData?.defaultLabel);

  // The two pills answer "what am I talking to", never "what was typed into this card".
  const model = modelInUse(card, session);
  // Which ROW of the menu the model in use belongs to — by family, so the alias settings.json keeps
  // ("opus") and a dated transcript id both tick the whitelisted row instead of growing a second one.
  const modelRow = whitelistModel(model.id);
  const modelUnlisted = !modelRow;
  const accountName = accountInUseName(card, session, accounts, inheritedAccount);
  const defaultAccountName = defaultAccountLabelOr(accountsData?.defaultLabel);

  /**
   * PLAN USAGE, polled while a card is open. This is the number that decides whether opening a card
   * on this account is a good idea, and the owner hit a limit precisely because it lived nowhere.
   * 60s, matching the server's cache: the usage endpoint throttles by caller, so a tighter poll
   * would only earn a back-off.
   */
  const { data: usageData } = useQuery({
    queryKey: ACCOUNT_USAGE_KEY,
    queryFn: boardApi.accountsUsage,
    enabled: Boolean(card) && active && isOwner,
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: false,
  });
  const usageBySlug = usageData?.bySlug ?? {};
  const inUseSlug = accountInUseSlug(card, session, projectAccountSlug(project));
  const inUseUsage = usageBySlug[inUseSlug];
  const usagePercent = pillPercent(inUseUsage);
  const now = useMinuteTick();

  /** The percentage of ONE account, for the menu rows — absent when that account has no numbers. */
  const menuPercent = (slug: string) => pillPercent(usageBySlug[slug]);

  /* ------------------------------------------------------------------ state */

  const [editingTitle, setEditingTitle] = React.useState<string | null>(null);
  const [shellOpen, setShellOpen] = React.useState(false);
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const [connection, setConnection] = React.useState<ConnectionState>("connecting");

  /**
   * TERMINAL or CHAT — the same session, rendered two ways, and the choice is the person's on every
   * screen rather than something guessed from the width. It is remembered per card and per device
   * (see `lib/chat.ts`): a phone can live in chat while the desktop stays on the terminal.
   *
   * Switching to chat UNMOUNTS the terminal, which closes its websocket. That is the point: an idle
   * TUI still repaints, and a card left in chat stops paying for frames nobody is reading.
   */
  const [mode, setMode] = React.useState<CardViewMode>(() => readCardMode(cardId));
  React.useEffect(() => setMode(readCardMode(cardId)), [cardId]);
  const switchMode = React.useCallback(
    (next: CardViewMode) => {
      setMode(next);
      writeCardMode(cardId, next);
      // The indicator belongs to whichever socket is mounted; the new one has not connected yet.
      setConnection("connecting");
    },
    [cardId],
  );

  const dot = statusDot(card?.status);
  /**
   * Is the agent's turn running? The card record answers on a desktop, where the sidebar polls the
   * board; on a phone the sidebar is not mounted, so the session poll (every 5s, already running
   * for the pills) is what keeps this true.
   */
  const working = session?.situation === "working" || card?.status === "working";
  // Claude EXITED and left a bare shell (server probed the tree). The card still looks "open", so
  // without this it is a mute terminal that silently queues whatever you type — J. The banner turns
  // that into "Claude parou — Reiniciar".
  const stopped = session?.situation === "stopped";
  const hasLiveSession = Boolean(card?.openedAt && !card.pausedAt);
  const canFinish = Boolean(card && card.column !== "done");
  const showTerminal = instant || openMutation.isSuccess;

  /**
   * Changing the account or the model ends the session server-side (applySessionChange); changing
   * this key makes the terminal drop and reattach, which recreates it with the new environment in
   * the SAME conversation. The nonce covers the rest: an explicit restart, and a switch on a card
   * whose pin already had that value in the key.
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
    toast.success(translate("toast.cardFinishedShort", { title: target.title }), {
      action: { label: translate("common.undo"), onClick: () => moveMutation.mutate(previous) },
    });
    onBack();
  }

  function askRestart() {
    if (
      card?.status === "working" &&
      !window.confirm(translate("confirm.restartWorkingAgent"))
    ) {
      return;
    }
    restartMutation.mutate();
  }

  /**
   * Uploads an image so the agent can read it, and answers with its path inside the runner — the
   * only form Claude can open, since uploads land outside the card's worktree.
   *
   * `progress` decides whether the WAIT is announced, and that is the whole difference between the
   * two call sites: the composer already draws a spinner over the thumbnail it just showed you, so
   * a toast there is a second notification for one event. A drop on the raw terminal has no such
   * picture, and needs the toast. A failure always speaks.
   */
  const uploadImageWith = React.useCallback(
    async (file: File, progress: boolean): Promise<string | null> => {
      if (!file.type.startsWith("image/")) return null;
      if (file.size > UPLOAD_MAX_BYTES) {
        toast.error(translate("cardView.imageTooBig"));
        return null;
      }
      const pending = progress ? toast.loading(translate("cardView.uploadingImage")) : null;
      try {
        const { path } = await boardApi.uploadCardImage(cardId, file);
        return path;
      } catch (error) {
        toast.error(apiErrorMessage(error, translate("cardView.uploadError")));
        return null;
      } finally {
        if (pending !== null) toast.dismiss(pending);
      }
    },
    [cardId],
  );

  /** Dropped on the terminal: the path is typed at the prompt, and the wait gets a toast. */
  const uploadImage = React.useCallback(
    (file: File) => uploadImageWith(file, true),
    [uploadImageWith],
  );

  /** Pasted into the composer: the thumbnail and its spinner are the whole story already. */
  const uploadAttachment = React.useCallback(
    (file: File) => uploadImageWith(file, false),
    [uploadImageWith],
  );

  /**
   * ENTER in the composer. The message does NOT go down the websocket any more: it is handed to the
   * card's outbox on the server, which delivers it to a RUNNING Claude or holds it until there is
   * one. A terminal socket types into whatever the pane happens to be — including the bare shell a
   * card falls back to when Claude exits, where the message is executed and lost.
   *
   * Throwing matters: the composer keeps the text in the field when this rejects.
   */
  const sendMessage = React.useCallback(
    async (text: string) => {
      try {
        const result = await boardApi.sendCardMessage(cardId, text);
        queryClient.setQueryData(cardMessagesKey(cardId), {
          pending: result.pending,
          agent: result.agent,
        });
      } catch (error) {
        toast.error(apiErrorMessage(error, translate("outbox.sendError")));
        throw error;
      }
    },
    [cardId, queryClient],
  );

  /**
   * A phone opens this screen as a FIXED page: the document must not scroll, because the thing that
   * should scroll is the terminal's own viewport, and a scrollable document steals the touch. The
   * class goes on `<html>` while the card is open and comes off when it closes or the window grows.
   */
  React.useEffect(() => {
    if (!active || !isMobile || typeof document === "undefined") return;
    const root = document.documentElement;
    root.classList.add("card-view-locked");
    return () => root.classList.remove("card-view-locked");
  }, [active, isMobile]);

  /**
   * TERMINAL | CHAT. The one control that is the same on a phone and on a desktop, in the same
   * place, because it is the control you reach for precisely when the terminal is not behaving —
   * and something you have to open a menu to find is not there when you need it. It never goes
   * behind the `⋯`, and it is never decided for you by the width of the screen.
   */
  const viewSwitch = (
    <div
      role="group"
      data-testid="card-view-switch"
      aria-label={t("cardView.viewMode")}
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/50 bg-card/40 p-0.5"
    >
      <ModeButton
        mode="terminal"
        current={mode}
        label={t("cardView.viewTerminal")}
        icon={<TerminalSquare className="h-3.5 w-3.5" />}
        compact={isMobile}
        onSelect={switchMode}
      />
      <ModeButton
        mode="chat"
        current={mode}
        label={t("cardView.viewChat")}
        icon={<MessageSquare className="h-3.5 w-3.5" />}
        compact={isMobile}
        onSelect={switchMode}
      />
    </div>
  );

  /** The model rows, shared by the desktop pill and the phone's overflow menu. */
  const modelItems = (
    <>
                {/* The FIXED list, always in the same order with the same labels. The trigger is
                    where "what am I talking to" is answered; a menu whose rows are recomputed from
                    the live session shuffles its own labels while you read it. */}
                {CLAUDE_MODELS.map((m) => (
                  <DropdownMenuCheckboxItem
                    key={m.id}
                    checked={modelRow?.id === m.id}
                    onSelect={() => modelMutation.mutate(m.id)}
                  >
                    {m.label}
                  </DropdownMenuCheckboxItem>
                ))}
                {/* A model the whitelist has never heard of — the transcript is still the truth. */}
                {modelUnlisted ? (
                  <DropdownMenuCheckboxItem checked onSelect={() => modelMutation.mutate(model.id)}>
                    {model.label}
                  </DropdownMenuCheckboxItem>
                ) : null}
                <DropdownMenuSeparator />
                {/* The only row that is not a model, and the only one that is an ACTION rather than
                    a state: it clears the card's pin and lets the account decide again. A check
                    here would compete with the one marking the model actually in use. */}
                <DropdownMenuItem onSelect={() => modelMutation.mutate(null)}>
                  {t("cardView.useAccountDefault")}
                </DropdownMenuItem>
    </>
  );

  /** The account rows, likewise shared. */
  const accountItems = (
    <>
                {/* EXPLICIT rows, one per account, each under its OWN name — the bug this replaces
                    labelled the first row with whatever account was IN USE, so picking "tech" made
                    the menu show "default" and picking default renamed it to "tech". The built-in
                    profile is first, under the install's name for it; choosing it clears the pin.
                    The check follows the EFFECTIVE account (card → project → built-in), which is
                    the one the session is really signed in to. */}
                <DropdownMenuCheckboxItem
                  checked={inUseSlug === DEFAULT_ACCOUNT_SLUG}
                  onSelect={() => accountMutation.mutate(null)}
                >
                  <span className="truncate">{defaultAccountName}</span>
                  {menuPercent(DEFAULT_ACCOUNT_SLUG) ? (
                    <span className="ml-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {menuPercent(DEFAULT_ACCOUNT_SLUG)}
                    </span>
                  ) : null}
                </DropdownMenuCheckboxItem>
                {accounts.map((a) => (
                  <DropdownMenuCheckboxItem
                    key={a.slug}
                    checked={inUseSlug === a.slug}
                    onSelect={() => accountMutation.mutate(a.slug)}
                  >
                    <span className="truncate">{accountLabel(a)}</span>
                    {menuPercent(a.slug) ? (
                      <span className="ml-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {menuPercent(a.slug)}
                      </span>
                    ) : null}
                  </DropdownMenuCheckboxItem>
                ))}
    </>
  );

  /**
   * IDENTITY: back, the menu handle, the status dot, the title, the project. What this screen IS.
   *
   * The back arrow is the first thing in the bar on EVERY width. On a phone the only other way out
   * was opening the drawer and tapping the card you are already looking at; on a desktop the board
   * is beside you, but an arrow where every other app puts one costs nothing and the Escape
   * shortcut is unchanged.
   */
  const identity = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            data-testid="card-back"
            className="h-9 w-9 shrink-0 text-muted-foreground md:h-7 md:w-7"
            aria-label={t("cardView.back")}
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("cardView.back")}</TooltipContent>
      </Tooltip>
      {onOpenMenu ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 text-muted-foreground md:h-7 md:w-7 lg:hidden"
          aria-label={t("cardView.openCardList")}
          onClick={onOpenMenu}
        >
          <Menu className="h-4 w-4" />
        </Button>
      ) : null}
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
              aria-label={t("cardView.cardTitle")}
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
              title={
                card ? `${t("cardView.clickToRename")}\n${cardRunnerHint(card)}` : t("cardView.clickToRename")
              }
              disabled={!card}
              onClick={() => card && setEditingTitle(card.title)}
              className="min-w-0 truncate rounded px-1 text-left hover:bg-card/60 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <h2 className="truncate text-base font-semibold tracking-tight">
                {card?.title ?? t("cardView.opening")}
              </h2>
            </button>
          )}
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground/80 md:inline md:shrink-0">
        · {project.name}
      </span>
    </>
  );

  /**
   * ACTIONS and CONFIGURATION: what you can DO to this card, then what it is talking to.
   *
   * One row on a desktop, and on a phone the second row — a strip that scrolls sideways. Nothing
   * wraps and nothing is absolutely positioned, which is the whole fix: the old single row put
   * Pause, Board, Restart and the project name on top of each other at 390px.
   */
  const actions = (
    <>
        {viewSwitch}
        {hasLiveSession || canFinish ? (
          <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/50 bg-card/40 p-0.5">
            {hasLiveSession ? (
              <BarAction
                label={t("cardView.pause")}
                hint={t("cardView.pauseHint")}
                busy={pauseMutation.isPending}
                icon={<Pause className="mr-1 h-3.5 w-3.5" />}
                onClick={() => pauseMutation.mutate()}
              />
            ) : null}
            {hasLiveSession ? (
              <BarAction
                label={t("cardView.restart")}
                hint={t("cardView.restartHint")}
                busy={restartMutation.isPending}
                icon={<RotateCw className="mr-1 h-3.5 w-3.5" />}
                onClick={askRestart}
              />
            ) : null}
            {canFinish ? (
              <BarAction
                label={t("cardView.done")}
                hint={t("cardView.doneHint")}
                busy={moveMutation.isPending}
                icon={<Check className="mr-1 h-3.5 w-3.5" />}
                onClick={() => card && finish(card)}
              />
            ) : null}
          </div>
        ) : null}

        <div className="flex shrink-0 items-center gap-1.5">
          {/* The two extra panes of THIS card. They were a footer row; a footer row costs a line of
              terminal, and these are configuration-weight controls that belong beside the pills. */}
          <PreviewMenu disabled={!showTerminal} />
          <PaneToggle
            label={t("cardView.browser")}
            open={browserOpen}
            disabled={!showTerminal}
            icon={<MonitorPlay className="h-3.5 w-3.5" />}
            onClick={() => setBrowserOpen((v) => !v)}
            hint={t("cardView.browserHint")}
          />
          <PaneToggle
            label={t("cardView.shell")}
            open={shellOpen}
            disabled={!showTerminal}
            icon={<TerminalSquare className="h-3.5 w-3.5" />}
            onClick={() => setShellOpen((v) => !v)}
          />
          {card ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("cardView.model")}
                  title={model.title ?? t("cardView.modelInUse")}
                  className={PILL}
                  disabled={modelMutation.isPending}
                >
                  {model.label}
                </button>
              </DropdownMenuTrigger>
              {/* Below the trigger, aligned to its right edge — never over the thing you clicked. */}
              <DropdownMenuContent side="bottom" align="end">
                {modelItems}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {card ? (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("cardView.claudeAccount")}
                      className={PILL}
                      disabled={accountMutation.isPending}
                    >
                      {/* The pill names the account that is SIGNED IN, plus how much of its 5-hour
                          window is gone — the one number that stops a card mid-turn. */}
                      {accountName}
                      {usagePercent ? (
                        <span className="ml-1 font-mono tabular-nums opacity-70">· {usagePercent}</span>
                      ) : null}
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[15rem] space-y-1.5">
                  <p className="text-[11px] font-medium">{t("usage.title", { name: accountName })}</p>
                  <AccountUsageBars slug={inUseSlug} usage={inUseUsage} now={now} />
                  <p className="text-[10px] text-muted-foreground">{t("cardView.switchAccountHint")}</p>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent side="bottom" align="end">
                {accountItems}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {showTerminal ? <ConnectionIndicator state={connection} /> : null}
        </div>
    </>
  );

  /**
   * The PHONE's second row.
   *
   * The first attempt was the desktop's controls in a strip that scrolled sideways, and the owner's
   * verdict was the right one: a row you have to scroll to find a button in is not simpler than a
   * row that overlaps, it is just quieter about it. So the three things you actually press mid-task
   * — pause, restart, done — are icons at full size, and everything that is CONFIGURATION goes
   * behind one `⋯`. Nothing scrolls, nothing wraps, nothing is hidden off the edge.
   */
  const mobileActions = (
    <div data-testid="card-bar-actions" className="flex min-w-0 items-center gap-1.5">
      {viewSwitch}
      {hasLiveSession ? (
        <IconAction
          label={t("cardView.pause")}
          hint={t("cardView.pauseHint")}
          busy={pauseMutation.isPending}
          icon={<Pause className="h-4 w-4" />}
          onClick={() => pauseMutation.mutate()}
        />
      ) : null}
      {hasLiveSession ? (
        <IconAction
          label={t("cardView.restart")}
          hint={t("cardView.restartHint")}
          busy={restartMutation.isPending}
          icon={<RotateCw className="h-4 w-4" />}
          onClick={askRestart}
        />
      ) : null}
      {canFinish ? (
        <IconAction
          label={t("cardView.done")}
          hint={t("cardView.doneHint")}
          busy={moveMutation.isPending}
          icon={<Check className="h-4 w-4" />}
          onClick={() => card && finish(card)}
        />
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {showTerminal ? <ConnectionIndicator state={connection} /> : null}
        <PreviewMenu compact disabled={!showTerminal} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-testid="card-bar-more"
              aria-label={t("cardView.more")}
              title={t("cardView.more")}
              className="h-9 w-9 shrink-0 rounded-md border border-border/50 bg-card/40 text-muted-foreground"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" className="max-h-[70vh] overflow-y-auto">
            <DropdownMenuCheckboxItem
              checked={browserOpen}
              disabled={!showTerminal}
              onSelect={() => setBrowserOpen((v) => !v)}
            >
              {t("cardView.browser")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={shellOpen}
              disabled={!showTerminal}
              onSelect={() => setShellOpen((v) => !v)}
            >
              {t("cardView.shell")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              data-testid="card-native-chat-toggle"
              checked={Boolean(card?.sdkChat)}
              disabled={!card || sdkChatMutation.isPending}
              onSelect={() => card && sdkChatMutation.mutate(!card.sdkChat)}
            >
              {t("cardView.nativeChat")}
            </DropdownMenuCheckboxItem>
            {card ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("cardView.model")}</DropdownMenuLabel>
                {modelItems}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("cardView.claudeAccount")}</DropdownMenuLabel>
                {accountItems}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* The card bar. One row from `md` up; two rows on a phone, where one row overlapped itself. */}
      {isMobile ? (
        <div
          data-testid="card-bar"
          className="flex min-w-0 shrink-0 flex-col gap-1.5 border-b border-border/60 pb-1.5"
        >
          <div data-testid="card-bar-identity" className="flex min-w-0 items-center gap-2">
            {identity}
          </div>
          {mobileActions}
        </div>
      ) : (
        <div
          data-testid="card-bar"
          className="flex min-h-[2.25rem] min-w-0 shrink-0 items-center gap-3 border-b border-border/60 pb-1.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">{identity}</div>
          {actions}
        </div>
      )}

      {/* Claude exited to a bare shell — say so loudly, above whichever pane is on screen, and offer
          the one thing that helps: restart, which resumes the SAME conversation (`claude -c`). */}
      {stopped ? (
        <div
          data-testid="claude-stopped-banner"
          role="status"
          className="mt-1.5 flex shrink-0 items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <span className="font-medium">{t("cardView.claudeStopped")}</span>
            <span className="ml-1 opacity-80">{t("cardView.claudeStoppedHint")}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1.5 border-amber-500/50 hover:bg-amber-500/20"
            disabled={restartMutation.isPending}
            onClick={() => restartMutation.mutate()}
          >
            {restartMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
            {t("cardView.restart")}
          </Button>
        </div>
      ) : null}

      {/* Body */}
      {!instant && openMutation.isError ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-2">
            <p>{apiErrorMessage(openMutation.error, t("cardView.prepareError"))}</p>
            <Button size="sm" variant="outline" onClick={() => openMutation.mutate()}>
              {t("common.tryAgain")}
            </Button>
          </div>
        </div>
      ) : undecided ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("cardView.loadingCard")}
        </div>
      ) : !showTerminal ? (
        // A card that is still cloning has no terminal to type into — but it is EXACTLY the moment
        // someone wants to say what the card is for. The composer is here, and what it sends goes
        // to the outbox: queued now, delivered the instant Claude is up. The wait costs nothing.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("cardView.preparing")}
            </div>
            <p className="max-w-md text-center text-xs opacity-70">
              {t("cardView.firstCardNote")}
            </p>
          </div>
          <CardOutbox cardId={cardId} />
          <TerminalComposer
            className="mt-1.5"
            cardId={cardId}
            active={active}
            onSend={sendMessage}
            onUploadImage={uploadAttachment}
          />
        </div>
      ) : (
        // Terminal LEFT, browser RIGHT, half each. Chromium is landscape and a browser stacked under
        // a terminal wastes the width; on a narrow screen the two stack instead.
        <div
          data-testid="card-workarea"
          className={cn("flex min-h-0 flex-1 flex-col", browserOpen && "lg:flex-row lg:gap-2")}
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {mode === "chat" && card?.sdkChat ? (
              /* NATIVE CHAT (beta): the Agent SDK driver socket — structured events, permission
                 buttons in the chat. Per-card opt-in; the global sdkDriver setting still gates the
                 server side, and with it off this view says so. */
              <SdkChatView
                cardId={cardId}
                active={active}
                onUploadImage={uploadImage}
                onStatus={setConnection}
                ariaLabel={t("chat.ariaFor", { title: card?.title ?? t("cardView.cardFallback") })}
              />
            ) : mode === "chat" ? (
              /* The SAME session, read from its transcript. No terminal websocket while this is up. */
              <ChatView
                cardId={cardId}
                active={active}
                working={working}
                onUploadImage={uploadImage}
                onStatus={setConnection}
                onOpenTerminal={() => switchMode("terminal")}
                ariaLabel={t("chat.ariaFor", { title: card?.title ?? t("cardView.cardFallback") })}
              />
            ) : (
              <>
                <XTerminal
                  zoomControl
                  wsPath={`/api/cards/${encodeURIComponent(cardId)}/terminal`}
                  reconnectKey={reconnectKey}
                  onStatus={setConnection}
                  onUploadImage={uploadImage}
                  /* The COMPOSER is where a card is written from. A terminal that grabs the keyboard on
                     every open (and every reconnect) puts the caret in the raw session, which is how a
                     first message ends up typed into xterm instead of the field below. Clicking the
                     terminal still focuses it — that is the deliberate way in. */
                  autoFocus={false}
                  ariaLabel={t("cardView.terminalFor", { title: card?.title ?? t("cardView.cardFallback") })}
                />
                {/* Anything composed that has not reached the agent yet — usually nothing at all. */}
                <CardOutbox cardId={cardId} />
                {/* Compose here, send when ready — the field accumulates until Enter. */}
                <TerminalComposer
                  className="mt-1.5"
                  cardId={cardId}
                  active={active}
                  onSend={sendMessage}
                  onUploadImage={uploadAttachment}
                />
              </>
            )}
            {shellOpen ? (
              <div className="flex h-[35%] min-h-[180px] shrink-0 flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {t("cardView.shellHeader")}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground"
                    aria-label={t("cardView.closeShell")}
                    title={t("cardView.closeShell")}
                    onClick={() => setShellOpen(false)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {/* A separate tmux session on the server; closing this pane only drops the socket.
                    It takes the keyboard when it opens — that is what a shell you just asked for
                    should do — but only while this card is the one on screen: a pane in the deck
                    that reconnects behind your back must not pull the caret out of the card you are
                    reading. */}
                <XTerminal
                  autoFocus={active}
                  wsPath={`/api/cards/${encodeURIComponent(cardId)}/terminal?shell=1`}
                  ariaLabel={t("cardView.shellAria")}
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

    </div>
  );
}

/**
 * One half of the Terminal | Chat switch: pressed or not, never disabled.
 *
 * Deliberately usable before the session is ready. The two panes are two ways of reading the same
 * card, and a switch that greys out while a card is opening is a switch you cannot pre-set — which
 * matters most on the slow open that made you want the chat in the first place.
 */
function ModeButton({
  mode,
  current,
  label,
  icon,
  compact,
  onSelect,
}: {
  mode: CardViewMode;
  current: CardViewMode;
  label: string;
  icon: React.ReactNode;
  compact?: boolean;
  onSelect: (mode: CardViewMode) => void;
}) {
  const active = current === mode;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={label}
      title={label}
      data-testid={`card-view-${mode}`}
      onClick={() => onSelect(mode)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        compact ? "h-8" : "h-6",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {compact ? null : label}
    </button>
  );
}

/**
 * Browser / Shell in the card bar: an icon and a word, pressed or not.
 *
 * Deliberately the same quiet weight as the pills next to it. These open a pane; they are not the
 * thing you came here to do, and the terminal below is.
 */
function PaneToggle({
  label,
  open,
  disabled,
  icon,
  onClick,
  hint,
}: {
  label: string;
  open: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  onClick: () => void;
  /** Extra tooltip shown when the pane is CLOSED (e.g. "this card can drive a browser"). */
  hint?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={open}
      disabled={disabled}
      onClick={onClick}
          title={
        open
          ? translate("cardView.closePane", { label: label.toLowerCase() })
          : hint ?? translate("cardView.openPane", { label: label.toLowerCase() })
      }
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        open
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-border/60 bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * One action in the PHONE's row: the icon, at a size a thumb can hit, and the word in the label
 * rather than beside it. Three of these fit a 390px screen with room for the overflow menu; three
 * labelled buttons did not, which is how they ended up on top of each other.
 */
function IconAction({
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
      size="icon"
      aria-label={label}
      title={hint}
      className="h-9 w-9 shrink-0 rounded-md border border-border/50 bg-card/40 text-muted-foreground"
      disabled={busy}
      onClick={onClick}
    >
      {icon}
    </Button>
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
  const t = useT();
  const spec =
    state === "open"
      ? { className: "bg-emerald-500", label: t("conn.connected") }
      : state === "reconnecting"
        ? { className: "bg-amber-500 dot-live", label: t("conn.reconnecting") }
        : state === "connecting"
          ? { className: "bg-muted-foreground/60", label: t("conn.connecting") }
          : { className: "bg-destructive", label: t("conn.disconnected") };
  const label = t("cardView.terminalState", { state: spec.label });
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center"
    >
      <span className={cn("inline-block h-2 w-2 rounded-full", spec.className)} />
    </span>
  );
}

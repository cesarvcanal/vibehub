import { hostExecutor, shQuote } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import {
  getCard,
  removeCardPreview,
  assertPreviewPort,
  normalizePreviewCommand,
  normalizePreviewCwd,
  type Card,
  type CardPreview,
} from "../board/registry.js";
import { buildKillSessionScript } from "../board/workspace.js";
import { previewPublicUrl, scanListeningPorts } from "./announce.js";
import { logger } from "../../utils/logger.js";

/**
 * PREVIEW LIFECYCLE — a registered preview outlives the card session that started it.
 *
 * The problem: an agent starts a dev server INSIDE its card's tmux pane, so the server is a
 * descendant of that pane — and every path that ends the card session (pause, hibernate, restart,
 * model switch) tree-kills the pane's descendants (workspace.buildKillSessionScript, the fix for
 * the orphaned-claude leak). The preview dies with the card, and the chip becomes a dead link.
 *
 * The answer: the preview gets its OWN home. `vibehub_preview` persists the START COMMAND and cwd
 * on the card, and when the server is (re)launched by vibehub it runs in a dedicated tmux session
 * — `preview-<card8>-<port>` — that is:
 *
 *  - OUTSIDE the card pane's process tree, so killing/pausing/restarting the card never touches it;
 *  - invisible to the runner reaper (it only kills ppid-1 claude processes and transcript
 *    watchers; a server under a live tmux session is neither);
 *  - addressable, so "Parar preview" can tree-kill exactly this server and nothing else.
 *
 * The agent's ORIGINAL process (in the card pane) is left where it is — adopting it would mean
 * re-parenting a live process, which Linux does not offer. Adoption happens at the first RESTART:
 * from then on the server lives in the preview session.
 */

/** How long a relaunch may take to start listening before the restart reports failure. */
export const RESTART_TIMEOUT_MS = 25_000;

/** How often the relaunch polls the port scan while waiting. */
export const RESTART_POLL_MS = 1_500;

const SESSION_CARD_RE = /^[0-9a-f-]{8}/i;

/**
 * The preview's dedicated tmux session: `preview-<first 8 of the card id>-<port>`. DERIVED — both
 * pieces are validated, so the name is always shell-safe, and the `preview-` prefix keeps it out
 * of the card session namespace (`card-<8>`), which the card kill paths address. PURE.
 */
export function previewSessionFor(cardId: string, port: number): string {
  const head = String(cardId ?? "").slice(0, 8);
  if (!SESSION_CARD_RE.test(head)) throw new Error(`invalid card id for a preview session: '${cardId}'`);
  return `preview-${head.toLowerCase()}-${assertPreviewPort(port)}`;
}

/**
 * Script that (re)launches a preview server in its dedicated tmux session: any previous instance
 * of the session dies first (a relaunch is a replace, and a half-dead server holding the port is
 * exactly what the user is trying to fix), then a fresh detached session runs the command in its
 * cwd through `bash -lc` (login shell — nvm/PATH setups apply, same as a person typing it). The
 * command and cwd are normalized by the registry before they get here; both are shell-quoted on
 * top of that. PURE.
 */
export function buildPreviewStartScript(container: string, session: string, cwd: string, command: string): string {
  const cleanCwd = normalizePreviewCwd(cwd);
  const cleanCommand = normalizePreviewCommand(command);
  if (!cleanCwd || !cleanCommand) throw new Error("a preview relaunch needs both a command and a cwd");
  const inner =
    `tmux kill-session -t ${shQuote(session)} 2>/dev/null || true; ` +
    `tmux new-session -d -s ${shQuote(session)} -c ${shQuote(cleanCwd)} bash -lc ${shQuote(cleanCommand)}`;
  return `docker exec ${shQuote(container)} bash -c ${shQuote(inner)}`;
}

/** Read-only: the last lines of the preview session's pane — what the server said before dying. PURE. */
export function buildCapturePaneScript(container: string, session: string): string {
  const inner = `tmux capture-pane -p -t ${shQuote(session)} 2>/dev/null | tail -n 15 || true`;
  return `docker exec ${shQuote(container)} bash -c ${shQuote(inner)}`;
}

/** The card and the registered preview, or the two distinct errors a caller must tell apart. */
async function requirePreview(cardId: string, port: number): Promise<{ card: Card; preview: CardPreview }> {
  const p = assertPreviewPort(port);
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const preview = (card.previews ?? []).find((v) => v.port === p);
  if (!preview) throw new Error(`no preview registered on port ${p} for this card`);
  return { card, preview };
}

export interface RestartedPreview {
  restarted: true;
  port: number;
  /** Same-origin path the tab opens (`/preview/<port>/`). */
  path: string;
  /** Full public URL, for completeness (the front uses `path` — same origin). */
  url: string;
}

/**
 * Relaunches a registered preview in its dedicated session and waits until the port LISTENS.
 *
 * Refuses (with the message the UI shows verbatim) when the preview has no stored command — an
 * old/manual registration has no relaunch recipe, and the honest answer is "ask the card's agent
 * to start it again". A relaunch that never starts listening within the timeout fails with the
 * pane's last lines, so the user sees WHY (`npm ERR`, a crash) instead of a bare timeout.
 */
export async function restartPreview(cardId: string, port: number): Promise<RestartedPreview> {
  const { card, preview } = await requirePreview(cardId, port);
  if (!preview.command || !preview.cwd) {
    throw new Error(
      "this preview has no stored start command — ask the card's agent to start the server again " +
        "(it will re-announce it with vibehub_preview)",
    );
  }
  const container = config.runner.container;
  const session = previewSessionFor(card.id, preview.port);
  await hostExecutor().runScript(buildPreviewStartScript(container, session, preview.cwd, preview.command), {
    timeoutMs: 30_000,
  });

  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  for (;;) {
    const listening = await scanListeningPorts();
    if (listening.some((l) => l.port === preview.port)) break;
    if (Date.now() >= deadline) {
      let tail = "";
      try {
        tail = (await hostExecutor().runScript(buildCapturePaneScript(container, session), { timeoutMs: 15_000 }))
          .stdout.trim();
      } catch {
        /* the tail is best-effort context — the timeout is the error */
      }
      throw new Error(
        `the preview did not start listening on port ${preview.port} within ${Math.round(RESTART_TIMEOUT_MS / 1000)}s` +
          (tail ? ` — last output:\n${tail}` : ""),
      );
    }
    await new Promise((r) => setTimeout(r, RESTART_POLL_MS));
  }

  logger.info(
    { audit: true, action: "preview.restart", card: card.worktreeSlug, port: preview.port, session },
    "preview relaunched in its dedicated session",
  );
  return {
    restarted: true,
    port: preview.port,
    path: `/preview/${preview.port}/`,
    url: previewPublicUrl(config.publicUrl, preview.port),
  };
}

/**
 * STOPS a preview: tree-kills its dedicated tmux session (same kill discipline as card sessions —
 * a dev server's children must not survive as orphans holding the port) and removes the record
 * from the card, chip included. Best-effort on the kill (the session may never have existed — a
 * preview that only ever ran inside the card pane), strict on the record: stopping twice is fine.
 */
export async function stopPreview(cardId: string, port: number): Promise<{ stopped: true; port: number }> {
  const { card, preview } = await requirePreview(cardId, port);
  const session = previewSessionFor(card.id, preview.port);
  try {
    await hostExecutor().runScript(buildKillSessionScript(config.runner.container, [session]), { timeoutMs: 30_000 });
  } catch (e) {
    logger.warn({ card: card.worktreeSlug, port, detail: (e as Error).message }, "preview kill failed (removing the record anyway)");
  }
  await removeCardPreview(cardId, preview.port);
  logger.info(
    { audit: true, action: "preview.stop", card: card.worktreeSlug, port: preview.port, session },
    "preview stopped and removed from the card",
  );
  return { stopped: true, port: preview.port };
}

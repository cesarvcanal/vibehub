import { hostExecutor } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import {
  getCard,
  getProject,
  registerCardPreview,
  assertPreviewPort,
  normalizePreviewCommand,
  normalizePreviewCwd,
  type CardPreview,
} from "../board/registry.js";
import { cardWorkPaths } from "../board/workspace.js";
import { listPortsScript, parseListeningPorts, type ListeningPort } from "./preview.js";
import { logger } from "../../utils/logger.js";

/**
 * PREVIEW ANNOUNCEMENT — the `vibehub_preview` tool's engine: a card's agent says "there is
 * something to see on this port", vibehub verifies it and hands back the LINK the user clicks.
 *
 * The flow it exists for: "sobe um preview" → the agent starts the dev server, waits for it to
 * listen, calls `vibehub_preview` → the user sees a chip on the card and clicks. The port scan is
 * the same one the Preview menu uses (services/preview/preview.ts), so the tool and the menu can
 * never disagree about what is listening. A port that is NOT listening is refused with the list of
 * ports that are — the agent's fix (start the server / wait for it) is different from a typo's.
 */

/** The clickable URL of a preview — publicUrl is where the user's browser reaches vibehub. PURE. */
export function previewPublicUrl(publicUrl: string, port: number): string {
  return `${publicUrl.replace(/\/+$/, "")}/preview/${assertPreviewPort(port)}/`;
}

/**
 * The one-line base-path warning that rides back with the URL. Only apps that emit ABSOLUTE URLs
 * need it (vite, Next.js); relative-path apps work as-is. Kept short: it is tool output, not docs.
 */
export const PREVIEW_BASE_HINT =
  "The app is served under /preview/<port>/ — if assets 404, set its base path " +
  "(vite: base '/preview/<port>/'; Next.js: basePath '/preview/<port>') or honour X-Forwarded-Prefix.";

/** What `vibehub_preview` answers with: the link, ready to be relayed to the user. */
export interface AnnouncedPreview {
  registered: true;
  cardId: string;
  port: number;
  label?: string;
  /** Full clickable URL (publicUrl + /preview/<port>/). THIS is what the agent hands the user. */
  url: string;
  /** Base-path guidance for apps that emit absolute URLs. */
  hint: string;
}

/** Scans the runner for listening ports — one round trip, same script as the Preview menu. */
export async function scanListeningPorts(): Promise<ListeningPort[]> {
  const { stdout } = await hostExecutor().runScript(listPortsScript(config.runner.container), {
    timeoutMs: 20_000,
  });
  return parseListeningPorts(stdout);
}

/** The refusal when the announced port is not listening — names what IS, so the agent can act. PURE. */
export function portNotListeningError(port: number, listening: readonly ListeningPort[]): Error {
  const others = listening.map((p) => `${p.port}${p.process ? ` (${p.process})` : ""}`).join(", ");
  return new Error(
    `nothing is listening on port ${port} inside the runner — start the server, wait until it listens, then call vibehub_preview again.` +
      (others ? ` Currently listening: ${others}.` : " Nothing is listening at all right now."),
  );
}

export interface AnnounceInput {
  label?: string;
  /**
   * Start command of the server. ALWAYS pass it: it is what lets vibehub relaunch the preview in
   * its own session after the card is paused/restarted (see services/preview/lifecycle.ts).
   */
  command?: string;
  /** Where the command runs. Absent with a command = the card's own worktree cwd. */
  cwd?: string;
}

/**
 * Verifies the port is LISTENING in the runner, records the preview on the card (deduped by port)
 * and returns the full URL. Throws a clear, actionable error when the port is silent or the card
 * does not exist — those are the two mistakes an agent actually makes here. When a command comes
 * without a cwd, the card's own worktree cwd is resolved NOW and stored, so the record stays
 * relaunchable on its own.
 */
export async function announcePreview(cardId: string, port: number, input: AnnounceInput = {}): Promise<AnnouncedPreview> {
  const p = assertPreviewPort(port);
  // Shape errors (a two-line command, a relative cwd) must beat the scan: they are the agent's to fix.
  const command = normalizePreviewCommand(input.command);
  let cwd = normalizePreviewCwd(input.cwd);
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found — pass your OWN card id ($VIBEHUB_CARD_ID)");
  if (command && !cwd) {
    const project = await getProject(card.projectId);
    if (project) cwd = cardWorkPaths(project, card).cwd;
  }

  const listening = await scanListeningPorts();
  if (!listening.some((l) => l.port === p)) throw portNotListeningError(p, listening);

  const updated = await registerCardPreview(cardId, p, { label: input.label, command, cwd });
  if (!updated) throw new Error("card not found — pass your OWN card id ($VIBEHUB_CARD_ID)");
  const stored = (updated.previews ?? []).find((v): v is CardPreview => v.port === p);

  logger.info(
    { audit: true, action: "preview.announce", card: updated.worktreeSlug, port: p, label: stored?.label },
    "agent registered a preview on its card",
  );
  return {
    registered: true,
    cardId: updated.id,
    port: p,
    ...(stored?.label ? { label: stored.label } : {}),
    url: previewPublicUrl(config.publicUrl, p),
    hint: PREVIEW_BASE_HINT,
  };
}

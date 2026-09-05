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
import { probePreview, diagnosePreview } from "./probe.js";
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

/**
 * The host guidance that rides back with the link: the panel is reached through more than one host
 * (a LAN IP, a domain behind a gateway), and the PATH is what is true on all of them — `url` is
 * only the configured public URL, one example among the hosts the user may actually be on.
 */
export const PREVIEW_HOST_NOTE =
  "The preview works on ANY host the vibehub panel is opened on: hand the user the PATH " +
  "(/preview/<port>/) and tell them to open it on the panel host they already use — `url` is just " +
  "that path on the configured public URL.";

/** What `vibehub_preview` answers with: the link, ready to be relayed to the user. */
export interface AnnouncedPreview {
  registered: true;
  cardId: string;
  port: number;
  label?: string;
  /**
   * Canonical same-origin path (`/preview/<port>/`) — valid on EVERY host the panel is reached
   * through. THIS is what the agent hands the user.
   */
  path: string;
  /** The path on the configured public URL — one example host, not the only one. */
  url: string;
  /** Base-path guidance for apps that emit absolute URLs. */
  hint: string;
  /** Host guidance: the path works on any panel host; `url` is only an example. */
  note: string;
  /**
   * What the end-to-end check saw and the user has to know (Portuguese — it is relayed verbatim):
   * the page opens, but a 404, a redirect out of the prefix or absolute assets await them. Absent
   * when the page is clean, or when the port did not answer HTTP at all.
   */
  warning?: string;
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

  // LISTENING is not OPENS. The port answering a TCP connect said nothing about the page, and that
  // gap is exactly how a redirect-looping vite got announced as `registered: true` (see probe.ts).
  // A page that cannot be opened is refused here, BEFORE anything is written to the card — an
  // announcement is a promise to the user, and a broken link is worse than no link.
  const probe = await probePreview(p);
  const diagnosis = probe ? diagnosePreview(p, probe) : {};
  if (diagnosis.fatal) throw new Error(diagnosis.fatal);

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
    path: `/preview/${p}/`,
    url: previewPublicUrl(config.publicUrl, p),
    hint: PREVIEW_BASE_HINT,
    note: PREVIEW_HOST_NOTE,
    ...(diagnosis.warning ? { warning: diagnosis.warning } : {}),
  };
}

import * as registry from "../board/registry.js";
import { effectiveAccountSlug } from "../board/registry.js";
import { reapplyCardIdentity, restoreMissingWorkspace } from "../board/workspace.js";
import { installCardSdkDriver, sdkDriverCommand } from "./driver.js";
import { ensureDriverSession, liveDriverSession, type DriverSession } from "./manager.js";
import { buildLatestTranscriptScript, parseLatestTranscript, resumeTargetFor } from "./transcript.js";
import { transcriptDirFor } from "../maestro/cardSession.js";
import { config } from "../../config/env.js";
import { hostExecutor } from "../../runtime/host.js";
import { logger } from "../../utils/logger.js";

/**
 * A card's native-chat driver started WITHOUT a browser — for an order that arrives from outside the
 * board (ChatGPT over the external MCP, another card's agent) while nobody has the card open.
 *
 * Until now only two things ever spawned a driver: the chat tab's websocket (routes/cardSdk.ts) and
 * the boot resume after a deploy (resume.ts). An instruction sent to a card nobody was looking at was
 * typed into its tmux TUI instead — the one place where the status hooks are the ONLY way the board
 * learns the card is working, a trust/resume menu can swallow the message, and a deploy leaves no
 * marker to resume from. The driver reports its own status in-process, records the turn in the
 * history, and writes the in-flight marker the resume sweep picks up after a deploy or a crash.
 *
 * Same preparation as the chat tab's connect, minus the per-socket work (replay, mirror, typing):
 * driver installed, worktree present, the actor's identity in place, and the resume target = the
 * newest transcript (a conversation that last moved in the TUI is continued, not forked).
 */

/** One preparation per card at a time: two orders arriving together share it (one driver, one probe). */
const starting = new Map<string, Promise<DriverSession>>();

export async function startCardDriver(cardId: string): Promise<DriverSession> {
  const live = liveDriverSession(cardId);
  if (live) return live;
  const running = starting.get(cardId);
  if (running) return await running;
  const attempt = prepareAndSpawn(cardId).finally(() => {
    if (starting.get(cardId) === attempt) starting.delete(cardId);
  });
  starting.set(cardId, attempt);
  return await attempt;
}

async function prepareAndSpawn(cardId: string): Promise<DriverSession> {
  const card = await registry.getCard(cardId);
  const project = card ? await registry.getProject(card.projectId) : undefined;
  if (!card || !project) throw new Error("card not found");
  await installCardSdkDriver();
  await restoreMissingWorkspace(card.id);
  await reapplyCardIdentity(card.id);
  const transcriptDir = transcriptDirFor(project, card, effectiveAccountSlug(card, project));
  let latestSessionId: string | null = null;
  try {
    const { stdout } = await hostExecutor().runScript(
      buildLatestTranscriptScript(config.runner.container, transcriptDir, 1),
      { timeoutMs: 15_000 },
    );
    latestSessionId = parseLatestTranscript(stdout).sessionId;
  } catch (err) {
    // The card's own resumeSessionId is the fallback resumeTargetFor already applies.
    logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "could not read the card transcript before a headless driver start");
  }
  const command = await sdkDriverCommand(project, { ...card, resumeSessionId: resumeTargetFor(card, latestSessionId) });
  // Re-check: a chat tab may have spawned the driver while this one was preparing.
  const raced = liveDriverSession(card.id);
  if (raced) return raced;
  const session = ensureDriverSession({ cardId: card.id, label: card.worktreeSlug, command, transcriptDir });
  logger.info(
    { audit: true, action: "sdk.driver.headless", card: card.worktreeSlug, resume: resumeTargetFor(card, latestSessionId) ?? null },
    "native chat driver started for an order from outside the board (no browser)",
  );
  return session;
}

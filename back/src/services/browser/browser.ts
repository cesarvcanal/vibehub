import { config } from "../../config/env.js";
import { hostExecutor, shQuote } from "../../runtime/host.js";
import { getCard, getProject } from "../board/registry.js";
import { logger } from "../../utils/logger.js";
import { cardBrowserPorts, type CardBrowserPorts } from "./ports.js";
import { startCapture, stopCapture } from "../credentials/capture.js";
import { markBrowserDown, markBrowserLive } from "./activity.js";

// Display/port derivation lives in ports.ts (no cycle with the card-open path); re-exported here so
// callers that already import from browser.ts do not have to know about the split.
export { cardBrowserPorts, cardBrowserSlot, cardCdpEndpoint, type CardBrowserPorts } from "./ports.js";
// Who is in the card's browser right now (see activity.ts) — the card bar reads it through the
// same route that starts and stops the browser, so it imports from here too.
export {
  cardBrowserActivity,
  takeBrowserControl,
  releaseBrowserControl,
  agentMayDriveBrowser,
  type CardBrowserActivity,
} from "./activity.js";

/**
 * THE CARD'S LIVE BROWSER — a HEADFUL Chromium inside the runner that the user watches (and can
 * take over) from the card's "Browser" tab over noVNC. On demand, PER CARD:
 *
 *   Xvfb :<display>  →  x11vnc (RFB on 127.0.0.1:<vncPort>, -localhost)  →  vibehub bridges the
 *   browser's binary WebSocket  ↔  `docker exec -i <container> socat …:<vncPort>` on the host.
 *
 *   Chromium runs HEADFUL on that same DISPLAY with `--remote-debugging-port=<cdpPort>` bound to
 *   127.0.0.1 — and it is through THAT CDP endpoint that the card's Playwright MCP drives EXACTLY
 *   the browser the user is watching (the MCP connects with `--cdp-endpoint http://127.0.0.1:<p>`).
 *   One browser, two drivers: the human and the agent.
 *
 * Everything is DERIVED from the card id (never raw input): display and ports come from a
 * deterministic slot, and container/user-data-dir are always shQuoted. Start is IDEMPOTENT (pgrep
 * guards), so reopening the tab never spawns a duplicate; stop kills only that display's processes.
 *
 * RAM: nothing runs until the tab is opened, and `stopCardBrowser` tears it all down when it closes.
 * Two cards never collide (distinct displays/ports) and the runner only pays for open browsers.
 */

/** Geometry of the card's virtual display. A full browser screen fits comfortably in 1440x900. */
export const BROWSER_GEOMETRY = "1440x900x24";
const WINDOW_W = 1440;
const WINDOW_H = 900;

/** Heredoc delimiters. Reserved words: nothing user-supplied ever reaches these scripts. */
const START_DELIM = "VIBEHUB_BROWSER_START";
const STOP_DELIM = "VIBEHUB_BROWSER_STOP";
const TABS_LIST_DELIM = "VIBEHUB_TABS_LIST";
const TABS_ACT_DELIM = "VIBEHUB_TABS_ACT";

export interface BrowserScriptOpts {
  containerName: string;
  display: number;
  vncPort: number;
  cdpPort: number;
  userDataDir: string;
}

/**
 * Script (run on the HOST, whole thing over stdin) that brings up Xvfb + x11vnc + headful Chromium
 * for the card INSIDE the container (`docker exec -i … bash -s`, heredoc). IDEMPOTENT: every link
 * only starts when it is not already up (pgrep on the exact display/port pattern).
 *
 * Deliberately NO `set -e`: this is a best-effort launcher for background processes, and a `pgrep`
 * with no match exits non-zero, which would abort the whole script. Processes are born under
 * `setsid` with stdin on /dev/null and output redirected to a log, so they SURVIVE the `bash -s`
 * that spawned them. PURE — it only builds a string.
 */
export function buildBrowserStartScript(o: BrowserScriptOpts): string {
  const inner = [
    `export DISPLAY=:${o.display}`,
    // Xvfb — the card's virtual display. -nolisten tcp: nothing off-box talks to the X server.
    `pgrep -f "Xvfb :${o.display} " >/dev/null 2>&1 || ` +
      `setsid Xvfb :${o.display} -screen 0 ${BROWSER_GEOMETRY} -nolisten tcp ` +
      `</dev/null >/tmp/vibehub-xvfb-${o.display}.log 2>&1 &`,
    // Wait for the X socket to exist before starting clients (up to ~4s).
    `for _i in $(seq 1 20); do [ -S /tmp/.X11-unix/X${o.display} ] && break; sleep 0.2; done`,
    // x11vnc — exposes the display over RFB on the LOOPBACK ONLY; vibehub reaches it via docker exec.
    `pgrep -f "x11vnc -display :${o.display} .* -rfbport ${o.vncPort}\\b" >/dev/null 2>&1 || ` +
      `setsid x11vnc -display :${o.display} -forever -shared -nopw -localhost -rfbport ${o.vncPort} ` +
      `</dev/null >/tmp/vibehub-x11vnc-${o.vncPort}.log 2>&1 &`,
    // Playwright's headful Chromium on that display, CDP on loopback, per-card user-data-dir.
    `CHROME=$(ls -d /root/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | head -1)`,
    `mkdir -p ${shQuote(o.userDataDir)}`,
    // The pgrep is only the fast path; `flock -n` is what makes the launch ATOMIC. Two of these
    // scripts running at once (panel open + VNC connect, or a close/reopen race) used to BOTH pass
    // the pgrep in the window before Chromium showed up in the process table — and the loser's
    // invocation, hitting the profile singleton of the winner's, degenerated into "open about:blank
    // as a new tab in the running browser": one stacked blank tab per reopen. The lock file is
    // per-display; Chromium inherits the lock fd for its whole life, so any concurrent (or later,
    // still-running) duplicate launch dies in flock without ever reaching the singleton.
    `pgrep -f "remote-debugging-port=${o.cdpPort}\\b" >/dev/null 2>&1 || ` +
      `setsid flock -n /tmp/vibehub-browser-${o.display}.lock env DISPLAY=:${o.display} "$CHROME" ` +
      `--no-sandbox --no-first-run --no-default-browser-check --disable-gpu --disable-dev-shm-usage ` +
      `--disable-features=TranslateUI --password-store=basic ` +
      `--user-data-dir=${shQuote(o.userDataDir)} ` +
      `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${o.cdpPort} ` +
      `--window-position=0,0 --window-size=${WINDOW_W},${WINDOW_H} about:blank ` +
      `</dev/null >/tmp/vibehub-chrome-${o.display}.log 2>&1 &`,
    "echo vibehub-browser-up",
  ].join("\n");
  return [`docker exec -i ${shQuote(o.containerName)} bash -s <<'${START_DELIM}'`, inner, START_DELIM].join("\n");
}

/** Script that tears the card's browser down (kills only ITS display/ports). PURE. */
export function buildBrowserStopScript(
  o: Pick<BrowserScriptOpts, "containerName" | "display" | "vncPort" | "cdpPort">,
): string {
  const inner = [
    `pkill -f "remote-debugging-port=${o.cdpPort}\\b" 2>/dev/null || true`,
    `pkill -f "x11vnc -display :${o.display} .* -rfbport ${o.vncPort}\\b" 2>/dev/null || true`,
    `pkill -f "Xvfb :${o.display} " 2>/dev/null || true`,
    "echo vibehub-browser-down",
  ].join("\n");
  return [`docker exec -i ${shQuote(o.containerName)} bash -s <<'${STOP_DELIM}'`, inner, STOP_DELIM].join("\n");
}

/* ------------------------------------------------------------------ tab grooming */

/** One DevTools target as `/json/list` reports it (only the fields the grooming reads). */
export interface CdpTarget {
  id: string;
  type: string;
  url: string;
}

/** URLs that mean "an empty tab nobody is using" — Chromium's three spellings of it. */
const BLANK_URLS = new Set(["about:blank", "chrome://newtab/", "chrome://new-tab-page/"]);
/** DevTools target ids are hex/uuid-ish; anything else never reaches a script. */
const TARGET_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

/**
 * Script that fetches the browser's open tabs (`/json/list` on the loopback CDP port). Retries
 * briefly because right after a cold launch Chromium takes a moment to expose CDP. Prints the JSON
 * (or nothing when the browser never answered — the caller treats that as "no grooming"). PURE.
 */
export function buildTabListScript(containerName: string, cdpPort: number): string {
  const inner = [
    `TABS=""`,
    `for _i in $(seq 1 12); do`,
    `  TABS=$(curl -sf --max-time 1 http://127.0.0.1:${cdpPort}/json/list) && break`,
    `  TABS=""; sleep 0.25`,
    `done`,
    `printf '%s' "$TABS"`,
  ].join("\n");
  return [`docker exec -i ${shQuote(containerName)} bash -s <<'${TABS_LIST_DELIM}'`, inner, TABS_LIST_DELIM].join("\n");
}

/**
 * Script that applies a grooming plan: closes the listed tabs and brings one to the front
 * (`/json/close/<id>`, `/json/activate/<id>` — plain HTTP on the loopback CDP port; activate is
 * CDP's Target.activateTarget). Ids are validated against TARGET_ID_RE — they come from Chromium,
 * but nothing unvetted ever lands in a script. PURE.
 */
export function buildTabActionsScript(
  containerName: string,
  cdpPort: number,
  plan: { activateId?: string; closeIds: string[] },
): string {
  for (const id of [...plan.closeIds, ...(plan.activateId ? [plan.activateId] : [])]) {
    if (!TARGET_ID_RE.test(id)) throw new Error(`invalid devtools target id: '${id}'`);
  }
  const lines = plan.closeIds.map(
    (id) => `curl -sf --max-time 2 http://127.0.0.1:${cdpPort}/json/close/${id} >/dev/null 2>&1 || true`,
  );
  if (plan.activateId) {
    lines.push(`curl -sf --max-time 2 http://127.0.0.1:${cdpPort}/json/activate/${plan.activateId} >/dev/null 2>&1 || true`);
  }
  lines.push("echo vibehub-tabs-groomed");
  return [`docker exec -i ${shQuote(containerName)} bash -s <<'${TABS_ACT_DELIM}'`, lines.join("\n"), TABS_ACT_DELIM].join("\n");
}

/**
 * Decides what opening the panel should SHOW and what it should sweep away. `/json/list` orders
 * pages most-recently-active first, so:
 *   - with at least one REAL page: bring the freshest one to the front (that is the tab the agent
 *     is working in) and close every idle blank tab — the ones the old double-launch bug stacked up;
 *   - all blank: keep exactly one (front), close the rest;
 *   - a single tab, real or blank: nothing to do — it is already the front.
 * PURE.
 */
export function planTabGrooming(targets: CdpTarget[]): { activateId?: string; closeIds: string[] } {
  const pages = targets.filter(
    (t) =>
      t != null && t.type === "page" && typeof t.id === "string" && typeof t.url === "string" &&
      !t.url.startsWith("devtools://"),
  );
  const real = pages.filter((t) => !BLANK_URLS.has(t.url));
  const blanks = pages.filter((t) => BLANK_URLS.has(t.url));
  if (real.length > 0) {
    const closeIds = blanks.map((t) => t.id);
    // A lone real page is already the front — don't spend an exec re-activating it.
    if (closeIds.length === 0 && real.length === 1) return { closeIds: [] };
    return { activateId: real[0]!.id, closeIds };
  }
  if (blanks.length > 1) return { activateId: blanks[0]!.id, closeIds: blanks.slice(1).map((t) => t.id) };
  return { closeIds: [] };
}

/**
 * Reads the card browser's open tabs and applies `planTabGrooming`: the tab the agent is on comes
 * to the front, orphan blank tabs go away. Failure-isolated — grooming is a nicety and must NEVER
 * be the reason the panel does not open (a browser still warming up simply yields no tab list).
 */
export async function groomCardBrowserTabs(containerName: string, cardId: string): Promise<void> {
  try {
    const { cdpPort } = cardBrowserPorts(cardId);
    const out = await hostExecutor().runScript(buildTabListScript(containerName, cdpPort), { timeoutMs: 20_000 });
    const idx = out.stdout.indexOf("[");
    if (idx < 0) return; // browser never answered — nothing to groom
    const raw = out.stdout.slice(idx);
    let targets: unknown;
    try {
      targets = JSON.parse(raw);
    } catch {
      return; // no tab list (browser still starting, or noise on stdout) — nothing to groom
    }
    if (!Array.isArray(targets)) return;
    const plan = planTabGrooming(targets as CdpTarget[]);
    if (!plan.activateId && plan.closeIds.length === 0) return;
    await hostExecutor().runScript(buildTabActionsScript(containerName, cdpPort, plan), { timeoutMs: 15_000 });
    logger.info(
      { audit: true, action: "browser.tabs", card: cardId, closed: plan.closeIds.length, activated: plan.activateId ?? null },
      "card browser tabs groomed (agent tab to the front, orphan blanks closed)",
    );
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not groom the card browser tabs");
  }
}

/**
 * The VNC bridge's remote command: a socat wiring the process stdio to x11vnc's RFB port on the
 * container loopback. The WS route spawns this and relays raw bytes — noVNC speaks RFB straight
 * over the WebSocket, so this socat plays websockify's role without the HTTP layer. The port is
 * numeric and derived; the container name is shQuoted. PURE.
 */
export function vncBridgeRemoteCommand(containerName: string, vncPort: number): string {
  return `docker exec -i ${shQuote(containerName)} socat STDIO TCP:127.0.0.1:${vncPort}`;
}

/**
 * argv for the bridge process, resolved through the host executor — `bash -lc …` when Docker is
 * local, `ssh … <command>` when it is across a hop. The WS route does not care which. PURE-ish (it
 * reads the executor's configuration, nothing else).
 */
export function vncBridgeCommand(containerName: string, vncPort: number): { file: string; args: string[] } {
  return hostExecutor().ptyCommand(vncBridgeRemoteCommand(containerName, vncPort));
}

/**
 * Brings the card's browser up (idempotent) and returns the derived ports. Called when the "Browser"
 * tab opens and, defensively, when the VNC WebSocket connects. The runner's setup already installed
 * Xvfb/x11vnc/socat and Playwright's Chromium.
 */
/**
 * Starts already in flight, per card. Opening the panel fires the POST and the VNC WebSocket within
 * milliseconds of each other, and BOTH bring the browser up — sharing the in-flight promise means
 * one docker exec instead of two racing ones (the flock in the script is the cross-process belt;
 * this is the in-process suspenders).
 */
const startsInFlight = new Map<string, Promise<CardBrowserPorts>>();

export async function startCardBrowser(
  containerName: string,
  cardId: string,
  by?: string,
): Promise<CardBrowserPorts> {
  const inFlight = startsInFlight.get(cardId);
  if (inFlight) return await inFlight;
  const run = (async () => {
    const ports = cardBrowserPorts(cardId);
    await hostExecutor().runScript(buildBrowserStartScript({ containerName, ...ports }), { timeoutMs: 60_000 });
    // From here the card bar can SEE this browser: the chip lights up even for whoever did not open
    // the pane themselves.
    markBrowserLive(cardId);
    logger.info(
      { audit: true, action: "browser.start", card: cardId, display: ports.display, by },
      "card browser started",
    );
    // Opening the panel CONNECTS to the browser as it is: agent's tab to the front, orphan blank
    // tabs swept. BEFORE the capture starts, so the observer attaches to the tab that survived the
    // sweep, not to a blank about to be closed. Failure-isolated inside — the panel opens either way.
    await groomCardBrowserTabs(containerName, cardId);
    // Watch this browser for a login being submitted (Cofre) and paint the click ripple. Idempotent
    // and failure-isolated inside startCapture — it must never keep the browser from opening.
    startCapture(cardId);
    return ports;
  })();
  startsInFlight.set(cardId, run);
  try {
    return await run;
  } finally {
    startsInFlight.delete(cardId);
  }
}

/** Tears the card's browser down (tab closed / idle timeout). Idempotent. */
export async function stopCardBrowser(containerName: string, cardId: string, by?: string): Promise<void> {
  // A stop racing an in-flight start (close/reopen flurry) waits for it — killing the processes
  // halfway through the launcher is how half-alive browsers are born.
  await startsInFlight.get(cardId)?.catch(() => undefined);
  stopCapture(cardId);
  markBrowserDown(cardId);
  const ports = cardBrowserPorts(cardId);
  await hostExecutor().runScript(buildBrowserStopScript({ containerName, ...ports }), { timeoutMs: 30_000 });
  logger.info(
    { audit: true, action: "browser.stop", card: cardId, display: ports.display, by },
    "card browser stopped",
  );
}

export interface ResolvedCardBrowser {
  /** The runner container the card's browser runs in. vibehub has exactly one. */
  containerName: string;
  ports: CardBrowserPorts;
}

/**
 * Resolves card → project → runner container. In the original panel this walked a fleet to find
 * WHICH host ran the card's runner; vibehub has a single runner, so the walk survives only as a
 * validity check: a card whose project vanished is broken, and failing here with a clear message
 * beats a confusing docker error later.
 */
export async function resolveCardBrowser(cardId: string): Promise<ResolvedCardBrowser> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");
  return { containerName: config.runner.container, ports: cardBrowserPorts(cardId) };
}

/** Opens the card's browser (resolves the runner, starts it idempotently). Returns the ports. */
export async function openCardBrowser(cardId: string, by?: string): Promise<CardBrowserPorts> {
  const { containerName } = await resolveCardBrowser(cardId);
  return await startCardBrowser(containerName, cardId, by);
}

/** Closes the card's browser (resolves the runner, tears it down). Idempotent. */
export async function closeCardBrowser(cardId: string, by?: string): Promise<void> {
  const { containerName } = await resolveCardBrowser(cardId);
  await stopCardBrowser(containerName, cardId, by);
}

export interface CardVncBridge {
  /** argv the WS route spawns to relay raw RFB bytes. */
  command: { file: string; args: string[] };
  ports: CardBrowserPorts;
}

/**
 * Prepares the card's VNC bridge: guarantees the browser is up (idempotent start) and returns the
 * argv the WS route spawns to wire the panel's WebSocket to the card's RFB port. Doing the start
 * here means the socket connects even when the tab was opened a millisecond ago.
 */
export async function cardVncBridge(cardId: string, by?: string): Promise<CardVncBridge> {
  const { containerName } = await resolveCardBrowser(cardId);
  const ports = await startCardBrowser(containerName, cardId, by);
  return { command: vncBridgeCommand(containerName, ports.vncPort), ports };
}

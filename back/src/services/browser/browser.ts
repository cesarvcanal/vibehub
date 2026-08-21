import { config } from "../../config/env.js";
import { hostExecutor, shQuote } from "../../runtime/host.js";
import { getCard, getProject } from "../board/registry.js";
import { logger } from "../../utils/logger.js";
import { cardBrowserPorts, type CardBrowserPorts } from "./ports.js";

// Display/port derivation lives in ports.ts (no cycle with the card-open path); re-exported here so
// callers that already import from browser.ts do not have to know about the split.
export { cardBrowserPorts, cardBrowserSlot, cardCdpEndpoint, type CardBrowserPorts } from "./ports.js";

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
    `pgrep -f "remote-debugging-port=${o.cdpPort}\\b" >/dev/null 2>&1 || ` +
      `setsid env DISPLAY=:${o.display} "$CHROME" ` +
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
export async function startCardBrowser(
  containerName: string,
  cardId: string,
  by?: string,
): Promise<CardBrowserPorts> {
  const ports = cardBrowserPorts(cardId);
  await hostExecutor().runScript(buildBrowserStartScript({ containerName, ...ports }), { timeoutMs: 60_000 });
  logger.info(
    { audit: true, action: "browser.start", card: cardId, display: ports.display, by },
    "card browser started",
  );
  return ports;
}

/** Tears the card's browser down (tab closed / idle timeout). Idempotent. */
export async function stopCardBrowser(containerName: string, cardId: string, by?: string): Promise<void> {
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

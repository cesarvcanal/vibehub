/**
 * Screenshot matrix of the voice call in the card chat — every state (connecting, listening while
 * the person speaks, the living mark while thinking, replying while the assistant speaks) in dark
 * and light, desktop and phone — plus the "no plate" check: the orb's canvas must be transparent
 * outside the particles and nothing behind it may paint a background.
 *
 * Same simulation and arguments as voice-in-chat.e2e.mjs (it reuses that file's in-page fakes).
 */
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith("--") ? [...acc, [cur.slice(2), all[i + 1]]] : acc), []),
);
const FRONT = args.front ?? "http://127.0.0.1:5913";
const DATA = args.data ?? "/tmp/vh-voice";
const OUT = args.out ?? "/tmp/voice-shots";
mkdirSync(OUT, { recursive: true });
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "voice-in-chat.e2e.mjs"), "utf8");
const installFakes = new Function(`${src.slice(src.indexOf("function installFakes()"), src.indexOf("const historyFile"))}; return installFakes;`)();
const historyFile = join(DATA, "sdk-history", `${args.card}.ndjson`);
/** The card's typed conversation only: a closing tab saves its call's turns (keepalive), and a
 *  screenshot run must leave the history as the E2E expects it. */
const typedOnly = () => readFileSync(historyFile, "utf8").split("\n").filter((l) => l && !l.includes('"voice_turn"'));
const history = typedOnly();

const browser = await chromium.launch({ executablePath: args.chrome, args: ["--no-sandbox"] });
const report = [];

async function phase(page, want, timeout = 6_000) {
  await page.waitForFunction((w) => document.querySelector("[data-testid=voice-call-bar]")?.dataset.phase === w, want, { timeout });
}

/** Transparency of the orb: share of fully transparent canvas pixels, corners, and CSS backgrounds. */
async function plate(page) {
  return await page.evaluate(() => {
    const c = document.querySelector("[data-testid=voice-orb] canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let clear = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] === 0) clear++;
    const corner = (x, y) => d[(y * c.width + x) * 4 + 3];
    const bgs = [];
    for (let el = c; el && el !== document.querySelector("[data-testid=sdk-chat-scroller]")?.parentElement?.parentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const before = getComputedStyle(el, "::before");
      bgs.push({ tag: el.tagName, bg: cs.backgroundColor, img: cs.backgroundImage, before: before.content !== "none" ? before.backgroundImage : "none" });
    }
    return {
      clearRatio: clear / (d.length / 4),
      corners: [corner(0, 0), corner(c.width - 1, 0), corner(0, c.height - 1), corner(c.width - 1, c.height - 1)],
      painted: bgs.filter((b) => (b.bg !== "rgba(0, 0, 0, 0)" && b.bg !== "transparent") || b.img !== "none" || (b.before !== "none" && b.before !== undefined)),
    };
  });
}

for (const theme of ["dark", "light"]) {
  for (const vp of [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.name === "mobile" ? 2 : 1 });
    await context.request.post(`${FRONT}/api/auth/login`, { data: { username: "operator", password: "supersecret" } });
    await context.addInitScript(installFakes);
    await context.addInitScript((t) => localStorage.setItem("vibehub.theme", t), theme);
    await context.routeWebSocket(/\/api\/cards\/[^/]+\/sdk/, (ws) => {
      for (const l of history) ws.send(l);
      ws.send(JSON.stringify({ type: "ready" }));
    });
    await context.route(/\/api\/cards\/[^/]+\/voice\/sessions/, (r) =>
      r.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ sessionId: "s", sdp: "v=0 answer" }) }),
    );
    // Never save turns from the screenshot run: the history file stays what the E2E expects.
    await context.route(/\/api\/cards\/[^/]+\/voice\/turns/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"saved":[],"duplicate":[]}' }));
    const page = await context.newPage();
    await page.goto(`${FRONT}/?project=${args.project}&card=${args.card}`);
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.getByTestId("sdk-chat-scroller").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(600);
    const tag = `${theme}-${vp.name}`;
    await page.screenshot({ path: join(OUT, `${tag}-0-chat.png`) });
    // Hold the answer a little, so "connecting" can be photographed.
    await page.evaluate(() => {
      const orig = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = function (d) {
        return new Promise((r) => setTimeout(() => r(orig.call(this, d)), 1500));
      };
    });
    await page.getByTestId("composer-voice").click();
    await phase(page, "connecting");
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, `${tag}-1-conectando.png`) });
    await phase(page, "listening");
    await page.evaluate(() => {
      window.__e2e.say("mic", 14, 0.6);
      window.__e2e.stream("session.input_transcript.delta", ["Me ", "conta ", "como ", "ficou ", "o deploy."], 260, 0);
    });
    await page.waitForTimeout(1_100);
    await page.screenshot({ path: join(OUT, `${tag}-2-ouvindo.png`) });
    await page.getByTestId("voice-call-orb").screenshot({ path: join(OUT, `${tag}-2-ouvindo-orb.png`) });
    await page.evaluate(() => window.__e2e.silence("mic"));
    await phase(page, "thinking");
    await page.waitForTimeout(1_200);
    await page.screenshot({ path: join(OUT, `${tag}-3-marca-viva.png`) });
    await page.getByTestId("voice-call-orb").screenshot({ path: join(OUT, `${tag}-3-marca-viva-orb.png`) });
    const thinkingPlate = await plate(page);
    await page.evaluate(() => {
      window.__e2e.say("ai", 18, 0.7);
      window.__e2e.stream("session.output_transcript.delta", ["O deploy ", "subiu ", "verde, ", "sem ", "alertas."], 320, 3000);
    });
    await phase(page, "ai_speaking");
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, `${tag}-4-respondendo.png`) });
    await page.getByTestId("voice-call-orb").screenshot({ path: join(OUT, `${tag}-4-respondendo-orb.png`) });
    const speakingPlate = await plate(page);
    const layout = await page.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      return { thread: r("[data-testid=sdk-chat-scroller]"), bar: r("[data-testid=voice-call-bar]"), field: r("textarea") };
    });
    report.push({ tag, thinkingPlate, speakingPlate, layout });
    await context.close();
  }
}
writeFileSync(join(OUT, "shots-report.json"), JSON.stringify(report, null, 2));
await new Promise((r) => setTimeout(r, 500));
writeFileSync(historyFile, typedOnly().join("\n") + "\n");
for (const r of report) {
  console.log(
    r.tag,
    "clear(thinking)",
    r.thinkingPlate.clearRatio.toFixed(2),
    "clear(speaking)",
    r.speakingPlate.clearRatio.toFixed(2),
    "corners",
    JSON.stringify(r.speakingPlate.corners),
    "painted ancestors",
    JSON.stringify(r.speakingPlate.painted),
    "bar-vs-field",
    Math.round(r.layout.bar.bottom),
    Math.round(r.layout.field.top),
  );
}
await browser.close();

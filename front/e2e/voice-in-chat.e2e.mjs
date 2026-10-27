/**
 * VOICE IN THE CARD'S CHAT — end to end in a real Chromium, against a real vibehub back-end.
 *
 * What is real: the browser, the React app, Web Audio (AudioContext, AnalyserNode), the <audio>
 * element playing the assistant's stream, the back-end (auth, voice routes, turn persistence into
 * `sdk-history`), the page reload replaying the thread from disk.
 *
 * What is SIMULATED, and why:
 * - GPT-Live: no key in this environment. `RTCPeerConnection` is replaced in the page by a fake
 *   whose "remote track" is a REAL audio MediaStream synthesised in the page (an oscillator shaped
 *   by a syllable envelope, through a MediaStreamDestination), and whose data channel emits the
 *   documented GPT-Live events. The microphone is the same kind of synthetic stream. So the orb's
 *   analyser measures real audio samples — but not audio decoded from a network WebRTC track.
 * - The card's Claude driver: no Docker here. The `/api/cards/:id/sdk` websocket is answered by a
 *   small mock that replays the card's REAL history file and answers typed messages.
 * - `/api/cards/:id/voice/sessions` (the SDP trade with OpenAI) is answered with a fake SDP.
 *
 * Run (back + front already up, see docs/voice-mode-poc.md):
 *   NODE_PATH=<dir with playwright-core> node front/e2e/voice-in-chat.e2e.mjs \
 *     --front http://127.0.0.1:5913 --data /tmp/vh-voice --card <id> --project <id> --out /tmp/shots
 */
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith("--") ? [...acc, [cur.slice(2), all[i + 1]]] : acc), []),
);
const FRONT = args.front ?? "http://127.0.0.1:5913";
const DATA = args.data ?? "/tmp/vh-voice";
const CARD = args.card;
const PROJECT = args.project;
const OUT = args.out ?? "/tmp/voice-shots";
const CHROME = args.chrome ?? process.env.CHROME_PATH;
mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Runs in the page before the app: the simulated microphone, peer and GPT-Live channel. */
function installFakes() {
  const ctx = new AudioContext();
  const e2e = (window.__e2e = { sent: [], channel: null, ctx });

  function voice() {
    // A voice-ish source: two detuned oscillators, gain driven by an envelope we schedule.
    const out = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    for (const f of [180, 271]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start();
    }
    gain.connect(out);
    return { stream: out.stream, gain };
  }
  const mic = voice();
  const remote = voice();
  e2e.mic = mic;
  e2e.remote = remote;

  /** Speaks `syllables` with the given peak (0..1): a pulse per syllable, like speech. */
  e2e.say = (who, syllables, peak = 0.5) => {
    const g = (who === "ai" ? remote : mic).gain.gain;
    const t0 = ctx.currentTime + 0.02;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0, t0);
    for (let i = 0; i < syllables; i++) {
      const at = t0 + i * 0.22;
      const level = peak * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7)));
      g.linearRampToValueAtTime(level, at + 0.05);
      g.linearRampToValueAtTime(level * 0.15, at + 0.18);
    }
    g.linearRampToValueAtTime(0, t0 + syllables * 0.22 + 0.05);
    return syllables * 220;
  };
  /** Emits transcript fragments on the model's cadence, from the page's own clock. */
  e2e.stream = (type, words, everyMs, startMs) =>
    words.forEach((delta, i) =>
      setTimeout(() => e2e.channel.emit({ type, delta, start_ms: startMs + i * everyMs, end_ms: startMs + i * everyMs + everyMs - 20 }), i * everyMs),
    );
  e2e.silence = (who) => {
    const g = (who === "ai" ? remote : mic).gain.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(0, ctx.currentTime);
  };

  navigator.mediaDevices.getUserMedia = async () => {
    await ctx.resume();
    return mic.stream;
  };

  class FakeChannel extends EventTarget {
    readyState = "connecting";
    send(data) {
      e2e.sent.push(JSON.parse(data));
      const event = JSON.parse(data);
      if (event.type === "session.close") setTimeout(() => this.emit({ type: "session.closed", reason: "close_requested" }), 50);
      if (event.type === "session.thinking.append") setTimeout(() => this.emit({ type: "session.thinking.appended" }), 20);
    }
    close() {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
    emit(event) {
      this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
    }
  }

  class FakePeer extends EventTarget {
    iceGatheringState = "complete";
    connectionState = "new";
    iceConnectionState = "new";
    localDescription = null;
    addTrack() {}
    createDataChannel() {
      this.channel = new FakeChannel();
      e2e.channel = this.channel;
      return this.channel;
    }
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n" };
    }
    async setLocalDescription(d) {
      this.localDescription = d;
    }
    async setRemoteDescription() {
      setTimeout(() => {
        this.connectionState = "connected";
        this.dispatchEvent(new Event("connectionstatechange"));
        this.channel.readyState = "open";
        this.channel.dispatchEvent(new Event("open"));
        this.dispatchEvent(Object.assign(new Event("track"), { track: remote.stream.getAudioTracks()[0], streams: [remote.stream] }));
        this.channel.emit({ type: "session.started", session: { id: "sess_e2e" } });
      }, 400);
    }
    async getStats() {
      return new Map();
    }
    close() {
      this.channel?.close();
    }
  }
  window.RTCPeerConnection = FakePeer;
}

const historyFile = join(DATA, "sdk-history", `${CARD}.ndjson`);
const readHistory = () =>
  readFileSync(historyFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await context.request.post(`${FRONT}/api/auth/login`, { data: { username: "operator", password: "supersecret" } });
await context.addInitScript(installFakes);

// The card's driver, mocked: replays the REAL history file, acks and answers typed messages.
const typedFrames = [];
await context.routeWebSocket(/\/api\/cards\/[^/]+\/sdk/, (ws) => {
  for (const event of readHistory()) ws.send(JSON.stringify(event));
  ws.send(JSON.stringify({ type: "ready" }));
  ws.onMessage((raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type !== "user") return;
    typedFrames.push(frame);
    ws.send(JSON.stringify({ type: "user_ack", cid: frame.cid }));
    setTimeout(() => ws.send(JSON.stringify({ type: "assistant_delta", text: "Rodando os testes do recorte… " })), 600);
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "assistant_text", text: "Rodando os testes do recorte… 129 testes verdes no front, 36 no back." }));
      ws.send(JSON.stringify({ type: "result", isError: false }));
    }, 2600);
  });
});
await context.route(/\/api\/cards\/[^/]+\/voice\/sessions/, (route) =>
  route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ sessionId: "sess_e2e", sdp: "v=0 answer" }) }),
);

const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
const url = `${FRONT}/?project=${PROJECT}&card=${CARD}`;
await page.goto(url);
const scroller = page.getByTestId("sdk-chat-scroller");
await scroller.waitFor({ timeout: 30_000 });
await page.getByText("Integra a voz no chat do card").waitFor();
await page.screenshot({ path: join(OUT, "01-chat-antes-da-chamada.png") });

const voiceButton = page.getByTestId("composer-voice");
check("voice button lives in the chat's composer", await voiceButton.isVisible());
const urlBefore = page.url();
await voiceButton.click();
const bar = page.getByTestId("voice-call-bar");
await bar.waitFor();
check("call starts in place — no navigation", page.url() === urlBefore);
const connecting = await page.evaluate(() => {
  const b = document.querySelector("[data-testid=voice-call-bar]");
  return { phase: b?.dataset.phase, orb: document.querySelector("[data-testid=voice-call-orb]")?.dataset.orb };
});
check("connecting shows the living mark", connecting.phase !== "connecting" || connecting.orb === "logo", JSON.stringify(connecting));
await page.screenshot({ path: join(OUT, "02-conectando-marca-viva.png") });
// NO PLATE behind the mark: the canvas is transparent outside the particles and nothing between it
// and the chat paints a background — the app's grid and constellations show through.
const plate = await page.evaluate(() => {
  const c = document.querySelector("[data-testid=voice-orb] canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const corners = [0, c.width - 1, (c.height - 1) * c.width, c.height * c.width - 1].map((i) => d[i * 4 + 3]);
  const painted = [];
  for (let el = c; el && !el.matches("[data-testid=voice-call-bar]"); el = el.parentElement) {
    const cs = getComputedStyle(el);
    const before = getComputedStyle(el, "::before");
    if (cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.backgroundImage !== "none" || (before.content !== "none" && before.backgroundImage !== "none")) painted.push(el.tagName);
  }
  const bar = getComputedStyle(document.querySelector("[data-testid=voice-call-bar]"));
  if (bar.backgroundColor !== "rgba(0, 0, 0, 0)" || bar.borderTopWidth !== "0px") painted.push("bar");
  return { corners, painted };
});
check("no plate behind the orb: transparent canvas, no painted background or box", plate.corners.every((a) => a === 0) && plate.painted.length === 0, JSON.stringify(plate));
await page.waitForFunction(() => document.querySelector("[data-testid=voice-call-bar]")?.dataset.phase === "listening");
check("live: listening, lilac", (await page.getByTestId("voice-call-orb").getAttribute("data-orb")) === "listen");

// The person speaks: real audio on the mic stream + the model's input transcript.
await page.evaluate(() => window.__e2e.say("mic", 10, 0.6));
const userWords = ["Quero ", "saber ", "se os ", "testes ", "passaram."];
for (const [i, w] of userWords.entries()) {
  await page.waitForTimeout(220);
  await page.evaluate(([delta, i]) => window.__e2e.channel.emit({ type: "session.input_transcript.delta", delta, start_ms: i * 220, end_ms: i * 220 + 200 }), [w, i]);
}
await page.waitForFunction(() => document.querySelector("[data-testid=voice-call-bar]")?.dataset.phase === "user_speaking");
const micVisual = Number(await page.getByTestId("voice-call-orb").getAttribute("data-mic-visual"));
check("listening reacts to the real mic level", micVisual > 0.2, `micVisual=${micVisual}`);
check("the person's words appear live in the SAME thread", await scroller.getByText("Quero saber se os testes passaram.").isVisible());
await page.screenshot({ path: join(OUT, "03-ouvindo-voce-lilas.png") });
await page.getByTestId("voice-call-orb").screenshot({ path: join(OUT, "03b-esfera-lilas-zoom.png") });

// Silence: waiting on the reply → the living mark (processing).
await page.evaluate(() => window.__e2e.silence("mic"));
await page.waitForFunction(() => document.querySelector("[data-testid=voice-call-bar]")?.dataset.phase === "thinking", null, { timeout: 5_000 });
check("waiting on the reply shows the living mark", (await page.getByTestId("voice-call-orb").getAttribute("data-orb")) === "logo");
await page.screenshot({ path: join(OUT, "04-pensando-marca-viva.png") });

/** Mean absolute change between two reads of the orb's canvas, 0..255 per channel. */
async function canvasMotion(ms = 160) {
  return await page.evaluate(async (ms) => {
    const c = document.querySelector("[data-testid=voice-orb] canvas");
    const g = c.getContext("2d");
    const a = g.getImageData(0, 0, c.width, c.height).data;
    await new Promise((r) => setTimeout(r, ms));
    const b = g.getImageData(0, 0, c.width, c.height).data;
    let d = 0;
    for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return d / (a.length / 4);
  }, ms);
}

// The assistant replies: REAL audio on the remote stream + output transcript fragments.
const aiMs = await page.evaluate(() => window.__e2e.say("ai", 16, 0.7));
const aiWords = ["Sim, ", "os ", "testes ", "do ", "recorte ", "passaram ", "todos."];
await page.evaluate((words) => window.__e2e.stream("session.output_transcript.delta", words, 300, 3000), aiWords);
// Sampled from the page every 60 ms, independent of this script's own pace.
const sampling = page.evaluate(async (windowMs) => {
  const out = [];
  const t0 = performance.now();
  // Only while the assistant's audio is scheduled to sound: a busy page stretches timers, and a
  // sample taken after the voice ended says nothing about how the orb follows it.
  while (performance.now() - t0 < windowMs) {
    await new Promise((r) => setTimeout(r, 60));
    const o = document.querySelector("[data-testid=voice-call-orb]");
    out.push({ at: Math.round(performance.now() - t0), source: o.dataset.aiSource, rms: Number(o.dataset.aiRms), visual: Number(o.dataset.aiVisual), orb: o.dataset.orb });
  }
  return out;
}, aiMs - 200);
await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, "05-respondendo-azul.png") });
await page.getByTestId("voice-call-orb").screenshot({ path: join(OUT, "05b-esfera-azul-zoom.png") });
const motionSpeaking = await canvasMotion();
const samples = await sampling;
const speaking = samples.filter((s) => s.orb === "talk");
const visuals = speaking.map((s) => s.visual);
const rmsValues = speaking.map((s) => s.rms).filter((v) => !Number.isNaN(v));
const spread = Math.max(...visuals) - Math.min(...visuals);
check("replying turns the sphere blue", speaking.length > samples.length * 0.7, `${speaking.length}/${samples.length} samples in talk over ${samples.at(-1)?.at} ms`);
const audible = speaking.filter((s) => s.rms > 0.01);
check("while the assistant's audio flows, the level is MEASURED on its stream (analyser)", audible.length > 0 && audible.every((s) => s.source === "analyser"), [...new Set(speaking.map((s) => s.source))].join(","));
check("the real RMS of the assistant's audio is non-trivial", Math.max(...rmsValues) > 0.05, `max rms=${Math.max(...rmsValues).toFixed(3)}`);
check("the visual intensity follows the syllables (varies, not a constant)", spread > 0.25, `visual ${Math.min(...visuals).toFixed(2)}…${Math.max(...visuals).toFixed(2)}`);
await page.waitForTimeout(400);
await page.evaluate(() => window.__e2e.silence("ai"));
const motionSilent = await canvasMotion();
await page.waitForTimeout(1_800);
check("the orb visibly moves more while the assistant speaks than in silence", motionSpeaking > motionSilent * 1.2, `speaking=${motionSpeaking.toFixed(2)} silent=${motionSilent.toFixed(2)}`);
const after = page.getByTestId("voice-call-orb");
check("silence: the reply's intensity falls back to zero (no clock-driven motion)", Number(await after.getAttribute("data-ai-visual")) < 0.05, `visual=${await after.getAttribute("data-ai-visual")}`);
check("the assistant's words are in the thread, as ONE turn", await scroller.getByText("Sim, os testes do recorte passaram todos.").isVisible());

// Typing during the call: the chat's own flow, and the voice is told quietly.
const box = page.getByRole("textbox");
await box.fill("roda o gate antes do PR");
await box.press("Enter");
await page.waitForTimeout(400);
check("typed text goes through the chat's websocket (same flow)", typedFrames.some((f) => f.text === "roda o gate antes do PR"));
const thinking = await page.evaluate(() => window.__e2e.sent.filter((e) => e.type === "session.thinking.append").map((e) => e.content));
check("the voice is told what was typed (session.thinking.append)", thinking.some((c) => c.includes("roda o gate antes do PR")));
await page.waitForFunction(() => document.querySelector("[data-testid=voice-call-bar]")?.dataset.phase === "thinking", null, { timeout: 3_000 }).catch(() => undefined);
await page.screenshot({ path: join(OUT, "06-digitando-durante-chamada.png") });
await page.getByText("129 testes verdes no front").waitFor({ timeout: 5_000 });
await page.waitForTimeout(300);
const thinking2 = await page.evaluate(() => window.__e2e.sent.filter((e) => e.type === "session.thinking.append").map((e) => e.content));
check("the agent's answer reaches the voice as context", thinking2.some((c) => c.includes("129 testes verdes")));
await page.screenshot({ path: join(OUT, "07-resposta-do-agente-na-chamada.png") });

// Mute: the mic stops moving the orb.
await page.getByTestId("voice-call-mute").click();
await page.evaluate(() => window.__e2e.say("mic", 6, 0.8));
await page.waitForTimeout(500);
check("muted: the mic moves nothing", Number(await page.getByTestId("voice-call-orb").getAttribute("data-mic-visual")) === 0);
const muteSent = await page.evaluate(() => window.__e2e.sent.some((e) => e.type === "session.input_audio.mute"));
check("muting tells the model", muteSent);
await page.screenshot({ path: join(OUT, "08-mudo.png") });

// Mobile, mid-call.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, "09-mobile-durante-chamada.png") });
const barBox = await bar.boundingBox();
const composerBox = await page.getByRole("textbox").boundingBox();
const scrollBox = await scroller.boundingBox();
check("mobile: the call strip sits between the thread and the field, overlapping neither",
  barBox && composerBox && scrollBox && barBox.y >= scrollBox.y + scrollBox.height - 1 && barBox.y + barBox.height <= composerBox.y + 1,
  JSON.stringify({ bar: barBox, field: composerBox?.y, threadEnd: scrollBox && scrollBox.y + scrollBox.height }));
await page.setViewportSize({ width: 1440, height: 900 });

// Hang up: the strip goes, the conversation stays — and survives a reload (saved on the server).
await page.getByTestId("voice-call-end").click();
await bar.waitFor({ state: "detached", timeout: 5_000 });
check("hang-up removes the strip and keeps the transcript", await scroller.getByText("Quero saber se os testes passaram.").isVisible());
await page.waitForTimeout(800);
const saved = readHistory().filter((e) => e.type === "voice_turn");
check("the spoken turns were saved in the card's history (server)", saved.some((e) => e.role === "user" && e.text.includes("Quero saber")) && saved.some((e) => e.role === "assistant" && e.text.includes("passaram todos")), `${saved.length} voice_turn line(s)`);
check("each turn saved once (idempotent)", new Set(saved.map((e) => e.vid)).size === saved.length);
await page.reload();
await scroller.waitFor();
await page.getByText("Quero saber se os testes passaram.").waitFor({ timeout: 15_000 });
const after1 = await page.getByTestId("sdk-voice").count();
check("after a reload the spoken turns are replayed in the thread, once each", after1 === saved.length, `${after1} on screen, ${saved.length} saved`);
await page.screenshot({ path: join(OUT, "10-depois-de-recarregar.png") });
check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

writeFileSync(join(OUT, "results.json"), JSON.stringify({ results, samples }, null, 2));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

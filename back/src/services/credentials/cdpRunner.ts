/**
 * The Node program that runs INSIDE the runner container to drive a card's Chromium over CDP.
 *
 * It is a STRING, executed with `node <file> <payloadFile>` via `docker exec`. Two modes:
 *   - "fill":    connect, focus each field, type its secret with Input.insertText, print the result.
 *   - "capture": connect, inject a submit observer + a Runtime binding, and stream NDJSON captures.
 *
 * Why raw CDP over Node built-ins (net + crypto) instead of Playwright: the runner has Playwright's
 * Chromium but not necessarily a resolvable `playwright`/`ws` module, and `net.connect` to the
 * loopback CDP port is guaranteed to work from inside the same container. Nothing here reaches the
 * network off-box.
 *
 * THE SECRET NEVER LEAVES THIS PROCESS AS TEXT: fill reads the value from the payload file, hands it
 * to `Input.insertText` as a protocol field, and prints ONLY {filled, fields} — never the value.
 * Capture reports {url, username, password} on its OWN stdout to the back, never to any LLM or log.
 */

/**
 * Injected into the page: resolves and focuses a field, returning true when it found one. Browser
 * JS (DOM globals), kept as a source string because it runs in Chromium, not in Node — so it is not
 * typechecked against the Node lib. It never contains a secret; the value arrives via Input.insertText.
 */
const FOCUS_SRC = `function focusField(field) {
  function nearestUser(pw) {
    var inputs = Array.prototype.slice.call(document.querySelectorAll("input"));
    var idx = inputs.indexOf(pw);
    for (var i = idx - 1; i >= 0; i--) {
      var el = inputs[i];
      var type = (el.type || "text").toLowerCase();
      if (["text", "email", "tel", ""].indexOf(type) >= 0) return el;
    }
    return document.querySelector(
      "input[autocomplete=username], input[name*=user i], input[name*=email i], input[id*=user i], input[id*=email i], input[type=email]"
    );
  }
  var el = null;
  if (field.selector) el = document.querySelector(field.selector);
  else if (field.ref === "PASS") el = document.querySelector("input[type=password]");
  else if (field.ref === "USER") {
    var pw = document.querySelector("input[type=password]");
    el = pw ? nearestUser(pw) : document.querySelector(
      "input[autocomplete=username], input[name*=user i], input[name*=email i], input[type=email], input[type=text]"
    );
  } else if (field.ref === "VALUE") {
    el = document.querySelector("input[type=password]") || document.querySelector("input[type=text], input:not([type])");
  }
  if (!el) return false;
  el.focus();
  try { el.value = ""; } catch (e) {}
  return true;
}`;

/**
 * Injected into the page: reports a login on form submit, and — GUIDED VIEWING — draws what the
 * agent is doing so the person watching over noVNC is not staring at a page that moves by itself.
 *
 * WHY IT HAS TO BE DRAWN AT ALL: the agent clicks over CDP, and CDP input is synthesised INSIDE
 * Chromium — it never touches the X11 pointer. So there is no cursor on the VNC canvas to follow;
 * on screen, links just open. This paints the missing mouse: a dot that follows every pointer move,
 * a ripple where a click lands, and a brief outline around the element that was clicked ("it
 * pressed THAT button").
 *
 * WHOSE POINTER IS IT: the page cannot tell an agent's synthetic event from a person's (both are
 * trusted), and correlating them with the VNC input stream would be a lot of machinery for nothing.
 * It does not need to: the panel opens in "Só assistir", where the person's mouse sends NOTHING
 * into the page — so in the mode you watch from, every dot on screen IS the agent. In "Pilotar
 * junto" the dot simply rides along under the real cursor.
 *
 * It also pings the binding (throttled) so the back knows this browser is BUSY and the card bar can
 * say so without opening the pane. The overlay lives in a closed shadow root on a
 * pointer-events:none host, so it can never interfere with the page. The login value goes to the
 * Runtime binding (which THIS program reads on its own stdout), never into the DOM, a log or the
 * model. Browser JS.
 */
const OBSERVER_SRC = `function installObserver() {
  var w = window;
  if (w.__vibehubCaptureInstalled) return;
  w.__vibehubCaptureInstalled = true;
  var lastPing = 0;
  function ping() {
    // Throttled: a pointer move fires dozens of times a second and the back only needs to know
    // "still busy", not the trajectory.
    var now = Date.now();
    if (now - lastPing < 400) return;
    lastPing = now;
    try { if (w.__vibehubCapture) w.__vibehubCapture(JSON.stringify({ act: 1 })); } catch (e) {}
  }
  /** The overlay's own layer, created on first use — at install time there may be no <html> yet. */
  var layer = null;
  function shadow() {
    if (layer && layer.host.isConnected) return layer;
    var parent = document.documentElement || document.body;
    if (!parent) return null;
    var host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    parent.appendChild(host);
    var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    layer = { host: host, root: root, cursor: null, hideAt: 0 };
    return layer;
  }
  function ripple(x, y) {
    try {
      var l = shadow();
      if (!l) return;
      var dot = document.createElement("div");
      dot.style.cssText =
        "position:fixed;left:" + (x - 14) + "px;top:" + (y - 14) + "px;width:28px;height:28px;" +
        "border-radius:50%;border:2px solid rgba(255,171,0,0.9);background:rgba(255,171,0,0.28);" +
        "pointer-events:none;z-index:2147483647;";
      l.root.appendChild(dot);
      if (dot.animate) {
        dot.animate(
          [{ transform: "scale(0.4)", opacity: 1 }, { transform: "scale(1.7)", opacity: 0 }],
          { duration: 500, easing: "ease-out" }
        );
      }
      setTimeout(function () { try { dot.remove(); } catch (e) {} }, 520);
    } catch (e) {}
  }
  /** The agent's mouse. One node, moved — a node per event would thrash a busy page. */
  function moveCursor(x, y) {
    try {
      var l = shadow();
      if (!l) return;
      if (!l.cursor || !l.cursor.isConnected) {
        var c = document.createElement("div");
        c.style.cssText =
          "position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;" +
          "background:rgba(255,171,0,0.55);box-shadow:0 0 0 2px rgba(255,171,0,0.95),0 0 12px 4px rgba(255,171,0,0.35);" +
          "pointer-events:none;z-index:2147483647;transition:left .08s linear,top .08s linear,opacity .25s;";
        l.root.appendChild(c);
        l.cursor = c;
      }
      l.cursor.style.left = x + "px";
      l.cursor.style.top = y + "px";
      l.cursor.style.opacity = "1";
      // Fade out when the pointer goes quiet, so a page nobody is driving is not permanently marked.
      l.hideAt = Date.now() + 2500;
      if (!l.timer) {
        l.timer = setInterval(function () {
          if (l.cursor && Date.now() > l.hideAt) l.cursor.style.opacity = "0";
        }, 500);
      }
    } catch (e) {}
  }
  /** Says WHAT was clicked, not only where — the outline sits on the element for a beat. */
  function outline(el) {
    try {
      if (!el || !el.getBoundingClientRect) return;
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      var l = shadow();
      if (!l) return;
      var box = document.createElement("div");
      box.style.cssText =
        "position:fixed;left:" + (r.left - 2) + "px;top:" + (r.top - 2) + "px;" +
        "width:" + (r.width + 4) + "px;height:" + (r.height + 4) + "px;border-radius:4px;" +
        "border:2px solid rgba(255,171,0,0.9);pointer-events:none;z-index:2147483647;";
      l.root.appendChild(box);
      if (box.animate) box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, easing: "ease-out" });
      setTimeout(function () { try { box.remove(); } catch (e) {} }, 920);
    } catch (e) {}
  }
  w.addEventListener("pointerdown", function (e) {
    if (!e || typeof e.clientX !== "number") return;
    ping();
    moveCursor(e.clientX, e.clientY);
    ripple(e.clientX, e.clientY);
    outline(e.target);
  }, true);
  w.addEventListener("pointermove", function (e) {
    if (!e || typeof e.clientX !== "number") return;
    ping();
    moveCursor(e.clientX, e.clientY);
  }, true);
  w.addEventListener("keydown", ping, true);
  function report(form) {
    try {
      var pw = form.querySelector("input[type=password]");
      if (!pw || !pw.value) return;
      var user = "";
      var inputs = Array.prototype.slice.call(form.querySelectorAll("input"));
      var idx = inputs.indexOf(pw);
      for (var i = idx - 1; i >= 0; i--) {
        var el = inputs[i];
        var type = (el.type || "text").toLowerCase();
        if (["text", "email", "tel", ""].indexOf(type) >= 0 && el.value) { user = el.value; break; }
      }
      if (w.__vibehubCapture) w.__vibehubCapture(JSON.stringify({ url: location.href, username: user, password: pw.value }));
    } catch (e) {}
  }
  document.addEventListener("submit", function (e) {
    var t = e.target;
    if (t && t.tagName === "FORM") report(t);
  }, true);
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("button, input[type=submit]") : null;
    if (!btn) return;
    var form = btn.closest("form");
    if (form) setTimeout(function () { report(form); }, 0);
  }, true);
}`;

export const CDP_RUNNER_SOURCE = String.raw`
import net from "node:net";
import crypto from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";

const payload = JSON.parse(Buffer.from(readFileSync(process.argv[2], "utf8").trim(), "base64").toString("utf8"));
// Shred both files the moment the payload is in memory — a fill payload carries the secret value,
// and even the capture payload should not linger. rm in the wrapper is only a belt for a crash here.
for (const f of [process.argv[1], process.argv[2]]) { try { unlinkSync(f); } catch { /* ignore */ } }
const CDP_PORT = payload.cdpPort;

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(CDP_PORT, "127.0.0.1", () => {
      sock.write("GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    });
    let buf = "";
    sock.setTimeout(8000, () => { sock.destroy(); reject(new Error("cdp http timeout")); });
    sock.on("data", (d) => { buf += d.toString(); });
    sock.on("error", reject);
    sock.on("close", () => {
      const i = buf.indexOf("\r\n\r\n");
      resolve(i >= 0 ? buf.slice(i + 4) : buf);
    });
  });
}

async function pickPageTarget() {
  const list = JSON.parse(await httpGet("/json/list"));
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || list.find((t) => t.webSocketDebuggerUrl);
  if (!page) throw new Error("no browser page is open in this card");
  return page.webSocketDebuggerUrl;
}

/** Minimal CDP WebSocket client (client-masked frames, text only). */
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const port = u.port || 80;
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(Number(port), u.hostname, () => {
      sock.write(
        "GET " + u.pathname + u.search + " HTTP/1.1\r\n" +
        "Host: " + u.host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let handshaken = false;
    let acc = Buffer.alloc(0);
    const handlers = new Map();
    const listeners = [];
    let nextId = 1;
    const api = {
      send(method, params) {
        const id = nextId++;
        return new Promise((res, rej) => {
          handlers.set(id, { res, rej });
          frame(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      on(fn) { listeners.push(fn); },
      close() { try { sock.destroy(); } catch { /* ignore */ } },
      onclose: null,
    };
    function frame(text) {
      const data = Buffer.from(text, "utf8");
      const len = data.length;
      const mask = crypto.randomBytes(4);
      let header;
      if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    }
    function dispatch(text) {
      let msg; try { msg = JSON.parse(text); } catch { return; }
      if (msg.id && handlers.has(msg.id)) {
        const h = handlers.get(msg.id); handlers.delete(msg.id);
        if (msg.error) h.rej(new Error(msg.error.message || "cdp error")); else h.res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    }
    sock.setTimeout(0);
    sock.on("data", (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      if (!handshaken) {
        const i = acc.indexOf("\r\n\r\n");
        if (i < 0) return;
        const head = acc.slice(0, i).toString();
        if (!/101/.test(head)) { reject(new Error("cdp ws handshake failed")); return; }
        handshaken = true;
        acc = acc.slice(i + 4);
        resolve(api);
      }
      // decode server frames (unmasked)
      while (acc.length >= 2) {
        const b1 = acc[1];
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) { if (acc.length < 4) break; len = acc.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (acc.length < 10) break; len = Number(acc.readBigUInt64BE(2)); off = 10; }
        if (acc.length < off + len) break;
        const opcode = acc[0] & 0x0f;
        const data = acc.slice(off, off + len);
        acc = acc.slice(off + len);
        if (opcode === 0x8) { sock.destroy(); return; }
        if (opcode === 0x1 || opcode === 0x0) dispatch(data.toString("utf8"));
      }
    });
    sock.on("error", reject);
    sock.on("close", () => { if (handshaken && api.onclose) api.onclose(); });
    sock.setTimeout(20000);
  });
}

async function doFill() {
  const ws = await connectCdp(await pickPageTarget());
  await ws.send("Runtime.enable");
  if (payload.url) {
    await ws.send("Page.enable").catch(() => {});
    const loaded = new Promise((res) => {
      const to = setTimeout(res, 15000);
      ws.on((m) => { if (m.method === "Page.loadEventFired") { clearTimeout(to); res(undefined); } });
    });
    await ws.send("Page.navigate", { url: payload.url });
    await loaded;
    // A beat for client-side rendered login forms to mount their inputs.
    await new Promise((r) => setTimeout(r, 600));
  }
  const filled = [];
  for (const field of payload.plan.fields) {
    const secret = payload.secrets[field.ref];
    if (secret == null) continue;
    const expr = "(" + FOCUS_FN + ")(" + JSON.stringify(field) + ")";
    const r = await ws.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (!r || !r.result || r.result.value !== true) continue;
    await ws.send("Input.insertText", { text: secret });
    filled.push(field.ref);
  }
  ws.close();
  process.stdout.write(JSON.stringify({ filled: filled.length > 0, fields: filled }) + "\n");
}

async function doCapture() {
  const ws = await connectCdp(await pickPageTarget());
  // The browser died (or this page went away): exit so the back forgets this listener and the next
  // start injects a fresh observer into the NEW browser — capture and the click ripple come back.
  ws.onclose = () => process.exit(0);
  await ws.send("Runtime.enable");
  await ws.send("Page.enable").catch(() => {});
  await ws.send("Runtime.addBinding", { name: "__vibehubCapture" });
  const install = "(" + OBSERVER_FN + ")()";
  await ws.send("Page.addScriptToEvaluateOnNewDocument", { source: install }).catch(() => {});
  await ws.send("Runtime.evaluate", { expression: install }).catch(() => {});
  ws.on((msg) => {
    if (msg.method === "Runtime.bindingCalled" && msg.params && msg.params.name === "__vibehubCapture") {
      try {
        const c = JSON.parse(msg.params.payload);
        // Two kinds of report ride this one binding: "someone is working in here" (no payload at
        // all) and an actual captured login.
        if (c.act) process.stdout.write(JSON.stringify({ type: "activity" }) + "\n");
        else process.stdout.write(JSON.stringify({ type: "capture", url: c.url, username: c.username, password: c.password }) + "\n");
      } catch { /* ignore malformed */ }
    }
    // Re-install the observer after a navigation so a fresh document is watched too.
    if (msg.method === "Page.frameNavigated" && msg.params && msg.params.frame && !msg.params.frame.parentId) {
      ws.send("Runtime.evaluate", { expression: install }).catch(() => {});
    }
  });
  process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");
  // Stay alive until the parent kills us (browser closed).
  setInterval(() => {}, 1 << 30);
}

const FOCUS_FN = ${JSON.stringify(FOCUS_SRC)};
const OBSERVER_FN = ${JSON.stringify(OBSERVER_SRC)};

const run = payload.mode === "capture" ? doCapture : doFill;
run().catch((e) => {
  process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }) + "\n");
  if (payload.mode !== "capture") process.exit(1);
});
`;

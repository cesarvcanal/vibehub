# Preview — open an app running in the runner

A card's agent often starts a server inside the runner — `npm run dev`, an API, anything on a TCP
port. **Preview** puts that server in your own browser tab.

## How to use it

1. In a card, click **Preview** in the card bar (on a phone: the globe next to the connection dot).
2. The menu scans the runner and lists every port that is listening, with the process name.
3. Click a port — or type one — and it opens in a new tab at `http://<vibehub>/preview/<port>/`.

## The request → link flow (`vibehub_preview`)

You should not have to hunt for ports. Ask the card's agent for a preview ("roda um preview",
"quero ver") and the flow is:

1. The agent starts the dev server inside the runner and waits for it to listen.
2. It calls the **`vibehub_preview`** MCP tool with `{ card, port, label }`. vibehub verifies the
   port is actually listening (same scan as the menu), records the preview on the card and returns
   the full URL (`<publicUrl>/preview/<port>/`).
3. The agent answers with that link, and the card grows a **chip** ("Preview: front") on its bar —
   click it and the app opens in a new tab. The Preview menu lists the announced previews first,
   above the raw port scan.

If the announced port is not listening, the tool refuses and tells the agent what is — so a link
you receive is a link that worked at the moment it was announced. Registered previews whose port
stops listening are pruned the next time the runner is scanned (opening the menu does it); there
is no background daemon watching them.

## How it works

The runner container publishes no ports and sits on a Docker network your machine cannot route to,
so there is no direct URL to hand out. vibehub **proxies** instead:

```
your browser ──HTTP/WS──▶ vibehub  ──docker exec socat──▶ 127.0.0.1:<port> inside the runner
              /preview/<port>/...
```

- Each connection rides its own tunnel through the host executor — the same mechanism the card
  browser's VNC bridge uses — so it works identically whether Docker is local or across SSH.
- The target is the **runner's loopback**, so servers bound to `127.0.0.1` (the default for vite,
  Next.js, etc.) are reachable without `--host`.
- **WebSockets are relayed** byte-for-byte, so vite HMR / live reload works.
- Auth is your vibehub session: the preview URL is same-origin, the cookie rides along, and nobody
  without a session can reach the proxied app. The `vibehub_session` cookie itself is stripped
  before requests cross into your app.
- The proxy sends `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-For` and
  `X-Forwarded-Prefix: /preview/<port>`.
- The port list comes from the runner's `/proc/net/tcp`, so it needs no tools installed; vibehub's
  own per-card browser ports (VNC 5900–6799, CDP 9222–10121) are hidden from it.

## Limitations

- **Apps that generate absolute URLs must know their base path.** The app is served under
  `/preview/<port>/`, and an app that emits `<script src="/src/main.tsx">` will 404. Either honour
  `X-Forwarded-Prefix`, or configure the base explicitly:
  - **vite**: `base: '/preview/5173/'` in `vite.config.ts` (or `vite --base /preview/5173/`).
    That also fixes the HMR websocket path.
  - **Next.js**: `basePath: '/preview/3000'` in `next.config.js`.
  - Plain static servers and most APIs use relative paths and need nothing.
- **No keep-alive**: every HTTP request opens its own tunnel (`Connection: close`), so a page with
  hundreds of dev-server modules loads noticeably slower than direct access. Fine for previewing;
  not a benchmark environment. WebSockets are one tunnel per socket and unaffected.
- **One runner**: the scan and the proxy target the configured runner container. There is no
  multi-runner routing.
- No HTTPS termination, per-port subdomains or per-preview auth — the vibehub session is the gate.

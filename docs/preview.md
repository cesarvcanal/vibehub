# Preview — open an app running in the runner

A card's agent often starts a server inside the runner — `npm run dev`, an API, anything on a TCP
port. **Preview** puts that server in your own browser tab.

## How to use it

1. In a card, click **Preview** in the card bar (on a phone: the globe next to the connection dot).
2. The menu scans the runner and lists every port that is listening, with the process name.
3. Click a port — or type one — and it opens in a new tab at `/preview/<port>/` on the **same
   origin you are using**: the panel is reachable through more than one host (a VPN IP, a domain
   behind a gateway) and every preview link is relative, so it works on all of them.

## The request → link flow (`vibehub_preview`)

You should not have to hunt for ports. Ask the card's agent for a preview ("roda um preview",
"quero ver") and the flow is:

1. The agent starts the dev server inside the runner and waits for it to listen.
2. It calls the **`vibehub_preview`** MCP tool with `{ card, port, label, command, cwd }`. vibehub
   verifies the port is actually listening (same scan as the menu), records the preview on the
   card — **including the start command**, which is the relaunch recipe — and returns the link:
   the canonical `path` (`/preview/<port>/`, valid on any host the panel is opened on) plus `url`
   (that path on the configured public URL, one example host).
3. The agent answers with that link, and the card grows a **chip** ("Preview: front") on its bar —
   click it and the app opens in a new tab. The Preview menu lists the announced previews first,
   above the raw port scan.

If the announced port is not listening, the tool refuses and tells the agent what is — so a link
you receive is a link that worked at the moment it was announced.

## Preview lifecycle — it outlives the card session

A server the agent starts lives inside the card's tmux pane, and everything that ends the card
session (pause, hibernate, restart, a model switch) tree-kills that pane's descendants — so the
server dies with the card. Registered previews survive that on purpose:

- **State on the chip.** The chip (and each row in the menu) carries the live state from the port
  scan: green = listening, amber "parado" = the port went silent, neutral gray = not verified yet
  (no scan answered). **Green is earned by the scan** — the chip never claims "no ar" it did not
  see.
- **Stopped ≠ dead.** Clicking a stopped preview never lands on a bare 502: it opens a small
  "Preview parado" screen. **Restart** relaunches the stored command in the preview's **own tmux
  session** in the runner (`preview-<card8>-<port>` — outside the card's kill tree, invisible to
  the process reaper), waits until the port listens and opens the tab. From that point the server
  belongs to the preview, and pausing/restarting the card no longer touches it.
- **Adoption semantics.** Announcing a preview does **not** move the running server: the process
  the agent started stays where it is, inside the card's pane (Linux offers no re-parenting of a
  live process). The move into the dedicated session happens at the **first Restart** — until
  then, anything that kills the card session kills the server too, the chip goes amber, and
  bringing it back is the one Restart click.
- **A dead link in the tab is a screen, not JSON.** Navigating to `/preview/<port>/` while the
  port is silent answers the same "Preview parado" screen straight from the proxy — with the
  Reiniciar button when the port belongs to a registered preview that stored its command, or the
  "ask the agent" guidance when it did not. Asset and API requests made by the previewed app keep
  the structured JSON 502.
- **No stored command** (an old or manual registration): the screen says the honest thing — ask
  the card's agent to start the server again; it will re-announce the link.
- **Stop preview** (the ✕ on the row, or the button in the dialog) tree-kills the dedicated
  session and removes the chip.
- **Cleanup without a daemon:** a registered preview whose port stopped listening and that has
  **no** relaunch command is pruned on the next scan (opening the menu does it). Previews with a
  command are kept — stopped and restartable is exactly their point.

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

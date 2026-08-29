# SDK driver — Fase 1, increments 1 e 2

Implements step 1 of `docs/sdk-migration-plan.md` §4: a **per-card SDK driver** that can run a card's
Claude session through the Agent SDK (`query()`) instead of the tmux/send-keys TUI. It is **opt-in,
OFF by default, and purely ADDITIVE** — with the flag off, the TUI/chat/provisioning path is
byte-for-byte unchanged. Nothing here removes or reroutes the existing terminal.

Built on the proven spike (`spikes/sdk-poc/`, branch `card/spike-sdk-poc`). Reuses its findings:
`bypassPermissions` auto-allows, a `PreToolUse` hook is the selective gate under bypass, resume works
by `session_id`, and a **bare-name allowlist SHADOWS the permission callback** (see the risk below).

## The flag

`sdkDriver: boolean` in `back/src/services/settings/settings.ts` — **default `false`**. Mirrors the
`transcribeProofread` pattern (interface + DEFAULTS + `SettingsPatch` + boolean validation + apply).
Toggle it via `PATCH /api/settings { "sdkDriver": true }`. It only gates the SDK websocket below.

## The pieces

| File | What |
|---|---|
| `back/src/services/sdk/sdk-driver.mjs` | The **driver process**. Runs IN the runner (Node, in the card's worktree). `query()` with `bypassPermissions` + a `PreToolUse` gate; NDJSON events on stdout; user messages on stdin. |
| `back/src/services/sdk/protocol.ts` | Pure contract: `DriverEvent` types, `parseDriverLine`, `encodeControl`, and the permission classifier (`classifySensitivity` / `sdkPermissionDecision`). Unit-tested; the driver embeds a mirror copy. |
| `back/src/services/sdk/driver.ts` | Installs the driver into the runner (`docker exec`, atomic) and builds the spawn command (`docker exec -i … bash -c '<token guard>; exec node …'`), resolved through the host executor. |
| `back/src/routes/cardSdk.ts` | The **websocket** `GET /api/cards/:id/sdk`. Flag-gated; spawns the driver and bridges events ↔ stdin. Entirely separate from the terminal/chat routes. |

The driver `.mjs` is copied into `dist` by `back/scripts/build-assets.mjs` (tsc ignores `.mjs`).

## The wire contract (consumed by the front's `SdkChatView` since increment 2)

The websocket sends **one JSON text frame per event**:

```jsonc
{ "type": "ready", "resume"?: "<sessionId>" }              // driver is up
{ "type": "session", "sessionId": "<uuid>" }               // learned the session id (resume key)
{ "type": "assistant_delta", "text": "…" }                 // live token stream
{ "type": "assistant_text", "text": "…" }                  // consolidated text block
{ "type": "tool_use", "id": "toolu_…", "name": "Write", "input": { … } }
{ "type": "permission", "tool": "Bash", "decision": "allow"|"deny", "sensitive": bool, "reason"?: "…", "id"?: "…", "timedOut"?: bool }
{ "type": "permission_request", "id": "perm_…", "tool": "Bash", "input"?: { … }, "reason"?: "…" }  // AWAITS a decision
{ "type": "result", "isError": bool, "sessionId"?: "…", "subtype"?: "success", "result"?: "…", "permissionDenials"?: [ … ] }
{ "type": "error", "message": "…" }
{ "type": "parse_error", "raw": "<the bad line>" }          // back-synthesised; nothing is swallowed
```

The front sends, per message: a JSON object `{ "type": "user", "text": "…" }`,
`{ "type": "interrupt" }`, or `{ "type": "permission_decision", "id": "…", "allow": true|false }`
(the answer to a `permission_request`) — **or a bare string**, which is treated as a user message.
Multi-turn works by resume: the driver captures `session_id`, the route persists it on the card
(`resumeSessionId`), and the next spawn continues the same session.

## Permission model (increment 2 — live)

`bypassPermissions` auto-allows the bulk ("libera tudo, pergunta só o sensível" — decisão do César).
The driver's **own** `PreToolUse` hook classifies the **SENSITIVE set** — `rm -r/-f`,
`git push --force`, `git reset --hard`, deploy-shaped commands (kubectl/helm/vercel/…),
`npm publish`, `curl | sh`, and reads of secret files (`.env`, `id_rsa`, `.oauth-token`, …) — and
**ESCALATES it to the chat**:

1. the hook emits `permission_request { id, tool, input, reason }` and **AWAITS**;
2. the front draws the **"Permitir / Negar"** card; a click sends
   `{ "type": "permission_decision", "id", "allow": true|false }` back down the socket;
3. no answer for **5 minutes** (`PERMISSION_TIMEOUT_MS`) ⇒ automatic **deny**;
4. either way the driver emits `permission { id, decision, sensitive: true, timedOut? }` so the card
   settles ("Permitida" / "Negada" / "Sem resposta — negada").

The pending ledger is `createPermissionBroker` in `protocol.ts` (unit-tested; the driver embeds the
mirror). An `interrupt` denies everything still pending and interrupts the running `query()`.

## Auth — OAuth token ONLY (ordem do César)

The driver authenticates **exclusively** with `CLAUDE_CODE_OAUTH_TOKEN`, read from the card
profile's `.oauth-token` (the Max subscription's setup-token, same as the TUI's session command).
The spawn line **`unset ANTHROPIC_API_KEY`** before `exec node`, and the driver itself runs
`delete process.env.ANTHROPIC_API_KEY` on boot — two locks on the same door, both tested. An
inherited API key would silently outrank the token and bill the API instead of the subscription;
it can never reach the SDK.

## ✅ The shadowing risk (PoC finding #1) — AUDITED (increment 2)

A **bare-name entry in `allowedTools`, or an `allow` rule in the runner's `settings.json`,
auto-approves that tool BEFORE any callback/hook runs** — silently (only a stderr warning
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`).

**Audit result (2026-08-29):** nothing vibehub provisions can shadow the escalation.

- `runnerSettingsJson({autonomous})` (`back/src/runtime/runner.ts`) writes
  `permissions: { defaultMode: "bypassPermissions" }` + hooks + env — **no `allowedTools`, no
  `permissions.allow` rules**, and no other code path writes them. (`defaultMode` is not a rule:
  it cannot pre-approve a specific tool past the hook.)
- Account profiles are seeded by **copying** that same default `settings.json`
  (`workspace.ts`), so they carry no allow rules either.
- The driver passes **no `allowedTools`** in its `query()` options and brings its **own**
  `PreToolUse` hook, which fires regardless of settings.

Residual caution (documented, not code): a **repo's own** `.claude/settings.json` committed inside
a card worktree could carry `allow` rules. vibehub does not write those; if a project adds them,
that project has chosen to pre-approve those tools for itself.

## Provisioning — automatic now

The `npm i` that used to be a manual prerequisite is part of the connect path:
`installCardSdkDriver()` plants the driver `.mjs` **and** runs `buildEnsureSdkScript`, which
installs `@anthropic-ai/claude-agent-sdk@<SDK_PACKAGE_VERSION>` into `/root/.vibehub-sdk` **only
when the `.sdk-version` marker disagrees** — the first connect pays one npm install, every one
after is a marker check. Bumping `SDK_PACKAGE_VERSION` in `driver.ts` is how the SDK is upgraded.
The runner container is never recreated.

## Session persistence

The driver emits the `session_id` (`session` / `result` events); the `/sdk` route persists each
NEW id onto the card (`resumeSessionId` in board.json, deduplicated). The next driver spawn — a
reconnect, the card reopened tomorrow — passes `--resume <id>` and continues the SAME conversation.
The chat footer shows the short session id (the resume key you are on).

## Turning it on — two switches, both off by default

1. **Global:** the `sdkDriver` setting — the "Driver SDK (chat nativo, beta)" switch in
   **Configurações**, or `PATCH /api/settings { "sdkDriver": true }`. Off = the `/sdk` socket
   refuses; NOTHING anywhere changes.
2. **Per card:** the card menu (`⋯`) → **"Chat nativo (beta)"**. Only cards with this checked use
   the SDK chat — every other card stays on the TUI/transcript path. This is the guinea-pig knob.

## Validação pela tela (roteiro do César)

1. **Ligar o flag global:** Configurações → "Driver SDK (chat nativo, beta)" → salvar.
2. **Escolher UM card de teste:** abrir o card → menu `⋯` → marcar **"Chat nativo (beta)"**.
3. **Ir pra aba Chat** do card: o rodapé mostra "Chat nativo (beta)" com a bolinha de conexão.
   (Primeira vez pode demorar alguns segundos extras: é o npm install único do SDK no runner.)
4. **Conversar:** mandar "cria hello.txt com HELLO e lê de volta". Esperado: resposta streamando,
   linhas compactas de ferramenta (Write/Read), fim de turno; o rodapé passa a mostrar `sessão
   <id>`.
5. **Pedir ação sensível:** mandar "roda exatamente: rm -rf .". Esperado: o card âmbar
   **"Permissão necessária"** com **Permitir / Negar**.
   - **Negar** → o agente é bloqueado e segue; o card mostra "Negada".
   - Repetir e **Permitir** → a ação roda; o card mostra "Permitida".
   - Não responder → em 5 minutos nega sozinho ("Sem resposta — negada").
6. **Interromper:** com um turno rodando, o botão ⏹ ao lado do composer manda o interrupt.
7. **Resume:** fechar e reabrir o card (ou recarregar a página) e mandar "qual arquivo criamos?".
   Esperado: responde com contexto — mesma sessão (mesmo id no rodapé), via o `resumeSessionId`
   persistido no card.
8. **Isolamento:** qualquer outro card (sem o toggle) segue exatamente como antes; desligar o flag
   global desliga tudo (o chat nativo passa a mostrar o aviso de driver desligado).

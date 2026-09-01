# SDK driver — o chat nativo

Implements step 1 of `docs/sdk-migration-plan.md` §4: a **per-card SDK driver** that can run a card's
Claude session through the Agent SDK (`query()`) instead of the tmux/send-keys TUI. It is **opt-in,
OFF by default, and purely ADDITIVE** — with the flag off, the TUI/chat/provisioning path is
byte-for-byte unchanged. Nothing here removes or reroutes the existing terminal.

Built on the proven spike (`spikes/sdk-poc/`, branch `card/spike-sdk-poc`). Reuses its findings:
`bypassPermissions` auto-allows, a `PreToolUse` hook is the selective gate under bypass, resume works
by `session_id`, and a **bare-name allowlist SHADOWS the permission callback** (see the risk below).

## The flag

`sdkDriver: boolean` in `back/src/services/settings/settings.ts` — **default `true`** since
2026-08-31 (the native chat graduated: it IS the Chat tab of every card). Off is the install-wide
fallback to the classic chat: the front mounts the transcript chat everywhere (it learns the flag
from `GET /api/features`, which any signed-in user can read) and the `/sdk` websocket does not
start. `PATCH /api/settings { "sdkDriver": false }` or the "Chat nativo" switch in Configurações.

`sdkPermissionMode: "same-as-terminal" | "ask-sensitive"` — **default `"same-as-terminal"`** — picks
the driver's permission-gate behaviour; see "Permission model" below.

## The pieces

| File | What |
|---|---|
| `back/src/services/sdk/sdk-driver.mjs` | The **driver process**. Runs IN the runner (Node, in the card's worktree). `query()` with `bypassPermissions` + a `PreToolUse` gate; NDJSON events on stdout; user messages on stdin. |
| `back/src/services/sdk/protocol.ts` | Pure contract: `DriverEvent` types, `parseDriverLine`, `encodeControl`, and the permission classifier (`classifySensitivity` / `sdkPermissionDecision`). Unit-tested; the driver embeds a mirror copy. |
| `back/src/services/sdk/driver.ts` | Installs the driver into the runner (`docker exec`, atomic) and builds the spawn command (`docker exec -i … bash -c '<token guard>; exec node …'`), resolved through the host executor. |
| `back/src/services/sdk/manager.ts` | O **dono do driver**: UM driver por card, propriedade do BACK (não da conexão). Multiplexa todos os websockets do card, persiste history/resume-id do lado que sobrevive, e cuida do fim de vida (killCardSession + idle). |
| `back/src/routes/cardSdk.ts` | The **websocket** `GET /api/cards/:id/sdk`. Flag-gated; faz o trabalho por-conexão (replay, mirror, quem digita) e ATTACHA no driver vivo do card via o manager. Entirely separate from the terminal/chat routes. |

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
`{ "type": "interrupt" }`, `{ "type": "permission_decision", "id": "…", "allow": true|false }`
(the answer to a `permission_request`), or `{ "type": "edit_user", "original": "…", "text": "…" }`
(editar uma mensagem enviada — ver a seção *Editar mensagem*) — **or a bare string**, which is
treated as a user message.
Multi-turn works by resume: the driver captures `session_id`, the route persists it on the card
(`resumeSessionId`), and the next spawn continues the same session.

## Editar mensagem (supersede) — só no chat nativo

O usuário pode editar uma mensagem que já mandou (lápis na bolha; Esc com o campo vazio edita a
última; Esc durante a edição cancela e devolve o rascunho). Como o modelo **já leu** a original, a
edição não reescreve o passado — é um **supersede**:

- O front manda `{ "type": "edit_user", "original", "text" }`. Se o turno disparado pela mensagem
  original ainda está rodando, ele manda `interrupt` ANTES (o mesmo frame do botão parar) e segura a
  edição até o `result`/`aborted` daquele turno (timeout de segurança de 15s — o driver enfileira
  turnos de todo jeito).
- O manager (`handleClientFrame`) embrulha o texto com `buildSupersedeText` (protocol.ts) e escreve
  no stdin do driver **um turno `user` normal** — o driver não conhece `edit_user`:

  ```
  [correção do usuário — desconsidere a mensagem anterior:
  «<original>»
  e considere esta versão no lugar:]

  <texto editado>
  ```

  A proveniência continua a do USUÁRIO — é fala dele, corrigida.
- A história (ndjson) ganha duas linhas: `{ "type": "message_edited", "originalText" }` (a bolha
  original é redesenhada atenuada com o selo "editada" — no replay também) e o novo
  `{ "type": "user", "text": <limpo>, "sent": <embrulhado> }`. `text` é o que a TELA mostra;
  `sent` é o que foi pro stdin — e é pelo `sent` que `replayDedupeKey` casa a linha embrulhada que
  o transcript vai carregar, então o replay nunca desenha o embrulho nem duplica a mensagem.
- Turno e marcador in-flight contam como um envio normal (deploy resume incluído).

**O chat clássico (transcript/tmux) não tem edição**: o caminho dele é `send-keys` na TUI — não há
como interromper semanticamente o turno nem falar de supersede com o motor; a tecla Esc lá já é o
próprio stop do terminal. A edição é um recurso do driver SDK.

## Escada de estados — feedback imediato ao enviar ("Preparando… → Pensando… → Trabalhando…")

Entre o Enter e o primeiro token existem segundos reais (o driver roda `query()` por turno: subir o
subprocess, carregar MCPs, resume da sessão). Para a mensagem nunca parecer perdida, o reducer
marca `awaiting` no envio próprio (`appendUserRow` com `awaiting`) e a view mostra **um** indicador
(nunca empilhado, mesmo assento do spinner):

- `awaiting && !ready` → **"Preparando…"** (driver frio, ainda subindo/retomando a sessão);
- `awaiting && ready` → **"Pensando…"** (o turno está no motor, nenhum token ainda);
- primeiro evento do driver (delta/tool/result…) limpa `awaiting` → o **"Trabalhando…"** normal
  assume (ou nada, se o turno acabou).

Replay e mensagens externas nunca acendem a escada — ela narra o NOSSO envio.

**Warm-up**: a rota já garante o driver de pé no CONNECT do websocket (`ensureDriverSession` roda a
cada conexão, antes de qualquer mensagem) — o arranque frio do processo acontece enquanto o usuário
digita, sem contar turno nem marcar in-flight (teste em manager.test.ts). A latência que resta é o
`query()` por turno dentro do driver; eliminá-la de verdade pede o modo streaming-input do SDK (uma
`query()` persistente por sessão) — anotado como próximo passo, fora deste incremento.

## Permission model — a configurable MODE (`sdkPermissionMode`)

Decisão de produto do mantenedor: o gate do driver virou um **modo configurável**,
`sdkPermissionMode`, com **`"same-as-terminal"` como default**.

- **`"same-as-terminal"`** — o chat nativo tem **exatamente o mesmo comportamento de permissões da
  aba Terminal do mesmo card**: o terminal roda o Claude sob as settings do próprio runner
  (`bypassPermissions` quando a instalação é autônoma) sem nenhum gate do vibehub por cima — então o
  hook do driver não escala nada, só emite eventos `permission` de observabilidade. Racional: um
  card, duas telas, UMA história de permissões — o gate antigo chegou a pedir confirmação para um
  `rm` do próprio scratchpad `/tmp` do agente, uma fricção que o terminal nunca teve.
- **`"ask-sensitive"`** — o comportamento anterior, mantido para cenários futuros (membros
  compartilhados, revisão só pelo celular): o conjunto SENSÍVEL escala para os botões
  Permitir/Negar no chat, como descrito abaixo. Toda a infraestrutura de `permission_request` /
  botões / timeout continua viva e testada neste modo.

O modo viaja para o driver como `--permission-gate` (fallback: `ask-sensitive`, o modo mais
estrito, para um driver spawnado sem a flag). A decisão pura é `sdkGateAction` em `protocol.ts`
(unit-tested; o driver embute o espelho).

### O modo `ask-sensitive`, por dentro

`bypassPermissions` auto-allows the bulk ("libera tudo, pergunta só o sensível").
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

## Perguntas com opções — AskUserQuestion no chat

O agente pode PERGUNTAR em vez de chutar: quando o modelo chama a tool nativa **AskUserQuestion**,
o SDK roteia a chamada pelo callback **`canUseTool`** em QUALQUER permission mode
(`bypassPermissions` incluído — é uma pergunta ao humano, não uma permissão). O driver intercepta:

1. valida/normaliza o input (`normalizeUserQuestions`) e emite
   `user_question { id, questions: [{ question, header?, options: [{label, description?}], multiSelect? }] }`;
2. o front desenha o **card de pergunta**: opções clicáveis por questão + campo livre
   **"Outra resposta…"**. Uma pergunta única de escolha única responde NO CLIQUE; multi-select (ou
   várias perguntas) coleta as escolhas e envia com um "Responder";
3. a resposta volta como `{ "type": "question_answer", "id", "answers": [{ "selected": [...] }] }`
   (uma entrada por pergunta, na ordem; texto livre é mais uma string em `selected`);
4. o driver devolve ao modelo via `updatedInput` (`{ questions, answers: { "<pergunta>": label | labels[] } }`,
   `buildAskUserAnswers`) e emite `question_result { id, answers }` para o card assentar
   ("Respondida: …");
5. **timeout generoso** (`QUESTION_TIMEOUT_MS`, 30 min): sem resposta, o modelo recebe um deny
   dizendo que o usuário não respondeu e que siga com o melhor julgamento; o card mostra "Sem
   resposta". Um `interrupt` cancela as perguntas pendentes do turno.

O par `user_question`/`question_result` é persistido no `sdk-history`: o replay re-desenha uma
pergunta pendente CLICÁVEL (o driver é do card e continua aguardando — F5 não perde a pergunta,
como a permissão) e uma respondida/expirada já assentada. Ledger: `createQuestionBroker` em
`protocol.ts` (unit-tested; o driver embute o espelho).

## As mesmas ferramentas do terminal (MCPs, navegador, CLAUDE.md)

O chat nativo carrega a MESMA configuração que a sessão TUI do card — o agente precisa poder
navegar, clicar e testar (Chrome/preview) igualzinho ao terminal, com o usuário acompanhando:

- `settingSources: ["user", "project", "local"]` no `query()` — o perfil do card traz os MCPs
  gerenciados (`vibehub`, cujas instructions SÃO a persona maestro; `navegador`; os registrados) e
  as settings do runner (status hooks — o dot de atividade segue o chat nativo —, persistência de
  sessão); o worktree traz o `.mcp.json` e settings do repo. Explícito de propósito: o default do
  SDK hoje é "all sources", mas um flip futuro não pode tirar as ferramentas em silêncio.
- `systemPrompt: { type: "preset", preset: "claude_code" }` — o prompt do próprio Claude Code, que
  é também o que carrega os CLAUDE.md (o brain na raiz do perfil e o do repo). Antes o driver
  rodava no prompt cru do SDK.
- O spawn (`buildSdkDriverCommandLine`) exporta o que a sessão tmux sempre exportou:
  `PW_CDP_ENDPOINT` (o MCP `navegador` resolve para o Chromium DESTE card — o mesmo que o usuário
  assiste no noVNC, botão Navegador), `VIBEHUB_CARD_ID` e `VIBEHUB_STATUS_URL` (os hooks de status
  do settings.json do runner passam a reportar o card certo).

No painel Navegador, o usuário escolhe entre **"Só assistir"** (default; conexão view-only do RFB —
o mouse dele não interfere no agente) e **"Pilotar junto"** (input habilitado; entra JUNTO do
controle do agente — o agente dirige via CDP, canal separado do VNC, ninguém expulsa ninguém). O
toggle troca `viewOnly` na conexão viva, sem reconectar.

## Auth — OAuth token ONLY (regra do projeto)

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

## Deploy resume — um turno em voo sobrevive ao restart do painel (2026-09-01)

Um push na `main` reinicia o app-vibehub; o driver é filho do back (docker exec) e **morre junto,
no meio do turno** — 2x em produção o card ficou mudo. A resposta:

- **Marcador durável por card** (`<dataDir>/sdk-inflight/<cardId>.json`, ver
  `services/sdk/inflight.ts`): escrito quando um turno de usuário entra no stdin do driver
  (`{startedAt, preview, attempts}`), removido quando o `result` fecha o último turno em voo, e
  também num stop DELIBERADO (pause/hibernate/delete — o que a pessoa encerrou não se retoma).
- **SIGTERM** (o docker stop do deploy): `shutdownAllDrivers()` encerra o stdin de cada driver
  (EOF = saída limpa, atravessa o docker exec) e **mantém os marcadores** — eles são a mensagem
  para o próximo boot.
- **Sweep de boot** (`services/sdk/resume.ts`, depois do listen): para cada marcador órfão, o card
  ganha uma **linha de sistema** no sdk-history (`system_note`, replayed como nota no chat) e —
  com `sdkAutoResume` ligado (default) — o driver sobe de novo (`--resume` da chave persistida) e
  recebe um turno de continuação **como turno de usuário normal** (nunca embrulhado em
  notificação), com **proveniência `system`** (#48) para nunca parecer fala da pessoa.
- **Sem loop:** o turno retomado nasce com `attempts: 1`; se um segundo deploy o matar, o próximo
  boot só escreve a linha ("não vou retomar de novo") e para explicitamente.
- **Filler do harness filtrado:** o par que o Claude Code sintetiza ao retomar sessão cortada —
  `[Request interrupted by user]` + `No response requested.` — é descartado em todo caminho que lê
  transcript (chat clássico, merge do replay, mirror) e também vindo ao vivo do driver: no chat
  ele lia como o Claude "dispensando" a mensagem da pessoa.
- **Mensagem durante o setup da conexão:** a rota `/sdk` agora **bufferiza** frames que chegam
  enquanto o connect ainda faz o probe/replay (antes eram descartados sem listener) e os entrega
  ao driver na ordem, como turnos normais.

## Turning it on — ONE switch, on by default (2026-08-31)

**Global only:** the `sdkDriver` setting — "Chat nativo (padrão da instalação)" in
**Configurações**. On (the default), the Chat tab of EVERY card is the native chat; off, every
card falls back to the classic transcript chat and the `/sdk` socket refuses.

The per-card opt-in ("Chat nativo (beta)" in the `⋯` menu) was **retired** the same day: the field
`card.sdkChat` still exists in `board.json` records that set it, but nothing reads it anymore —
**vestigial, no data migration needed**. Cards that never used the native chat lose nothing: the
history bridge (#43/#51) merges the TUI transcript into the native chat's replay on first open.

## Validação pela tela (roteiro manual)

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

## Convivência TUI ↔ chat nativo — as regras de um card com as duas telas

Um card é **UMA conversa**, mesmo quando ela acontece em duas telas. As regras:

- **Terminal → chat nativo, ao vivo (o espelho).** Enquanto um chat nativo está conectado, o back
  segue o transcript do card (o mesmo loop `tail -F` do chat clássico — `buildFollowCommand`,
  marcador do reaper incluído; ver `back/src/services/sdk/mirror.ts`) e converte as linhas NOVAS em
  frames pro chat: a mensagem digitada na TUI aparece como balão de usuário (com remetente, quando
  o log de proveniência conhece), as respostas como assistant/tool, e o burst abre com a linha de
  sistema **"Atividade no terminal"**. Os eventos espelhados também entram no `sdk-history`
  (`source:"terminal"` + `tid`), então sobrevivem a reconexão.
- **Reconexão / chat fechado (o merge).** O replay de cada connect é um MERGE do `sdk-history` com
  o transcript (`mergeTranscriptReplay`): o que o history não conhece — inclusive conversa feita na
  TUI **enquanto nenhum chat estava aberto** — entra na linha do tempo; o que o driver já disse é
  deduplicado por id de tool-use, por `tid` e por texto normalizado (multiset). Nada some, nada é
  desenhado duas vezes.
- **Chat nativo → terminal.** Uma mensagem mandada no chat nativo roda no driver, que grava a
  sessão no MESMO diretório de transcripts; a TUI **não** desenha esse turno ao vivo (o processo
  `claude` dela não sabe do driver — a tela dela segue "congelada" enquanto o driver conversa), mas
  o próximo `claude -c` / resume retoma o transcript mais novo e continua exatamente dessa
  conversa. Alternar à vontade é suportado; a regra de resume é sempre "o transcript mais novo
  vence" (`resumeTargetFor`).
- **Estado honesto.** "Trabalhando…" só acende com evento VIVO do driver (depois do `ready`) e
  apaga quando o socket cai (a tela desconectada não pode atestar o que o driver está fazendo);
  replay nunca acende — no reconnect, se o turno ainda roda, o próximo delta reacende. Todo turno
  do driver se fecha sozinho: um turno encerrado sem `result` (interrupt, erro, stall) emite
  `result{subtype:"aborted"}` no `finally` do `runTurn` — é também assim que o manager conta
  turnos pra saber quando o driver está ocioso.

## O turno sobrevive à página (manager — o bug do reload no meio do turno)

O driver era filho da CONEXÃO: o route spawnava um por websocket e o matava no close. Bastava o
usuário mandar mensagem no chat nativo e recarregar a página no meio do turno → o socket caía, o
driver morria NO MEIO do turno, a resposta nunca chegava ao transcript e o driver novo do reconnect
fazia `--resume` sem continuar o turno pendente — mensagem engolida.

Agora o driver é **do CARD**, propriedade do back (`back/src/services/sdk/manager.ts`):

- **Um driver por card.** `ensureDriverSession` spawna no máximo um; reconectar (ou abrir uma
  segunda aba) ATTACHA no processo vivo — duas abas multiplexam o mesmo driver, nunca dois.
- **A persistência mora no lado que sobrevive.** É o manager (não o socket) que ouve o stdout do
  driver: sdk-history, resume-id no board e as chaves de dedupe do mirror continuam fluindo com
  ZERO páginas abertas. Fechar a página só desanexa o socket; o turno segue e fica gravado — o
  reconnect replay mostra o que a tela perdeu.
- **Reconnect reata.** Um socket que chega num driver já `ready` recebe um `ready` sintetizado
  (com o resume-id mais novo) — sem ele o composer da página nova nunca habilitaria.
- **Interrupt continua funcionando**: o botão manda o frame pro stdin do driver VIVO, de qualquer
  aba conectada.
- **Morte silenciosa é proibida.** O manager guarda a cauda do stderr do driver
  (`STDERR_TAIL_MAX`); uma saída que ninguém pediu (crash, código ≠ 0) vira log **warn** no back
  (código de saída + stderr + turnos em voo) E frame de erro no chat com o mesmo post-mortem.
  Investigação (repro manual no runner): o `--resume` de uma sessão grande (3,7MB)
  funciona normalmente — a morte era o socket fechando e levando o driver junto (Cmd+Shift+R,
  troca de aba), com o stderr em nível debug e o frame de saída indo pra um socket já fechado.
- **Fim de vida.** (1) `killCardSession` notifica o manager (`onCardSessionKill` em
  `workspace.ts`) — pausar, hibernar, reiniciar, deletar, trocar modelo/conta matam o driver
  junto com o tmux. (2) **Ocioso**: sem nenhum socket E sem turno rodando por `DRIVER_IDLE_MS`
  (15 min), o driver se encerra sozinho — o resume-id persistido traz a conversa de volta no
  próximo connect. (3) O **reaper** nunca julga um driver vivo: `reapCandidates` recusa qualquer
  processo com `.vibehub-sdk/sdk-driver.mjs` na linha de comando (e os subprocessos do SDK pendem
  do driver, nunca ppid 1 enquanto ele vive). Um driver realmente morto sai sozinho no EOF do
  stdin (`rl.on("close") → exit 0`), inclusive quando o back reinicia.

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
{ "type": "ready", "resume"?: "<sessionId>", "turnActive"?: bool } // driver is up (turnActive: a turn is in flight)
{ "type": "session", "sessionId": "<uuid>" }               // learned the session id (resume key)
{ "type": "assistant_delta", "text": "…" }                 // live token stream
{ "type": "assistant_text", "text": "…" }                  // consolidated text block
{ "type": "tool_use", "id": "toolu_…", "name": "Write", "input": { … } }
{ "type": "permission", "tool": "Bash", "decision": "allow"|"deny", "sensitive": bool, "reason"?: "…", "id"?: "…", "timedOut"?: bool }
{ "type": "permission_request", "id": "perm_…", "tool": "Bash", "input"?: { … }, "reason"?: "…" }  // AWAITS a decision
{ "type": "turn_absorbed" }                                // a send folded into the RUNNING turn (streaming input)
{ "type": "result", "isError": bool, "sessionId"?: "…", "subtype"?: "success", "result"?: "…", "permissionDenials"?: [ … ] }
{ "type": "catalog", "commands": [ { "name": "code-review", "description": "…", "argumentHint": "[<pr#>]", "aliases": ["review"], "source": "skill"|"plugin"|"command" } ] }
{ "type": "local_output", "text": "…" }                    // resposta de um comando LOCAL (/cost, /usage)
{ "type": "conversation_reset", "trigger"?: "clear" }      // o /clear zerou o contexto: sessão NOVA no CLI; o back apaga o log do card e grava a nota "conversation-cleared"; o front limpa a tela
{ "type": "background_tasks", "tasks": [ { "id": "…", "type": "local_bash", "description": "…" } ] } // o conjunto VIVO de tarefas em segundo plano (substitui o anterior; [] = nada rodando). Estado, não conversa: nunca gravado, reenviado a quem conecta; enquanto não vazio o driver não é desligado por ociosidade
{ "type": "thinking", "text": "…" }                        // o raciocínio do modelo (bloco fechado)
{ "type": "thinking_delta", "text": "…" }                  // …e o mesmo, token a token, ao vivo
{ "type": "user_question", "id": "…", "questions": [ { "question": "…", "header"?: "…", "options": [ { "label": "…", "description"?: "…" } ], "multiSelect"?: bool } ] }
{ "type": "question_result", "id": "…", "answers"?: [ { "selected": ["…"] } ], "timedOut"?: bool, "superseded"?: bool }
{ "type": "rewound", "ok": bool, "uuid"?: "…", "reason"?: "no-fork-point"|"absorbed", "originalText"?: "…" } // an edit was applied (live-only)
{ "type": "workflow_progress", "runId": "wf_…", "name": "…", "total": n, "done": n, "agents": [ { "id", "label", "status": "running"|"done", "result"? } ], "at": ms, "finished": bool } // live-only
{ "type": "system_note", "text": "…", "at": ms }           // back-synthesised: the panel's own line (persisted)
{ "type": "peer_typing", "name": "…", "active": bool }     // back-synthesised: ANOTHER socket of this card is typing (ephemeral)
{ "type": "user_ack", "cid": "…" }                         // back-synthesised: a send is ON DISK
{ "type": "user_nack", "cid": "…", "reason": "driver-gone"|"history-write-failed" } // back-synthesised: the send was REFUSED, or never reached the disk
{ "type": "error", "message": "…" }
{ "type": "parse_error", "raw": "<the bad line>" }          // back-synthesised; nothing is swallowed
```

The connect REPLAY (before any of the above) re-sends the persisted history events — `user`,
`assistant_text`, `tool_use`, `permission_request`/`permission`, `user_question`/`question_result`,
`system_note`, `message_edited` — plus the terminal-mirrored ones (`source: "terminal"`, `tid`).

The front sends, per message: a JSON object `{ "type": "user", "text": "…", "cid"?: "…" }`,
`{ "type": "interrupt", "reason"?: "edit" }`, `{ "type": "permission_decision", "id": "…", "allow": true|false }`
(the answer to a `permission_request`), `{ "type": "question_answer", "id": "…", "answers": [{ "selected": ["…"] }] }`
(the answer to a `user_question`), `{ "type": "edit_user", "original": "…", "text": "…", "cid"?: "…" }`
(editar uma mensagem enviada — ver a seção *Editar mensagem*), `{ "type": "typing", "active": bool }`
(o "está digitando", só repassado às outras abas) — **or a bare string**, which is treated as a user
message.
Multi-turn works by resume: the driver captures `session_id`, the manager persists it on the card
(`resumeSessionId`), and the next spawn continues the same session.

## O menu "/" — invocar skills e comandos pelo chat

No Terminal você aperta `/` e a TUI oferece a lista; no chat nativo era preciso saber o nome de cor.
A sessão JÁ conhece tudo que pode rodar — skills (`~/.claude/skills`, plugins, `.claude/skills` do
repo), comandos de plugin, comandos do projeto (`.claude/commands`) e os built-ins do Claude Code —,
porque o driver sobe com `settingSources: ["user","project","local"]`. O que faltava era o caminho
até a tela:

1. **Driver** — no `init` de cada stream, o driver pede `query.supportedCommands()` (nome,
   descrição, `argumentHint`, aliases) e emite UM `catalog` com essa lista mais as listas do próprio
   `init`: `skills` (quais nomes são skills), `plugins` (quais plugins estão instalados) e
   `terminal_slash_commands` (os presos ao terminal — `/doctor`, `/color`). O pedido é feito uma vez
   por processo (o `init` se repete a cada turno, e um round-trip de controle por turno não
   compraria nada); um `commands_changed` do CLI — uma skill descoberta no meio da sessão — emite o
   catálogo de novo. Falhou? o próximo `init` tenta outra vez.
2. **Back** — `normalizeSlashCommands` (protocol.ts) é quem transforma isso no que pode ir pro
   browser: nome válido ou fora, descrição achatada numa linha e limitada, catálogo com teto,
   `source` calculado (`skill` / `plugin` / `command`) e os terminal-only removidos. O manager
   guarda o resultado em `session.catalog` e **reenvia no attach** de cada socket — o catálogo é
   ESTADO de sessão, não conversa: nunca entra no histórico, e uma aba que abre depois não pode
   ficar sem menu esperando o `init` do próximo turno.
3. **Front** — `lib/slashMenu.ts` tem as regras puras (quando o menu abre, o ranking da busca, como
   o campo fica depois de escolher) e o `TerminalComposer` desenha a lista acima do campo. O menu só
   existe enquanto o rascunho INTEIRO é uma palavra começada por `/`: digitou espaço, o nome está
   fechado e o que vem depois são os argumentos. Enter/Tab escolhem, setas andam, Esc dispensa
   **sem mexer no rascunho** (e um caractere a mais reabre). A busca casa nome, alias E descrição —
   é o que faz "bug" achar a skill que caça bug.

O envio não tem nada de especial: `/code-review high` vai como mensagem de usuário normal, e o CLI
resolve o comando do outro lado (é o mesmo caminho da TUI). Quando o comando é LOCAL (`/cost`,
`/usage`), não existe turno nem fala do modelo — a resposta chega como `local_command_output` e
vira a linha `command_output` do chat, em vez de ser engolida.

Um runner mais antigo, que não reporte catálogo, simplesmente não tem menu: o campo se comporta
como antes e um `/` digitado à mão continua chegando no CLI.

## Editar mensagem = REBOBINAR a conversa (2026-09-26)

Editar passou a levar a sessão **de volta pra antes da mensagem corrigida**, como em qualquer chat:
o modelo nunca leu a versão errada, a resposta pela metade deixa de existir e as ferramentas que
rodaram no meio saem junto. Antes a edição só EMPILHAVA — a conversa ganhava as duas bolhas, a meia
resposta e um supersede explicando a correção; o modelo lembrava de tudo.

Como: `resume` + `resumeSessionAt` no `query()`. Medido contra o SDK antes de escrever (e depois
ponta a ponta, com sessão real): rebobinar no uuid do **assistant** do turno mantido traz a
resposta antiga de volta; rebobinar no uuid do `result` é recusado com `error_during_execution`. A
sessão continua com o mesmo id — trunca no lugar.

**De onde vem o ponto de volta (hotfix 2026-10-05).** Primeiro do **transcript da sessão em
disco** (`forkPointFromTranscript` + `readSessionTranscript` no driver): andando só pelo ramo vivo
(da entrada mais nova subindo por `parentUuid`), acha o prompt com aquele texto e o primeiro
`assistant` acima dele. Isso vale para **qualquer** mensagem (não só a última) e sobrevive ao driver
ser derrubado por ociosidade ou deploy — antes o ponto vivia só na memória do processo, e qualquer
um desses casos caía no supersede (a edição aparecia como mensagem nova embaixo, sem apagar nada).
Editar a **primeira** mensagem abre uma sessão nova (`rewound` com `ok: true` e sem `uuid`). Um
`compact_boundary` ou um pai ausente no arquivo **não** contam como início da conversa: aí o disco
responde "não achei". Também "não achei" quando a mesma frase aparece mais abaixo como mensagem
absorvida (`attachment` `queued_command`) — a tela está editando essa, que não tem ponto próprio.
Sem resposta do disco, o ponto em memória só vale se a mensagem editada for **a última enviada**
(senão rebobinaria a errada); fora isso, supersede. O que estava abaixo da mensagem editada —
inclusive uma mensagem absorvida — some da tela e do modelo, que é o que editar acima dela significa.

A decisão é tomada **antes** de derrubar o stream: uma edição que termina em supersede não reinicia o
CLI. `user`/`edit_user` que chegam enquanto um rebobinar está em curso esperam a vez (`serialized`),
senão abririam um stream na ponta velha e a edição cairia dentro dele. O `rewound` com `ok: true`
leva `originalText`, e a tela corta a partir da linha com essas palavras (não da editada mais nova —
um supersede anterior mais abaixo também fica "editada").

Risco residual conhecido: editar a **primeira** mensagem abre sessão nova; se o driver morrer antes
de essa sessão gravar o primeiro arquivo (~1s), o próximo spawn retoma a sessão antiga.

**Quando o driver RECUSA rebobinar** (só quando o disco não achou o ponto; cai no supersede de
sempre, que continua existindo):

- **`no-fork-point`** — não há pra onde voltar (primeira mensagem da sessão, ou o stream morreu ao
  ser derrubado).
- **`absorbed`** — uma mensagem entrou **no meio do turno** depois da que está sendo editada (o
  "encavalar" que o vibehub suporta). Rebobinar descartaria essa mensagem sem bolha, sem linha no
  log e sem como recuperar — e é uma mensagem que uma PESSOA escreveu. O SDK tem um guard pra isso
  (`resumeDropsTurn`), mas ele exige o prompt uuid do próprio envio, que o driver nunca vê; então
  o driver recusa por conta própria.

O evento `rewound` (`{ ok, uuid?, reason? }`) diz qual dos dois aconteceu, e **as três camadas têm
de concordar**: o modelo (a sessão truncada), o log (`rewindHistory` corta do original até o
marcador `message_edited`) e a tela (`dropRewoundRows` corta as mesmas linhas). Com `ok: false`
ninguém corta nada — o supersede significa que tudo que está na tela ainda faz parte da conversa.

Três detalhes que fazem as camadas realmente baterem:

- **A nota do corte sai junto.** "A resposta acima ficou pela metade" fala de uma meia resposta que
  o rebobinar apagou. No caminho comum ela está entre o original e o marcador, e o corte a leva; no
  caminho do prazo de carência (a tela desiste de esperar o turno fechar e manda a edição assim
  mesmo) ela aterrissa DEPOIS do marcador, e quem a tira é `dropOrphanInterruptNotes`. Na tela,
  `dropRewoundRows` faz o mesmo na cauda.
- **O `rewound: ok` tem dono.** O manager mantém uma FILA das edições em voo (`session.rewinds`) e
  casa cada resposta com a sua, na ordem — duas edições antes da primeira resposta cortavam o log na
  mensagem errada. Um `ok: true` sem dono (driver repetindo, frame atrasado) **não é repassado à
  tela**: lá ele apagaria turnos inteiros que o modelo ainda tem.
- **A chave de dedupe do espelho muda com o resultado.** Ver a seção da edição, abaixo.

Invariante que os testes cercam: **a edição sempre chega ao modelo**. Recusa, falha ao derrubar o
stream, `applyFlagSettings` quebrado — todos os caminhos terminam mandando a mensagem, como rewind
ou como supersede. Uma edição que não chega é o único resultado inaceitável.

## Editar mensagem (supersede) — só no chat nativo

O usuário pode editar uma mensagem que já mandou (lápis na bolha; Esc com o campo vazio edita a
última; Esc durante a edição cancela e devolve o rascunho). Como o modelo **já leu** a original, a
edição não reescreve o passado — é um **supersede**:

- **Entrar na edição PAUSA o turno.** No clique do lápis (não no envio), com um turno rodando, o
  front manda `{ "type": "interrupt", "reason": "edit" }`. O relato que originou isso: "cliquei pra
  editar e, em vez de PAUSAR o raciocínio, ele continua respondendo normalmente" — o agente gastava
  o turno em cima da mensagem que estava sendo corrigida.
- O front manda `{ "type": "edit_user", "original", "text" }` e segura a edição até o
  `result`/`aborted` do turno interrompido (timeout de segurança de 15s — o driver enfileira turnos
  de todo jeito), pra que a edição nunca chegue como resposta de um turno que a mensagem antiga
  ainda está tocando. Se um turno novo apareceu no meio (outra aba), ele também é interrompido.
- **Cancelar a edição (Esc/X) NÃO ressuscita o turno** — o SDK não desinterrompe nada. A tela diz a
  verdade: aparece uma faixa "o turno foi interrompido quando você entrou na edição" com um botão
  **Continuar de onde parou**, que manda um turno NOVO pedindo pra retomar (`RESUME_TURN_TEXT`), e um
  X pra dispensar. Enviar a edição substitui a oferta.
- O manager NARRA o corte: no `result` do turno abortado (depois dos últimos deltas, nunca antes)
  ele grava e transmite `{ "type": "system_note", "text": "turn-interrupted" | "turn-interrupted-edit" }`.
  É código, não prosa — o front traduz (pt-BR/en) e a linha sobrevive ao F5, porque explica um texto
  que ficou cortado no meio. Um stop sem turno rodando não gera nota.
- **Nada de balão vermelho mudo.** O CLI encerra um turno interrompido como `error_during_execution`
  com `terminal_reason: aborted_streaming | aborted_tools` e um diagnóstico interno
  (`[ede_diagnostic] …`) no lugar de texto; o chat desenhava literalmente a palavra "error", e
  depois o jargão. Agora a filtragem acontece no DRIVER, que é a camada que sobrevive ao F5 e à
  segunda aba:
  - `wasAborted(terminal_reason)` ⇒ o `result` vai com `isError: false`. Interrupção não é falha, e
    a nota acima já contou a história. (`interruptRequested` no reducer continua como segunda
    trava, mas ele é estado de uma aba só.)
  - `humanErrorText` tira os diagnósticos internos do CLI (`[ede_diagnostic]`) de qualquer mensagem
    de erro; se não sobrar nada, nada é emitido. `[session_crash]` NÃO é filtrado — jargão que a
    pessoa pode agir em cima vale mais que um turno que para sem explicação.
  - O stream que o próprio driver derruba (`endStream`, no rebobinar) não vira erro na tela: o SDK
    reporta essa morte como exceção, e ela é nossa. O que é engolido vai pro stderr com o prefixo
    `[sdk-driver]`, que o manager loga em `warn`.
  - Falha de verdade continua virando frase traduzida com o `subtype` e o que fazer.
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
  `sent` é a APOSTA de o que vai pro stdin, feita antes de o driver escolher — e é pelo `sent` que
  `replayDedupeKey` casa a linha embrulhada que o transcript vai carregar.
- **Quem decide a aposta é o `rewound`**, e as duas pontas são acertadas quando ele chega:
  - `ok: true` ⇒ foi o texto LIMPO que o modelo leu. O manager registra esse texto na memória de
    dedupe do espelho (sem isso o espelho republicava a mensagem corrigida como se o TERMINAL a
    tivesse dito — uma segunda bolha embaixo da que acabara de ser corrigida) e `rewindHistory`
    apaga o `sent`, que virou mentira. Sem isso o F5 desenhava a mensagem duas vezes.
  - `ok: false` ⇒ foi mesmo o embrulho; `sent` fica e tudo segue como antes.
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

## As palavras reservadas — `ultrathink` e `ultracode`

As duas não são texto: o CLI lê as duas do que você escreve e age sozinho — `ultrathink` injeta o
pedido de raciocínio mais fundo naquele turno, `ultracode` opta o turno pela orquestração
multi-agente (ferramenta Workflow). Isso vale **igual no terminal e no chat nativo**, porque quem
faz é o CLI, e o driver entrega o texto verbatim.

O que o CLI **não** faz é subir o NÍVEL de esforço — e é exatamente isso que o painel promete
quando pinta a palavra no compositor. Então o driver:

1. detecta a palavra na mensagem, com as MESMAS regras do front
   (`front/src/features/board/lib/ultraWords.ts`: caixa livre, mas nada de `/comando`, caminho,
   flag, nome de arquivo ou palavra entre aspas/parênteses — a tela só pinta o que o back vai
   honrar, e vice-versa);
2. fixa a camada de *flag settings* em `effortLevel: "max"` (mais `ultracode: true` quando a
   palavra é essa: xhigh + orquestração), caindo para `max` puro e depois `xhigh` se a sessão não
   permitir — plano com teto de esforço, workflows desligados, CLI antigo;
3. **devolve** no `result` do turno (`applyFlagSettings({ effortLevel: null, ultracode: null })`):
   limpa a camada de flags, então o que vale de novo é a configuração do próprio usuário. A palavra
   valia para AQUELE turno.

Duas armadilhas que o teste cerca: a mensagem é empurrada num `finally`, então nenhuma falha da
escalada pode engoli-la; e a primeira mensagem de uma corrente nova espera o
`initializationResult()` (com timeout) antes de mandar a configuração, porque um control request
escrito num CLI que ainda não existe se perde.

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

The driver emits the `session_id` (`session` / `result` events); the manager
(`handleDriverEvent` in `services/sdk/manager.ts` — the side that survives the page) persists each
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

## Streaming input — mensagem no meio do turno entra NO turno (2026-09-01)

A dor: o César mandava uma segunda mensagem com o agente trabalhando e ela só era vista quando o
turno acabava (o driver antigo rodava UM `query({ prompt: string })` por turno e enfileirava o
resto). Agora o driver usa o **modo de input streaming do SDK**: um `query()` de vida longa cujo
`prompt` é um AsyncIterable de user messages (um channel interno). Mensagem que chega no MEIO do
turno é empurrada pro stream vivo e o CLI **dobra ela no turno corrente** — o modelo absorve no
próximo passo, exatamente como a fila da TUI.

**Verificado ao vivo no SDK 0.3.246** (PoC + smoke do driver real): mensagem empurrada durante um
`sleep` de turno em andamento → UM único `result`, cuja resposta final já honrava a mensagem
mid-turn. Os types do SDK confirmam a semântica (fold-in-flight, "queued user message … absorbed
mid-turn", batches coalescidos).

Como as peças se mantêm coerentes:

- **`turn_absorbed`** — quando um send chega com turno já rodando, o driver o injeta e emite este
  evento: o send NÃO vai produzir `result` próprio. O **manager** devolve o +1 daquele send no
  `activeTurns` (piso em 1 — absorvido implica turno em voo, com um result ainda devido), então
  spinner/idle/inflight-marker continuam fechando no ÚNICO result do turno. O **front** marca a
  bolha com o rótulo **"entrou no turno em andamento"** — a mensagem nunca parece perdida.
  Live-only: não entra no `sdk-history` (num replay o turno já é passado).
- **Sessão e resume** — o stream nasce com `resume: lastSessionId`; se o stream morre (erro do
  SDK), o próximo send abre outro que resume a MESMA sessão. `session` agora é emitido só quando o
  id MUDA (o modo streaming entrega muitos system messages por turno).
- **Interrupt** — continua o `query().interrupt()` (é o modo onde ele é oficialmente suportado).
  Todo send já está no CLI (não há mais fila no driver): o interrupt aborta o turno corrente; um
  send empurrado no último instante e ainda não dobrado pode sobreviver e rodar como turno próprio
  — o result extra é absorvido pelo piso-em-zero do manager.
- **Corrida honesta (documentada)** — o driver decide "absorvido?" pelo SEU `turnActive` na hora do
  push; se o result do CLI já estava em trânsito, o CLI enfileira o send como turno novo e chega um
  result a mais que o esperado. O clamp em zero absorve; o pior sintoma é o spinner apagar entre os
  dois results (o próximo delta reacende).
- **Supersede (#65) e inflight (#64)** intocados: o manager segue embrulhando `edit_user` como user
  turn normal, e o marker durável segue +1 por send / limpo quando `activeTurns` zera.

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
- **Aba que fecha no meio do setup não prende nada.** O connect gasta segundos em `await` (instalar
  o driver, a sonda do transcript, o replay) sem ninguém ouvindo o `close`; uma aba fechada nesse
  intervalo já disparou o evento. A rota confere o `readyState` depois do último `await` e, com o
  socket morto, sai sem assinar o barramento externo, sem pegar ref do espelho e sem subir driver —
  e `attachSocket` recusa um socket que não esteja `OPEN`. Antes, o socket morto ficava em
  `session.sockets` para sempre: o idle stop nunca armava, o card nunca hibernava (`isCardChatInUse`)
  e o follow do espelho rodava eterno. O chat legado (`/api/cards/:id/chat`) segue a mesma regra.
- **O close atrasado do driver velho não mexe no sucessor.** O `close` de um driver parado
  (`stopCardDriver`) pode chegar depois que o próximo já subiu; a memória de dedupe do espelho e a
  sondagem da frota são do CARD, então só são apagadas quando nenhum sucessor assumiu o card. A
  memória é ESVAZIADA (`forgetDriverKeys`), não trocada: um espelho vivo lê o mesmo `Set`.

## Recibo de entrega — a mensagem que "sumia no F5" (2026-09-17)

**O incidente** (três vezes num dia): a pessoa escreve uma instrução longa, dá Enter, o chat entra
num carregando eterno — e no F5 (ou em outro computador) a mensagem não está lá, como se nunca
tivesse sido enviada. Reenviar o mesmo texto funciona. Dois furos, um em cada ponta:

1. **A hibernação matava a conversa.** `openedAt` é gravado só no PRIMEIRO open e uma conversa do
   chat nativo nunca move o `statusAt` dos hooks — então o idle sweep media um card que a pessoa
   estava usando como "sem sinal de vida há horas" e o hibernava, o que mata o driver
   (`killCardSession` → `stopCardDriver`). Nos logs de produção: card aberto 00:57:34, hibernado
   01:01:37 por `idle-sweep`, e de novo a cada passada de 5 min. A mensagem escrita no instante
   seguinte era escrita num stdin morto dentro de um `try {} catch {}`, gravada no histórico e
   respondida por ninguém — o "loop carregando" com a mensagem ainda lá depois do F5.
2. **O navegador chamava `send()` de entrega.** Um socket meio-aberto (VPN caindo, proxy soltando,
   o back reiniciando) aceita `send()` e joga os bytes no vácuo — e o `readyState` continua `OPEN`
   por minutos. A bolha era só estado React: o F5 apagava a única testemunha da mensagem.

**As três regras que fecham isso:**

- **Card em uso não hiberna.** O manager registra um veto (`onCardInUseProbe` em `workspace.ts`) —
  `isCardChatInUse`: há aba conectada, ou há turno rodando. Fechada a aba, o driver se encerra pelo
  próprio idle stop e o card volta a ser hibernável. Além disso, `lastActivityAt` agora conta
  `humanActiveAt`, e uma mensagem no chat nativo passa a estampá-lo — conversar É sinal de vida.
- **Envio nunca é engolido.** `handleClientFrame` devolve um veredito (`ClientFrameOutcome`): com o
  driver morto ele **recusa** (nada escrito, nada gravado, nenhum turno contado) e o socket recebe
  `user_nack`; aceito, o `user_ack` sai **depois** do append no histórico — o ack promete
  durabilidade, não intenção. Um append que FALHA (disco cheio) não ganha ack: sai `user_nack`
  com `reason: "history-write-failed"` (`appendHistoryReported`), e o navegador guarda as palavras
  — antes ele recebia o ack, apagava o outbox e a mensagem sumia no F5. EPIPE no stdin virou frame
  de erro, não silêncio.
- **O navegador guarda o que enviou.** `front/src/features/board/lib/sdkOutbox.ts`: cada envio
  nasce em `localStorage` (por card) com um `cid` ANTES de ir pro socket, e só sai de lá com o
  `user_ack`. Sem recibo em `OUTBOX_ACK_TIMEOUT_MS` (12s) a bolha vira **"não entregue"** com
  *Reenviar*/*Descartar* e o socket é derrubado (o reconnect é a única forma de descobrir se ele
  estava vivo). No reconnect, `reconcileOutbox` compara o outbox com o replay do servidor: texto
  que está no replay foi entregue (só o recibo se perdeu); o que não está volta marcado, com o
  texto inteiro — inclusive depois de um F5. O casamento é por texto (o `cid` não volta do disco),
  mas não contra QUALQUER ocorrência: cada entrada nasce com uma MARCA (`sendMark`, sobre
  `deliveredUserTexts` — as bolhas do usuário já gravadas na tela), ancorada no relógio do
  SERVIDOR. `since` é o `at` (carimbo do histórico) mais novo que a tela conhecia quando a mensagem
  saiu; `seenBefore` conta só as linhas com aquelas palavras DEPOIS da âncora (na prática, envios
  desta conexão confirmados pelo `user_ack`, que não traz hora). Na reconciliação (`deliveryOf`)
  só contam as linhas do replay com `at > since`; as `seenBefore` primeiras já existiam, e só uma
  além delas prova a entrega; cada linha do replay casa com no máximo uma entrada. Antes, o "sim"
  de ontem dava por entregue o "sim" de hoje perdido num socket meio-aberto, e ele sumia em
  silêncio. A âncora existe porque o replay é uma JANELA que descarta sempre o mais velho: contar
  na tela inteira dava 6 "ok" no envio contra 3 no replay, e a mensagem entregue voltava "não
  entregue" com um *Reenviar* que duplicava o turno. O limite que sobra: se a conversa andar mais
  que a janela inteira entre o envio e o reconnect, a entrega volta como "não entregue" — com
  *Reenviar*/*Descartar*, nunca sumida (e o *Reenviar* do mesmo `cid` só cobra o recibo, abaixo;
  ele também refaz a marca contra a tela de agora, `retryOutbox`). Sem nenhum `at` na tela
  (histórico antigo ou conversa vazia) não há âncora e conta-se tudo; entradas gravadas antes dos
  campos casam contra qualquer ocorrência, como antes.
- **O backoff do reconnect só zera com o `ready`.** O aperto de mão do websocket não é saúde: o
  back aceita a conexão e SÓ ENTÃO descobre se consegue servi-la (setup do driver, card apagado,
  instalação que falhou) — e fecha. Zerar no `onopen` transformava isso num reconnect no intervalo
  base para sempre. O chat SDK zera o backoff (`createReconnectBackoff().healthy()`, em
  `front/src/features/board/lib/reconnect.ts`) quando chega o frame `ready`, a prova de que o
  servidor terminou o setup e está atendendo; uma conexão que cai antes dele mantém o atraso
  crescendo geometricamente (400ms → 15s).
- **O veredito é dado UMA vez por envio.** A mensagem dada por não entregue CONTINUA no outbox (é a
  cópia que o *Reenviar*/*Descartar* oferece) e o `at` dela não anda mais — então ela é marcada com
  `undelivered`, e `overdueMessages` ignora quem já foi cobrado. Sem essa marca ela estaria vencida
  em TODO tique do watchdog, que derrubava o socket a cada 2s: a tela entrava no loop "chat →
  *Iniciando o agente…* → histórico inteiro → chat", piscando sem parar (produção, 2026-09-17, logo
  depois do recibo entrar no ar). Um *Reenviar* zera o relógio e limpa a marca — o envio novo volta
  a ser cobrável; um `user_nack` a estampa na hora, porque o servidor JÁ respondeu e derrubar essa
  conexão não descobriria nada.
- **O prazo só corre quando o servidor pode responder.** O `onopen` do navegador dispara no aperto
  de mão do websocket, mas o back só chega a ATENDER frames depois de um setup de vários segundos
  (`installCardSdkDriver` com dois `docker exec` por SSH, a sonda de transcript com timeout de 15s —
  sozinha maior que o prazo de 12s —, `readHistory`, o replay, o spawn do driver); até lá os frames
  esperam em `pendingFrames` e são entregues DE VERDADE quando o setup acaba. Contar esse tempo
  contra a mensagem marcava "não entregue" o que o servidor tinha recebido — e o watchdog derrubava
  o socket no meio do setup, cuja reconexão paga o setup inteiro de novo: era esse o "toda hora"
  (produção, 2026-09-28). `overdueMessages` agora recebe um PISO (`answerableSince`, o instante do
  `ready`) e o watchdog se cala enquanto não existe conexão em condições de responder — com o fio
  caído quem dá o veredito é a reconciliação do reconnect, que pergunta ao replay.
- **Reconciliar é sobre o que sobrou de ANTES.** O `ready` sai no attach e só DEPOIS o back responde
  o que ficou bufferado, então o replay não pode conter o envio em voo — e a reconciliação, que
  compara por texto, o dava por perdido: uma SEGUNDA bolha, marcada. Ela agora só julga os órfãos
  (`liveUserCids`): um `cid` que já tem bolha nesta tela pertence a esta conexão e tem dono.
- **Quem só precisa de fio ESPERA, não é condenada.** Um socket cai por motivos banais e volta em
  400ms–15s; escrever nessa janela fazia a mensagem nascer condenada na hora, com o texto em dois
  lugares (a bolha e o campo, de onde o Enter seguinte mandava a cópia). Com o fio fora do ar o
  envio vai para a **fila** — o mesmo lugar de quem escreveu durante um turno: editável, em disco,
  entregue sozinha pelo despacho quando houver conexão.
- **`Reenviar` não roda o turno duas vezes.** O reenvio repete o MESMO `cid` de propósito: o que se
  perdeu foi o recibo, não a mensagem. `handleClientFrame` lembra os recibos já emitidos
  (`acceptedCids`, os últimos `ACCEPTED_CIDS_MAX`) e devolve o `user_ack` sem tocar no driver — sem
  isso, reenviar "apaga a branch" executava a instrução duas vezes. Mesmas palavras com `cid` NOVO
  seguem sendo mensagem nova: mandar duas vezes é um direito. Se o recibo guardado é um
  `history-write-failed` (o driver JÁ leu a mensagem, só o append falhou), o reenvio tenta GRAVAR a
  linha de novo (`chargeReceipt`) e devolve esse novo veredito — antes ele ganhava o mesmo nack para
  sempre, e a saída que sobrava (Descartar + digitar de novo) fazia o modelo trabalhar em dobro.

## A espera é uma escolha, não uma sentença (2026-09-28)

O que se escreve com um turno rodando espera na **fila**, logo acima do campo — editável, em disco,
entregue sozinha quando o turno fecha. Três regras que faltavam para ela não atrapalhar mais do que
ajuda:

- **O lápis não para o turno.** Ele parava (o pedido anterior: "cliquei pra editar e ele continua
  respondendo"), e o preço apareceu em produção: clicar em editar e MUDAR DE IDEIA matava um turno
  que ninguém quis matar, e um turno cortado não se descorta — sobrava uma oferta de "continuar de
  onde parou" para consertar um estrago que a própria tela havia feito. Clicar em editar não é uma
  decisão; é abrir a possibilidade de uma. Quem para o turno é a **correção enviada** (`send`), e o
  custo é conhecido: entre o lápis e o Enter o agente segue trabalhando na mensagem antiga.
  Trabalho a mais é recuperável; um turno morto por engano, não. A oferta "continuar de onde parou"
  saiu junto — sem o corte acidental ela não tinha mais o que consertar.
- **A fila tem teto.** Ela é irmã do scroller da conversa num flex column: sem limite, uma
  instrução de duzentas linhas esticava a bandeja até espremer o `flex-1` do scroller a quase zero
  e empurrar a conversa para fora da tela. Agora a bandeja para em `max-h-[28vh]` com rolagem
  própria, e cada mensagem em espera em `max-h-24` — uma gigante rola no lugar dela em vez de
  esconder as outras. A espera é um aviso, não uma leitura: o lápis continua sendo o caminho para
  ler a mensagem inteira, no campo.
- **A fila anda no RESPIRO do turno, não no fim dele.** Esperar o `result` fazia um turno de quinze
  minutos segurar por quinze minutos um "para, tá errado". Só que um turno não é um bloco maciço:
  entre uma ferramenta e a próxima o modelo FECHA um bloco de resposta, e é esse instante que o
  Cursor e o Claude Code usam para puxar o que está esperando. `turnHasRoomForMore` (puro, em
  `lib/sdkChat.ts`) lê o respiro na mesma ordem da barra de atividade: ferramenta rodando, não;
  texto ou raciocínio ainda escorrendo, não; "Preparando…", não; bloco fechado, sim. Uma mensagem
  recém-entregue não abre o respiro seguinte — senão a fila inteira sairia de uma vez, que é o
  oposto de "uma por vez, e as outras continuam suas".
- **Dá para atropelar a espera.** Cada mensagem da fila carrega o gesto de ir AGORA
  (`sdk-queued-send-now`): ela entra no turno em andamento pelo streaming input e volta marcada
  "entrou no turno em andamento" (o `turn_absorbed` acima). Esperar continua sendo o padrão — uma
  mensagem dobrada no meio de um raciocínio entra como interrupção de contexto, não como pergunta
  nova —, mas "para, tá errado" não é uma pergunta para daqui a dez minutos. Sem fio de pé nada sai
  da fila: forçar um envio que não pode acontecer só trocaria uma mensagem guardada por uma bolha
  condenada.

## Duas palavras e um menu (2026-09-28)

- **O NOME do slash command não é palavra reservada — a mensagem inteira, sim.** A regra antiga
  descartava tudo por causa da primeira letra ("começou com barra, então nada aqui é keyword"), e
  uma mensagem que abria com `/superpowers:systematic-debugging`, trazia parágrafos de contexto e
  terminava em `ultracode` não escalava nada. O que é comando é o PRIMEIRO TOKEN; o resto são os
  argumentos, que o comando expande para dentro do prompt — prosa, onde `ultrathink`/`ultracode`
  valem como valeriam em qualquer frase. `/ultracode-review` segue de fora: é o nome de um comando.
  A regra vive em DOIS lugares e tem de concordar letra por letra — `commandNameEnd` em
  `front/src/features/board/lib/ultraWords.ts` (que pinta) e `ultraCommandNameEnd` em
  `sdk-driver.mjs` (que ESCALA).
- **O menu "/" existe no instante do connect.** O catálogo chega num evento que o driver anuncia UMA
  vez, ao subir, e vivia só em `session.catalog`: num card cujo driver ainda estava bootando o
  primeiro "/" abria vazio, e apagar e digitar de novo "resolvia" porque nesse meio-tempo o anúncio
  chegava. Agora ele é gravado por card (`services/sdk/catalog.ts`, `<dataDir>/sdk-catalog/`) e a
  rota serve a última lista conhecida quando a sessão ainda não tem a sua. Uma lista VAZIA nunca é
  gravada: ela apagaria um menu bom por causa de um driver que subiu capenga.

## O raciocínio na tela

A espera mostrava só um spinner com "Trabalhando…" — um turno de dez minutos e um de meio segundo
eram idênticos, e quem esperava não tinha como saber se o agente havia entendido o pedido. O
pensamento é a única coisa que o modelo produz ANTES da resposta, então é ele que transforma espera
em acompanhamento.

- **O driver pede o resumo.** `thinking: { type: "adaptive", display: "summarized" }` em
  `baseOptions()`. O `display` não é enfeite: nos modelos atuais o padrão é `omitted` e os blocos
  chegam com texto VAZIO — sem ele o driver encaminharia nada, sem erro nenhum, e a tela continuaria
  no spinner. `adaptive` deixa o modelo decidir quando e quanto pensar.
- **Dois eventos, como no texto.** `thinking_delta` ao vivo (o texto vem em `delta.thinking`, NÃO em
  `delta.text`) e `thinking` consolidado, que substitui os deltas que o montaram. `redacted_thinking`
  é ignorado de propósito: não carrega texto legível, e uma linha vazia seria pior que nada.
- **Duas correntes que não se misturam.** O raciocínio tem linha própria (`kind: "thinking"`); um
  delta de resposta FECHA um raciocínio aberto e vice-versa. Sem isso o primeiro token da resposta
  era colado no fim do pensamento — e uma linha ficava "pensando" para sempre.
- **Não é gravado.** `replayableHistoryEvent` recusa os dois, como faz com o `turn_absorbed`: é
  orientação do momento. Gravá-lo encheria o log (replay de 500 eventos) com o pensamento de ontem e
  empurraria a conversa de verdade para fora do replay. Depois de um F5, o que volta é a conversa —
  mensagem, ferramenta, resposta.
- **Na tela.** Aberto enquanto pensa, recolhido quando termina (um clique reabre) — durante a espera
  é o que se quer ler; depois, vira ruído entre a pergunta e a resposta. Uma escolha explícita da
  pessoa vence o automático, então abrir no meio do turno não é desfeito quando ele acaba.

## O indicador diz o que a IA está dizendo (2026-09-28)

O que mais se via num turno longo era "ferramenta demorada, ainda rodando" — a MESMA frase para
qualquer ferramenta e qualquer raciocínio, escolhida por uma tabela a partir do relógio
(`workingStage`). Ela não informava nada, e o material de verdade estava a um passo dali, no estado:
a descrição que o PRÓPRIO agente escreveu para o comando (`toolHeadline` já a extrai — "Medindo o
tamanho do módulo PDV") e o raciocínio que ele está escrevendo neste instante.

`liveActivityDetail` (puro, em `lib/sdkChat.ts`) devolve a ÚLTIMA linha do que está em curso, porque
é ela que está mudando: o começo de um raciocínio de dez linhas é história, o fim é notícia. Um
bloco já FECHADO não é atividade — virou a saída do turno e já está desenhado logo acima —, e aí a
função devolve `null`. A frase enlatada volta a ser o que sempre deveria ter sido: o fallback de
quando não há nada a dizer, como o "Preparando…" de uma sessão subindo.

## O fluxo do agente na tela — a barra fixa e a manchete da ferramenta (2026-09-26)

O terminal tem uma coisa que o chat não tinha: uma linha de status sempre visível dizendo o que o
agente está fazendo e há quanto tempo. No chat essa informação existia, mas espalhada pelo scroll —
num turno longo (uma skill, um agente, um build) ela ficava muito acima da dobra, e quem
acompanhava o card tinha que rolar para saber se ainda havia algo rodando.

- **A barra fixa** (`SdkActivityBar`, `sticky top-0` dentro do scroller) só existe enquanto o turno
  está vivo, e carrega três fatos: **o quê** (`currentActivity` — a manchete da ferramenta mais
  recente, o raciocínio em curso, ou a resposta sendo escrita), **há quanto tempo** (`useTurnClock`,
  `4s`, `1m 24s` — "Trabalhando…" sem número é a mesma palavra no segundo 2 e no minuto 9) e **com
  qual esforço** (a palavra reservada com que a mensagem foi enviada: `ultrathink` vira "esforço
  alto", `ultracode` se anuncia por nome — a escalada acontecia em silêncio). Um clique vai para a
  ponta viva da conversa. A escada de estados inline continua onde estava: ela marca o LUGAR do
  trabalho na conversa, a barra é a que não sai da tela.
- **A manchete da ferramenta** (`toolHeadline`, puro) porta o formato de duas linhas da TUI: o que
  está sendo feito e, indentado sob ele, o detalhe. O `description` que o agente escreve para um
  `Bash` ("Measuring PDV module size") é a melhor linha da tela e era exatamente o que o chat
  jogava fora — mostrava `Bash` e um pedaço truncado do input. `Read(registry.ts)` com o caminho
  embaixo, `Grep(padrão)`, `Fetch(host)`; e um `Skill(code-review)` ou um `Task(...)` diz
  **"Rodando em segundo plano"**, que é a informação que faltava: aquela chamada não termina ali,
  ela sai correndo enquanto o turno segue.
- **Uma palavra, uma paleta.** `ultrathink` e `ultracode` eram pintados com o MESMO arco-íris da
  TUI, letra a letra — iguais na tela, sendo pedidos diferentes (um compra raciocínio, o outro liga
  orquestração multi-agente). O `ultracode` agora tem paleta própria (rampa fria ciano → violeta),
  mesma varredura, mesma mecânica.

## Falar é responder (o cartão de pergunta não prende mais a tela)

Com um `user_question` de pé, o turno está PARADO dentro do `canUseTool` esperando um clique. Uma
mensagem escrita no chat nesse meio-tempo entrava na corrente do CLI e ficava lá, sem ninguém para
lê-la, até o timeout de 30 minutos: na tela, "mandei a mensagem e não acontece nada, fica preso"
(produção, 2026-09-17 — o caso é justamente NÃO gostar do plano proposto e querer outro rumo).

- **Uma mensagem libera o cartão.** `supersedePendingQuestions()` no driver (`supersedeAll()` no
  broker canônico de `protocol.ts`) resolve tudo que espera clique com `superseded: true`.
- **A ordem é o bug.** A mensagem é empurrada (`sendUser`) ANTES de o cartão ser liberado. Liberar
  primeiro solta o turno, que pode seguir e responder à pergunta sem nunca ter visto a mensagem
  nova — o oposto do que a pessoa pediu ao escrever.
- **O modelo lê o motivo.** `QUESTION_SUPERSEDED_MESSAGE` diz as três coisas que impedem o agente de
  reabrir a mesma pergunta: não houve escolha, existe uma mensagem nesta conversa, e ela manda.
- **A tela não mente.** O `question_result` sai com `superseded`, e o cartão diz "Você respondeu por
  mensagem" — `unanswered` seria falso: a pessoa respondeu, só não pelo cartão. Ele também sai da
  bandeja de decisões pendentes, que parava de cobrar um clique que já não fazia sentido.

O cartão de PERMISSÃO (`permission_request`) tem a mesma forma de espera, e segue como estava: ali a
decisão é binária, o botão Negar é o caminho explícito, e o relógio é de 5 minutos, não 30.

## Quem escreveu e quem está digitando — duas contas no mesmo card (2026-10-06)

**O bug.** A conta "mussa" mandou "continua nao para"; a aba trocou para "cesar" e a barra lateral
mudou (o `SessionGuard` revalida o `/auth/me` no foco) — mas a bolha continuou desenhada como do
leitor, sem nome, até um F5. Eram dois furos juntos:

1. **A bolha própria nascia sem autor.** `appendUserRow(..., undefined)` + `originRole(undefined)`
   = `"self"` para QUEM estivesse logado. Agora o envio (e a cópia no outbox, `OutboxMessage.from`)
   leva o autor da conta que escreveu; o `readOutbox` valida esse campo com `parseOrigin`
   (localStorage é entrada não confiável).
2. **O socket continuava falando pela conta antiga.** O back resolve o autor UMA vez por conexão
   (`wsOrigin` em `routes/cardSdk.ts`), e o effect do socket dependia só de `cardId`. Agora depende
   também de `identity.epoch` (`lib/viewerIdentity.ts`), que só anda numa troca REAL entre duas
   contas conhecidas — o `/auth/me` chegando ou a sessão caindo não reconectam (a conversa não pisca).
3. **O que outra conta deixou esperando não sai por esta conexão.** Fila (`QueuedMessage.from`) e
   outbox guardam o autor; quando o leitor muda, `foreignToOutbox` tira da fila o que é de outra
   conta e o transforma em cópia "não entregue" — na tela com o nome de quem escreveu, descartável,
   SEM "Reenviar" (só quem escreveu reenvia; daqui sairia no nome errado). Edição em curso é limpa
   na troca. O `onclose` de um socket já descartado não mexe mais no estado da conexão nova.

**"Cesar está digitando…".** Presença efêmera sobre o mesmo websocket do card (o projeto não usa
socket.io: o "room" é o `session.sockets` do manager):

- O front manda `{ "type": "typing", "active": boolean }` — um na primeira tecla, no máximo um a cada
  `TYPING_SEND_EVERY_MS` (2,5 s) enquanto a pessoa escreve, e o "parou" depois de `TYPING_IDLE_MS`
  (3 s) sem tecla, ao apagar o campo ou ao enviar (`lib/peerTyping.ts` `createTypingSignal`). Só
  teclas da pessoa contam (`TerminalComposer` `onDraftInput`), não rascunho restaurado nem modo edição.
- O back (`attachSocket`) intercepta o frame ANTES do `parseSdkClientFrame` — cujo fallthrough
  transforma texto desconhecido em turno — e o repassa como `{ "type": "peer_typing", "name",
  "active" }` só para os OUTROS sockets do card. Nunca vai ao driver nem ao histórico. Guarda própria
  contra abuso: `TYPING_RELAY_MIN_MS` (1 s) entre dois "digitando" do mesmo socket — mesmo com um
  "parou" no meio, senão um loop digitando/parou repassaria cada frame (o "parou" em si nunca espera).
  Um "digitando" que chega no buffer do setup (antes do attach) é descartado: já está velho.
  Um envio aceito e o fechamento do socket também mandam o "parou"; socket sem autor não anuncia.
- O front expira cada nome em `PEER_TYPING_TTL_MS` (6 s) sem renovação — um "parou" perdido nunca
  deixa o indicador preso —, esconde o próprio nome (mesma conta em duas abas) e limpa tudo a cada
  reconexão. O desenho (`PeerTypingIndicator`) são os três pontos do LoaderOne da Aceternity (y em
  loop, ease-in-out, 1 s, 0,2 s de defasagem) feitos em CSS (`animate-typing-dot`), sem biblioteca de
  animação no bundle, e parados com `prefers-reduced-motion`.

Limitação conhecida: o estado é por SOCKET no back e por NOME no front — a mesma pessoa digitando
em duas abas e fechando uma apaga o indicador por até 2,5 s (até a próxima renovação da outra).

Custo no servidor: um frame de poucos bytes a cada ~2,5 s por pessoa digitando, fan-out só para as
abas abertas NAQUELE card. Nada em disco, nenhum timer no back.

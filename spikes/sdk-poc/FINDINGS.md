# SDK PoC — findings (spike, throwaway)

Prova de conceito pedida em `docs/sdk-migration-plan.md` §3: dá pra dirigir uma sessão do Claude
Code pelo **Agent SDK / stream-json** em vez da TUI no tmux, transformando permissão e escolhas
interativas em eventos **estruturados** (viram botão no chat), matando a classe de bug do
send-keys-por-cima-de-menu?

**Veredito: SIM, viável.** Todos os critérios de aceite passaram, rodando de verdade dentro do
`vibehub-runner` em produção (kvm4), autenticado com o mesmo token dos cards. Um único achado
importante muda o desenho da Fase 1 (abaixo).

## O que rodou (de verdade, não dry-run)

- **Onde:** `docker exec` no container `vibehub-runner` (host kvm4, `31.97.90.168`).
- **Auth:** `CLAUDE_CODE_OAUTH_TOKEN` lido de `/root/.claude/.oauth-token` — exatamente como o
  `sessionCommand` do vibehub já injeta hoje (`back/src/services/board/workspace.ts:106`). Modelo
  respondido: `claude-opus-5`. Sub Max via setup-token, sem API key.
- **SDK:** `@anthropic-ai/claude-agent-sdk` **v0.3.246** (o `claude` CLI do runner e 2.1.246).
- **Harness:** `run-poc.mjs` (v1) + `run-poc2.mjs` (v2). v2 corrige o desenho da prova de permissao
  depois do que a v1 ensinou (ver "pegadinha" abaixo). Resultados capturados em
  `results-v1-summary.json` / `results-v2-summary.json`.

## Criterios de aceite — resultado

| # | Criterio | Resultado |
|---|---|---|
| 1 | Streaming estruturado (texto + `tool_use`) | OK — eventos estruturados, shapes reais abaixo |
| 2 | `canUseTool` dispara e a decisao e honrada (allow/deny) | OK — allow Write, **deny** `rm` -> agente obedeceu, arquivo sobreviveu |
| 2b | `bypassPermissions` roda sem chamar `canUseTool` (auto-allow) | OK — `canUseTool` disparou **0 vezes** |
| 2c | Ainda da pra travar 1 tool sob auto-allow | OK — via **PreToolUse hook** (nao via canUseTool) |
| 3 | Resume por id (2o turno com contexto) | OK — mesmo `session_id`, lembrou o conteudo do arquivo |
| 4 | Tarefa real (edita arquivo / roda comando) | OK — Write + Read + Bash de verdade |
| 5 | Sem menu de TUI (resume "1/2/3", /compact) | OK — nenhum; o caminho headless nao os emite |

## 1. Shapes reais dos eventos (o que o chat consumiria)

`query()` devolve um async-iterable. Tipos de mensagem de topo observados:
`system`, `stream_event`, `assistant`, `user`, `result`, `rate_limit_event`.

- **`system`** (primeira msg + hooks): traz `session_id`, `subtype` (`init`, `hook_started`, ...),
  `model`. E daqui que sai o id pra resume.
- **`stream_event`** (so com `includePartialMessages: true`) — os deltas, `msg.event` e um evento
  cru da Messages API. Subtipos vistos:
  `message_start`, `content_block_start`, `content_block_delta` (`text_delta`, `thinking_delta`,
  `input_json_delta`, `signature_delta`), `content_block_stop`, `message_delta`, `message_stop`.
  Renderizar texto = `event.delta.text` quando `delta.type === "text_delta"`.
- **`assistant`** — mensagem consolidada, `msg.message.content[]` com blocos `text` / `tool_use`.
  `tool_use` real capturado:
  ```json
  { "kind":"tool_use", "id":"toolu_012EN3AjNvfLpMwRPAMk4EmW",
    "name":"Write", "input":{"file_path":"/tmp/poc-work/hello.txt","content":"HELLO_FROM_SDK"} }
  ```
- **`result`** — fim do turno:
  ```json
  { "subtype":"success", "is_error":false,
    "session_id":"0d1b3864-4870-4141-8451-79d73de0bd96",
    "result":"...", "num_turns":4, "permission_denials":[] }
  ```
  Note `permission_denials[]` — a lista dos tool_use negados, com `tool_name`, `tool_use_id`,
  `tool_input`. Ou seja: a negacao tambem volta **estruturada** no resultado, nao so no callback.

Isto e tudo o que o chat precisa pra renderizar texto ao vivo + cartoes de tool_use + estado real
do turno. **Zero parsing de pane, zero send-keys.**

## 2. `canUseTool` — a prova, e a PEGADINHA que redesenha a Fase 1

`CanUseTool = (toolName, input, options) => Promise<PermissionResult | null>` e
`PermissionResult = {behavior:"allow", updatedInput?} | {behavior:"deny", message, interrupt?}`.
E **in-process e aguardado**: o loop do agente para ate a Promise resolver. E exatamente o gancho
que vira botao "Permitir / Negar" no chat.

**Cena D (v2) — prova limpa:** modo default, `canUseTool` como arbitro. Politica: allow Write, deny
`Bash rm`. Resultado:
- `canUseTool` disparou pra `Write` -> **allow**, e pra `Bash(rm)` -> **deny**;
- o agente **obedeceu**: `fileSurvived=true`, `permission_denials` listou o `rm`, e a fala final do
  proprio agente foi "step 3 foi bloqueado". Decisao honrada.

**A pegadinha (o achado que importa):** na v1 eu passei `allowedTools: ["Write","Read","Bash"]`
achando que era so a lista de tools disponiveis. **Nao e.** O SDK avisou:

> `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED: Bare allowedTools entries auto-approve the whole tool BEFORE
> the callback is consulted.`

Ou seja, **nome cru em `allowedTools` = auto-approve daquele tool, e o `canUseTool` nem e chamado**.
Na v1 o `rm` passou batido e apagou o arquivo. Regras `allow` de `settings.json` fazem o mesmo
shadow. **Consequencia pro vibehub:** pra rotear permissao pro chat, os tools que a gente quer
"perguntar" **nao podem** estar num allowlist cru nem cobertos por regra `allow` no settings do
runner — senao o botao nunca aparece. (O `settings.json` do runner hoje e gerado por
`runnerSettings` com `autonomous` — precisa auditar o que ele allowlista.)

**Read nao passou pelo callback** na cena D: tools read-only sao auto-aprovados pelo default. Entao
o gate natural cai sobre escrita/exec, que e o que interessa.

## 2b/2c. Auto-allow (bypass) + gate seletivo

Direcao confirmada do PO: card sandbox, "bypass permissions on", agente age livre.

- **Cena C (v1):** `permissionMode:"bypassPermissions"` + `allowDangerouslySkipPermissions:true`.
  Com um `canUseTool` presente, ele **disparou 0 vezes** — SDK avisou que bypass auto-aprova tudo
  antes do callback. Auto-allow confirmado.
- **Cena E (v2):** bypass ligado **+ um PreToolUse hook** que nega so `rm`. O Write passou, o `rm`
  foi **bloqueado pelo hook** (`keepSurvived=true`, `permission_denials` registrou).
  -> **Sob auto-allow, `canUseTool` esta fora; o gate seletivo e o `PreToolUse` hook.** (O hook
  tambem retorna estruturado — `permissionDecision: "deny"` — da pra escalar pro chat.)

**Portanto, os 3 modelos de permissao do plano (§7.3) na pratica:**
1. `canUseTool` sempre (botao no chat) -> **nao** allowlistar os tools sensiveis; funciona, cada
   acao sensivel vira uma pausa aguardada.
2. `bypassPermissions` (friccao zero) -> `canUseTool` morto; nada pergunta.
3. **Hibrido (recomendado):** bypass no runner **+ PreToolUse hook** que auto-allow o grosso e so
   **escala pro chat** um conjunto pequeno de acoes sensiveis (rm/push/deploy/secrets...). O hook e
   o ponto de decisao; ele pode chamar de volta o back e devolver allow/deny.

## 3. Resume

Cena B: segundo `query({ options:{ resume: "<sessionId>" } })` com o id da cena A. Voltou o
**mesmo** `session_id` e o agente respondeu, **sem tool**, o conteudo exato (`HELLO_FROM_SDK`) e o
nome do arquivo do turno anterior. Contexto preservado. (`forkSession:true` existe pra ramificar
em vez de continuar; `resumeSessionAt` pra truncar num UUID.)

## 4. Tarefa real

Write criou `hello.txt`, Read leu de volta, Bash rodou `rm` — arquivos reais no FS do runner,
verificados por `existsSync`. Nao e echo de brinquedo.

## 5. Sem menu de TUI

Nenhuma das quatro rodadas emitiu o menu de resume "1/2/3" nem prompt de `/compact` como texto. O
caminho headless/SDK **nao tem TUI** — some por construcao a classe de bug do menu-guard (#23), do
envio-cego e do pending fragil (#27).

## Riscos / incognitas (honesto)

- **RISCO #1 (o maior): allowlist/settings que dao shadow no callback.** Se o `settings.json` do
  runner (ou um `allowedTools`) auto-aprovar um tool, o botao de permissao **nunca aparece** e a
  gente acha que "esta quebrado". A migracao TEM que auditar/reescrever o settings gerado por
  `runnerSettings` e escolher conscientemente o que e auto-allow vs escalado. E silencioso — so um
  warning no stderr denuncia.
- **`canUseTool` bloqueia o loop.** E aguardado; sem UX de timeout/default/"responder depois" o
  agente trava esperando o clique (o proprio plano §5 ja alerta). Sob o modelo hibrido isso fica
  restrito as poucas acoes sensiveis.
- **Transporte.** O `query()` roda in-process (Node) — precisa de um **driver por card no runner**
  (processo Node que roda o `query()`), com os eventos indo pro back por WS/stream e o
  `canUseTool`/hook roteados pro chat e de volta. Hoje o back fala com o runner por
  `docker exec`/tmux; o driver SDK e um processo novo, nao a TUI.
- **Coexistencia.** Login interativo (`/login`), shell real, `git rebase -i` continuam querendo um
  terminal. O tmux nao morre — vira escape hatch sob demanda (plano §4.3), nao o motor.
- **Historico/persistencia.** O resume por id do SDK funciona (sessoes em `~/.claude/projects/`),
  mas decidir se a fonte de verdade do historico e o SDK ou o back e decisao de arquitetura aberta
  (§7.2).

## Veredito e primeiro passo concreto

**O caminho SDK e viavel pra Fase 1.** Eventos estruturados, permissao programatica honrada, resume
e edicao real — tudo rodou no runner de producao com o auth real. A classe de bug do send-keys
morre por construcao.

**Primeiro passo de migracao (Fase 1, isolado, dev-only):** um **"driver SDK" por card** — um
processo Node no runner que roda `query()` num worktree, com:
1. transporte dos eventos estruturados pro back (WS), renderizados no chat (texto ao vivo +
   cartoes de tool_use + estado real do turno);
2. modelo de permissao **hibrido**: `bypassPermissions` + um **PreToolUse hook** que auto-allow o
   grosso e escala ao chat so acoes sensiveis (a lista a fechar com o Cesar);
3. **auditoria do `settings.json`/allowlist do runner** pra garantir que os tools sensiveis nao
   estao sendo auto-aprovados por baixo (o achado #1);
4. resume por `session_id` guardado no card.
Rodar atras de um flag, ao lado da TUI atual, sem tocar no provisionamento — e so entao planejar as
Fases 2-4 (chat nativo, terminal como view opcional, limpeza dos gambs).

---
*Spike isolado. Nada de producao foi tocado. Harness e resultados neste diretorio.*

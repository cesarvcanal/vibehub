# Plano — migrar a sessão do vibehub para o Agent SDK (stream-json)

> Status: **PROPOSTA / só planejamento.** Nada aqui está implementado. Objetivo: decidir se
> vamos, e provar antes de mexer no núcleo. Decisão do César (25/08): "só planejar por enquanto".

## 1. O problema (a raiz dos "techgambs")

Hoje o vibehub dirige o Claude Code rodando a **TUI dele no tmux** e:

- **envia** mensagem por `send-keys` (teclado apontado pra tela), e
- **lê** o estado pelo **parsing do transcript** e do **pane** (capture-pane).

Ou seja: pilotamos por cima de uma interface feita pra humano. Toda a classe de bug desta sessão
nasce daí:

| Sintoma | Gambiarra atual |
|---|---|
| enviar por cima de um menu (resume/compact/permissão) | detectar o menu lendo o pane (#23) |
| mensagem enfileirada some do chat | pending durável no localStorage (#27) |
| não sabemos o estado real da mensagem | balão "pending" otimista + reconciliação por texto |
| permissão / plan / login | só resolvíveis no terminal cru |
| "Claude não está rodando" (falso) | sondar a árvore de processos do pane (#16) |

Não temos um **canal programático** com o agente — temos um teclado e um OCR do terminal.

## 2. O alvo — sessão estruturada

Rodar o Claude Code em modo **Agent SDK / headless stream-json**, não a TUI. Aí:

- a **mensagem entra** pela API e os **eventos saem estruturados** (texto, `tool_use`, resultado);
- **permissão** chega pelo callback **`canUseTool`** (allow/deny programático) — vira **botão
  clicável** no chat, sem parsing de pane;
- **sem** menu de resume, **sem** envio-cego, **sem** pending frágil: o chat vira a interface
  nativa, com **estado real** da mensagem (enviada / na fila / entregue / respondida).

A classe inteira de bug morre — não some com gambiarra, some por construção.

### Fatos técnicos (confirmados na doc do Claude Code)

- `claude -p` (headless) **pula** os menus de TUI (resume, etc.).
- `--output-format stream-json` dá deltas de texto e `tool_use`, **mas NÃO** traz permissão como
  evento. **A única interface estruturada de permissão é o `canUseTool` do Agent SDK** (in-process,
  aguardado antes do agente continuar).
- `PreToolUse` hook pode auto-allow/deny (veto barato) — útil, mas não substitui o callback.
- `--permission-mode` (acceptEdits / bypassPermissions / dontAsk / plan) controla o resto. O runner
  é sandbox por card → dá pra ser permissivo com segurança.
- Sessão é **resumível** por id (`--resume <id>` no headless / `query()` no SDK).

## 3. Como a gente TESTA antes de fazer (o pedido do César)

**Não migra nada de cara.** Primeiro um **spike / prova de conceito**, isolado, que NÃO encosta no
provisionamento atual. Se o PoC provar, aí planejamos a migração de verdade.

### PoC — escopo mínimo (1 branch, dev-only)

Um harness pequeno (um endpoint dev escondido, ou um script no runner) que:

1. abre **UMA** sessão via Agent SDK (`@anthropic-ai/claude-agent-sdk`) num worktree de teste;
2. manda um prompt e **renderiza os eventos estruturados** (assistant text + `tool_use`);
3. resolve **UMA** permissão via `canUseTool` retornando allow/deny (e mostra que o agente respeita);
4. **resume** a mesma sessão (segunda mensagem, mesmo id);
5. executa uma tarefa real de ponta (ex.: editar um arquivo) pra provar que não é brinquedo.

**Critérios de aceite do PoC:** (a) eventos vêm estruturados; (b) `canUseTool` dispara e a decisão
é honrada; (c) resume funciona; (d) roda uma edição de verdade; (e) **zero** mudança no que já roda
em produção. Roda numa **branch/frente separada**, o César testa isolado — e este terminal segue
livre pras alterações de UX.

## 4. A migração de verdade (só depois do PoC verde)

Fases, cada uma sua própria passada com plano:

1. **Camada de sessão nova** — um "driver SDK" por card (processo no runner que roda o `query()` do
   SDK), com transporte de eventos pro back (WS/stream) e `canUseTool` roteado pro chat.
2. **Chat = interface nativa** — o chat consome os eventos estruturados (não mais só o transcript);
   estado real da mensagem; permissões viram botões. As gambiarras (#23 menu-guard, #27 pending,
   sonda de menu) viram **desnecessárias** e saem.
3. **Terminal vira view opcional** — pros casos que só ele resolve (um shell de verdade, `/login`,
   um `git rebase -i`), roda um **tmux de shell** ao lado, sob demanda. Deixa de ser o **motor**.
4. **Limpeza** — remove send-keys como caminho principal, o parsing de pane pra estado, o pending
   frágil.

## 5. Trade-offs honestos

- É **migração de verdade**, mexe no núcleo (provisionamento + ciclo de sessão). Não é swap de tarde.
- O **terminal cru** deixa de ser o motor e vira escape hatch (bom — mas é mudança de modelo mental).
- Algumas coisas **continuam precisando** de um terminal (login interativo, shell) — o terminal não
  morre, só sai do caminho crítico.
- `canUseTool` é **in-process e aguardado**: o loop do agente espera a decisão. Precisa de UX pra não
  travar (timeout / default / "responder depois").

## 6. O que já subimos NÃO foi jogado fora

O menu-guard, o pending durável, o botão copiar, o navegador ligado, a UI e o parsing de transcript
**continuam valendo** como v1 — deixaram o chat usável AGORA. A migração é o movimento que faz os
techgambs **pararem de nascer**; até lá, os gambs seguram a peteca sem prejuízo.

## 7. Decisões em aberto (pra fechar com o César antes do PoC)

1. **Onde roda o driver SDK?** No runner (um processo por card, como hoje o `claude`) — provável — ou
   no back? (Runner mantém o isolamento por card.)
2. **Persistência/resume:** confiar no resume por id do SDK, ou o back guarda o histórico?
3. **Modelo de permissão:** `canUseTool` sempre (botão no chat) vs `bypassPermissions` + hook pro
   sandbox (menos fricção) vs híbrido (bypass no runner, `canUseTool` só pra ações sensíveis)?
4. **Coexistência com o terminal:** shell tmux sob demanda ao lado do driver, ou manter a TUI como
   modo alternativo?

## Próximo passo

Com o "vai" do César: rodar o **PoC** (seção 3) numa branch separada, isolado. Ele testa; se provar,
abrimos o plano da Fase 1.

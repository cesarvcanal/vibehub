# Higiene de processos do runner

Contexto: incidente de 2026-08-29. O `vibehub-runner` acumulou ~800 processos — ~180 `claude`
órfãos (ppid 1, rodando havia dias) e centenas de watchers de transcript vazados — e o load do
host (8 vCPUs) chegou a 55, deixando o vibehub inutilizável.

## As três defesas (neste repo)

1. **Watcher de transcript com morte garantida** (`back/src/services/chat/chat.ts`,
   `buildFollowCommand`): o loop de follow roda com `docker exec -i` e usa `read -t 2` como sleep
   — se o stdin (a conexão com o back) fechar, `read` volta EOF e o loop sai sozinho, matando o
   `tail` pelo trap. Era assim que vazava: matar o cliente `docker exec` local NÃO mata o processo
   dentro do container, e o heartbeat em stdout nunca falha porque o daemon segue consumindo. O
   loop também carrega o marcador `vibehub-transcript-follow` na linha de comando, para o reaper
   reconhecer um vazado.

2. **Kill por árvore de processos** (`back/src/services/board/workspace.ts`,
   `buildKillSessionScript` / `killCardSession`): todo caminho que encerra um terminal de card
   (pausar, hibernar, reiniciar, restart-all, deletar, troca de modelo/conta) mata a árvore
   inteira dos panes (SIGTERM → kill-session → SIGKILL nos sobreviventes), não só a sessão tmux.
   `tmux kill-session` sozinho manda SIGHUP, que o `claude` sobrevive — era assim que os órfãos
   nasciam.

3. **Reaper periódico** (`back/src/services/reaper/reaper.ts`): a cada 10 minutos o back lista os
   processos do runner e mata órfãos (ppid 1) com mais de 1h que sejam `claude` ou watcher de
   transcript. Loga o que matou; runner fora do ar = só warn. A última contagem fica exposta no
   `GET /api/runner` (campo `processes`) — contagem subindo entre sweeps é sinal de vazamento novo.

## Pendência: zumbis exigem `init: true`

O PID 1 do runner é `sleep infinity`, que nunca chama `wait()`: qualquer órfão morto vira zumbi
para sempre (~176 observados no incidente). Zumbi não consome CPU/memória, só um slot de pid, e
some no restart do container. A solução definitiva é **recriar o container do runner com
`init: true`** (PID 1 vira um init de verdade que colhe filhos) — agendada à parte com o César;
não fazer junto com deploy comum porque a recriação derruba todas as sessões tmux vivas.

# Higiene de processos do runner

Contexto (racional de design): numa instalação real, o `vibehub-runner` chegou a acumular ~800
processos — ~180 `claude` órfãos (ppid 1, rodando havia dias) e centenas de watchers de transcript
vazados — e o load do host (8 vCPUs) chegou a 55, deixando o vibehub inutilizável. As defesas
abaixo existem pra essa classe de vazamento nunca voltar.

## As defesas (neste repo)

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

4. **Prazo dentro do container** (`back/src/runtime/host.ts`, `containerScriptCommand`): o timeout
   de `runProcess` mata só o wrapper local (`bash -s`/`ssh` e o cliente `docker exec`) — pelo mesmo
   motivo do item 1, o trabalho dentro do container seguia vivo. No open de card isso era grave: um
   clone que estourava os 10 minutos liberava o lock de provisionamento e o próximo open rodava por
   cima do clone vivo. O open script agora entra no container como
   `docker exec -i <runner> timeout -s KILL <s> bash -s`, com `<s>` = prazo do Node menos
   `CONTAINER_DEADLINE_MARGIN_MS` (15s: handshake do ssh + start do exec). O `timeout` do coreutils
   (sempre presente na imagem Debian do runner) põe o bash num grupo de processos próprio e mata o
   grupo inteiro no prazo — bash e todo `git` debaixo dele —, antes de o Node desistir. O servidor
   tmux, que se desprende numa sessão própria, fica de fora de propósito.

## Zumbis: o runner nasce com `--init`

O comando do runner é `sleep infinity`, que nunca chama `wait()`: sem um init de verdade como
PID 1, qualquer órfão morto vira zumbi para sempre (~176 observados no incidente). Zumbi não
consome CPU/memória, só um slot de pid, e some no restart do container.

Por isso `buildRunScript` (`back/src/runtime/runner.ts`) cria o container com **`--init`**: o PID 1
vira o `docker-init` (tini), que colhe os filhos. Vale só para container **novo** — um runner que já
existe é apenas iniciado (`docker start`), nunca recriado, porque recriar derruba todas as sessões
tmux vivas. Instalações anteriores a essa mudança continuam com `sleep infinity` como PID 1 até o
operador recriar o container (remover o `vibehub-runner` e reprovisionar, ou `init: true` no
compose), numa janela agendada e não junto com um deploy comum.

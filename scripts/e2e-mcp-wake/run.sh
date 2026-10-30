#!/bin/bash
# E2E REAL (Claude, driver SDK e tmux de verdade) das ordens que chegam pelo MCP externo — o que o
# ChatGPT faz — sem navegador. Roda DENTRO do runner (é ele que tem claude/tmux). Não é do CI.
#
#   scripts/e2e-mcp-wake/run.sh            # S1–S6 + crash do driver no meio de uma ferramenta
#   scripts/e2e-mcp-wake/run.sh extra      # inatividade + sweep real, driver parado por ociosidade, ordem no
#                                          # meio da ferramenta, timeout de ferramenta, card em Done, persistência
#   scripts/e2e-mcp-wake/run.sh apiretry   # API fora do ar no meio do turno (proxy derruba conexões): volta sozinho
#   scripts/e2e-mcp-wake/run.sh deploy     # SIGKILL do back inteiro no meio da ferramenta + boot novo
#   scripts/e2e-mcp-wake/run.sh compare    # mesmo cenário na main (src-old) e nesta branch
#
# Isolamento: board/histórico num diretório temporário; o SDK do driver é uma CÓPIA (o shim troca
# /root/.vibehub-sdk por ela), então o driver plantado no runner de produção não é tocado; HOME
# próprio (o `bash -lc` do executor local reseta o PATH) com .claude apontando para o perfil real.
# Cards de teste usam o modelo haiku. Ao final, sessões tmux e /work/scratch dos cards são apagados.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
W="${E2E_WORK:-$(mktemp -d /tmp/vibehub-e2e-XXXX)}"
mkdir -p "$W/bin" "$W/home" "$W/sdk"
cp "$ROOT/scripts/e2e-mcp-wake/docker-shim.sh" "$W/bin/docker" && chmod +x "$W/bin/docker"
[ -d "$W/sdk/node_modules" ] || cp -a /root/.vibehub-sdk/node_modules /root/.vibehub-sdk/package*.json "$W/sdk/"
ln -sfn /root/.claude "$W/home/.claude"; cp /root/.claude.json "$W/home/.claude.json"
printf 'export PATH=%s/bin:$PATH\nexport E2E_SDK=%s/sdk\n' "$W" "$W" > "$W/home/.bash_profile"
export HOME="$W/home" E2E_BACK="$ROOT/back" E2E_SDK="$W/sdk" VIBEHUB_PUBLIC_URL=http://127.0.0.1:9 PATH="$W/bin:$PATH"
cleanup() {
  for b in "$W"/data*/board.json; do
    [ -f "$b" ] || continue
    node -e 'for (const c of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).cards) console.log(c.tmuxSession, c.worktreeSlug)' "$b" |
      while read -r s w; do tmux kill-session -t "$s" 2>/dev/null || true; rm -rf "/work/scratch/$w"; done
  done
}
trap cleanup EXIT
cd "$ROOT/back"
case "${1:-main}" in
  main) VIBEHUB_DATA_DIR="$W/data" npx tsx "$ROOT/scripts/e2e-mcp-wake/harness.mts" main ;;
  extra) VIBEHUB_DATA_DIR="$W/data-extra" npx tsx "$ROOT/scripts/e2e-mcp-wake/harness.mts" extra ;;
  apiretry) VIBEHUB_DATA_DIR="$W/data-apiretry" npx tsx "$ROOT/scripts/e2e-mcp-wake/harness.mts" apiretry ;;
  deploy)
    export VIBEHUB_DATA_DIR="$W/data-deploy"
    setsid bash -c "echo \$\$ > '$W/a.pgid'; exec npx tsx '$ROOT/scripts/e2e-mcp-wake/harness.mts' deploy-a" > "$W/deploy-a.log" 2>&1 &
    for _ in $(seq 1 120); do grep -q TOOL_RUNNING "$W/deploy-a.log" 2>/dev/null && break; sleep 1; done
    sleep 3; kill -9 -"$(cat "$W/a.pgid")"   # o `docker rm -f` do blue/green: o back e o driver juntos
    npx tsx "$ROOT/scripts/e2e-mcp-wake/harness.mts" deploy-b ;;
  compare)
    rm -rf src-old && mkdir src-old && git archive "${E2E_BASE:-origin/main}" src | tar -x -C src-old --strip-components=1
    trap 'rm -rf "$ROOT/back/src-old"; cleanup' EXIT
    for v in src-old src; do E2E_SRC=$v VIBEHUB_DATA_DIR="$W/data-$v" npx tsx "$ROOT/scripts/e2e-mcp-wake/beforeafter.mts" | grep -E '^\[(OLD|NEW)'; done ;;
esac

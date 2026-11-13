#!/bin/bash
# REAL E2E (real Claude, SDK driver and tmux) of the orders that arrive through the external MCP — what
# ChatGPT does — without a browser. Runs INSIDE the runner (it is the one that has claude/tmux). Not part of CI.
#
#   scripts/e2e-mcp-wake/run.sh            # S1–S6 + driver crash in the middle of a tool
#   scripts/e2e-mcp-wake/run.sh extra      # inactivity + real sweep, driver stopped for idleness, order in the
#                                          # middle of a tool, tool timeout, card in Done, persistence
#   scripts/e2e-mcp-wake/run.sh apiretry   # API down in the middle of the turn (a proxy drops connections): recovers on its own
#   scripts/e2e-mcp-wake/run.sh deploy     # SIGKILL of the whole back in the middle of a tool + a new boot
#   scripts/e2e-mcp-wake/run.sh compare    # the same scenario on main (src-old) and on this branch
#
# Isolation: board/history in a temporary directory; the driver's SDK is a COPY (the shim swaps
# /root/.vibehub-sdk for it), so the driver planted in the production runner is not touched; its own
# HOME (the local executor's `bash -lc` resets PATH) with .claude pointing at the real profile.
# Test cards use the haiku model. At the end, the cards' tmux sessions and /work/scratch are deleted.
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
    sleep 3; kill -9 -"$(cat "$W/a.pgid")"   # the blue/green `docker rm -f`: the back and the driver together
    npx tsx "$ROOT/scripts/e2e-mcp-wake/harness.mts" deploy-b ;;
  compare)
    rm -rf src-old && mkdir src-old && git archive "${E2E_BASE:-origin/main}" src | tar -x -C src-old --strip-components=1
    trap 'rm -rf "$ROOT/back/src-old"; cleanup' EXIT
    for v in src-old src; do E2E_SRC=$v VIBEHUB_DATA_DIR="$W/data-$v" npx tsx "$ROOT/scripts/e2e-mcp-wake/beforeafter.mts" | grep -E '^\[(OLD|NEW)'; done ;;
esac

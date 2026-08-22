#!/usr/bin/env bash
#
# vibehub installer — one line on a laptop or a fresh VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/cesarvcanal/vibehub/main/scripts/install.sh | bash
#
# It checks Docker, drops a compose file in ./vibehub (or $VIBEHUB_DIR), starts the app, and prints
# the URL to open. Everything else happens in the setup wizard, in the browser.

set -euo pipefail

DIR="${VIBEHUB_DIR:-$PWD/vibehub}"
PORT="${VIBEHUB_PORT:-3010}"
IMAGE="${VIBEHUB_IMAGE:-ghcr.io/cesarvcanal/vibehub:latest}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31mx\033[0m %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install it first: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "Docker is installed but not reachable. Is the daemon running, and can this user talk to it?"
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing. Install docker-compose-plugin and retry."

say "Installing vibehub into $DIR"
mkdir -p "$DIR"
cd "$DIR"

# The runner's persistent /root and /work live on the host, outside any container's lifetime.
# macOS Docker Desktop only shares a few roots (/Users, /tmp, …) — /opt is not one of them.
if [ "$(uname -s)" = "Darwin" ]; then
  RUNNER_BASE="${VIBEHUB_RUNNER_BASE_DIR:-$HOME/.vibehub/runner}"
else
  RUNNER_BASE="${VIBEHUB_RUNNER_BASE_DIR:-/opt/vibehub/runner}"
fi
if ! mkdir -p "$RUNNER_BASE" 2>/dev/null; then
  say "Cannot create $RUNNER_BASE without privileges — trying with sudo"
  sudo mkdir -p "$RUNNER_BASE"
  sudo chown "$(id -u):$(id -g)" "$RUNNER_BASE"
fi

cat > docker-compose.yml <<COMPOSE
services:
  vibehub:
    image: ${IMAGE}
    container_name: vibehub
    restart: unless-stopped
    ports:
      - "${PORT}:3010"
    environment:
      VIBEHUB_PUBLIC_URL: "\${VIBEHUB_PUBLIC_URL:-http://vibehub:3010}"
      VIBEHUB_RUNNER_KIND: "local"
      VIBEHUB_RUNNER_BASE_DIR: "${RUNNER_BASE}"
      VIBEHUB_RUNNER_NETWORK: "vibehub"
      VIBEHUB_INSECURE_COOKIES: "\${VIBEHUB_INSECURE_COOKIES:-1}"
      VIBEHUB_SECRET_KEY: "\${VIBEHUB_SECRET_KEY:-}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - vibehub-data:/data
    networks:
      - vibehub

networks:
  vibehub:
    name: vibehub

volumes:
  vibehub-data:
COMPOSE

say "Pulling the image"
docker compose pull --quiet 2>/dev/null || say "Image not published yet — building from source instead" 

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  [ -f Dockerfile ] || {
    say "Cloning the source to build"
    command -v git >/dev/null 2>&1 || die "git is required to build from source"
    git clone --depth 1 https://github.com/cesarvcanal/vibehub.git src
    cd src
  }
  docker build -t "$IMAGE" .
  cd "$DIR"
fi

say "Starting vibehub"
docker compose up -d

HOST_ADDR="localhost"
if [ -n "${SSH_CONNECTION:-}" ]; then
  HOST_ADDR="$(echo "$SSH_CONNECTION" | awk '{print $3}')"
fi

cat <<DONE

  vibehub is up.

  Open      http://${HOST_ADDR}:${PORT}
  Data      docker volume "vibehub-data"  (back this up — it holds your encrypted vault)
  Logs      docker compose -f ${DIR}/docker-compose.yml logs -f
  Stop      docker compose -f ${DIR}/docker-compose.yml down

  The setup wizard will create your account and provision the runner container.

DONE

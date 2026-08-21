# vibehub — single image serving the API and the built UI.
#
# The container needs a Docker socket (or SSH access to a host that has one) to manage the runner:
# see docker-compose.yml. It never runs the agent itself — that lives in the runner container.

FROM node:24-bookworm-slim AS build
WORKDIR /src

# node-pty is a native module: it needs a toolchain at build time, not at runtime.
RUN apt-get update -qq && apt-get install -y -qq python3 make g++ >/dev/null && rm -rf /var/lib/apt/lists/*

COPY back/package*.json back/
COPY front/package*.json front/
RUN npm --prefix back ci && npm --prefix front ci

COPY back back
COPY front front
RUN npm --prefix back run build && npm --prefix front run build

# Drop dev dependencies but KEEP the compiled native modules (node-pty). The runtime image has no
# toolchain, so it cannot rebuild them — pruning here is what lets it stay slim.
RUN npm --prefix back prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The docker CLI is how vibehub provisions and reaches the runner container.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends docker.io openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY back/package*.json ./
COPY --from=build /src/back/node_modules ./node_modules
COPY --from=build /src/back/dist ./dist
COPY --from=build /src/front/dist ./public

ENV VIBEHUB_PORT=3010 \
    VIBEHUB_DATA_DIR=/data \
    VIBEHUB_STATIC_DIR=/app/public
VOLUME ["/data"]
EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VIBEHUB_PORT||3010)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

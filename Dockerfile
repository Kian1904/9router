# Dockerfile optimized for Render free tier (512MB RAM)
# Based on 9router's official Dockerfile with memory-safe tweaks
ARG NODE_IMAGE=node:22-alpine
ARG ALPINE_MIRROR=dl-cdn.alpinelinux.org
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG APP_VERSION=unknown

FROM ${NODE_IMAGE} AS base
ARG ALPINE_MIRROR
WORKDIR /app

RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

FROM base AS builder
ARG NPM_REGISTRY
ARG RAILWAY_GIT_COMMIT_SHA

RUN apk add --no-cache python3 make g++ linux-headers

COPY package.json ./
RUN npm install \
      --registry="${NPM_REGISTRY}" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
# WAJIB: experimental.cpus:1 biar build gak OOM di env kecil
ENV NEXT_EXPERIMENTAL_CPUS=1
RUN APP_REVISION="${APP_REVISION:-$RAILWAY_GIT_COMMIT_SHA}" npm run build

# Postbuild: copy standalone assets (wajib per catatan build 9router)
RUN node scripts/copy-standalone-assets.mjs 2>/dev/null || true

# https://github.com/decolua/9router/issues/5245
# wreq-js and playwright-core are lazy runtime dependencies (loaded by
# lazyRuntime.js via createRequire). Next standalone tracing does not include
# them, so OpenCode Free fails with HTTP 502 ("resolve is undefined").
# Install them (with their native bindings/transitive deps) in an isolated dir
# so the runner stage can copy them into /app/node_modules.
RUN --mount=type=cache,target=/root/.npm \
    mkdir -p /opt/lazy-runtime && cd /opt/lazy-runtime && \
    npm init -y >/dev/null && \
    npm install --no-save \
      --registry="${NPM_REGISTRY}" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000 \
      wreq-js playwright-core

FROM ${NODE_IMAGE} AS runner
ARG ALPINE_MIRROR
ARG APP_VERSION
WORKDIR /app

RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

LABEL org.opencontainers.image.title="9router-render" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production
# Render inject $PORT, fallback 10000 kalau local
ENV PORT=${PORT:-10000}
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data
# Optional persistent state sync; values are injected as Render secrets.
# CF_KV_URL, CF_KV_TOKEN, CF_KV_ENCRYPTION_KEY
# RENDER FREE TIER FIX: paksa V8 GC agresif sebelum mentok 512MB
ENV NODE_OPTIONS="--max-old-space-size=384 --disable-warning=MODULE_TYPELESS_PACKAGE_JSON"

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
COPY --from=builder /app/src/mitm ./src/mitm
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src

# Module yang sering di-skip tracing tapi WAJIB ada
COPY --from=builder /app/node_modules/jose ./node_modules/jose
COPY --from=builder /app/node_modules/uuid ./node_modules/uuid
COPY --from=builder /app/node_modules/bcryptjs ./node_modules/bcryptjs
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
COPY --from=builder /app/node_modules/next ./node_modules/next
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
# wreq-js + playwright-core (and deps) are lazy-loaded at runtime and omitted by
# tracing. See https://github.com/decolua/9router/issues/5245
COPY --from=builder /opt/lazy-runtime/node_modules/. ./node_modules/

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

RUN apk add --no-cache su-exec ffmpeg && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

# Render butuh EXPOSE $PORT, tapi Dockerfile gak support variable di EXPOSE.
# Render auto-detect dari env var PORT, jadi EXPOSE ini cuma dokumentasi.
EXPOSE 10000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]

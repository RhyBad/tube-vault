# syntax=docker/dockerfile:1
# TubeVault (TS monorepo) images. Multi-stage per the gog-vault pattern: one
# shared build, then a minimal `pnpm deploy` per app on a shared engine runtime.
#
#   docker build --target api    -t tubevault-api:dev .
#   docker build --target worker -t tubevault-worker:dev .
#   docker build --target web    -t tubevault-web:dev .
#
# Base is Debian (bookworm-slim), NOT alpine: the pinned engine stack below
# installs deno from its PyPI wheel (glibc-only — the v1-proven delivery path),
# and native node deps (argon2 prebuilds, Prisma engines) must be built for the
# same libc they run on, so the build stage matches the runtime.

# ───────────────────────── shared build stage ─────────────────────────
FROM node:22-bookworm-slim AS build
# Prisma engines on Debian link against the distro OpenSSL 3 (node bundles its
# own statically — the slim image does not guarantee libssl otherwise).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
# ── dependency layer ── Only what `pnpm install` + `prisma generate` read: the
# workspace manifests, every package's package.json and the Prisma schema — NOT
# the source. A source edit then re-runs only the build below, not the install.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
# EVERY workspace importer's package.json must be present or the frozen-lockfile
# install refuses (the lockfile knows them all).
COPY packages/types/package.json packages/types/
COPY packages/core/package.json packages/core/
COPY packages/engine/package.json packages/engine/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
COPY packages/notify/package.json packages/notify/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/db/prisma packages/db/prisma
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tubevault/db exec prisma generate

# ── source layer ── The actual code; edits invalidate from here down only.
COPY packages ./packages
COPY apps ./apps
# Sequential (topological) build: workspace deps (types/db/core/engine) land in
# dist/ before the apps that import them. The web app is EXCLUDED here — it has
# its own lean build stage below (no prisma/engine baggage in its image path).
RUN pnpm -r --workspace-concurrency=1 --filter '!@tubevault/web' build

# Minimal production deploys (prod deps only): a self-contained node_modules
# tree per app — no devDeps, no sources, no sibling packages.
RUN pnpm --filter @tubevault/api deploy --prod /deploy/api \
 && pnpm --filter @tubevault/worker deploy --prod /deploy/worker
# `pnpm deploy` rebuilds node_modules from the lockfile and does NOT re-run
# `prisma generate`, so each deploy only carries the inert @prisma/client stub —
# the app would crash with "@prisma/client did not initialize yet". Regenerate
# into each deploy, pointing --schema at the REAL file under .pnpm (`find -type f`
# does not descend the node_modules/@tubevault/db symlink; with the symlink path
# Prisma treats the deploy as a project root and tries to npm-install the CLI).
# `set -e` + the non-empty guard fail the build on any iteration's failure.
RUN set -e; for d in api worker; do \
      schema="$(find "/deploy/$d" -type f -path '*@tubevault/db/prisma/schema.prisma' | head -1)"; \
      test -n "$schema"; \
      pnpm --filter @tubevault/db exec prisma generate --schema "$schema"; \
    done

# ─────────────────────── shared engine runtime ────────────────────────
# The EXACT engine stack the v1 image proved against both YouTube gates
# (bot-wall + nsig), pinned to v1's uv.lock versions and delivered the same
# way — one Python venv holding all three:
#   yt-dlp[default]  the engine + EJS challenge-solver scripts (yt-dlp-ejs)
#   deno             the JS runtime yt-dlp auto-detects on PATH to run EJS —
#                    without it "n challenge solving failed" throttling returns
#   bgutil plugin    PO-token client; INERT until a provider URL is configured
#                    (compose `pot` profile), no rebuild needed to enable
FROM node:22-bookworm-slim AS engine-runtime
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-venv openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/engine \
 && /opt/engine/bin/pip install --no-cache-dir \
      'yt-dlp[default]==2026.6.9' \
      'deno==2.9.1' \
      'bgutil-ytdlp-pot-provider==1.3.1' \
 && rm -rf /root/.cache
# Venv first on PATH: `yt-dlp` and `deno` resolve to the pinned installs.
ENV PATH="/opt/engine/bin:$PATH"
# Non-root (uid 10001, v1 parity). Pre-create the /data mount point owned by
# app so a NAMED volume inherits that ownership; for a BIND mount the host
# dir's ownership wins — chown it to 10001 first (see runbook "First run").
RUN useradd --create-home --uid 10001 app \
 && mkdir -p /data && chown app:app /data
WORKDIR /app

# ───────────────────────────── api ────────────────────────────────────
FROM engine-runtime AS api
# The api applies pending migrations on boot; `prisma migrate deploy` needs the
# CLI, which the --prod deploy dropped. Install it PINNED to the lockfile's 6.x
# (client and CLI must never drift), then drop the npm cache in the same layer.
RUN npm i -g prisma@6.19.3 && npm cache clean --force && rm -rf /root/.npm
COPY --from=build /deploy/api /app
# Build identity: the release tag flows in as --build-arg APP_VERSION (+ GIT_SHA,
# BUILT_AT) and is baked as read-only runtime env (GET /api/version reads these)
# plus OCI labels. Declared LATE so a version bump rebuilds only these tiny
# layers, not the deps above. A plain build with no args self-reports 0.0.0-dev.
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG BUILT_AT=
ENV APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_SHA} BUILT_AT=${BUILT_AT}
LABEL org.opencontainers.image.title="tubevault-api" \
      org.opencontainers.image.description="TubeVault API (NestJS)" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.source="https://github.com/RhyBad/tube-vault" \
      org.opencontainers.image.licenses="Apache-2.0"
USER app
EXPOSE 3000
# Apply pending migrations, then start. The schema (+ migrations/) ships inside
# the deployed @tubevault/db package, reachable via the node_modules symlink.
# `exec` is LOAD-BEARING: without it sh stays between tini and node, SIGTERM
# kills sh instantly and node is SIGKILLed by teardown — Nest's shutdown hooks
# (enableShutdownHooks) would be dead code while exit codes still LOOK graceful.
CMD ["sh", "-c", "prisma migrate deploy --schema node_modules/@tubevault/db/prisma/schema.prisma && exec node dist/main.js"]

# ─────────────────────────── worker ───────────────────────────────────
FROM engine-runtime AS worker
# ffmpeg/ffprobe: mux bestvideo+bestaudio and probe integrity (verify chain).
# Worker-only — the api never touches media internals.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /deploy/worker /app
# Build identity (see the api stage) — read-only runtime env + OCI labels.
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG BUILT_AT=
ENV APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_SHA} BUILT_AT=${BUILT_AT}
LABEL org.opencontainers.image.title="tubevault-worker" \
      org.opencontainers.image.description="TubeVault worker (archive + live roles)" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.source="https://github.com/RhyBad/tube-vault" \
      org.opencontainers.image.licenses="Apache-2.0"
USER app
# No migrate here — the worker assumes the api applied migrations on boot.
CMD ["node", "dist/main.js"]

# ─────────────────────────── web ──────────────────────────────────────
# Lean, separate build path: the web app depends ONLY on @tubevault/types
# (PLAN.md dependency rule), so its image never installs prisma/nest/engine.
# Stays alpine — its output is static files, no native/libc coupling.
FROM node:22-alpine AS web-build
RUN corepack enable
WORKDIR /repo
# The frozen-lockfile check needs every importer's package.json (same note as
# the shared stage). NOTE: `--filter @tubevault/web...` still installs the
# ROOT workspace package's devDependencies alongside web+types (pnpm treats
# the root as always selected) — web ALSO pins `typescript` in its own
# devDependencies so the `tsc && vite build` below never depends on that
# root-install side effect.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/types/package.json packages/types/
COPY packages/core/package.json packages/core/
COPY packages/engine/package.json packages/engine/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
COPY packages/notify/package.json packages/notify/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @tubevault/web...
COPY packages/types ./packages/types
COPY apps/web ./apps/web
# Bake the version into the static bundle: Vite's `define` (apps/web/vite.config.ts)
# inlines this VITE_APP_VERSION at build. No arg → 0.0.0-dev (honest dev build).
ARG APP_VERSION=0.0.0-dev
ENV VITE_APP_VERSION=${APP_VERSION}
# `@tubevault/web...` = web AND its workspace deps: types builds (dist/) first,
# then `tsc && vite build` emits apps/web/dist.
RUN pnpm --filter @tubevault/web... --workspace-concurrency=1 build

# Unprivileged base (P9 audit): keeps the repo's non-root posture — the api
# and worker stages already drop to uid 10001; stock nginx:alpine would have
# made the web container the only root process in the stack. The base listens
# on 8080 (non-root cannot bind 80); nginx.conf and the compose mapping agree.
FROM nginxinc/nginx-unprivileged:alpine AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /repo/apps/web/dist /usr/share/nginx/html
# OCI labels LAST (matches api/worker) so a timestamp-only rebuild doesn't bust
# the COPY layers above. The version is already baked into the static bundle;
# this stage serves files, so it carries no runtime version env.
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG BUILT_AT=
LABEL org.opencontainers.image.title="tubevault-web" \
      org.opencontainers.image.description="TubeVault web dashboard (React + nginx)" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.source="https://github.com/RhyBad/tube-vault" \
      org.opencontainers.image.licenses="Apache-2.0"
EXPOSE 8080

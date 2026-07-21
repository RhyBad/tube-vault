# SYNTHETIC dry-run fixture — proves the Release workflow's multi-arch, multi-target
# (api/worker/web on amd64+arm64) buildx path WITHOUT the real app image. NOT TubeVault.
# The real ./Dockerfile (same targets + build-args) arrives from the upstream release
# snapshot at tag time.
FROM alpine:3.20 AS base
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
RUN printf 'tubevault fixture v=%s sha=%s at=%s arch=%s\n' "$APP_VERSION" "$GIT_SHA" "$BUILT_AT" "$(uname -m)" > /fixture

FROM base AS api
FROM base AS worker
FROM base AS web

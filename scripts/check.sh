#!/usr/bin/env bash
# TubeVault verification harness — the single source of truth for "is it green?".
# install → prisma generate → build (tsc -b = typecheck) → lint → format-check → tests.
# Exits non-zero on ANY failure. Type-checking IS the build.
# Every TDD cycle must end with this passing.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

pnpm() { corepack pnpm "$@"; } # honor the packageManager pin without a global install

echo "==> [1/6] pnpm install (frozen lockfile)"
pnpm install --frozen-lockfile

echo "==> [2/6] prisma generate (@tubevault/db)"
pnpm --filter @tubevault/db exec prisma generate

echo "==> [3/6] build (tsc = typecheck, topological)"
pnpm -r --workspace-concurrency=1 build

echo "==> [4/6] eslint"
pnpm lint

echo "==> [5/6] prettier (check only)"
pnpm format:check

echo "==> [6/6] vitest"
pnpm test

echo "==> ALL GREEN ✔"

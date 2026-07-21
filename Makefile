# TubeVault — developer commands.
# `make check` is the single verification entry point (install+build+lint+format+tests).
SHELL := /usr/bin/env bash
PNPM ?= corepack pnpm

.PHONY: help install check fmt lint type test docker-build i18n-extract publish clean

help:
	@echo "make install      - pnpm install (frozen lockfile)"
	@echo "make check        - run the full verification harness (build+lint+format+tests)"
	@echo "make fmt          - auto-format (prettier) and auto-fix lint (eslint)"
	@echo "make lint         - eslint only"
	@echo "make type         - typecheck only (tsc -b via the topological build)"
	@echo "make test         - vitest only"
	@echo "make docker-build - build the api/worker/web Docker images"
	@echo "make i18n-extract - emit the canonical apps/web/dist/i18n/en.json"
	@echo "make publish      - dry-run the Gitea->GitHub publish (VERSION=X.Y.Z; EXECUTE=1 for real, blocked until Phase C)"
	@echo "make clean        - remove build output and tooling caches"

install:
	$(PNPM) install --frozen-lockfile

check:
	./scripts/check.sh

fmt:
	$(PNPM) format
	$(PNPM) lint --fix

lint:
	$(PNPM) lint

type:
	$(PNPM) -r --workspace-concurrency=1 build

test:
	$(PNPM) test

docker-build:
	docker build --target api    -t tubevault-api:dev .
	docker build --target worker -t tubevault-worker:dev .
	docker build --target web    -t tubevault-web:dev .

i18n-extract:
	$(PNPM) --filter @tubevault/web run i18n:extract

# Publish a snapshot + v<VERSION> tag to the public GitHub mirror. Dry-run by
# default; EXECUTE=1 attempts a real push (currently blocked until Phase C).
publish:
	@test -n "$(VERSION)" || { echo "usage: make publish VERSION=X.Y.Z [EXECUTE=1]"; exit 2; }
	./scripts/publish-from-gitea.sh "$(VERSION)" $(if $(EXECUTE),--execute,--dry-run)

clean:
	rm -rf coverage node_modules/.cache
	find apps packages -name '*.tsbuildinfo' -delete 2>/dev/null || true

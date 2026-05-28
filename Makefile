# cool-tunnel-server v0.5.8 -- monorepo operator + developer Makefile.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

V ?=
TARGET ?=

.PHONY: help
help: ## list available targets
	@awk -F'## ' '/^[a-zA-Z][a-zA-Z0-9_.-]*:.*## / { \
		split($$1, a, ":"); \
		printf "  \033[1m%-22s\033[0m %s\n", a[1], $$2 \
	}' $(MAKEFILE_LIST) | sort

# ---------- Local CI ------------------------------------------------

.PHONY: ci
ci: utf8-check compose-config manifests-jq manifest-lockstep ts-typecheck ts-test web-build operator-typecheck operator-test singbox-typecheck singbox-test rust-fmt-check rust-clippy rust-test rust-build stale-reference-scan ## full local release gate

.PHONY: utf8-check
utf8-check: ## verify tracked text files are valid UTF-8
	./scripts/check-utf8.sh

.PHONY: compose-config
compose-config: ## verify Docker Compose syntax and required services
	@created_env=0; \
	if [ ! -f .env ]; then cp .env.example .env; chmod 0600 .env; created_env=1; fi; \
	trap 'if [ "$$created_env" = "1" ]; then rm -f .env; fi' EXIT; \
	docker compose --env-file .env.example config >/dev/null; \
	for service in admin-api admin-web caddy singbox; do \
		docker compose --env-file .env.example config --services | grep -qx "$$service" || { echo "missing compose service: $$service" >&2; exit 1; }; \
	done; \
	docker compose --env-file .env.example config --services | grep -Eq '^(panel|db|mariadb|redis)$$' \
		&& { echo "retired service present in compose output" >&2; exit 1; } || true

.PHONY: manifests-jq
manifests-jq: ## jq parse every manifests/*.json
	@for f in manifests/*.json; do jq . "$$f" >/dev/null || { echo "bad json: $$f"; exit 1; }; done
	@echo "    manifests-jq: clean"

.PHONY: client-runtime-manifest
client-runtime-manifest: ## verify portable client runtime catalog
	@scripts/verify-client-runtime-manifest.sh

.PHONY: manifest-lockstep
manifest-lockstep: client-runtime-manifest ## verify app/package manifests are aligned
	@root_v=$$(jq -r '.version' package.json); \
	core_v=$$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' core/Cargo.toml | head -1); \
	for f in apps/api/package.json apps/web/package.json packages/shared/package.json packages/security/package.json packages/config/package.json packages/db/package.json operator/package.json singbox-core/package.json; do \
		v=$$(jq -r '.version' "$$f"); \
		if [ "$$v" != "$$root_v" ]; then echo "$$f version drift: $$v != $$root_v" >&2; exit 1; fi; \
	done; \
	for f in manifests/admin-api.upstream.json manifests/admin-web.upstream.json manifests/client-runtime.upstream.json manifests/ct-protocol.upstream.json; do \
		v=$$(jq -r '.version' "$$f"); \
		if [ "$$v" != "$$root_v" ]; then echo "$$f version drift: $$v != $$root_v" >&2; exit 1; fi; \
	done; \
	if [ "$$core_v" != "$$root_v" ]; then echo "core/Cargo.toml version drift: $$core_v != $$root_v" >&2; exit 1; fi
	@echo "    manifest-lockstep: clean"

.PHONY: ts-typecheck
ts-typecheck: ## typecheck apps and packages
	pnpm --filter @cool-tunnel/api typecheck
	pnpm --filter @cool-tunnel/web typecheck
	pnpm --filter @cool-tunnel/shared typecheck
	pnpm --filter @cool-tunnel/security typecheck
	pnpm --filter @cool-tunnel/config typecheck
	pnpm --filter @cool-tunnel/db typecheck

.PHONY: ts-test
ts-test: ## run API, web, and shared package tests
	bun test apps/api/tests apps/web/tests packages/db/tests packages/security/tests packages/config/tests

.PHONY: web-build
web-build: ## build the Next.js admin frontend
	pnpm --filter @cool-tunnel/web build

.PHONY: operator-typecheck
operator-typecheck: ## tsc --noEmit on operator/
	cd operator && bun run typecheck

.PHONY: operator-test
operator-test: ## run operator unit tests
	cd operator && bun test

.PHONY: operator-build
operator-build: ## build ct-operator binary; pass TARGET=<linux-arm64|darwin-arm64|all>
	pnpm install --frozen-lockfile
	cd operator && bun run build $(TARGET)

.PHONY: singbox-typecheck
singbox-typecheck: ## typecheck singbox-core/
	cd singbox-core && bun run typecheck

.PHONY: singbox-test
singbox-test: ## run singbox-core tests
	cd singbox-core && bun test

.PHONY: rust-fmt
rust-fmt: ## cargo fmt --all
	cd core && cargo fmt --all

.PHONY: rust-fmt-check
rust-fmt-check: ## cargo fmt --all -- --check
	cd core && cargo fmt --all -- --check

.PHONY: rust-clippy
rust-clippy: ## cargo clippy --workspace --all-targets
	cd core && SQLX_OFFLINE=true cargo clippy --workspace --all-targets --locked

.PHONY: rust-test
rust-test: ## cargo test --workspace
	cd core && SQLX_OFFLINE=true cargo test --workspace --locked

.PHONY: rust-build
rust-build: ## cargo build --workspace
	cd core && SQLX_OFFLINE=true cargo build --workspace --locked

.PHONY: stale-reference-scan
stale-reference-scan: ## fail on active-runtime references to removed PHP panel surfaces
	@bad="$$(rg -n 'docker/panel|panel/config|panel/composer|php artisan|FrankenPHP|supervisord|composer install|composer audit|CT_BOOTSTRAP_ADMIN_PASSWORD' \
		.github docker-compose.yml caddy scripts apps packages operator docker manifests README.md GETTING_STARTED.md docs SECURITY.md SUPPORT.md STRUCTURE.md VERSIONING.md 2>/dev/null \
		--glob '!apps/api/dist/**' \
		--glob '!apps/web/.next/**' \
		--glob '!operator/bin/**' \
		--glob '!operator/tests/**' \
		--glob '!packages/security/**' \
		--glob '!node_modules/**' \
		--glob '!docs/installation-debian.md' \
		--glob '!docs/architecture.md' \
		--glob '!docs/operations.md' \
		--glob '!docs/design/**' || true)"; \
	if [ -n "$$bad" ]; then printf '%s\n' "$$bad" >&2; exit 1; fi
	@echo "    stale-reference-scan: clean"

# ---------- Operator ops ------------------------------------------

.PHONY: install
install: ## first-time bootstrap
	./ct install

.PHONY: reinstall
reinstall: ## rerun install safely
	./ct reinstall

.PHONY: update
update: ## pull, load release images, migrate, render, and restart
	./ct update

.PHONY: deploy
deploy: update ## alias of update

.PHONY: doctor
doctor: ## read-only health dashboard
	./ct doctor

.PHONY: backup
backup: ## snapshot SQLite, .env, manifests, and Caddy state
	./ct backup

.PHONY: restore
restore: ## restore from BACKUP=<path>
	@test -n "$(BACKUP)" || { echo 'usage: make restore BACKUP=backups/file.tar.gz' >&2; exit 2; }
	./ct restore "$(BACKUP)"

.PHONY: auto-update
auto-update: ## run the unattended update agent once
	./ct auto-update now

.PHONY: render-caddyfile
render-caddyfile: ## render the generated Caddyfile
	./ct render caddyfile

.PHONY: render-singbox
render-singbox: ## render the generated sing-box config
	./ct render singbox

.PHONY: logs
logs: ## tail all container logs
	docker compose logs -f --tail=80

.PHONY: status
status: ## one-shot compose and image status
	@echo "=== Containers ==="
	@docker compose ps 2>/dev/null || echo "docker compose not running here"
	@echo
	@echo "=== Images ==="
	@docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.CreatedSince}}\t{{.Size}}' \
		2>/dev/null | (grep -E 'REPOSITORY|cool-tunnel-server' || echo "no cool-tunnel images yet")
	@echo
	@echo "=== Recent admin-api/admin-web errors ==="
	@docker compose logs --tail=160 admin-api admin-web 2>/dev/null \
		| grep -iE 'error|fatal|exception|panic' | tail -10 || echo "no recent admin errors"

.PHONY: clean-images
clean-images: ## remove local cool-tunnel-server runtime images
	@for img in cool-tunnel-server-singbox-core cool-tunnel-server-caddy cool-tunnel-server-singbox cool-tunnel-server-admin-api cool-tunnel-server-admin-web; do \
		docker image rm -f "$$img:latest" 2>/dev/null && echo "removed $$img:latest" || echo "$$img:latest not present"; \
	done

.PHONY: build-detached
build-detached: ## maintainer/dev only: build release images in tmux
	@if ! command -v tmux >/dev/null 2>&1; then echo "tmux not installed"; exit 1; fi
	@if tmux has-session -t ct-build 2>/dev/null; then echo "tmux session ct-build already exists"; exit 1; fi
	@tmux new-session -d -s ct-build './scripts/build_release_image_bundle.sh; echo "DONE $$(date)"; read'
	@echo "Build started in tmux session ct-build. Attach with: tmux attach -t ct-build"

# ---------- Release plumbing --------------------------------------

.PHONY: set-version
set-version: ## bump package, Rust, app/package, and app manifest versions; pass V=X.Y.Z
	@test -n "$(V)" || { echo 'usage: make set-version V=0.5.3' >&2; exit 2; }
	@for f in package.json apps/api/package.json apps/web/package.json packages/shared/package.json packages/security/package.json packages/config/package.json packages/db/package.json operator/package.json singbox-core/package.json; do \
		tmp="$${f}.tmp"; jq --arg v "$(V)" '.version = $$v' "$$f" > "$$tmp" && mv "$$tmp" "$$f"; \
	done
	@sed -i.bak -E 's/^version[[:space:]]*=[[:space:]]*"[^"]+"/version       = "$(V)"/' core/Cargo.toml
	@sed -i.bak -E 's/export const SINGBOX_CORE_VERSION = "[^"]+"/export const SINGBOX_CORE_VERSION = "$(V)"/' singbox-core/src/version.ts
	@for f in manifests/admin-api.upstream.json manifests/admin-web.upstream.json manifests/ct-protocol.upstream.json manifests/client-runtime.upstream.json; do \
		tmp="$${f}.tmp"; jq --arg v "$(V)" '.version = $$v' "$$f" > "$$tmp" && mv "$$tmp" "$$f"; \
	done
	@tmp=manifests/client-runtime.upstream.json.tmp; jq --arg v "$(V)" '.authority.release_tag = ("v" + $$v)' manifests/client-runtime.upstream.json > "$$tmp" && mv "$$tmp" manifests/client-runtime.upstream.json
	@find . -name '*.bak' -delete
	@cd core && cargo update --workspace
	@echo "bumped repository metadata to $(V)"

.PHONY: set-component-version
set-component-version: ## bump a component manifest; pass COMPONENT=<slug> V=<version>
	@test -n "$(COMPONENT)" -a -n "$(V)" || { echo 'usage: make set-component-version COMPONENT=caddy V=v2.11.4' >&2; exit 2; }
	@test -f "manifests/$(COMPONENT).upstream.json" || { echo "no such manifest: manifests/$(COMPONENT).upstream.json" >&2; exit 2; }
	@tmp="manifests/$(COMPONENT).upstream.json.tmp"; jq --arg v "$(V)" '.version = $$v' "manifests/$(COMPONENT).upstream.json" > "$$tmp" && mv "$$tmp" "manifests/$(COMPONENT).upstream.json"
	@echo "bumped manifests/$(COMPONENT).upstream.json to $(V)"

.PHONY: pin-images
pin-images: ## resolve current Docker base-image tags to digests
	cd operator && bun run pin-images.ts

.PHONY: sbom
sbom: ## generate CycloneDX SBOMs for Rust, TypeScript, and Docker images
	cd operator && bun run sbom.ts

.PHONY: clean
clean: ## remove local build artifacts
	rm -rf core/target apps/web/.next apps/api/dist packages/*/dist operator/dist singbox-core/bin

.PHONY: dist-clean
dist-clean: clean ## clean plus remove Docker volumes (DESTRUCTIVE)
	@printf 'WILL DROP DOCKER VOLUMES. Type "yes" to proceed: '; \
	read confirm; \
	if [ "$$confirm" = "yes" ]; then docker compose down -v; else echo aborted; fi

# Cool Tunnel Server — operator + developer Makefile.
#
# `make help` prints every target with a short description. Each
# target is short and assumes you've read the corresponding script
# / doc; this is glue, not a manual.
#
# Conventions:
#   - Tabs for recipe lines (Makefile requires it).
#   - .PHONY for everything because nothing here is a real file
#     target.
#   - One target per logical action; compose them via deps.

.SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# ---------- Configuration -----------------------------------------

# Override on the command line: `make set-version V=0.0.7`
V ?=

# ---------- Help --------------------------------------------------

.PHONY: help
help: ## list available targets
	@awk -F'## ' '/^[a-zA-Z][a-zA-Z0-9_.-]*:.*## / { \
		split($$1, a, ":"); \
		printf "  \033[1m%-20s\033[0m %s\n", a[1], $$2 \
	}' $(MAKEFILE_LIST) | sort

# ---------- CI gate (exactly what GitHub Actions runs) ------------

.PHONY: ci
ci: rust-fmt-check rust-clippy rust-test php-syntax shellcheck manifests-jq ## full local CI gate

.PHONY: rust-fmt
rust-fmt: ## cargo fmt --all
	cd core && cargo fmt --all

.PHONY: rust-fmt-check
rust-fmt-check: ## cargo fmt --all -- --check
	cd core && cargo fmt --all -- --check

.PHONY: rust-build
rust-build: ## cargo build --release --workspace (offline sqlx)
	cd core && SQLX_OFFLINE=true cargo build --release --workspace --locked

.PHONY: rust-test
rust-test: ## cargo test --release --workspace (offline sqlx)
	cd core && SQLX_OFFLINE=true cargo test --release --workspace --locked

.PHONY: rust-clippy
rust-clippy: ## cargo clippy --all-targets -- -D warnings (offline sqlx)
	cd core && SQLX_OFFLINE=true cargo clippy --release --all-targets --locked -- -D warnings

.PHONY: sqlx-prepare
sqlx-prepare: ## regenerate core/.sqlx/ from live schema (run after migrations or query!() edits)
	./scripts/sqlx-prepare.sh

.PHONY: sqlx-check
sqlx-check: ## verify core/.sqlx/ matches the live schema (CI lint)
	@cd core && SQLX_OFFLINE=true cargo check --workspace --locked \
		|| { echo ""; \
		     echo "  ↳ if this failed with 'no cached data for query',"; \
		     echo "    .sqlx/ is stale — run: make sqlx-prepare && git add core/.sqlx"; \
		     exit 1; }

.PHONY: php-syntax
php-syntax: ## php -l on every panel/**/*.php
	@cd panel && set -e ; \
	while IFS= read -r -d '' f; do \
		php -l "$$f" >/dev/null || { echo "syntax error in panel/$$f"; exit 1; }; \
	done < <(find app database/migrations database/seeders config bootstrap routes \
		-name '*.php' -type f -print0)
	@echo "    php-syntax: clean"

.PHONY: shellcheck
shellcheck: ## shellcheck all scripts and entrypoints
	shellcheck -x scripts/*.sh docker/panel/entrypoint.sh

.PHONY: manifests-jq
manifests-jq: ## jq parse every manifests/*.json
	@for f in manifests/*.json; do jq . "$$f" >/dev/null || { echo "bad json: $$f"; exit 1; }; done
	@echo "    manifests-jq: clean"

# ---------- Operator ops (alias the scripts/) ---------------------

.PHONY: install
install: ## first-time bootstrap (interactive)
	./scripts/install.sh

.PHONY: update
update: ## pull, rebuild, run component check, swap traffic
	./scripts/update.sh

.PHONY: backup
backup: ## snapshot db + .env + caddy data into backups/
	./scripts/backup.sh

.PHONY: readiness
readiness: ## run scripts/late-night-comeback.sh
	./scripts/late-night-comeback.sh

.PHONY: logs
logs: ## tail all container logs
	docker compose logs -f --tail=80

.PHONY: status
status: ## one-shot health check (safe to run after SSH reconnect)
	@echo "=== Containers ==="
	@docker compose ps 2>/dev/null || echo "  docker compose not running here"
	@echo ""
	@echo "=== Images (cool-tunnel-server-* only) ==="
	@docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.CreatedSince}}\t{{.Size}}' \
		2>/dev/null | (grep -E 'REPOSITORY|cool-tunnel-server' || echo "  no cool-tunnel images yet")
	@echo ""
	@echo "=== ct-server-core binary inside panel image ==="
	@docker run --rm --entrypoint=ls cool-tunnel-server-panel:latest \
		-la /usr/local/bin/ct-server-core 2>/dev/null \
		|| echo "  panel image not built / binary missing"
	@echo ""
	@echo "=== Last panel errors (if any) ==="
	@docker compose logs --tail=200 panel 2>/dev/null \
		| grep -iE 'error|fatal|exception' | tail -5 \
		|| echo "  no recent errors"
	@echo ""
	@echo "=== Last sing-box errors (if any) ==="
	@docker compose logs --tail=200 sing-box 2>/dev/null \
		| grep -iE 'error|fatal|panic' | tail -5 \
		|| echo "  no recent errors"
	@echo ""
	@echo "=== Cert presence ==="
	@if [ -f /var/lib/docker/volumes/cool-tunnel-server_caddy_data/_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$$(grep ^DOMAIN= .env 2>/dev/null | cut -d= -f2)/$$(grep ^DOMAIN= .env 2>/dev/null | cut -d= -f2).crt ]; then \
		echo "  ✓ cert obtained"; \
	else \
		echo "  ✗ cert not yet (or DOMAIN unset)"; \
	fi

.PHONY: clean-images
clean-images: ## drop locally-built cool-tunnel-server-* images (forces fresh rebuild)
	@for img in cool-tunnel-server-core cool-tunnel-server-panel \
	            cool-tunnel-server-caddy cool-tunnel-server-singbox \
	            cool-tunnel-server-sqlx-prepare; do \
		docker image rm -f "$$img:latest" 2>/dev/null && echo "  removed $$img:latest" \
		    || echo "  $$img:latest not present"; \
	done
	@echo "    next step: docker compose --profile build-only build core-builder"

.PHONY: build-detached
build-detached: ## run a long build in tmux so SSH drops don't kill it
	@if ! command -v tmux >/dev/null 2>&1; then \
		echo "tmux not installed — apt install -y tmux"; exit 1; \
	fi
	@if tmux has-session -t ct-build 2>/dev/null; then \
		echo "tmux session 'ct-build' already exists. Attach: tmux attach -t ct-build"; \
		echo "Or kill: tmux kill-session -t ct-build"; \
		exit 1; \
	fi
	@tmux new-session -d -s ct-build \
		'set -x; \
		 docker compose --profile build-only build core-builder && \
		 docker compose build panel && \
		 docker compose up -d --force-recreate panel sing-box && \
		 echo "DONE $$(date)" > /tmp/ct-build.done; \
		 echo "press enter to close session"; read'
	@echo "Build started in tmux session 'ct-build'."
	@echo "Attach to watch:        tmux attach -t ct-build"
	@echo "Detach without killing: Ctrl-B then d"
	@echo "Check status from any session: make status"
	@echo "When done: /tmp/ct-build.done will exist."

.PHONY: components
components: ## ct-server-core component check (OK/NG)
	docker compose exec -T panel ct-server-core component check --manifests /srv/manifests

# ---------- Release plumbing -------------------------------------

.PHONY: set-version
set-version: ## bump the version in Cargo.toml + manifests + lockfile; pass V=X.Y.Z
	@if [ -z "$(V)" ]; then echo 'usage: make set-version V=0.0.7'; exit 1; fi
	@sed -i.bak 's/^version       = ".*"/version       = "$(V)"/' core/Cargo.toml
	@sed -i.bak -E 's/"version": "[0-9]+\.[0-9]+\.[0-9]+"/"version": "$(V)"/' \
		manifests/ct-server-core.upstream.json \
		manifests/ct-protocol.upstream.json \
		manifests/panel.upstream.json
	@find . -name '*.bak' -delete
	@# Refresh core/Cargo.lock so the workspace member version
	@# entries (`name = "ct-server-core" / "ct-protocol", version = "..."`)
	@# track Cargo.toml. Without this, the next `cargo build --locked`
	@# (the LTSC release-check job uses --locked) fails with "the
	@# lock file ... needs to be updated", leaving the operator with
	@# a stale lockfile inside what they thought was a clean version
	@# bump. `cargo update --workspace --offline` only touches the
	@# in-tree workspace entries — no crates.io fetch, no transitive
	@# bumps. If the registry cache is cold, fall back to an online
	@# update; on hard failure (air-gapped CI, cargo borked), exit
	@# loudly so the operator notices BEFORE they tag the release —
	@# silent failure here is exactly the trap this whole step
	@# exists to prevent. (v0.0.14 hardening.)
	@cd core && \
	    cargo update --workspace --offline >/dev/null 2>&1 \
	    || cargo update --workspace        >/dev/null 2>&1 \
	    || { \
	        echo ""; \
	        echo "  ✗ make set-version: could not refresh Cargo.lock" >&2; \
	        echo "    workspace versions in core/Cargo.toml were bumped, but" >&2; \
	        echo "    cargo update failed (offline AND online). Run:" >&2; \
	        echo "        cd core && cargo check" >&2; \
	        echo "    manually before tagging the release, or revert the bump:" >&2; \
	        echo "        git checkout -- core/Cargo.toml manifests/*.upstream.json" >&2; \
	        echo ""; \
	        exit 1; \
	    }
	@echo "    bumped to $(V) in: core/Cargo.toml, core/Cargo.lock, manifests/{ct-server-core,ct-protocol,panel}.upstream.json"

.PHONY: pin-images
pin-images: ## resolve current docker base-image tags to digests; updates Dockerfiles in place
	@if ! command -v docker >/dev/null; then echo 'docker not on PATH'; exit 1; fi
	@./scripts/pin-images.sh

.PHONY: sbom
sbom: ## generate CycloneDX SBOMs for cargo + composer + docker
	./scripts/sbom.sh

# ---------- Cleaning ---------------------------------------------

.PHONY: clean
clean: ## remove cargo target, composer vendor, php caches
	rm -rf core/target panel/vendor panel/storage/framework/{cache/data,sessions,views}/* panel/storage/logs/*

.PHONY: dist-clean
dist-clean: clean ## clean + drop docker volumes (DESTRUCTIVE — confirms first)
	@printf 'WILL DROP DOCKER VOLUMES (db, redis, caddy ACME state). Type "yes" to proceed: '; \
	read confirm; \
	if [ "$$confirm" = "yes" ]; then docker compose down -v; else echo aborted; fi

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
rust-build: ## cargo build --release --workspace
	cd core && cargo build --release --workspace --locked

.PHONY: rust-test
rust-test: ## cargo test --release --workspace
	cd core && cargo test --release --workspace --locked

.PHONY: rust-clippy
rust-clippy: ## cargo clippy --all-targets -- -D warnings
	cd core && cargo clippy --release --all-targets --locked -- -D warnings

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

.PHONY: components
components: ## ct-server-core component check (OK/NG)
	docker compose exec -T panel ct-server-core component check --manifests /srv/manifests

# ---------- Release plumbing -------------------------------------

.PHONY: set-version
set-version: ## bump the version in Cargo.toml + manifests; pass V=X.Y.Z
	@if [ -z "$(V)" ]; then echo 'usage: make set-version V=0.0.7'; exit 1; fi
	@sed -i.bak 's/^version       = ".*"/version       = "$(V)"/' core/Cargo.toml
	@sed -i.bak -E 's/"version": "[0-9]+\.[0-9]+\.[0-9]+"/"version": "$(V)"/' \
		manifests/ct-server-core.upstream.json \
		manifests/ct-protocol.upstream.json \
		manifests/panel.upstream.json
	@find . -name '*.bak' -delete
	@echo "    bumped to $(V) in: core/Cargo.toml, manifests/{ct-server-core,ct-protocol,panel}.upstream.json"

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

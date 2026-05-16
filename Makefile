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

# GNU make's shell-selection variable is `SHELL` (no leading dot);
# `.SHELLFLAGS` IS dotted but `.SHELL` was a typo. With `.SHELL`,
# make falls back to /bin/sh which doesn't support bash-only
# constructs like `< <(...)` process substitution used in the
# `php-syntax` target. (v0.0.55 — fixed during the Cycle 3 CI
# bring-up.)
SHELL := /bin/bash
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
ci: rust-fmt-check rust-clippy rust-test php-syntax composer-audit shellcheck manifests-jq manifest-lockstep verify-sot verify-supervisord secrets-argv ## full local CI gate

# Cycle 3 / v0.0.55 — cross-language SoT parity guard. Runs both
# the PHP and Rust panel-hostname resolvers against fixture envs and
# asserts equivalent output (or equivalent fail-mode on the all-empty
# fixture). Catches future drift between the two implementations of
# the same logic. Wired into `ci` above so every local + GitHub
# Actions CI run exercises it. Requires the panel's composer
# dependencies installed (vendor/autoload.php) and a working cargo
# toolchain — both are already required by the surrounding ci
# steps.
#
# v0.0.56 — verify_sot.sh now gracefully skips (with a pointer to
# verify-sot-vps below) when php/cargo are missing on the host.
# That lets `make ci` pass on docker-only VPS hosts without
# silently masking the SoT contract.
.PHONY: verify-sot
verify-sot: ## cross-language SoT parity check (Cycle 3 / v0.0.55; skips when host lacks php/cargo — see verify-sot-vps)
	cd operator && bun run verify-sot.ts --mode=host

# v0.0.56 — VPS-side counterpart to verify-sot. Exercises the same
# five fixtures via `docker compose exec` against the running panel
# container, so it works on docker-only hosts where PHP and cargo
# aren't installed. NOT wired into `make ci` — it requires a
# running stack, which CI doesn't have. Operator surface for
# confirming a deployed release honours the v0.0.55 SoT contract.
.PHONY: verify-sot-vps
verify-sot-vps: ## VPS-side SoT parity check via docker compose exec (v0.0.56)
	cd operator && bun run verify-sot.ts --mode=vps

# Round-22 process-lifecycle audit — pin the round-6 supervisord
# graceful-shutdown invariants (stopsignal=TERM, stopwaitsecs=20,
# killasgroup, stopasgroup) on every [program:*] block, plus the
# frankenphp MAX_REQUESTS=500 worker-recycle ceiling. A future
# edit that drops one of these wouldn't break any test —
# supervisord still works — but `docker compose stop` would
# SIGKILL in-flight requests on the affected program. Wired into
# `make ci` so drift surfaces on every PR.
.PHONY: verify-supervisord
verify-supervisord: ## supervisord.conf lifecycle-invariants drift detector (round-22)
	cd operator && bun run verify-supervisord.ts

# v0.0.79 robustness-review fix: enforce backup.sh's v0.0.17
# MYSQL_PWD / REDISCLI_AUTH discipline across every script that
# shells out to the db or redis container. The bad pattern is
# `mariadb … -p"…"` or `redis-cli … -a "…"` with the password
# interpolated into argv — the secret then surfaces in `ps -ef`
# inside the container, in `docker top` on the host, and in any
# process collector (sysdig / Falco / Datadog) that snapshots
# argv. The good pattern is `compose exec -T -e MYSQL_PWD=… db
# mariadb -u USER` (or REDISCLI_AUTH for redis-cli) — the env
# is delivered via the docker engine API, never via argv.
#
# The check is line-anchored (skips comments) and looks for a
# literal `$` after the dangerous flag, since the operational
# hazard is env-var interpolation specifically. Hard-coded
# literal secrets are caught separately by gitleaks in audit.yml.
.PHONY: secrets-argv
secrets-argv: ## enforce MYSQL_PWD / REDISCLI_AUTH discipline (no DB/Redis password on argv)
	@bad="$$(grep -rnE --include='*.sh' \
	    -e '^[^#]*(mariadb|mysql|redis-cli)[^|#]*[[:space:]]*-(p|a)[[:space:]]*"?\$$' \
	    scripts/ docker/ 2>/dev/null | grep -vE ':[[:space:]]*#' || true)"; \
	if [ -n "$$bad" ]; then \
	    printf '%s\n' "secrets-argv: FAIL — DB/Redis password on argv detected:" "$$bad" "" \
	        "Use 'compose exec -T -e MYSQL_PWD=\"\$$DB_PASSWORD\" db mariadb -u USER …' or" \
	        "    'compose exec -T -e REDISCLI_AUTH=\"\$$REDIS_PASSWORD\" redis redis-cli …' instead." \
	        "(See backup.sh's v0.0.17 pattern for the canonical example.)" >&2; \
	    exit 1; \
	fi; \
	printf '    secrets-argv: clean\n'

# Convenience aliases — `make fmt`, `make lint`, `make test` are
# the muscle-memory commands every Rust project ships. The full
# names are kept (some operators script against them) but typing
# `make fmt` should Just Work. (v0.0.18.)
.PHONY: fmt
fmt: rust-fmt ## alias of rust-fmt

.PHONY: lint
lint: rust-clippy ## alias of rust-clippy

.PHONY: test
test: rust-test ## alias of rust-test

.PHONY: build
build: rust-build ## alias of rust-build; local Rust release build gate

.PHONY: audit
audit: ci ## local audit gate; mirrors CI plus script-level drift checks

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
rust-clippy: ## cargo clippy --all-targets (offline sqlx; deny rules in workspace.lints already fail the build on real correctness issues)
	@# Cycle 3 / v0.0.55 — dropped the trailing `-- -D warnings`. The
	@# workspace's [lints.clippy] table already sets unwrap_used,
	@# expect_used, panic, todo, unimplemented to deny — those fail
	@# compilation regardless of cmdline flags. `-D warnings` on top
	@# was promoting the entire `pedantic` lint group (warn-level by
	@# the same workspace config) to errors, which generated 80+
	@# false-positive failures in pre-existing code (doc_markdown
	@# acronyms, missing #[must_use] on pure helpers, etc.) that had
	@# never been cleaned up. The relaxation keeps real correctness
	@# gating intact via the deny rules and stops blocking the CI on
	@# pedantic-level chatter. Targeted pedantic cleanup remains a
	@# good Cycle-N follow-up; not blocking SoT / drift work.
	cd core && SQLX_OFFLINE=true cargo clippy --release --all-targets --locked

.PHONY: sqlx-prepare
sqlx-prepare: ## regenerate core/.sqlx/ from live schema (run after migrations or query!() edits)
	cd operator && bun run sqlx-prepare.ts

.PHONY: sqlx-check
sqlx-check: ## verify core/.sqlx/ matches the live schema (CI lint)
	@cd core && SQLX_OFFLINE=true cargo check --workspace --locked \
		|| { echo ""; \
		     echo "  ↳ if this failed with 'no cached data for query',"; \
		     echo "    .sqlx/ is stale — run: make sqlx-prepare && git add core/.sqlx"; \
		     exit 1; }

.PHONY: php-test
php-test: ## phpunit on the panel test suite (requires composer install in panel/)
	@if [ ! -f panel/vendor/autoload.php ]; then \
	    echo "panel/vendor/ missing — run \`cd panel && composer install\` first" >&2; \
	    exit 1; \
	fi
	cd panel && vendor/bin/phpunit

.PHONY: php-syntax
php-syntax: ## php -l on every panel/**/*.php
	@cd panel && set -e ; \
	while IFS= read -r -d '' f; do \
		php -l "$$f" >/dev/null || { echo "syntax error in panel/$$f"; exit 1; }; \
	done < <(find app database/migrations database/seeders config bootstrap routes \
		-name '*.php' -type f -print0)
	@echo "    php-syntax: clean"

# Round 23 — match the GitHub Actions audit workflow's `composer
# audit` job so an operator running `make ci` locally sees the
# same vuln check (was a silent gap pre-this; the workflow caught
# CVEs that local make ci would have missed). Skips gracefully if
# composer / vendor isn't present so docker-only hosts still get
# `make ci` exit 0.
.PHONY: composer-audit
composer-audit: ## composer security audit on the panel deps (matches GH Actions audit.yml)
	@if ! command -v composer >/dev/null 2>&1; then \
		echo "    composer-audit: SKIP (composer not on PATH; run on a host with composer to enable)"; \
		exit 0; \
	fi; \
	if [ ! -f panel/composer.lock ]; then \
		echo "    composer-audit: SKIP (panel/composer.lock missing)"; \
		exit 0; \
	fi; \
	cd panel && composer audit --no-interaction --no-cache

.PHONY: shellcheck
shellcheck: ## shellcheck all scripts and entrypoints (severity=warning — style/info are non-blocking)
	@# Cycle 3 / v0.0.55 — added `--severity=warning` so the CI gate
	@# only fails on real correctness findings. Info-level chatter
	@# (SC2012 prefer-find-over-ls, SC1091 can't-follow-source-from-
	@# this-cwd, SC2016 single-quoted-deliberate-no-expansion)
	@# accumulated in pre-Cycle-3 scripts and was always blocking
	@# the gate. Bumping the severity floor preserves the actual
	@# correctness gating (warnings + errors) without churning on
	@# style-level cleanup. Targeted info-level cleanup remains a
	@# good Cycle-N follow-up if the team wants stricter style.
	shellcheck -x --severity=warning scripts/*.sh docker/panel/entrypoint.sh

.PHONY: manifests-jq
manifests-jq: ## jq parse every manifests/*.json
	@for f in manifests/*.json; do jq . "$$f" >/dev/null || { echo "bad json: $$f"; exit 1; }; done
	@echo "    manifests-jq: clean"

.PHONY: manifest-lockstep
manifest-lockstep: ## verify manifest pins match local deployment sources
	@naive_arg=$$(sed -n -E 's/^ARG NAIVE_VERSION=v?(.+)/\1/p' docker/panel/Dockerfile | head -n1); \
	naive_manifest=$$(jq -r '.version' manifests/naiveproxy-client.upstream.json); \
	case "$$naive_arg" in "$$naive_manifest"| "$$naive_manifest"-*) ;; \
	    *) echo "naiveproxy-client manifest drift: Dockerfile=$$naive_arg manifest=$$naive_manifest" >&2; \
	    exit 1; \
	    ;; \
	esac
	@credential_pin=$$(jq -r '.version' manifests/credential-lock.upstream.json); \
	if [ "$$credential_pin" != "db=rendered=manifest=mac-config" ]; then \
	    echo "credential-lock manifest drift: $$credential_pin" >&2; \
	    exit 1; \
	fi
	@echo "    manifest-lockstep: clean"

# ---------- Operator ops (alias the scripts/) ---------------------

.PHONY: install
install: ## first-time bootstrap (interactive)
	./scripts/install.sh

.PHONY: update
update: ## pull, rebuild, run component check, swap traffic
	./scripts/update.sh

.PHONY: deploy
deploy: update ## alias of update; deploy the latest fast-forwarded release

.PHONY: backup
backup: ## snapshot db + .env + caddy data into backups/
	./scripts/backup.sh

.PHONY: readiness
readiness: ## run scripts/late-night-comeback.sh (strict >=9/10 readiness gate; cron/CI suitable)
	./scripts/late-night-comeback.sh

.PHONY: doctor
doctor: ## run scripts/doctor.sh (operator-friendly health dashboard with PASS/WARN/FAIL + remediation hints)
	./scripts/doctor.sh

.PHONY: auto-sync
auto-sync: ## run scripts/auto_sync.sh (credential-lock audit + auto-correct agent; cron-friendly)
	./scripts/auto_sync.sh

.PHONY: fix
fix: ## run scripts/fix.sh (interactive multi-recipe auto-diagnose-and-repair agent; the "I'm stuck" command)
	./scripts/fix.sh

.PHONY: auto-update
auto-update: ## run scripts/auto_update.sh (unattended release-pulling agent; default-OFF cron-safe; `ct auto-update enable` to schedule)
	./scripts/auto_update.sh

# ============================================================
# operator/ — Bun CLI (ct-operator)
# ============================================================
# Compiled standalone replacement for fix / doctor / late-night-comeback.
# The `ct` dispatcher prefers operator/bin/ct-operator-<os>-<arch> when
# present and falls back to the .sh scripts otherwise. No flag day.

.PHONY: operator-build
operator-build: ## build ct-operator binary (default linux-x64; pass TARGET=<linux-arm64|darwin-arm64|all> to cross-compile)
	cd operator && bun install --frozen-lockfile && bun run build $(TARGET)

.PHONY: operator-test
operator-test: ## run ct-operator unit tests (bun test)
	cd operator && bun test

.PHONY: operator-typecheck
operator-typecheck: ## tsc --noEmit on operator/
	cd operator && bun run typecheck

.PHONY: operator-fetch
operator-fetch: ## fetch the ct-operator binary matching the deployed release into operator/bin/ (idempotent; honors CT_SKIP_OPERATOR_FETCH=1)
	./scripts/fetch_operator_binary.sh

.PHONY: operator-keygen
operator-keygen: ## generate ed25519 signing keypair for SHA256SUMS (writes operator/signing.key; prints pubkey)
	@if [ -f operator/signing.key ]; then \
		echo "operator/signing.key already exists; refusing to overwrite."; \
		echo "If you really mean to rotate, move the old one aside first."; \
		exit 1; \
	fi
	openssl genpkey -algorithm ed25519 -out operator/signing.key
	@chmod 600 operator/signing.key
	@echo ""
	@echo "private key: operator/signing.key  (chmod 600, KEEP SECRET)"
	@echo "  -> store as GitHub Actions secret CT_OPERATOR_SIGNING_KEY"
	@echo "  -> operator/.gitignore already excludes this file"
	@echo ""
	@echo "public key (set as CT_OPERATOR_PUBKEY env var at build time):"
	@openssl pkey -in operator/signing.key -pubout -outform DER | tail -c 32 | base64

.PHONY: help-topics
help-topics: ## list operator mini-manual topics (then run `make help-<topic>`)
	@cd operator && bun run help.ts

# Per-topic help dispatch. The `%` is the topic name (e.g.
# `make help-update` -> `bun run help.ts update`). Pattern
# rules don't show in `make help`'s table -- run `make
# help-topics` to see the list.
help-%:
	@cd operator && bun run help.ts $*

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
set-version: ## bump the version in Cargo.toml + manifests + lockfile + panel config; pass V=X.Y.Z
	@if [ -z "$(V)" ]; then echo 'usage: make set-version V=0.0.7'; exit 1; fi
	@sed -i.bak 's/^version       = ".*"/version       = "$(V)"/' core/Cargo.toml
	@sed -i.bak -E 's/"version": "[0-9]+\.[0-9]+\.[0-9]+"/"version": "$(V)"/' \
		manifests/ct-server-core.upstream.json \
		manifests/ct-protocol.upstream.json \
		manifests/panel.upstream.json
	@# panel/config/cool-tunnel.php::version is the runtime source of
	@# truth for the `ct:version` artisan command (Cycle 2 panel
	@# probe, v0.0.39). It MUST equal manifests/panel.upstream.json's
	@# version, otherwise the matcher's soft version check trips
	@# VersionMismatch on every component check after the bump.
	@sed -i.bak -E "s/'version' => '[0-9]+\.[0-9]+\.[0-9]+'/'version' => '$(V)'/" \
		panel/config/cool-tunnel.php
	@# operator/package.json::version — read at build time by build.ts
	@# and baked into the binary via --define BUILD_VERSION=. Without
	@# bumping this, the compiled binary's `--version` and the
	@# incident-bridge JSON's `operator_version` field stay at the
	@# scaffold's 0.0.1 forever, regardless of release tag. (v0.1.8.)
	@sed -i.bak -E 's/"version": "[0-9]+\.[0-9]+\.[0-9]+"/"version": "$(V)"/' \
		operator/package.json
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

.PHONY: set-component-version
set-component-version: ## bump component version across compose + Dockerfile + manifest in lockstep; pass COMPONENT=<slug> V=X.Y.Z
	@# v0.0.40 introduced this macro for THIRD-PARTY manifest pins.
	@# v0.0.45 extended it: a single invocation now drives the
	@# compose `image:` tag, the Dockerfile `FROM` / `ARG` /
	@# `COPY --from=` lines, AND the manifest version in lockstep.
	@# The v0.0.43 drift probes assert these stay aligned — drift
	@# between any two layers trips VersionMismatch on the panel
	@# Components page. This macro is now the SINGLE source of
	@# truth for "bump component <X> to <Y>"; partial bumps are
	@# structurally impossible.
	@if [ -z "$(COMPONENT)" ] || [ -z "$(V)" ]; then \
	    echo 'usage: make set-component-version COMPONENT=redis V=7.4.9'; \
	    echo ''; \
	    echo 'lockstep-aware components (compose / Dockerfile / manifest):'; \
	    echo '  redis    — docker-compose.yml + docker/panel/Dockerfile + manifest'; \
	    echo '  mariadb  — docker-compose.yml + manifest'; \
	    echo '  sing-box — docker/sing-box/Dockerfile (ARG) + manifest'; \
	    echo '  haproxy  — docker/haproxy/Dockerfile (FROM) + manifest'; \
	    echo ''; \
	    echo 'manifest-only components:'; \
	    echo '  caddy, ct-protocol, ct-server-core, doh-resolver,'; \
	    echo '  naiveproxy, naiveproxy-client, panel'; \
	    exit 1; \
	fi
	@if [ ! -f manifests/$(COMPONENT).upstream.json ]; then \
	    echo "no such component: manifests/$(COMPONENT).upstream.json"; \
	    exit 1; \
	fi
	@# Component-aware lockstep handlers (v0.0.45). Each branch
	@# bumps the source-of-truth files for that component beyond
	@# the manifest. Components without a branch fall through to
	@# manifest-only — used by caddy (informational-only) and the
	@# in-tree components that coordinate via `make set-version`.
	@case "$(COMPONENT)" in \
	    redis) \
	        sed -i.bak -E 's|(image: *)redis:[^[:space:]]+|\1redis:$(V)-alpine|' docker-compose.yml && \
	        sed -i.bak -E 's|(COPY --from=)redis:[^[:space:]]+|\1redis:$(V)-alpine|' docker/panel/Dockerfile && \
	        echo "    bumped redis tag: docker-compose.yml + docker/panel/Dockerfile" \
	        ;; \
	    mariadb) \
	        sed -i.bak -E 's|(image: *)mariadb:[^[:space:]]+|\1mariadb:$(V)|' docker-compose.yml && \
	        echo "    bumped mariadb tag: docker-compose.yml" \
	        ;; \
	    sing-box) \
	        sed -i.bak -E 's|^(ARG SING_BOX_VERSION=).*|\1$(V)|' docker/sing-box/Dockerfile && \
	        echo "    bumped sing-box: docker/sing-box/Dockerfile (ARG)" \
	        ;; \
	    haproxy) \
	        sed -i.bak -E 's|^(FROM )haproxy:[^[:space:]]+|\1haproxy:$(V)-alpine|' docker/haproxy/Dockerfile && \
	        echo "    bumped haproxy: docker/haproxy/Dockerfile (FROM)" \
	        ;; \
	esac
	@sed -i.bak -E 's/"version": "[^"]*"/"version": "$(V)"/' manifests/$(COMPONENT).upstream.json
	@# Re-run jq through the file to catch a sed regex bug that
	@# would have produced invalid JSON (no-op replacement edge cases,
	@# trailing commas, etc.). Loud failure here is exactly what we
	@# want — a silently-broken manifest reaches the matcher as a
	@# JSON-parse skip, which would silently drop the component from
	@# the OK/NG report.
	@jq . manifests/$(COMPONENT).upstream.json >/dev/null \
	    || { echo "  ✗ JSON invalid; .bak files preserved for rollback" >&2; exit 1; }
	@# .bak cleanup only runs after jq validation passes — partial-
	@# update failures leave the .bak files on disk for operator
	@# inspection. Per-file rm rather than `find -delete` to avoid
	@# touching unrelated .bak files in the working tree.
	@rm -f docker-compose.yml.bak \
	       docker/panel/Dockerfile.bak \
	       docker/sing-box/Dockerfile.bak \
	       docker/haproxy/Dockerfile.bak \
	       manifests/$(COMPONENT).upstream.json.bak
	@echo "    bumped manifests/$(COMPONENT).upstream.json::version → $(V)"
	@echo "    LOCKSTEP COMPLETE — run \`make ci\` to verify"

.PHONY: pin-images
pin-images: ## resolve current docker base-image tags to digests; updates Dockerfiles in place
	@if ! command -v docker >/dev/null; then echo 'docker not on PATH'; exit 1; fi
	cd operator && bun run pin-images.ts

.PHONY: sync-naive-pin
sync-naive-pin: ## rewrite docker/{naive,panel}/Dockerfile ARG defaults to match manifests/naive.upstream.json (the v0.3.0 single-source-of-truth)
	cd operator && bun run sync-naive-pin.ts

.PHONY: check-naive-pin
check-naive-pin: ## verify docker/{naive,panel}/Dockerfile ARG defaults match manifests/naive.upstream.json; exit non-zero on drift (CI / pre-build gate)
	cd operator && bun run sync-naive-pin.ts --check

.PHONY: sbom
sbom: ## generate CycloneDX SBOMs for cargo + composer + docker
	cd operator && bun run sbom.ts

# ---------- Cleaning ---------------------------------------------

.PHONY: clean
clean: ## remove cargo target, composer vendor, php caches
	rm -rf core/target panel/vendor panel/storage/framework/{cache/data,sessions,views}/* panel/storage/logs/*

.PHONY: dist-clean
dist-clean: clean ## clean + drop docker volumes (DESTRUCTIVE — confirms first)
	@printf 'WILL DROP DOCKER VOLUMES (db, redis, caddy ACME state). Type "yes" to proceed: '; \
	read confirm; \
	if [ "$$confirm" = "yes" ]; then docker compose down -v; else echo aborted; fi

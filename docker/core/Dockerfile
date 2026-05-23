# SPDX-License-Identifier: AGPL-3.0-only
#
# Build the ct-server-core Rust binary. This image isn't run as a
# service; it's used by docker-compose's build stage to extract the
# binary and copy it into the panel image. (See the panel image's
# multi-stage build, which uses --from=ct-server-core-builder.)
#
# v0.0.49 restructured the build pipeline around cargo-chef + a
# target/ cache mount. The dependency graph (recipe.json from
# Cargo.toml + Cargo.lock) is cooked in a separate layer keyed only
# on the lockfile, so source-only changes (every typical
# `make update`) skip the 285-crate dep compile and go straight to
# the 2 workspace crates — incremental rebuilds drop from ~3-6 min
# to ~15-30 s. Pre-v0.0.49 the Dockerfile cache-mounted only the
# registry directory; every rebuild started from zero compiled
# artefacts even when no Cargo.lock change.

# LTSC pin: Rust toolchain matches core/rust-toolchain.toml exactly.
# Bumping one without the other will surface as a "rustc 1.X is not
# supported" error during cargo build. Both files name the same
# version on purpose. v0.0.50 bumped 1.86 → 1.88 because v0.0.49's
# `cargo install cargo-chef --locked` resolves cargo-platform 0.3.2
# transitively, and cargo-platform 0.3.2 requires rustc 1.88 — the
# binding floor today.
ARG CT_RUST_BASE_IMAGE=rust:1.88.0-alpine
ARG CT_ALPINE_BASE_IMAGE=alpine:3.20

FROM ${CT_RUST_BASE_IMAGE} AS chef

# The base image already contains the exact Rust release we pin.
# Force rustup to use it even after core/rust-toolchain.toml is
# copied into /build/core. Without this, rustup re-checks
# static.rust-lang.org during `cargo chef prepare` / `cargo build`;
# on Vultr-class hosts with broken provider routing that can fail with
# NetworkUnreachable despite the toolchain already being present.
ENV RUSTUP_TOOLCHAIN=1.88.0
ARG CT_ALPINE_REPOSITORY_BASE=
RUN if [ -n "${CT_ALPINE_REPOSITORY_BASE}" ]; then \
        sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${CT_ALPINE_REPOSITORY_BASE}#g" /etc/apk/repositories; \
    fi

# Build deps: musl for static linking, openssl/pkg-config for sqlx +
# rustls (which we use, but transitive deps still need pkg-config).
RUN apk add --no-cache \
        musl-dev \
        pkgconfig \
        openssl-dev \
        openssl-libs-static \
        ca-certificates

# Install cargo-chef (v0.0.49). The ~0.1 constraint pins to the 0.1.x
# line — patch updates inside that line shouldn't change recipe.json
# shape. The chef stage is the base for both `planner` and `builder`
# below; one install lives in this layer and is reused. First-ever
# build pays ~30-60 s for this; subsequent builds hit the cached
# layer (invalidates only on rust-toolchain bump or cargo-chef minor
# bump).
RUN cargo install cargo-chef --version "~0.1" --locked

# Map Docker's TARGETARCH (amd64|arm64|arm) to the matching musl
# rustc target triple. BuildKit auto-populates TARGETARCH from
# `--platform` or the daemon's native arch — the project shipped
# x86_64-only before, which broke arm64 hosts (Lima on Apple
# Silicon, AWS Graviton, RPi-class Debian). See the
# 2026-05-05-VM-smoke-test note in CHANGELOG for context.
ARG TARGETARCH
RUN case "${TARGETARCH:-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/;s/armv7l/arm/')}" in \
        amd64) RUST_TARGET=x86_64-unknown-linux-musl ;; \
        arm64) RUST_TARGET=aarch64-unknown-linux-musl ;; \
        arm)   RUST_TARGET=armv7-unknown-linux-musleabihf ;; \
        *)     echo "unsupported TARGETARCH: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
    esac && \
    if ! rustup target list --installed | grep -qx "${RUST_TARGET}"; then \
        rustup target add "${RUST_TARGET}"; \
    fi && \
    printf '%s' "${RUST_TARGET}" > /tmp/rust-target

WORKDIR /build/core

# Planner stage (v0.0.49): extract the dependency graph into
# recipe.json. The stage runs against the actual workspace source,
# but `cargo chef prepare` only inspects Cargo.toml + Cargo.lock —
# it produces a structured snapshot of the dep graph that's
# byte-identical when the lockfile is unchanged, regardless of
# application source edits. Cheap (~5 s on a 1-vCPU VPS).
FROM chef AS planner
COPY core /build/core
COPY manifests /build/manifests
RUN cargo chef prepare --recipe-path recipe.json

# Builder stage (v0.0.49): cook deps using just the recipe, then
# compile the workspace. The cook step's layer is cached unless
# Cargo.lock changes — that's where the typical-`make update` win
# comes from. Application source edits bypass the cook entirely and
# go straight to the second RUN below, which only compiles the 2
# workspace crates (ct-protocol + ct-server-core).
FROM chef AS builder

# Compile-time SQL safety. SQLX_OFFLINE=true forces the
# `sqlx::query!()` macros to read core/.sqlx/*.json (committed)
# instead of attempting to open a live DB connection. A schema
# regression that wasn't reflected in .sqlx/ will fail this
# stage with a clear "no cached data for query" error;
# operator regenerates with `make sqlx-prepare`. Note: SQLX_OFFLINE
# only fires when workspace code containing `sqlx::query!()` is
# being compiled — it's a no-op during the cook step (which
# compiles the sqlx-mysql crate dep, not our queries).
ENV SQLX_OFFLINE=true

# Static link against musl so the resulting binary runs in any
# minimal Alpine OR debian base without a musl-libc dependency.
#
# IMPORTANT: these flags are set via the per-target env vars, NOT via
# global RUSTFLAGS. With global RUSTFLAGS="-C target-feature=
# +crt-static", Cargo applies the flag to EVERY compilation
# including the host-side proc-macros (async-trait, serde_derive,
# tokio-macros, etc.) — and those need cdylib output, which
# crt-static refuses. The build fails partway through with:
#
#   error: cannot produce proc-macro for `async-trait` as the
#   target `<host-musl>` does not support these crate types
#
# Per-target env scopes the flag to ONLY the final binary's musl
# build; proc-macros are compiled for the host toolchain default
# (also musl on rust:alpine, but without crt-static so cdylibs work).
# One env var per supported triple — Cargo only consults the one
# matching the active --target.
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=+crt-static"
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=+crt-static"
ENV CARGO_TARGET_ARMV7_UNKNOWN_LINUX_MUSLEABIHF_RUSTFLAGS="-C target-feature=+crt-static"

# Cargo profile: defaults to `release` (full LTO, codegen-units=1 —
# lowest binary size, highest peak compile RAM). Set to
# `release-small` for the low-mem-VPS install path: same musl-static
# linking, ~50% lower peak RAM, ~5-15% slower runtime. The two
# profiles live in core/Cargo.toml. Wired through compose via
# CT_CORE_BUILD_PROFILE in .env (v0.0.38).
ARG CARGO_PROFILE=release
ENV CT_CARGO_PROFILE=${CARGO_PROFILE}

# Cook deps using just recipe.json — the heavy step (~285 crates).
# This RUN's layer is keyed on recipe.json content, so it's reused
# across builds where Cargo.lock hasn't changed (i.e. every typical
# `make update` after a release). The target/ cache mount preserves
# intermediate cargo build artefacts across builds even when this
# layer is invalidated (a Cargo.lock bump still benefits from
# incremental cargo state where it can).
COPY --from=planner /build/core/recipe.json /build/core/recipe.json
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/core/target,id=ct-core-target,sharing=locked \
    RUST_TARGET=$(cat /tmp/rust-target) && \
    cargo chef cook --profile "${CT_CARGO_PROFILE}" --target "${RUST_TARGET}" \
        --recipe-path recipe.json

# Now copy the actual workspace and build the binary. Since the
# cook step above already compiled all 285 deps, this RUN only
# compiles the 2 workspace crates (ct-protocol + ct-server-core) —
# fast even from cold (~30 s on a single-vCPU VPS, <10 s with
# warm target/ cache).
COPY core /build/core
COPY manifests /build/manifests

# v0.0.49: the target/ cache mount is now safe alongside the
# multi-stage `COPY --from=builder /ct-server-core` below. Pre-v0.0.49
# the Dockerfile comment said the cache mount "interacts badly"
# with the COPY — that concern was overcautious. The
# `install -Dm755 target/.../ct-server-core /ct-server-core` step
# below copies the binary OUT of the cache mount (which only
# exists for the duration of this RUN) INTO the layer's own
# filesystem at /ct-server-core. When the RUN ends,
# /ct-server-core is committed to the layer; the cache mount
# unmounts but its contents persist in BuildKit's cache for next
# time. The runtime stage's `COPY --from=builder /ct-server-core`
# reads from the committed layer, not from the cache mount, so
# the path resolves correctly.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/core/target,id=ct-core-target,sharing=locked \
    RUST_TARGET=$(cat /tmp/rust-target) && \
    cargo build --profile "${CT_CARGO_PROFILE}" --bin ct-server-core --target "${RUST_TARGET}" && \
    install -Dm755 "target/${RUST_TARGET}/${CT_CARGO_PROFILE}/ct-server-core" /ct-server-core && \
    (strip /ct-server-core || true) && \
    test -x /ct-server-core

# Final runtime stage: a tiny image we never actually run, but use
# as the source for `--from=` in the panel Dockerfile.
#
# IMPORTANT: this stage MUST be explicitly named (`AS runtime`)
# because the file also contains an `AS sqlx-prepare` stage below.
# BuildKit's default-when-no-target-specified is "the last stage
# in the file" — without an explicit `target: runtime` in
# docker-compose.yml's core-builder service, BuildKit would build
# the sqlx-prepare stage and tag it as cool-tunnel-server-core,
# resulting in an image that has cargo + sqlx-cli but NO
# ct-server-core binary. The panel image's
# `COPY --from=ct-core-stage /usr/local/bin/ct-server-core` then
# fails with "/usr/local/bin/ct-server-core: not found".
FROM ${CT_ALPINE_BASE_IMAGE} AS runtime
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
COPY --from=builder /ct-server-core /usr/local/bin/ct-server-core
ENTRYPOINT ["/usr/local/bin/ct-server-core"]
CMD ["--help"]

# Optional stage: a Rust toolchain image with sqlx-cli pre-built,
# used by `make sqlx-prepare` to regenerate core/.sqlx/ on a host
# that doesn't have rustup installed (typical VPS).
#
# Why a stage in this Dockerfile rather than a pull from
# Docker Hub: anonymous Docker Hub pulls are rate-limited
# (100/6h per IP). On a fresh VPS that just pulled
# rust:1.86-alpine + alpine:3.20 + caddy + sing-box + php:8.3-fpm
# + mariadb + redis to bring the stack up, the limit is already
# half-consumed; one extra `docker run rust:1.86-alpine` at
# prepare time can tip over. Building this stage as part of the
# project's compose graph lets BuildKit reuse the cached layers
# from the `chef` stage above — no fresh registry pull. (The
# apk add list and rustup component set are deliberately distinct
# from the chef stage's; sqlx-prepare needs git for cargo's
# crates.io fetch, plus clippy + rustfmt for the toolchain.toml
# components.)
#
# Brought up via:
#   docker compose --profile sqlx run --rm sqlx-prepare
FROM ${CT_RUST_BASE_IMAGE} AS sqlx-prepare
ENV RUSTUP_TOOLCHAIN=1.88.0
ARG CT_ALPINE_REPOSITORY_BASE=
RUN if [ -n "${CT_ALPINE_REPOSITORY_BASE}" ]; then \
        sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${CT_ALPINE_REPOSITORY_BASE}#g" /etc/apk/repositories; \
    fi
RUN apk add --no-cache \
        musl-dev \
        pkgconfig \
        openssl-dev \
        openssl-libs-static \
        ca-certificates \
        git
# Pre-install the components core/rust-toolchain.toml requires
# (clippy, rustfmt). Without this, rustup re-reads toolchain.toml
# at every runtime invocation and tries to download them from
# static.rust-lang.org — which fails on the ct-data internal-only
# network. We bake them in at build time when the container has
# regular internet via BuildKit. Skip already-baked components so
# hosts with blocked static.rust-lang.org routes can still reuse the
# base image without a rustup sync.
RUN for component in clippy rustfmt; do \
        if ! rustup component list --installed | grep -qx "${component}"; then \
            rustup component add "${component}"; \
        fi; \
    done
RUN cargo install sqlx-cli --version "~0.8" \
        --no-default-features --features "rustls,mysql" --locked
WORKDIR /build/core
ENTRYPOINT ["cargo", "sqlx"]
CMD ["prepare", "--workspace"]

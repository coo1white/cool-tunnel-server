# syntax=docker/dockerfile:1.7
#
# Build the ct-server-core Rust binary. This image isn't run as a
# service; it's used by docker-compose's build stage to extract the
# binary and copy it into the panel image. (See the panel image's
# multi-stage build, which uses --from=ct-server-core-builder.)

# LTSC pin: Rust toolchain matches core/rust-toolchain.toml exactly.
# Bumping one without the other will surface as a "rustc 1.X is not
# supported" error during cargo build. Both files name the same
# version on purpose.
FROM rust:1.86-alpine AS builder

# Build deps: musl for static linking, openssl/pkg-config for sqlx +
# rustls (which we use, but transitive deps still need pkg-config).
RUN apk add --no-cache \
        musl-dev \
        pkgconfig \
        openssl-dev \
        openssl-libs-static \
        ca-certificates

WORKDIR /build

# Copy the workspace and build in release. We use BuildKit cache
# mounts so iterative builds don't re-download crates every time.
COPY core /build/core
COPY manifests /build/manifests

WORKDIR /build/core

# Static link against musl so the resulting binary runs in any
# minimal Alpine OR debian base without a musl-libc dependency.
#
# IMPORTANT: this flag is set via the per-target env var, NOT via
# global RUSTFLAGS. With global RUSTFLAGS="-C target-feature=
# +crt-static", Cargo applies the flag to EVERY compilation
# including the host-side proc-macros (async-trait, serde_derive,
# tokio-macros, etc.) — and those need cdylib output, which
# crt-static refuses. The build fails partway through with:
#
#   error: cannot produce proc-macro for `async-trait` as the
#   target `x86_64-unknown-linux-musl` does not support these
#   crate types
#
# Per-target env scopes the flag to ONLY the binary's
# x86_64-unknown-linux-musl build; proc-macros are compiled for
# the host toolchain default (also musl on rust:alpine, but
# without crt-static so cdylibs work).
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=+crt-static"

# Build with the registry cache mount only. We deliberately do NOT
# cache-mount /build/core/target — that interacts badly with the
# multi-stage `COPY --from=builder /ct-server-core` below: when
# BuildKit serves the builder stage from a partially-populated
# layer cache, the binary that lives under the target cache mount
# isn't part of the committed builder image, and the COPY in the
# final stage fails with "failed to compute cache key:
# /ct-server-core: not found". We accept slightly slower
# rebuilds (no incremental cargo target reuse) for a build that
# is actually correct end-to-end.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --release --bin ct-server-core --target x86_64-unknown-linux-musl && \
    install -Dm755 target/x86_64-unknown-linux-musl/release/ct-server-core /ct-server-core && \
    (strip /ct-server-core || true) && \
    test -x /ct-server-core

# Final stage: a tiny runtime image we never actually run, but use
# as the source for `--from=` in the panel Dockerfile.
FROM alpine:3.20
COPY --from=builder /ct-server-core /usr/local/bin/ct-server-core
ENTRYPOINT ["/usr/local/bin/ct-server-core"]
CMD ["--help"]

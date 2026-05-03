# syntax=docker/dockerfile:1.7
#
# Build the ct-server-core Rust binary. This image isn't run as a
# service; it's used by docker-compose's build stage to extract the
# binary and copy it into the panel image. (See the panel image's
# multi-stage build, which uses --from=ct-server-core-builder.)

FROM rust:1.78-alpine AS builder

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

# Static link against musl so the binary runs in any minimal base.
ENV RUSTFLAGS="-C target-feature=+crt-static"

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/core/target \
    cargo build --release --bin ct-server-core && \
    cp target/release/ct-server-core /ct-server-core && \
    strip /ct-server-core || true

# Final stage: a tiny runtime image we never actually run, but use
# as the source for `--from=` in the panel Dockerfile.
FROM alpine:3.20
COPY --from=builder /ct-server-core /usr/local/bin/ct-server-core
ENTRYPOINT ["/usr/local/bin/ct-server-core"]
CMD ["--help"]

# SPDX-License-Identifier: AGPL-3.0-only
#
# Local release-asset builder for ct-server-core.
#
# This intentionally skips cargo-chef: release assets are built once on
# a maintainer workstation/VM, not on every low-resource VPS install.

ARG CT_RUST_BASE_IMAGE=rust:1.88.0-alpine
FROM ${CT_RUST_BASE_IMAGE} AS builder

ARG CT_ALPINE_REPOSITORY_BASE=
ARG TARGETARCH
ENV RUSTUP_TOOLCHAIN=1.88.0 \
    SQLX_OFFLINE=true
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=+crt-static"
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=+crt-static"

RUN if [ -n "${CT_ALPINE_REPOSITORY_BASE}" ]; then \
        sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${CT_ALPINE_REPOSITORY_BASE}#g" /etc/apk/repositories; \
    fi
RUN apk add --no-cache \
        musl-dev \
        pkgconfig \
        openssl-dev \
        openssl-libs-static \
        ca-certificates
RUN case "${TARGETARCH:-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}" in \
        amd64) RUST_TARGET=x86_64-unknown-linux-musl ;; \
        arm64) RUST_TARGET=aarch64-unknown-linux-musl ;; \
        *)     echo "unsupported TARGETARCH: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
    esac && \
    if ! rustup target list --installed | grep -qx "${RUST_TARGET}"; then \
        rustup target add "${RUST_TARGET}"; \
    fi && \
    printf '%s' "${RUST_TARGET}" > /tmp/rust-target

WORKDIR /build/core
COPY core /build/core
COPY manifests /build/manifests
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/core/target,id=ct-core-release-target,sharing=locked \
    RUST_TARGET=$(cat /tmp/rust-target) && \
    cargo build --release --locked --bin ct-server-core --target "${RUST_TARGET}" && \
    install -Dm755 "target/${RUST_TARGET}/release/ct-server-core" /ct-server-core && \
    (strip /ct-server-core || true) && \
    test -x /ct-server-core

FROM scratch AS artifact
COPY --from=builder /ct-server-core /ct-server-core

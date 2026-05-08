# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-only
#
# sing-box (https://github.com/SagerNet/sing-box) — actively-maintained
# Go reimplementation of the NaiveProxy server protocol with multi-user
# support, built-in ACME, and a clash-style management API for hot
# reloads. Replaces the unmaintained klzgrad/forwardproxy plugin.
#
# We pull the upstream pre-built binary for the target arch rather
# than building from source — the upstream releases are signed, the
# Go toolchain is heavy, and this keeps our build reproducible
# without us tracking sing-box's exact commit graph.

FROM alpine:3.20

ARG SING_BOX_VERSION=1.13.11
ARG TARGETARCH

# `with_clash_api` is included in the official release tarball so we
# don't have to compile sing-box ourselves to get the management API.
#
# Use the `-musl` variant: as of v1.13 the upstream split into glibc/
# musl tarballs (the no-suffix tarball is dynamically linked against
# glibc and fails to exec on alpine with a misleading "not found").
RUN apk add --no-cache ca-certificates curl tzdata tini \
    && case "$TARGETARCH" in \
            amd64) ARCH=amd64 ;; \
            arm64) ARCH=arm64 ;; \
            arm)   ARCH=armv7 ;; \
            *)     echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-${ARCH}-musl.tar.gz" \
         -o /tmp/sing-box.tgz \
    && tar -xzf /tmp/sing-box.tgz -C /tmp \
    && mv /tmp/sing-box-*/sing-box /usr/local/bin/sing-box \
    && rm -rf /tmp/sing-box* \
    && chmod +x /usr/local/bin/sing-box \
    && /usr/local/bin/sing-box version

# Persistent state: the rendered config.json lives in /etc/sing-box/
# (mounted from a docker volume the panel/core write to); /data is
# kept for the cache_file when enabled. ACME state lives in
# caddy_data, not here — Caddy is the ACME side post-v0.0.4.
VOLUME ["/etc/sing-box", "/data"]

# 443  — TLS-terminating naive inbound (HTTP/2 CONNECT). NaiveProxy
#        is HTTP/2-only at the protocol level — no UDP/443 here. A
#        UDP listen with no service produces fingerprintable RSTs on
#        QUIC scans, which is the opposite of probe-resistance.
# 9090 — clash-API HTTP listener (bound by the rendered config's
#        experimental.clash_api.external_controller). EXPOSE here
#        documents that the listener exists on the docker-internal
#        network. The compose `ports:` map for sing-box MUST NOT
#        publish 9090 to the host (audit-enforced); EXPOSE alone
#        does not make a port reachable from outside docker.
EXPOSE 443 9090

# Periodic liveness probe: confirm the sing-box process is running.
# The rendered config DOES carry a clash_api block (TCP listener on
# 0.0.0.0:9090, reachable from the panel over the docker bridge —
# see `core/ct-server-core/src/admin.rs`), but we deliberately do
# NOT probe it here: a clash-API HTTP probe is gated by the API
# listener coming up after sing-box has parsed config and bound its
# inbounds, which adds a startup-order dependency to liveness. We
# also can't probe the unix-socket variant — `external_controller_unix`
# never existed upstream. Process-presence is the cheapest signal
# that covers the crash modes we actually care about (cert read
# error, panic, OOM-kill); pidof returns non-zero and docker
# restarts the container per the three-strikes default.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD pidof sing-box >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/sing-box", "run", "--config-directory", "/etc/sing-box", "--directory", "/data"]

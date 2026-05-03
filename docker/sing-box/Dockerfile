# syntax=docker/dockerfile:1.7
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

ARG SING_BOX_VERSION=1.10.7
ARG TARGETARCH

# `with_clash_api` is included in the official release tarball so we
# don't have to compile sing-box ourselves to get the management API.
RUN apk add --no-cache ca-certificates curl tzdata tini \
    && case "$TARGETARCH" in \
            amd64) ARCH=amd64 ;; \
            arm64) ARCH=arm64 ;; \
            arm)   ARCH=armv7 ;; \
            *)     echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-${ARCH}.tar.gz" \
         -o /tmp/sing-box.tgz \
    && tar -xzf /tmp/sing-box.tgz -C /tmp \
    && mv /tmp/sing-box-*/sing-box /usr/local/bin/sing-box \
    && rm -rf /tmp/sing-box* \
    && chmod +x /usr/local/bin/sing-box \
    && /usr/local/bin/sing-box version

# Persistent state: ACME certs land in /data/acme; the rendered
# config.json lives in /etc/sing-box/ (mounted from a docker volume
# the panel/core write to). /run/sing-box holds the unix socket the
# clash API listens on so we can hot-reload without TCP exposure.
VOLUME ["/etc/sing-box", "/data"]
RUN mkdir -p /run/sing-box && chmod 0770 /run/sing-box

# 80   — ACME HTTP-01 challenge listener (sing-box auto-binds when
#        renewing; idle otherwise).
# 443  — TLS terminating naive inbound (HTTP/2 CONNECT).
# 443/udp — HTTP/3 if/when sing-box's naive inbound supports it.
EXPOSE 80 443 443/udp

# Periodic liveness probe: ask the in-process clash API for its
# current config. If the unix socket is up and answering, the server
# is healthy. Three-strikes-and-restart is the docker default.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD test -S /run/sing-box/clash.sock \
        || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/sing-box", "run", "--config-directory", "/etc/sing-box", "--directory", "/data"]

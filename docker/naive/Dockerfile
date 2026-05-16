# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cool Tunnel Server — naive server container (v0.3.0+).
#
# Runs klzgrad/naiveproxy's `naive` Linux binary as the server-side
# proxy. Same binary the macOS client bundles, version-pinned to the
# tag in COOL-TUNNEL/naive.upstream.json (mirrored here in
# docker/naive/naive.upstream.json). Same binary on both ends → no
# padding-protocol drift surface; this is the v0.3.0 architecture's
# central premise. See docker/caddy/Dockerfile head comment for the
# v0.1→v0.2→v0.3 drift history.
#
# Lifecycle:
#
#   - boot: `bun supervisor.ts` reads /data/config/naive.json + the
#     cert pair at /data/caddy/certificates/.../<DOMAIN>/, spawns
#     `naive` as a child process with `--listen=https://user:pass@:443
#     --cert=… --key=…`.
#   - reload: the supervisor watches both files. Any change → SIGTERM
#     the existing naive child, wait for exit, spawn anew. Sub-second
#     gap; in-flight tunnels drop but new ones connect immediately.
#   - cert renewal: Caddy renews the cert in the shared volume every
#     ~60 days. mtime change fires the same respawn path.
#
# We deliberately do NOT need the docker socket in this container.
# The supervisor file-watches; there's no docker exec path.
#
# Bun runtime in the container is intentional — it's the place new
# orchestration code lives going forward (panel.app still writes
# naive.json via PHP, but the runtime watcher is TypeScript and any
# future supervisor logic — multi-account spawn, health probes,
# cert-mtime-driven hot-swap — extends supervisor.ts).

# ----------------------------------------------------------------------
# Stage 1 — fetch + verify the upstream naive Linux binary
# ----------------------------------------------------------------------
FROM alpine:3.21 AS fetch

RUN apk add --no-cache curl xz tar

# Pin args. Default values match docker/naive/naive.upstream.json at
# the time this image was built; CI / operator can override per build.
# Mismatch between ARG and the json file is caught by the verify step
# inside the panel container's pin-check job (not in this Dockerfile,
# because we don't want the image build to pull the json at build
# time — the operator's snapshot of the json is authoritative for
# release-cut purposes).
ARG NAIVE_TAG=v148.0.7778.96-5
ARG NAIVE_URL=https://github.com/klzgrad/naiveproxy/releases/download/v148.0.7778.96-5/naiveproxy-v148.0.7778.96-5-linux-x64.tar.xz
ARG NAIVE_SHA256=ca6958dcbbfb7b1b38c55a213dab6927ce3c1417d969b815657513b81fc7352d

RUN set -eux \
    && mkdir -p /fetch \
    && cd /fetch \
    && curl -fsSL -o naive.tar.xz "${NAIVE_URL}" \
    && echo "${NAIVE_SHA256}  naive.tar.xz" > /fetch/sha256.txt \
    && sha256sum -c /fetch/sha256.txt \
    && tar xf naive.tar.xz \
    && mv naiveproxy-*/naive /fetch/naive \
    && chmod +x /fetch/naive \
    && /fetch/naive --version || true

# ----------------------------------------------------------------------
# Stage 2 — runtime
# ----------------------------------------------------------------------
FROM oven/bun:1.1-alpine AS runtime

# naive's release binary is dynamically linked against the typical
# Alpine glibc-compat path (it's a Chromium-derived build). The
# `gcompat` package provides the glibc-style dynamic linker.
# `libcap` provides `setcap` / `getcap` for the file-capability we
# set on /usr/local/bin/naive below (oven/bun:1.1-alpine doesn't
# ship libcap by default; v0.3.0 first-deploy on Vultr 2026-05-16
# hit "setcap: not found" without this).
RUN apk add --no-cache gcompat ca-certificates libcap

COPY --from=fetch /fetch/naive /usr/local/bin/naive

# Supervisor — Bun TypeScript, watches /data/config/naive.json and
# /data/caddy/certificates/, respawns naive on change. See file
# head comment for the full state machine.
COPY supervisor.ts /opt/supervisor/supervisor.ts

# Drop privileges. The naive binary doesn't need root; it binds to
# its container-internal port (default 443) and that's privileged,
# but we set the file capability on the binary so the container can
# bind without running as root. Mirrors the ct-caddy pattern.
RUN setcap cap_net_bind_service=+ep /usr/local/bin/naive \
    && getcap /usr/local/bin/naive | grep -q cap_net_bind_service \
    && addgroup -S naive -g 65532 \
    && adduser -S naive -G naive -u 65532 -h /home/naive

USER naive:naive
WORKDIR /home/naive

EXPOSE 443

# Liveness — supervisor exposes a tiny HTTP endpoint on 127.0.0.1:9091
# returning `{"status":"ok","naive_pid":<n>,"config_mtime":<unix>}`.
# A non-200 response means the supervisor itself wedged; restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:9091/healthz >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/bun", "run", "/opt/supervisor/supervisor.ts"]

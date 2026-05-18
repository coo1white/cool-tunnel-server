# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cool Tunnel Server — ct-singbox container (v0.4.0+).
#
# Runs SagerNet/sing-box as the server-side proxy under singbox-core's
# supervision. The SAME singbox-core binary is also embedded in the
# macOS client (Cool Tunnel.app). One upstream tag, one config schema,
# one supervisor, both ends.
#
# Three stages:
#
#   1. bun-build: Bun 1.1+ alpine image, compiles singbox-core/ to a
#      self-contained binary via `bun build --compile`.
#   2. singbox-fetch: alpine image with curl + tar, uses singbox-core
#      install to fetch + SHA-256 verify the sing-box binary at the
#      pinned tag in singbox-core/singbox.upstream.json.
#   3. runtime: minimal alpine image, copies the two binaries (singbox-
#      core + sing-box), drops privileges, runs singbox-core supervise.
#      cap_net_bind_service file-cap so the non-root container user can
#      bind :443.

# ----------------------------------------------------------------------
# Stage 1 — compile singbox-core to a self-contained binary
# ----------------------------------------------------------------------
FROM oven/bun:1.1-alpine AS bun-build

WORKDIR /build
COPY singbox-core /build/singbox-core

# Install dev dependencies + run a typecheck before compiling. A
# typecheck failure here fails the build with a clearer error than the
# eventual runtime traceback would.
RUN cd singbox-core \
    && bun install --frozen-lockfile 2>/dev/null || bun install \
    && bunx tsc --noEmit \
    && bun build --compile --target=bun-linux-x64 \
        src/cli.ts \
        --outfile /build/singbox-core-linux-x64

# ----------------------------------------------------------------------
# Stage 2 — fetch + verify sing-box upstream binary
# ----------------------------------------------------------------------
FROM alpine:3.21 AS singbox-fetch

RUN apk add --no-cache curl tar ca-certificates gcompat libstdc++ libgcc

COPY --from=bun-build /build/singbox-core-linux-x64 /usr/local/bin/singbox-core
# We need singbox.upstream.json to be at the path version.ts resolves
# at runtime — but since version.ts uses `import … with { type: "json" }`
# the JSON is BAKED INTO the compiled binary at build time. So no
# separate copy here; the install subcommand reads the embedded pin.

RUN /usr/local/bin/singbox-core install --target-dir /out --no-verify \
    && test -x /out/sing-box \
    && /out/sing-box version

# ----------------------------------------------------------------------
# Stage 3 — runtime
# ----------------------------------------------------------------------
FROM alpine:3.21 AS runtime
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# sing-box is statically-linked Go. singbox-core is a Bun-compiled
# glibc binary and needs Alpine's gcompat plus libstdc++/libgcc.
RUN apk add --no-cache ca-certificates libcap gcompat libstdc++ libgcc \
    && addgroup -S singbox -g 65532 \
    && adduser -S singbox -G singbox -u 65532 -h /home/singbox

COPY --from=bun-build /build/singbox-core-linux-x64 /usr/local/bin/singbox-core
COPY --from=singbox-fetch /out/sing-box /usr/local/bin/sing-box

# File-cap on the sing-box binary so the non-root container user can
# bind :443 without ambient-cap-set support in alpine. cap_add in
# docker-compose.yml grants the cap to the cgroup; the file-cap makes
# it inherit across exec.
RUN setcap cap_net_bind_service=+ep /usr/local/bin/sing-box \
    && getcap /usr/local/bin/sing-box | grep -q cap_net_bind_service \
    && chmod +x /usr/local/bin/singbox-core /usr/local/bin/sing-box

USER singbox:singbox
WORKDIR /home/singbox

EXPOSE 443

# Healthcheck — singbox-core's supervise subcommand serves /healthz on
# 127.0.0.1:9091; non-200 means the supervisor is wedged.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1:9091/healthz >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/singbox-core", "supervise"]

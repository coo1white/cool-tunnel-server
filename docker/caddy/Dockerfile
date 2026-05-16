# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cool Tunnel Server — Caddy (single-process front door, v0.2.0+).
#
# Until v0.1.20 the architecture put three containers in front of
# the panel: HAProxy SNI-routed :443 to either sing-box (NaiveProxy
# server) or a "ghost" Caddy on :8444. Sing-box bumps kept drifting
# the NaiveProxy padding wire format vs the macOS client's bundled
# naive binary; HAProxy SNI added a TCP-mode buffer with no real
# operational value.
#
# v0.2.0 collapses all three roles into a single Caddy container,
# matching the klzgrad/naiveproxy README's own recommended
# deployment (Caddy + forwardproxy plugin with the Padding
# extension). This Caddy:
#
#   - binds :80  (HTTP-01 challenges + http→https redirect)
#   - binds :443 (TLS termination + SNI-routed handling)
#       SNI = panel.<DOMAIN>  →  reverse_proxy → panel:9000 (FrankenPHP)
#       SNI = <DOMAIN>        →  forward_proxy (Padding-emitting CONNECT)
#
# We compile Caddy with `klzgrad/forwardproxy@naive` baked in via
# xcaddy. The plugin re-exports the canonical
# `caddyserver/forwardproxy` module path with the Padding extension
# merged in (the original "klzgrad fork" was upstreamed; its go.mod
# now redeclares the canonical path, so we redirect at the xcaddy
# command line — without the redirect, `go get` complains
#   "module declares its path as: caddyserver/forwardproxy
#    but was required as: klzgrad/forwardproxy").
#
# Why Caddy 2.8.4: matches the version Phase-0 validation was
# operationalised under for the rest of the stack. The Phase 0
# interop test on 2026-05-16 actually used 2.11.3 (the
# caddy:builder default) and worked, but mixing a Caddy bump and
# a forwardproxy adoption in one release would broaden the blast
# radius. Bump 2.8.4 → 2.11.x as a separate change.

# ----------------------------------------------------------------------
# Stage 1 — build Caddy with the forwardproxy plugin
# ----------------------------------------------------------------------
FROM caddy:2.8.4-builder AS build

# xcaddy resolves `caddyserver/forwardproxy@caddy2` as the canonical
# Go module path; the `=` redirect points it at klzgrad's `naive`
# branch which carries the Padding-extension implementation. Both
# pieces are required — the path mismatch alone produces the
# "module declares its path as: caddyserver/forwardproxy" failure
# documented in the head comment.
RUN xcaddy build \
        --with github.com/caddyserver/forwardproxy@caddy2=github.com/klzgrad/forwardproxy@naive \
        --output /out/caddy \
    && /out/caddy version \
    && /out/caddy list-modules | grep -q '^http.handlers.forward_proxy$'

# ----------------------------------------------------------------------
# Stage 2 — runtime
# ----------------------------------------------------------------------
FROM caddy:2.8.4-alpine

# Replace the stock Caddy binary with our xcaddy build. The image's
# existing entrypoint + CMD + capabilities (NET_BIND_SERVICE so it
# can bind privileged :80 / :443 as a non-root container) are
# unchanged.
COPY --from=build /out/caddy /usr/bin/caddy

# Re-apply the cap_net_bind_service file capability. The stock
# caddy:2.8.4-alpine image bakes this cap on /usr/bin/caddy so
# the image's non-root `caddy` user can bind privileged ports
# (:80, :443). Docker `COPY` does NOT preserve file capabilities
# — the new binary lands with empty caps and Caddy then silently
# falls back to alternative ports (:443 → :8443, :80 → :8080),
# producing a healthy container that nothing public can reach.
#
# Symptom observed on the v0.2.0 first-deploy 2026-05-16: ss inside
# the container showed `:::8443 LISTEN` instead of `:::443`, the
# host's `docker compose ps` showed `0.0.0.0:443->443/tcp` (the
# mapping survives even with no listener on the container side),
# external connections to https://<domain>:443 were refused with
# no apparent cause.
#
# The `cap_add: NET_BIND_SERVICE` in docker-compose.yml is
# necessary but not sufficient — it grants the cap to the
# container's effective set, but the file-cap on the binary
# (with the `+ep` flag) is what allows the binary's exec to
# inherit it without ambient-cap kernel features the alpine
# image doesn't enable.
RUN setcap cap_net_bind_service=+ep /usr/bin/caddy \
    && getcap /usr/bin/caddy | grep -q cap_net_bind_service

# Caddy reads /etc/caddy/Caddyfile on boot. Compose mounts the
# panel-rendered file (from caddy/Caddyfile.tpl) into /etc/caddy.
VOLUME ["/etc/caddy", "/data", "/config"]

# Public ports. :80 stays for ACME HTTP-01. :443 is NEW vs v0.1.x —
# Caddy now does TLS termination for both the panel reverse-proxy
# and the naive forward_proxy, SNI-routed inside Caddy itself.
EXPOSE 80
EXPOSE 443

# Periodic liveness probe via the loopback admin API. Caddy's
# /config/ endpoint returns 200 + the live config JSON whenever
# the process is alive enough to answer. We do NOT publish :2019
# externally — the host-firewall + the `admin off` setting
# inside the Caddyfile globals is belt-and-braces.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1:2019/config/ >/dev/null || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

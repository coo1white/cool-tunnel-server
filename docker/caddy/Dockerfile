# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cool Tunnel Server — Caddy front door (v0.3.0+).
#
# Architecture evolution:
#
#   v0.1.x: HAProxy SNI :443 → sing-box (NaiveProxy server) | ghost
#           Caddy on :8444 (panel). Three containers. Sing-box bumps
#           kept drifting the NaiveProxy padding wire format vs the
#           macOS client's bundled naive binary.
#   v0.2.x: collapsed to one Caddy with klzgrad/forwardproxy@naive
#           plugin baked in. Worked for ~weeks but klzgrad's fork has
#           been effectively frozen since 2025-01-18 (commit d62c80d
#           "Add Naive padding protocol v1") while klzgrad/naiveproxy
#           kept iterating on the client-side preamble + padding
#           protocols. By v148 (May 2026) the bundled Mac naive
#           emitted a preamble that the v1-only server doesn't
#           recognise; the tunnel set up the CONNECT and then closed
#           before any target bytes flowed — exactly the same class
#           of drift v0.2.0 was supposed to fix.
#   v0.3.0: Caddy stops being the NaiveProxy server entirely. It
#           keeps ACME + panel reverse-proxy + SNI routing, but the
#           naive forward-proxy role moves to a sibling ct-naive
#           container that runs the actual `naive` binary (same
#           upstream tag the macOS client bundles). Same binary on
#           both ends → guaranteed wire compatibility forever, no
#           padding-protocol drift surface.
#
# v0.3.0 Caddy roles:
#
#   - binds :80 (HTTP-01 ACME challenges + http→https redirect)
#   - binds :443 with mholt/caddy-l4 layer4 SNI router:
#       SNI = <DOMAIN>        → raw TCP proxy to ct-naive:443
#                               (ct-naive terminates TLS with the
#                                naive.<DOMAIN> cert it reads from
#                                the shared /data volume)
#       SNI = <PANEL_DOMAIN>  → fall-through to inner Caddy HTTP
#                               server on 127.0.0.1:8443, which
#                               terminates TLS and reverse_proxies
#                               panel:9000
#   - manages BOTH TLS certs via auto-https; ct-naive reads its
#     cert from the shared volume (read-only mount).
#
# Plugin: github.com/mholt/caddy-l4 baked in via xcaddy. The
# klzgrad/forwardproxy@naive plugin is GONE — its wire format is
# the very thing v0.3.0 routes around.
#
# Why Caddy 2.8.4: matches the version operationalised under v0.2.x;
# bumping Caddy + adopting layer4 in one release would broaden the
# blast radius. Bump 2.8.4 → current as a separate change.

# ----------------------------------------------------------------------
# Stage 1 — build Caddy with the layer4 plugin
# ----------------------------------------------------------------------
FROM caddy:2.8.4-builder AS build

# xcaddy fetches and links mholt/caddy-l4. The plugin exposes
# `layer4.matchers.tls` (SNI/ALPN matching), `layer4.handlers.proxy`
# (raw TCP forward), `layer4.handlers.tls` (in-place termination),
# and `layer4.handlers.subroute` — enough to build the SNI router
# the Caddyfile.tpl uses without further redirects or replacements.
RUN xcaddy build \
        --with github.com/mholt/caddy-l4 \
        --output /out/caddy \
    && /out/caddy version \
    && /out/caddy list-modules | grep -q '^layer4$'

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

# Public ports. :80 stays for ACME HTTP-01. :443 is the layer4
# SNI router on the front door.
EXPOSE 80
EXPOSE 443

# Periodic liveness probe via the loopback admin API. Caddy's
# /config/ endpoint returns 200 + the live config JSON whenever
# the process is alive enough to answer. We do NOT publish :2019
# externally — the host-firewall + the `admin 127.0.0.1:2019`
# directive inside the Caddyfile globals is belt-and-braces.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1:2019/config/ >/dev/null || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

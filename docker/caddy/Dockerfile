# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cool Tunnel Server — Caddy front door (v0.4.0+).
#
# Architecture evolution:
#
#   v0.1.x: HAProxy SNI :443 → sing-box (NaiveProxy server) | ghost
#           Caddy on :8444 (panel). Three containers. Padding-format
#           drift between sing-box's naive plugin and the macOS
#           client's bundled naive binary.
#   v0.2.x: Caddy with klzgrad/forwardproxy@naive plugin. Same wire-
#           format drift class hit by the next major naive bump on
#           the Mac side; klzgrad/forwardproxy frozen Jan 2025.
#   v0.3.0: tried to run naive itself as the server. Wrong premise —
#           naive --listen only accepts socks/http/redir, NEVER https.
#           naive is a client-only binary; klzgrad/forwardproxy was
#           always the only naive-protocol-aware server. Abandoned.
#   v0.4.0: drop naive entirely. Server runs sing-box (SagerNet) in
#           VLESS+Reality mode; macOS client also runs sing-box
#           (same upstream tag, same binary on both ends via the
#           singbox-core/ shared package). Reality replaces ACME-
#           issued TLS for the proxy: sing-box's handshake captures
#           the destination site's TLS (e.g. www.microsoft.com:443)
#           and uses Reality cryptography under that cover. Caddy's
#           ACME-cert role shrinks to JUST the panel subdomain.
#
# v0.4.0 Caddy roles:
#
#   - binds :80 (HTTP-01 ACME for panel.<DOMAIN> + http→https redir)
#   - binds :443 with mholt/caddy-l4 layer4 SNI splitter:
#       SNI = panel.<DOMAIN>  → tcp/127.0.0.1:8443 → inner Caddy
#                               HTTPS terminator → reverse_proxy
#                               panel:9000
#       any other SNI         → tcp/ct-singbox:443 (sing-box does
#                               its own Reality TLS; Caddy doesn't
#                               terminate or hold a cert for this)
#   - manages ONE cert (panel.<DOMAIN>). The proxy path doesn't
#     need an ACME cert because Reality fakes a real destination
#     site's TLS (operator picks www.microsoft.com or similar in
#     ServerConfig.reality_dest_host).
#
# Plugin: github.com/mholt/caddy-l4 baked in via xcaddy. No more
# klzgrad/forwardproxy@naive — sing-box has replaced it on the
# proxy path entirely.
#
# Why Caddy 2.11.3: caddy-l4 v0.1.1+ requires Go 1.25+, which only
# arrived in caddy:2.11.x builders. The v0.2.x Dockerfile head
# comment flagged 2.11.3 as the deferred-bump target ("Phase 0
# interop test on 2026-05-16 used 2.11.3 and worked"); the layer4
# adoption forces it here. caddy:2.11.3-alpine is the matching
# runtime image so the Go-version-coupled module set lines up.

# ----------------------------------------------------------------------
# Stage 1 — build Caddy with the layer4 plugin
# ----------------------------------------------------------------------
FROM caddy:2.11.3-builder AS build

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
FROM caddy:2.11.3-alpine
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Replace the stock Caddy binary with our xcaddy build. The image's
# existing entrypoint + CMD + capabilities (NET_BIND_SERVICE so it
# can bind privileged :80 / :443 as a non-root container) are
# unchanged.
COPY --from=build /out/caddy /usr/bin/caddy

# Re-apply the cap_net_bind_service file capability. The stock
# caddy:2.11.3-alpine image bakes this cap on /usr/bin/caddy so
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

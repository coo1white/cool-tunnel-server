# syntax=docker/dockerfile:1.7
#
# Cool Tunnel Server — HAProxy SNI router image.
#
# What this HAProxy does (full rationale in haproxy/haproxy.cfg.tpl):
#
#   1. Owns :443 on the public interface.
#   2. Sniffs the SNI server_name from each TLS ClientHello WITHOUT
#      decrypting the connection (TCP mode, ssl-passthrough).
#   3. Forwards the raw bytes to sing-box (apex domain, NaiveProxy)
#      or Caddy (panel subdomain, reverse-proxies to the panel
#      container's nginx).
#
# Stock haproxy:alpine — no patches, no plugins. The whole
# configuration surface is haproxy.cfg.tpl rendered by ct-server-core
# (parallel to caddy/Caddyfile.tpl and sing-box/config.json.tpl).
#
# Why an image and not just `image: haproxy:alpine` directly in
# docker-compose.yml? Same reason as docker/caddy/Dockerfile: pin the
# tag in one place, add a HEALTHCHECK, keep this comment block next
# to the cfg.tpl that actually configures it.
#
# Pinned to 2.9-alpine: HAProxy 2.9 is the latest LTS as of 2026-05.
# 3.0+ exists but the LTS line is the operator-friendly choice for a
# self-hosted deployment that may not get patched aggressively.

FROM haproxy:2.9-alpine

# HAProxy reads /usr/local/etc/haproxy/haproxy.cfg on boot. The compose
# file mounts the panel-rendered file (from the rendered
# haproxy.cfg.tpl) into /usr/local/etc/haproxy on first start.
VOLUME ["/usr/local/etc/haproxy"]

EXPOSE 443
# We deliberately do NOT EXPOSE 80. Port 80 is Caddy's domain (ACME
# HTTP-01 challenges); HAProxy is :443 only.

# Periodic liveness probe: HAProxy listens on a loopback admin socket
# inside the container. Use the embedded `runtime` socket via the
# stats unix domain socket to verify the process is alive enough to
# respond. The simplest portable check is `nc -z 127.0.0.1 443` — if
# the listener is bound, HAProxy is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD nc -z 127.0.0.1 443 || exit 1

# Default CMD is provided by the haproxy:alpine base image; do not
# override. The base entrypoint runs `haproxy -W -db -f
# /usr/local/etc/haproxy/haproxy.cfg` and re-exec's on SIGHUP, which
# is what `docker compose restart haproxy` triggers for a config
# reload after `ct-server-core haproxy render`.

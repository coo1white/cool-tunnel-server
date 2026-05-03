# syntax=docker/dockerfile:1.7
#
# Cool Tunnel Server — Caddy ACME-only image.
#
# This is *stock* Caddy. We do not compile any plugins (xcaddy is
# gone). Caddy's only job here is:
#
#   1. Bind :80 for HTTP-01 challenges + http→https redirects.
#   2. Manage a TLS certificate for the operator's domain via the
#      upstream ACME directory (Let's Encrypt by default).
#   3. Touch a flag file in the shared `caddy_data` volume on every
#      cert obtain / renewal so the panel's scheduled task knows to
#      reload sing-box (which reads the cert from the same volume).
#
# Why an image and not just `image: caddy:alpine` directly in
# docker-compose.yml? So we can attach a HEALTHCHECK and an
# explicit pinned tag in one place, plus this comment block lives
# next to the Caddyfile.tpl that actually configures it.

FROM caddy:2.8.4-alpine

# Caddy reads /etc/caddy/Caddyfile on boot. The compose file mounts
# the panel-rendered file (from the rendered Caddyfile.tpl) into
# /etc/caddy on first start.
VOLUME ["/etc/caddy", "/data", "/config"]

EXPOSE 80
# We deliberately do NOT EXPOSE 443. Port 443 is sing-box's domain;
# Caddy obtains certs via HTTP-01 on :80 and never serves on :443.

# Periodic liveness probe: ask Caddy's admin API (loopback only) for
# its current config. If Caddy is alive enough to answer, healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1:2019/config/ >/dev/null \
        || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

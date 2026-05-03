# syntax=docker/dockerfile:1.7
#
# Caddy compiled with the NaiveProxy fork of forwardproxy.
#
# We pin xcaddy via the official caddy:builder base, and build with
# klzgrad/forwardproxy@naive — this is the variant NaiveProxy clients
# expect (basic_auth, hide_ip, hide_via, probe_resistance).

FROM caddy:builder-alpine AS builder

# klzgrad's naive branch of forwardproxy. The funny syntax tells xcaddy
# to swap caddyserver/forwardproxy for klzgrad's fork at the @caddy2
# version selector.
RUN xcaddy build \
    --with github.com/caddyserver/forwardproxy@caddy2=github.com/klzgrad/forwardproxy@naive

FROM caddy:alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Persistent state: ACME certs in /data, runtime in /config.
VOLUME ["/data", "/config"]

# /run/caddy holds the unix-socket admin endpoint we share with the
# panel container so the panel can `caddy reload` without TCP exposure.
RUN mkdir -p /run/caddy && chown root:root /run/caddy && chmod 0770 /run/caddy

# 80   — ACME HTTP-01 challenges + redirect to HTTPS
# 443  — TLS, HTTP/2, forward_proxy
# 443/udp — HTTP/3 (QUIC)
EXPOSE 80 443 443/udp

# Caddy reads /etc/caddy/Caddyfile by default; the compose file mounts
# the panel-rendered Caddyfile there.
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

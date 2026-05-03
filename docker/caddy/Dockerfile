# syntax=docker/dockerfile:1.7
#
# Caddy compiled with the NaiveProxy server-side plugin baked in.
#
# NaiveProxy (https://github.com/klzgrad/naiveproxy) ships in two
# halves, by the same author, under the same umbrella project:
#   - client side: the `naive` binary, bundled into the cool-tunnel
#     client family on each platform.
#   - server side: a Caddy plugin (basic_auth + hide_ip + hide_via +
#     probe_resistance) that the `naive` binary connects to.
#
# This Dockerfile builds the server side. xcaddy fetches the plugin
# source via the canonical github.com/klzgrad/forwardproxy@naive
# coordinate (that's where the source actually lives — same author,
# same Apache-2.0, same project) and compiles it into the Caddy
# binary. From an operator's perspective the result is "Caddy with
# the NaiveProxy plugin"; the forwardproxy@naive coordinate is an
# implementation detail of the build.

FROM caddy:builder-alpine AS builder

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
# 443  — TLS, HTTP/2, NaiveProxy CONNECT
# 443/udp — HTTP/3 (QUIC)
EXPOSE 80 443 443/udp

# Caddy reads /etc/caddy/Caddyfile by default; the compose file mounts
# the panel-rendered Caddyfile there.
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

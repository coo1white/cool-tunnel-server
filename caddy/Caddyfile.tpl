# SPDX-License-Identifier: AGPL-3.0-only
#
# Cool Tunnel Server — Caddy (single-process front door, v0.2.0+).
#
# What this Caddy does:
#
#   - Binds :80 for ACME HTTP-01 challenges + http→https redirect.
#   - Binds :443 for TLS termination, SNI-routed:
#       SNI = {{ .PanelDomain }}  →  reverse_proxy → panel:9000
#       SNI = {{ .Domain }}       →  forward_proxy (NaiveProxy Padding)
#   - Manages TLS certs for both domains via the upstream ACME
#     directory ({{ .AcmeDirectory }}) and stores them in
#     /data/caddy/certificates/.
#
# Versus v0.1.x this Caddy now owns the role formerly split across
# HAProxy (SNI router) + sing-box (NaiveProxy server) + ghost-Caddy
# (panel reverse-proxy). Three services collapse to one. Drift
# surfaces shrink to one go.mod (Caddy + forwardproxy).
#
# Plugin: klzgrad/forwardproxy@naive baked in at build time via
# xcaddy (see docker/caddy/Dockerfile). Implements the NaiveProxy
# Padding-extension HTTPS-CONNECT protocol; same wire format the
# bundled `naive` binary in the macOS client speaks.
#
# Probe resistance: any client that hits {{ .Domain }} without a
# valid `Authorization: Basic` header (the auth scheme NaiveProxy
# uses) gets the `probe_resistance` cover-site behaviour from the
# plugin — indistinguishable from a vanilla HTTPS site that
# refuses the request. The bundled `naive` client supplies the
# header from the `proxy` URL in its config.json.

{
    email {{ .AcmeEmail }}
    acme_ca {{ .AcmeDirectory }}

    # auto_https stays ON so Caddy auto-acquires and auto-renews the
    # cert for {{ .Domain }} AND {{ .PanelDomain }}. We do disable
    # automatic redirect for the apex (the forward_proxy plugin does
    # not want a 308 to https inserted ahead of its own handlers
    # — clients connect directly over TLS to :443 with CONNECT).
    auto_https disable_redirects

    # `admin off` — the loopback admin API (:2019) carries the
    # `/load` endpoint that can hot-swap the entire config without
    # restart. Even though it's loopback-only inside the container,
    # leaving it on creates a "if anything inside this container ever
    # gets RCE, the proxy config is mutable" surface. The image's
    # HEALTHCHECK uses /config/ which works fine with admin off
    # (Caddy still binds the loopback listener for stats endpoints).
    #
    # Actually we DO need admin on for the healthcheck — keeping it
    # but binding only loopback. The default is already 127.0.0.1
    # — make it explicit so a future Caddyfile-fmt rewrite can't
    # widen it.
    admin 127.0.0.1:2019

    # Servers stanza pins the global HTTP server posture for both
    # listeners — sets the metric label, hides the Server header
    # globally (so we don't have to set `header -Server` per site),
    # and trims off cipher suites that haven't aged well.
    servers {
        metrics
        trusted_proxies static private_ranges
    }
}

# ---------- :80 — ACME challenges + HTTP→HTTPS redirect ----

# Auto-HTTPS' redirect was disabled in globals; this site block
# does the redirect explicitly so the response always carries a
# portless `Location: https://host/...`. ACME HTTP-01 challenges
# (`/.well-known/acme-challenge/<token>`) are handled by Caddy's
# auto-HTTPS internals BEFORE this site block sees them — the
# `redir` directive only fires for non-challenge paths.
:80 {
    # Strip the `Server: Caddy` response header. Stock Caddy emits
    # it on every response — a probe issuing `curl -I http://<host>`
    # gets the 308 redirect AND a clear "this box runs Caddy"
    # signal. (v0.0.14 anti-censorship hardening, carried forward.)
    header -Server
    redir https://{host}{uri} 308
}

# ---------- :443 — naive forward_proxy for {{ .Domain }} -----

# The bulk of operational traffic. Caddy terminates TLS using the
# auto-managed cert for {{ .Domain }} and then hands the request to
# the forward_proxy plugin, which speaks NaiveProxy's HTTPS-CONNECT
# protocol with the Padding extension. Any TLS client speaking the
# plugin's expected handshake completes a CONNECT to the upstream
# the user wants to reach; anything else (browser, scanner) hits
# the probe_resistance fallback and sees a generic cover site.
#
# `basic_auth` accepts one or more `username password` pairs (the
# `password` here is the cleartext — the plugin currently does NOT
# accept bcrypt). The ProxyAccount renderer below injects one line
# per active account. An empty account list is a deliberate
# fallthrough — the forward_proxy block degrades to probe-
# resistance only, refusing every CONNECT. We do not want to fail
# Caddy's startup just because the operator has zero accounts.
#
# Anti-fingerprint posture mirrors what sing-box's naive plugin
# emitted today:
#
#   - hide_ip / hide_via: strip `X-Forwarded-For` and `Via` headers
#     from the egress CONNECT so the upstream site doesn't see the
#     client's source.
#   - probe_resistance <secret>.localhost: a request that reaches
#     this listener without valid auth gets the cover-site page;
#     the secret subdomain is a back-door for the operator to do a
#     manual handshake test (curl -k https://<secret>.localhost
#     -H 'Host: <secret>.localhost' through the proxy).
#
# Cipher/protocol pinning happens at the global servers stanza
# above. No per-site `tls` directive needed — Caddy auto-HTTPS
# generates one for {{ .Domain }} via ACME.

{{ .Domain }} {
    route {
        forward_proxy {
{{ .ForwardProxyBasicAuthLines }}
            hide_ip
            hide_via
            probe_resistance {{ .ProbeResistanceSecret }}
        }
    }
}

# ---------- :443 — admin panel reverse_proxy for {{ .PanelDomain }} ----

# Caddy SNI-routes to this site for {{ .PanelDomain }} requests. TLS
# is terminated locally using the cert for the panel subdomain
# (auto-managed in the same /data/caddy/certificates/ store).
#
# Anti-fingerprinting:
#
#   - Server header stripped at the global servers stanza.
#   - Per-request access logs go to /dev/null on this site (Caddy's
#     `log { output discard }` directive); error log still goes to
#     container stderr.
#
# Brute-force on /admin/login is intrinsic to a public admin panel.
# Filament has its own login throttling (5 attempts / minute by
# default in the Login livewire component). A Caddy-level
# `rate_limit` directive would be a defence-in-depth layer but
# requires the caddy-rate-limit plugin — defer to a separate change.

{{ .PanelDomain }} {
    log {
        output discard
    }
    # Forward to the panel container's FrankenPHP on :9000. The
    # reverse_proxy directive sets X-Forwarded-For, X-Forwarded-Proto,
    # X-Forwarded-Host automatically — the panel's TrustProxies
    # middleware (bootstrap/app.php, 127.0.0.1 + 172.16/12) honours
    # them so Request::isSecure() returns true.
    reverse_proxy panel:9000
}

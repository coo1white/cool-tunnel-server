# SPDX-License-Identifier: AGPL-3.0-only
#
# Cool Tunnel Server — Caddy (v0.3.0+ layer4 SNI router).
#
# Architecture:
#
#   - :80  — ACME HTTP-01 challenges + http→https redirect.
#   - :443 — mholt/caddy-l4 layer4 SNI router. The two SNI hostnames
#            are routed at TCP level WITHOUT terminating TLS at the
#            front; one path terminates inside this container (panel),
#            the other forwards raw bytes to ct-naive (naive does its
#            own TLS using the cert Caddy already acquired).
#
#       SNI = {{ .Domain }}        → proxy ct-naive:443 (raw TCP,
#                                    no TLS termination at layer4)
#       SNI = {{ .PanelDomain }}   → fall-through → proxy
#                                    127.0.0.1:8443 (raw TCP) →
#                                    inner Caddy HTTPS site →
#                                    reverse_proxy panel:9000
#
# Cert acquisition: Caddy auto-https obtains both certs because both
# hostnames are referenced (panel's site block on 127.0.0.1:8443
# serves real requests; the {{ .Domain }} site block exists ONLY to
# trigger cert acquisition — its serve path is never reached because
# layer4 forwards the SNI to ct-naive before the inner HTTP server
# sees the connection).
#
# ct-naive reads /data/caddy/certificates/<acme_dir>/{{ .Domain }}/
# via the shared caddy_data volume. The supervisor inside ct-naive
# scans for the cert pair on boot and respawns naive when the mtime
# changes (Let's Encrypt renews every ~60 days).
#
# Why this architecture vs v0.2.x:
#
#   v0.2.x baked klzgrad/forwardproxy@naive into Caddy. Worked, but
#   that plugin's wire-format is frozen at the Jan 2025 protocol
#   while klzgrad/naiveproxy (the binary the macOS client bundles)
#   has continued evolving padding + preamble formats. Result:
#   recent naive clients hit "post-CONNECT tunnel closed before
#   target replied" — exactly the failure mode v0.2.0 was supposed
#   to fix vs v0.1.x's sing-box. v0.3.0 sidesteps the whole class
#   of bugs by running the same naive binary on both ends — version
#   pinned in docker/naive/naive.upstream.json and the macOS client's
#   COOL-TUNNEL/naive.upstream.json. Bump both together; that's the
#   only compatibility surface.

# ---------- globals --------------------------------------------------
#
# layer4 lives INSIDE the global block — it's a Caddy app, not a
# top-level site. caddy-l4's Caddyfile dialect requires the
# `layer4 { … }` stanza to appear here; placing it outside is the
# parse error "unrecognized directive: :443" because the parser
# treats `layer4 { … }` as a site address with body, then sees
# `:443 { … }` and has no way to interpret it. See
# https://github.com/mholt/caddy-l4/blob/master/docs/servers.md.

{
    email {{ .AcmeEmail }}
    acme_ca {{ .AcmeDirectory }}

    # auto_https stays ON so Caddy auto-acquires and auto-renews
    # certs for BOTH {{ .Domain }} AND {{ .PanelDomain }}.
    # disable_redirects because the :80 block below does the redirect
    # explicitly with the exact 308 wording we want.
    auto_https disable_redirects

    # Admin API is required for the healthcheck (HEALTHCHECK in
    # docker/caddy/Dockerfile hits /config/). Bound to loopback only
    # inside the container — host firewall + the explicit address
    # are belt-and-braces.
    admin 127.0.0.1:2019

    # Global server posture: metrics, stripped Server header, sane
    # trusted proxies. Applies to every HTTP server we declare below
    # (the inner :8443 panel site; layer4 doesn't run an HTTP server).
    servers {
        metrics
        trusted_proxies static private_ranges
    }

    # ----- layer4 — public :443 SNI router (caddy-l4) ----------------
    #
    # caddy-l4 plugin baked in via docker/caddy/Dockerfile. Two
    # routes — the first matches the proxy SNI exactly and TCP-
    # proxies raw bytes to ct-naive; the second is the unconditional
    # fallback for anything else (panel.*, or any random scanner)
    # and forwards to the inner HTTPS server on 127.0.0.1:8443 where
    # Caddy's HTTP app multiplexes by SNI/Host as normal.
    #
    # Why raw TCP for naive: we want naive to terminate TLS itself
    # (so the wire format matches what the macOS client speaks end-
    # to-end with NO intermediary parsing the TLS stream). Caddy
    # never sees the decrypted bytes; it's a transparent SNI
    # splitter.
    layer4 {
        :443 {
            @naive_sni tls {
                sni {{ .Domain }}
            }
            route @naive_sni {
                proxy ct-naive:443
            }

            # Catch-all: panel.* SNI + every probe. Forward raw
            # bytes to the inner Caddy HTTPS listener on
            # 127.0.0.1:8443. The inner listener has the panel cert
            # (and the dummy naive cert-acquisition block); SNI
            # mismatch falls through to Caddy's default-host
            # behaviour, which for an unknown SNI returns the cover-
            # site default site (currently empty 404).
            route {
                proxy 127.0.0.1:8443
            }
        }
    }
}

# ---------- :80 — ACME challenges + HTTP→HTTPS redirect --------------
#
# Auto-HTTPS redirect was disabled in globals; this site block does
# the redirect explicitly so the response always carries a portless
# `Location: https://host/...`. ACME HTTP-01 challenges
# (`/.well-known/acme-challenge/<token>`) are handled by Caddy's
# auto-HTTPS internals BEFORE this site block sees them — the `redir`
# directive only fires for non-challenge paths.
:80 {
    # Strip the `Server: Caddy` response header. Stock Caddy emits
    # it on every response — a probe issuing `curl -I http://<host>`
    # gets the 308 redirect AND a clear "this box runs Caddy" signal.
    # (v0.0.14 anti-censorship hardening, carried forward.)
    header -Server
    redir https://{host}{uri} 308
}

# ---------- 127.0.0.1:8443 — panel reverse-proxy + naive cert pin ----
#
# Inner HTTPS listener. Bound to the container loopback only — the
# only way traffic reaches this listener is via the layer4 router
# above proxying public :443 here. Two site blocks on this listener:
#
#   1. https://{{ .PanelDomain }}:8443 — real serving site. Caddy
#      terminates TLS using the auto-managed panel cert, then
#      reverse_proxies to FrankenPHP on panel:9000.
#   2. https://{{ .Domain }}:8443 — DUMMY site. Exists ONLY so
#      Caddy's auto-HTTPS issues + renews the {{ .Domain }} cert
#      (which lives in /data/caddy/certificates, shared RO to
#      ct-naive). The serve path returns 404 because layer4
#      forwards naive.* SNI to ct-naive before any request can
#      reach this listener with that SNI.

https://{{ .PanelDomain }}:8443 {
    log {
        output discard
    }
    # Reverse-proxy to the panel container's FrankenPHP on :9000.
    # reverse_proxy sets X-Forwarded-For, X-Forwarded-Proto,
    # X-Forwarded-Host automatically — the panel's TrustProxies
    # middleware (bootstrap/app.php, 127.0.0.1 + 172.16/12) honours
    # them so Request::isSecure() returns true.
    reverse_proxy panel:9000
}

https://{{ .Domain }}:8443 {
    # No real handlers. Caddy's auto-HTTPS still issues + renews the
    # cert for this hostname because the site block exists. The cert
    # lives at /data/caddy/certificates/<acme_dir>/{{ .Domain }}/ and
    # ct-naive reads it via the shared volume.
    #
    # If a request somehow lands here (a layer4 misroute, or someone
    # SSH-tunnelling to the loopback port directly), serve 404 with
    # no body — minimum information disclosure.
    respond 404
}

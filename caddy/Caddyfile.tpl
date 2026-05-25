# SPDX-License-Identifier: AGPL-3.0-only
#
# Cool Tunnel Server — Caddy (v0.4.0+ layer4 SNI splitter only).
#
# Architecture (v0.4.0):
#
#   - :80  — ACME HTTP-01 challenges for the PANEL domain only +
#            http→https redirect.
#   - :443 — mholt/caddy-l4 layer4 SNI splitter. TWO branches:
#
#       SNI = {{ .PanelDomain }}  → tcp/127.0.0.1:8443 (raw TCP) →
#                                   inner Caddy HTTPS terminator →
#                                   reverse_proxy panel:9000
#
#       (any other SNI, including
#        Reality fake-SNI like
#        www.microsoft.com,
#        www.apple.com, etc.)    → tcp/ct-singbox:443
#
# Why no ACME cert for the PROXY domain anymore:
#
#   Reality replaces traditional ACME-issued TLS for the proxy path.
#   sing-box's Reality handshake captures the destination site's
#   handshake (e.g. www.microsoft.com:443) and uses it AS the
#   cover; the client sends SNI=<dest_host> and to a passive
#   observer the connection is indistinguishable from real
#   www.microsoft.com traffic. The server doesn't present a cert
#   for naive.<DOMAIN> at all — Reality does its own cryptography
#   underneath what looks like a normal TLS handshake.
#
#   Effect: Caddy only acquires + renews ONE cert (the panel
#   subdomain), not two. The proxy DNS record (naive.<DOMAIN>) is
#   still useful as a host-style pointer to the server IP, but
#   carries no TLS material.
#
# Why this works versus v0.3.0:
#
#   v0.3.0 tried to run naive itself as the server. naive's --listen
#   flag does NOT accept https://; naive is a client-only binary.
#   v0.4.0 swaps in sing-box (one binary, server + client modes,
#   actively maintained) which DOES run as an HTTPS-CONNECT-style
#   server via VLESS+Reality. The wire format compatibility issue
#   that bit v0.1 → v0.3 becomes structurally impossible: the same
#   sing-box upstream tag is pinned on both ends via
#   singbox-core/singbox.upstream.json.

{
    email {{ .AcmeEmail }}
    acme_ca {{ .AcmeDirectory }}

    # auto_https stays ON so the panel subdomain gets ACME-managed
    # cert + renewal. disable_redirects because the :80 block below
    # does the redirect explicitly with the exact 308 wording we
    # want.
    auto_https disable_redirects

    # Admin API on loopback only (host firewall + the explicit
    # 127.0.0.1 bind are belt-and-braces).
    admin 127.0.0.1:2019

    servers {
        metrics
        trusted_proxies static private_ranges
    }

    # ----- layer4 — public :443 SNI splitter (caddy-l4) --------------
    #
    # Two routes. The named-matcher pulls the panel SNI to the inner
    # HTTPS server; the fallthrough catches every other SNI — Reality
    # fake-SNI, scanner probes, etc. — and forwards raw bytes to
    # ct-singbox.
    layer4 {
        :443 {
            @panel_sni tls {
                sni {{ .PanelDomain }}
            }
            route @panel_sni {
                proxy 127.0.0.1:8443
            }
            # Catch-all: Reality SNI + probes → ct-singbox.
            route {
                proxy ct-singbox:443
            }
        }
    }
}

# ---------- :80 — ACME challenges + HTTP→HTTPS redirect --------------
#
# Auto-HTTPS redirect was disabled in globals; this site block does
# the redirect explicitly. ACME HTTP-01 challenges
# (`/.well-known/acme-challenge/<token>`) are handled by Caddy's
# auto-HTTPS internals BEFORE this site block sees them — the redir
# directive only fires for non-challenge paths.
:80 {
    header -Server
    redir https://{host}{path} 308
}

# ---------- 127.0.0.1:8443 — panel reverse-proxy ---------------------
#
# Inner HTTPS listener. Bound to the container loopback only — the
# only way traffic reaches it is via the layer4 router above
# proxying public :443 here for panel.<DOMAIN> SNI.

https://{{ .PanelDomain }}:8443 {
    log {
        output discard
    }
    reverse_proxy panel:9000 {
        header_up X-Forwarded-For {remote_host}
    }
}

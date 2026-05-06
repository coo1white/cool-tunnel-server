#
# Cool Tunnel Server — Caddy ACME + panel reverse-proxy.
#
# What this Caddy does:
#
#   - Binds :80 for ACME HTTP-01 challenges (Caddy's auto-HTTPS uses
#     port 80 for the challenge unless you configure otherwise).
#     :80 is host-mapped — both {{ .Domain }} and {{ .PanelDomain }}
#     resolve here for `/.well-known/acme-challenge/...` traffic.
#   - Redirects any plain HTTP request to HTTPS so an operator hitting
#     the bare domain by mistake doesn't see Caddy's default page.
#   - Manages a TLS certificate for {{ .Domain }} via the upstream
#     ACME directory ({{ .AcmeDirectory }}) — Caddy stores the cert
#     in /data/caddy/certificates/. The sing-box container has that
#     directory mounted read-only and uses the cert files directly.
#   - Manages a SECOND TLS certificate for {{ .PanelDomain }} via
#     the same ACME directory. (R1-1 / R1-2, v0.0.33.) Caddy
#     terminates TLS for the panel subdomain itself and reverse-
#     proxies plain HTTP to the panel container's nginx on :9000.
#   - sing-box's render path watches the cert file's mtime
#     directly (folded into the render-change SHA-256 hash in
#     `core/ct-server-core/src/singbox/mod.rs::read_cert_mtime`),
#     so a Caddy renewal flips the rendered hash and the
#     scheduled `singbox:render --if-changed --reload` picks
#     it up automatically. No flag file or events handler
#     needed.
#
# What this Caddy does NOT do:
#
#   - It does NOT bind :443 publicly. HAProxy owns :443 on the host
#     and TCP-forwards to either Caddy:8444 (panel SNI) or
#     sing-box:443 (proxy SNI).
#   - It does NOT proxy proxy-traffic. NaiveProxy is sing-box's job.
#
# Why the architecture is split this way:
#
#   - Caddy's auto-HTTPS / CertMagic is the most reliable ACME
#     implementation in the Go ecosystem (multi-challenge fallback,
#     ZeroSSL fallback, conservative retry pacing). For an operator
#     deploying to a fresh VPS, "ACME just works" is worth its own
#     container. Sing-box ships its own ACME but we don't use it
#     here.
#   - Caddy here is stock — no plugins. The unmaintained
#     klzgrad/forwardproxy plugin we used in v0.0.1 is no longer
#     part of this image (see CHANGELOG for the v0.0.2 pivot).
#   - HAProxy in front does only TCP/SNI routing — no TLS termination
#     happens at the router. Each backend (Caddy, sing-box) terminates
#     TLS itself, so the on-the-wire fingerprint stays whatever the
#     backend negotiates. (Anti-tracking probe-resistance preserved.)
#

{
    email {{ .AcmeEmail }}
    acme_ca {{ .AcmeDirectory }}

    # No `events { ... exec ... }` block: stock Caddy 2.8 does
    # not include the third-party `events.handlers.exec` module,
    # so any exec handler in the Caddyfile fails to load with
    # "module not registered: events.handlers.exec". The
    # cert-renewed flag this used to write was already
    # vestigial — sing-box's render path reads the cert file's
    # mtime directly (see read_cert_mtime in singbox/mod.rs) and
    # the existing scheduled reload picks up renewals via the
    # render-change hash. Caddy renewal failures show up in
    # `docker compose logs caddy` at WARN level, which is
    # already what an operator inspects on cert trouble.
}

# ---------- :80 — public ACME challenge handler + HTTP→HTTPS ----

# Caddy's auto-HTTPS automatically binds :80 for HTTP-01 challenges.
# This site block additionally redirects any non-challenge traffic
# (e.g. an operator pasting `http://proxy.example.com` into a
# browser) to https://, so we never serve a default Caddy page.
:80 {
    # Strip the `Server: Caddy` response header. Stock Caddy emits
    # it on every response — a probe issuing `curl -I http://<host>`
    # gets the 308 redirect AND a clear "this box runs Caddy"
    # signal. For an anti-censorship deployment, every detail that
    # narrows the host's identity is a step closer to a blacklist;
    # we have no operational reason to advertise the server engine.
    # (v0.0.14 anti-censorship hardening.)
    header -Server
    redir https://{host}{uri} 308
}

# ---------- A "ghost" HTTPS site so Caddy manages a cert ---------

# Caddy obtains a certificate only for domains that appear in a site
# block. We need the cert managed for {{ .Domain }} but we cannot
# bind :443 — sing-box owns it. Workaround: put the site on an
# internal-only port (8443) that nothing actually connects to. The
# port is bound inside the caddy container only and is NOT mapped
# to the host in docker-compose.yml. Caddy still does HTTP-01
# challenges on :80, stores the cert in /data/caddy/certificates/,
# and sing-box reads from there.

{{ .Domain }}:8443 {
    # Disable TLS-ALPN-01 challenges since :443 is taken by sing-box;
    # HTTP-01 on :80 is the only challenge type we can do here. Pin
    # to TLS 1.3 only — the ghost site never serves real traffic, so
    # there's no compat reason to advertise legacy versions to
    # anyone who probes :8443 inside the container network.
    tls {{ .AcmeEmail }} {
        protocols tls1.3
    }
    # Strip the `Server: Caddy` response header for symmetry with
    # the :80 block. Even though :8443 is unreachable from outside
    # the container network, defence-in-depth: nothing here exposes
    # the engine identity. (v0.0.14 anti-censorship hardening.)
    header -Server
    # If something probes :8443 (only reachable from inside the
    # container network — the port is not host-mapped), close the
    # connection cleanly with 444. The previous `respond "managed"
    # 200` was a recognisable string signature; an empty 444
    # response looks like a generic firewalled endpoint.
    respond "" 444 {
        close
    }
}

# ---------- Admin panel ({{ .PanelDomain }}:8444) ------------------

# Caddy terminates TLS for the panel subdomain here using its own
# auto-HTTPS-managed cert. HAProxy on host :443 reaches this listener
# at caddy:8444 over the internal ct-net; the port is NOT host-mapped.
# Caddy reverse-proxies plain HTTP to the panel container's nginx on
# :9000 (which maps via FastCGI to PHP-FPM serving the Filament app).
#
# Anti-fingerprinting:
#
#   - Pin to TLS 1.3 only — same posture as the apex's sing-box
#     listener; any operator probe trying TLS 1.2 sees a clean
#     handshake reject, not a downgrade.
#   - Strip `Server: Caddy` so the response doesn't advertise the
#     reverse-proxy engine.
#   - Disable Caddy's default access log on this site — per-request
#     logs are a forensic trail. Errors still go to stderr (Caddy's
#     default error log on the global handler).
#
# Brute-force on /admin/login is intrinsic to a public admin panel.
# Filament has its own login throttling (5 attempts / minute by
# default in the Login livewire component). A Caddy-level
# `rate_limit` directive would be a defence-in-depth layer but
# requires the caddy-rate-limit plugin which violates this image's
# stock-only invariant. (Defer to v0.1: ship a non-stock Caddy
# image OR move panel auth to a dedicated component with built-in
# rate limiting.)

{{ .PanelDomain }}:8444 {
    tls {{ .AcmeEmail }} {
        protocols tls1.3
    }
    header -Server

    # Don't log every panel request to disk. Errors only — Caddy's
    # global error handler still writes those to stderr.
    log {
        output discard
    }

    # Forward to the panel container's nginx. The panel listens on
    # :9000 inside the container; ct-net resolves `panel` to the
    # service's IP. The reverse_proxy directive sets
    # `X-Forwarded-For`, `X-Forwarded-Proto: https`, and `Host`
    # automatically — the panel's TrustProxies middleware (configured
    # at bootstrap/app.php for 127.0.0.1 + 172.16/12) honours these
    # so Symfony's Request::isSecure() returns true and Laravel
    # generates correct https:// redirect URLs.
    reverse_proxy panel:9000
}

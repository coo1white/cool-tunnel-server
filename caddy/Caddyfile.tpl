#
# Cool Tunnel Server — Caddy ACME-only mode.
#
# What this Caddy does:
#
#   - Binds :80 for ACME HTTP-01 challenges (Caddy's auto-HTTPS uses
#     port 80 for the challenge unless you configure otherwise).
#   - Redirects any plain HTTP request to HTTPS so an operator hitting
#     the bare domain by mistake doesn't see Caddy's default page.
#   - Manages a TLS certificate for {{ .Domain }} via the upstream
#     ACME directory ({{ .AcmeDirectory }}) — Caddy stores the cert
#     in /data/caddy/certificates/. The sing-box container has that
#     directory mounted read-only and uses the cert files directly.
#   - On every successful obtain / renewal, Caddy `touch`es a flag
#     file at /data/caddy/cert-renewed. The panel's scheduled task
#     watches this file and triggers a sing-box hot reload via the
#     clash API; sing-box re-reads the new certificate on reload.
#
# What this Caddy does NOT do:
#
#   - It does NOT bind :443. That port belongs to sing-box for
#     terminating the naive proxy's TLS handshake.
#   - It does NOT proxy any traffic. The proxy is sing-box's job.
#
# Why the architecture is split this way:
#
#   - Caddy's auto-HTTPS / CertMagic is the most reliable ACME
#     implementation in the Go ecosystem; sing-box's built-in ACME
#     works but lacks Caddy's multi-challenge fallback and ZeroSSL
#     fallback, so ACME failures hurt more.
#   - Caddy here is stock — no plugins. The unmaintained
#     klzgrad/forwardproxy plugin we used in v0.0.1 is no longer
#     part of this image.
#

{
    email {{ .AcmeEmail }}
    acme_ca {{ .AcmeDirectory }}

    # On cert obtain / renewal, bump the flag file the panel watches.
    events {
        on cert_obtained  exec touch /data/cert-renewed
        on cert_failed    exec sh -c "echo \"$(date -u +%FT%TZ)\" >> /data/cert-failures.log"
    }
}

# ---------- :80 — public ACME challenge handler + HTTP→HTTPS ----

# Caddy's auto-HTTPS automatically binds :80 for HTTP-01 challenges.
# This site block additionally redirects any non-challenge traffic
# (e.g. an operator pasting `http://proxy.example.com` into a
# browser) to https://, so we never serve a default Caddy page.
:80 {
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
    # HTTP-01 on :80 is the only challenge type we can do here.
    tls {{ .AcmeEmail }} {
        protocols tls1.2 tls1.3
    }
    respond "managed" 200
}

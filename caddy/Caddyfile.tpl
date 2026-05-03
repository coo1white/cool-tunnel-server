# Cool Tunnel Server — Caddyfile template.
#
# This file is a *template*. The panel renders it into the
# Caddyfile that Caddy actually loads, substituting:
#
#   {{DOMAIN}}              — public hostname (from .env / ServerConfig)
#   {{ACME_EMAIL}}          — ACME contact email
#   {{ACME_DIRECTORY}}      — ACME directory URL
#   {{ANTI_TRACKING_BLOCK}} — hide_ip / hide_via / probe_resistance lines
#   {{BASIC_AUTH_BLOCK}}    — one basic_auth line per active ProxyAccount
#   {{ADMIN_BASIC_AUTH}}    — edge basic_auth gating /admin
#   {{DOH_RESOLVER}}        — DNS-over-HTTPS upstream for CONNECT lookups
#
# CaddyfileGenerator does the substitution; if you tweak this template,
# re-render with `php artisan caddyfile:render` (or just save anything
# in the panel — model events do it for you).

{
    order forward_proxy before file_server
    email {{ACME_EMAIL}}
    acme_ca {{ACME_DIRECTORY}}

    # Admin API on a unix socket the panel can write to. Never exposed
    # over TCP — there's no auth on the admin API and it can do
    # anything Caddy can do.
    admin unix//run/caddy/admin.sock

    # DNS-over-HTTPS for any name resolution Caddy itself does. Stops
    # the host's recursive resolver from seeing CONNECT targets.
    servers {
        protocols h1 h2 h3
    }

    # Use a DoH resolver for ACME and any other Caddy-internal lookups.
    # Doesn't affect what naive's CONNECT does — that goes out via
    # whatever the upstream the proxy decides to dial.
    {{DOH_RESOLVER_BLOCK}}
}

# ---------- Public proxy + cover site ----------
:443, {{DOMAIN}} {
    tls {{ACME_EMAIL}}

    forward_proxy {
        {{BASIC_AUTH_BLOCK}}
        {{ANTI_TRACKING_BLOCK}}
    }

    # Anything that *isn't* an authenticated CONNECT falls through
    # here. We hand the request to the panel (which renders whichever
    # FakeWebsite is currently selected) and only fall back to static
    # assets if the panel is unreachable.
    @adminPath path /admin /admin/*
    handle @adminPath {
        {{ADMIN_BASIC_AUTH}}
        reverse_proxy panel:9000 {
            header_up X-Forwarded-Proto https
            header_up X-Forwarded-Port  443
        }
    }

    @assets path /favicon.ico /robots.txt /static/* /assets/*
    handle @assets {
        root * /srv/fallback
        try_files {path} /index.html
        file_server
    }

    handle {
        reverse_proxy panel:9000 {
            header_up X-Forwarded-Proto https
            header_up X-Forwarded-Port  443

            # If the panel is down we still want unauthenticated
            # probes to see *something* that looks like a website,
            # not a Caddy 502 page (which would fingerprint us).
            @panelDown status 502 503 504
            handle_response @panelDown {
                root * /srv/fallback
                try_files {path} /index.html
                file_server
            }
        }
    }
}

# SPDX-License-Identifier: AGPL-3.0-only
#
# Cool Tunnel Server Caddy template.
# Caddy owns ACME and public SNI routing only. The admin web app owns
# browser UI; the Hono API owns auth/session/admin APIs; sing-box owns
# Reality TLS for proxy traffic.
#
# SNI routing on :443 (layer4 — Caddy never terminates proxy TLS):
#   SNI = PANEL_DOMAIN -> inner Caddy :8443 (admin panel)
#   SNI = DOMAIN       -> inner Caddy :8444 (landing page, real cert)
#                         — only when CT_LANDING_PAGE is enabled
#   anything else      -> ct-singbox:443 (Reality). Real clients use the
#                         REALITY_DEST_HOST SNI, so they land here, not above.

{
    email {{ .AcmeEmail }}
    acme_ca {{ .AcmeDirectory }}
    auto_https disable_redirects
    admin 127.0.0.1:2019

    servers {
        trusted_proxies static private_ranges
    }

    layer4 {
        :443 {
            @admin_sni tls {
                sni {{ .PanelDomain }}
            }
            route @admin_sni {
                proxy 127.0.0.1:8443
            }
{{ if .LandingPage }}
            @site_sni tls {
                sni {{ .Domain }}
            }
            route @site_sni {
                proxy 127.0.0.1:8444
            }
{{ end }}
            route {
                proxy ct-singbox:443
            }
        }
    }
}

:80 {
    header -Server
    redir https://{host}{path} 308
}

https://{{ .PanelDomain }}:8443 {
    log {
        output discard
    }
    header -Server
    reverse_proxy admin-web:3000
}

{{ if .LandingPage }}
# Public landing page for the bare proxy domain. Opt-in via CT_LANDING_PAGE.
# Proxy clients reach Reality with the REALITY_DEST_HOST SNI (never this
# hostname), so this page is only served to browsers/scanners that ask for
# DOMAIN by name. It gives the host a valid certificate and an ordinary-looking
# site instead of a cert warning or a borrowed CDN error page. Edit the HTML
# below to taste.
https://{{ .Domain }}:8444 {
    log {
        output discard
    }
    header -Server
    header Content-Type "text/html; charset=utf-8"
    respond `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Welcome</title>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:38rem;margin:5rem auto;padding:0 1.25rem;color:#1f2937;line-height:1.65">
<h1 style="font-size:1.6rem;font-weight:600;margin:0 0 .5rem">It works</h1>
<p style="color:#4b5563;margin:0">This site is online. There's nothing else here yet.</p>
</body>
</html>
` 200
}
{{ end }}

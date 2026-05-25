# SPDX-License-Identifier: AGPL-3.0-only
#
# Cool Tunnel Server v0.5.2 Caddy template.
# Caddy owns ACME and public SNI routing only. The admin web app owns
# browser UI; the Hono API owns auth/session/admin APIs; sing-box owns
# Reality TLS for proxy traffic.

{
    email {{ .AcmeEmail }}
    acme_ca {{ .AcmeDirectory }}
    auto_https disable_redirects
    admin 127.0.0.1:2019

    servers {
        metrics
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

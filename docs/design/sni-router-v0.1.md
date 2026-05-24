# SNI Router Design

Caddy routes by SNI. Requests for `PANEL_DOMAIN` go to the Bun admin panel. Other TLS traffic is forwarded to sing-box for the VLESS + Reality proxy path.

```text
:443
  SNI == PANEL_DOMAIN -> panel:9000
  other SNI           -> singbox:443
```

Admin access is protected by Better Auth sessions and the first-owner bootstrap flow.

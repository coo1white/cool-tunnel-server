# SNI Router Design

Caddy routes by SNI. Requests for `PANEL_DOMAIN` go to the Next.js admin dashboard, which talks only to the internal Hono API. Other TLS traffic is forwarded to sing-box for the VLESS + Reality proxy path.

```text
:443
  SNI == PANEL_DOMAIN -> admin-web:3000
  other SNI           -> singbox:443
```

Admin access is protected by Better Auth sessions and the first-owner bootstrap flow.

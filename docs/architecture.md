# Architecture

Cool Tunnel Server is a five-service stack:

| Service | Role |
| --- | --- |
| `caddy` | Public `:80`/`:443` front door. Handles ACME for `PANEL_DOMAIN` and uses `mholt/caddy-l4` to split TLS by SNI. |
| `singbox` | VLESS + Reality proxy engine. Reads `/data/config/singbox.json` and is supervised by `singbox-core`. |
| `panel` | Laravel + Filament admin UI, subscription endpoint, scheduler, queue worker, and `ct-server-core` daemon. |
| `db` | MariaDB state: config, accounts, admins, and app data. |
| `redis` | Cache, sessions, queues, and revocation/reload pub/sub. |

## Front Door

```text
:80
  caddy
    ACME HTTP-01 for PANEL_DOMAIN
    HTTP -> HTTPS redirects

:443
  caddy layer4 SNI splitter
    SNI == PANEL_DOMAIN -> 127.0.0.1:8443 -> panel:9000
    any other SNI       -> ct-singbox:443 -> VLESS + Reality
```

Caddy does not decrypt proxy traffic. Reality TLS terminates inside
sing-box on the proxy path. The panel path terminates in Caddy's inner
HTTPS listener and reverse-proxies to FrankenPHP on `panel:9000`.

## Render And Reload

- The panel writes sing-box input from DB state.
- `singbox-core render-server` renders `/data/config/singbox.json`.
- `ct-singbox` watches that file and respawns sing-box when it changes.
- `ct-server-core caddyfile render` renders `/etc/caddy/Caddyfile`.
- `ct update` reloads Caddy from the host-side operator.

There is no clash API or HAProxy reload path in the current runtime.

## Component Manifests

Every replaceable runtime part is pinned under
`manifests/*.upstream.json` or the matching deployment source
(`docker-compose.yml`, Dockerfiles, Composer, Cargo, or
`singbox-core/singbox.upstream.json`). `ct doctor`, `ct readiness`,
and `credential-lock:check` are the supported operator health gates.

## Client Contract

Clients consume the subscription manifest from:

```text
https://<PANEL_DOMAIN>/api/v1/subscription/<token>
```

The manifest carries the server host, port, VLESS UUID, Reality public
key, short IDs, and the sing-box version pin. The shared Rust protocol
crate defines the manifest schema so server and clients agree on the
wire format.

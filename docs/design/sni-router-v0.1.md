# SNI Router — v0.1 design seed

> **Status:** seed, not an implementation plan. Captures the
> architectural sketch the 2026-05-04 audit's R1-1 cluster needs.
> Detailed design + diff sequencing comes later.

## Why this exists

`docs/audits/2026-05-04T06-31-58Z.md` finding R1-1 documents that
sing-box v1.13.11's `naive` inbound has no schema-level fallback
to a cover site, and `option/naive.go::NaiveInboundOptions` has no
`fallback`, `fall_back`, or `fallback_url` field on any inherited
type. R1-2 documents the cascade: the Filament panel `/admin` is
unreachable from the public internet because there is no front-door
service to dispatch non-naive traffic to `panel:9000`. The 2026-05-04
ship pass landed an SSH-tunnel workaround as a runbook-scope partial
fix; this doc captures the v0.1 path back to public reachability.

## Scope

- Restore the property the original klzgrad/forwardproxy plugin held:
  `:443` traffic that does **not** look like an authenticated naive
  CONNECT is routed to a cover site (the existing FakeSiteController
  flow on `panel:9000`).
- Make `/admin` reachable on the public domain with proper TLS, no
  SSH dance, gated by Filament login + (re-introduced in v0.2) edge
  basic-auth.
- Maintain the "ACME-only Caddy, no plugins" invariant the stack's
  identity rests on. **No** `caddy-l4` or other layer4 plugins.

## Out of scope

- Migrating off NaiveProxy (vless+REALITY, trojan, anytls). v0.0.x
  clients are deployed against the naive wire format; protocol
  migration is a v0.x → v1.0 story.
- Re-introducing the forwardproxy Caddy plugin. The audit-blessed
  posture is sing-box for the proxy server, stock Caddy for ACME.

## Architectural sketch

A small TLS-aware front-door service, written as a new sub-binary
in `core/ct-server-core/src/router/`. Inbound on `:443/tcp`,
peeks the first TLS frame's `ClientHello` (without terminating
TLS), extracts SNI + ALPN, and forwards the raw connection to one
of two upstream targets:

| Inbound shape (peek-only) | Upstream | Rationale |
|---|---|---|
| Authenticated naive HTTP/2 with the padding extension | `ct-singbox:443` | Existing naive inbound; padded CONNECTs flow through unchanged. |
| Anything else hitting the apex domain | `ct-panel:9000` | FakeSiteController + `/admin` are all served here. |
| SNI mismatch / unknown host | drop (RST or 502) | Cheap; matches the "TLS endpoint that mostly looks like Caddy" target shape. |

Distinguishing naive from non-naive at peek time is the design
question this seed leaves open; two viable paths:

1. **ALPN: `h2` + presence of a naive-padding HPACK header.** Peek
   farther than `ClientHello`; intercept the first HTTP/2 frame.
   Higher signal but more state.
2. **SNI + opportunistic forward.** Forward all `:443` to sing-box
   first; on the inbound's `missing naive padding` close, retry to
   `panel:9000`. Simpler, but doubles failure-path latency for cover
   site hits. Probably the v0.1 default; tightened in v0.2.

## Where it lives

`core/ct-server-core/src/router/` (new submodule) — the binary
already runs in the panel image, has tokio + reqwest, and the
existing daemon model (long-lived process under supervisord) fits
the listener shape. New CLI subcommand `ct-server-core router serve
--listen 0.0.0.0:443 --naive ct-singbox:443 --fallback panel:9000`.

`docker-compose.yml`:
- sing-box's `ports:` block loses `"443:443"`; sing-box stays bound
  to `:443` *inside* `ct-net` only.
- A new `router` service in the panel image (or its own thin image
  reusing `cool-tunnel-server-core:latest`) takes the `"443:443"`
  host map.
- Audit guard in `.github/workflows/audit.yml` adapts: sing-box
  publishes nothing on the host; `:443` is the router's.

## Crate dependencies

- `tokio` (already in tree) — async runtime, listener + connect.
- `rustls` or `tls-parser` for **peek-only** ClientHello parsing.
  No TLS termination here — we never decrypt.
  - `tls-parser` (RustCrypto) is lightweight and fits "peek only".
  - `rustls` is heavier; only worth pulling if we move to the ALPN
    path that needs HTTP/2 framing too.
- `h2` (low-level HTTP/2) — only if we go path 1 in the design
  question above.

## Test surface

- **Unit:** `tls-parser` against a corpus of canned ClientHello
  bytes (good SNI, missing SNI, oversized SNI, ALPN with `h2`,
  ALPN with `http/1.1`, malformed length prefix). Bound the parse
  budget (max 8 KiB peek, 1s read timeout).
- **Integration:** spin a fake naive upstream + a fake fallback
  upstream as tokio TcpListeners, run the router against both, and
  assert that:
  - SNI matches the operator domain → routes to one upstream
  - Different SNI → drops or 502
  - Empty SNI → drops
  - Malformed TLS → drops, no panic
- **Property:** `quickcheck` over random byte prefixes, assert
  no panics regardless of input shape (peek must be hostile-input-
  safe; this is the new public attack surface, R2 territory).
- **Stress:** the existing `scripts/stress/g_anti_tracking_probe.sh`
  shape extended to also probe `:443` apex without naive auth,
  assert it returns the cover site (HTML, 200, length within range).

## Migration path

1. Land the router binary + tests behind a feature flag (no
   compose changes yet). The probe already shells out to a real
   naive client (R4-3 done) — it'll exercise the router end-to-end
   once the compose pivot lands.
2. Compose pivot in a separate runbook commit: sing-box loses host
   port, router takes it, panel keeps its loopback bind for SSH
   compatibility (deprecated once router serves `/admin` cleanly).
3. Reintroduce the edge basic-auth feature deleted under R4-2 once
   the router can enforce it on the `/admin` path.
4. Update `docs/installation-debian.md`, `GETTING_STARTED.md`,
   `docs/architecture.md` — drop the SSH-tunnel workaround section
   in favour of the public URL.

## Known unknowns

- **Naive padding detection cost.** Path 1 requires reading the
  HTTP/2 SETTINGS frame; that's at minimum a kilobyte of buffer per
  connection. Worth measuring before committing to the path.
- **PROXY protocol.** Should the router emit PROXY v2 to the
  upstreams so the panel still sees the real client IP? Likely yes;
  Filament's logs and any future rate-limit need it.
- **HTTP/3.** NaiveProxy is HTTP/2-only by protocol design (see
  `cross-platform-clients.md`). The router stays TCP/443; UDP/443 is
  not handled.
- **Cert source.** Caddy still issues; the router reads from
  `caddy_data` like sing-box does today, OR the router talks to
  Caddy's admin API. Probably the volume mount, for the same
  reasons sing-box uses it.

— end seed

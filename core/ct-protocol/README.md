# ct-protocol

Cool Tunnel wire format and shared types — the Rust crate that every
client (and the server) depends on for a single source of truth on
profile URLs, subscription manifests, and admin/control wire types.

## Why this exists

The macOS client today has a Rust core (`cool-tunnel-core`) that owns
all the validation logic. As the client family grows
(`cool-tunnel-android`, `cool-tunnel-win`, `cool-tunnel-ios`,
`cool-tunnel-linux-desktop`), each new platform should *not* re-
implement profile parsing, PAC generation, or subscription
verification — the rules are the same everywhere.

`ct-protocol` is that shared rulebook. It's `no_std`-compatible,
zero-`unsafe`, and carries no I/O — anything that touches the network
or filesystem lives in the platform's own core crate. That makes it
trivially embeddable in:

| Platform | Integration |
| --- | --- |
| macOS    | Linked into `cool-tunnel-core` (existing). |
| iOS      | XCFramework wrapping `ct-protocol` + `ct-client-core` (planned). |
| Android  | JNI bindings around the static lib (planned). |
| Windows  | Static lib + thin C ABI shim (planned). |
| Linux desktop | Static lib + GTK/Qt frontend (planned). |
| **Server** | Used by `ct-server-core` to emit the same types it expects clients to consume. |

The server is the canonical source of the wire format. Any change here
ships in a server release first; clients pick it up via `cargo update`.

## Types in scope

- `ProfileV1` — `naive+https://user:pass@host:port` URLs (parser +
  serializer + validator).
- `SubscriptionManifestV1` — JSON the panel emits at
  `GET /api/v1/subscription/<token>`. One or more profiles plus
  metadata (server-supported features, recommended fake site, ACME
  status). Signed with an HMAC over a per-account secret.
- `WireRequestV1` / `WireResponseV1` / `WireEventV1` — JSON-over-
  unix-socket protocol the panel uses to talk to `ct-server-core`'s
  daemon mode.
- `AntiTrackingFeature` — enum of mitigations (`HideIp`, `HideVia`,
  `ProbeResistance`, `DohResolver`, `Http3`).

## Versioning

The `V1` suffix is load-bearing: a `V2` will live side by side and
clients negotiate via the `version` field on every wire type. We do
not hide breaking changes inside a `V1`.

## License

Apache-2.0.

# ct-protocol

Cool Tunnel wire format and shared types — the Rust crate that every
client (and the server) depends on for a single source of truth on
subscription manifests, component manifests, and admin/control wire
types.

## Why this exists

The macOS client today has a Rust core (`cool-tunnel-core`) that owns
all the validation logic. As the client family grows
(`cool-tunnel-android`, `cool-tunnel-win`, `cool-tunnel-ios`,
`cool-tunnel-linux-desktop`), each new platform should *not* re-
implement profile parsing, PAC generation, or subscription
verification — the rules are the same everywhere.

`ct-protocol` is that shared rulebook. It's `no_std`-compatible,
zero-`unsafe`, and carries no I/O — anything that touches the network
or filesystem lives in the platform's own core crate. The current
server line emits admin-pinned SubscriptionManifestV2 JSON for
VLESS+Reality; the older ProfileV1 / SubscriptionManifestV1 structs
remain in this crate as compatibility types until a Rust V2 mirror
lands. That makes the crate trivially embeddable in:

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

- `SubscriptionManifestV1` / `ProfileV1` — compatibility structs for
  pre-v0.4 clients. Current VLESS+Reality subscriptions are v2 and
  are pinned by the admin tests until `SubscriptionManifestV2` lands
  here.
- `WireRequestV1` / `WireResponseV1` / `WireEventV1` — JSON-over-
  unix-socket protocol the admin runtime uses to talk to `ct-server-core`'s
  daemon mode.
- `AntiTrackingFeature` — enum of mitigations (`HideIp`, `HideVia`,
  `ProbeResistance`, `DohResolver`, `Http3`).

## Versioning

The `V1` suffix is load-bearing: a `V2` will live side by side and
clients negotiate via the `version` field on every wire type. We do
not hide breaking changes inside a `V1`.

## License

Apache-2.0.

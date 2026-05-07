# Cross-Platform Clients

Today there's one client: [Cool Tunnel for macOS](https://github.com/coo1white/cool-tunnel).
The plan is to grow to a family:

| Repo (proposed) | Platform | UI tier | Status |
| --- | --- | --- | --- |
| `cool-tunnel`         | macOS         | SwiftUI + AppKit            | **Shipping** (v0.1.5) |
| `cool-tunnel-ios`     | iOS / iPadOS  | SwiftUI                     | Planned |
| `cool-tunnel-android` | Android       | Jetpack Compose             | Planned |
| `cool-tunnel-win`     | Windows 10/11 | WinUI 3 (or Tauri shell)    | Planned |
| `cool-tunnel-linux`   | Linux desktop | GTK 4 (or Qt 6)             | Planned |

Every client in this family **shares the same Rust core layer** —
specifically the `ct-protocol` crate from this repo, plus a per-
platform thin core (`ct-client-core-*`) that handles platform glue
(naive-binary management, system-proxy integration, keychain).

## How the layering works

Each client ships **three** layers that match the server's three
layers:

```
   ┌─────────────────────────────────────────────────┐
   │  Per-platform UI (SwiftUI / Compose / WinUI /…) │
   └────────────────────┬────────────────────────────┘
                        │ Foreign-function call
                        │ (XCFramework / JNI / C ABI)
   ┌────────────────────▼────────────────────────────┐
   │  ct-protocol           ct-client-core-<plat>     │
   │  (shared crate)        (per-platform glue)       │
   │     ProfileV1            naive binary mgmt       │
   │     SubscriptionV1       system-proxy plumbing   │
   │     WireV1               keychain / keystore     │
   │     Components           lsof-style anomaly      │
   └────────────────────┬────────────────────────────┘
                        │ Process::spawn
                        ▼
   ┌─────────────────────────────────────────────────┐
   │  naive (BSD-3 upstream binary, per-platform)     │
   │  TLS handshake + HTTP CONNECT to your server     │
   └─────────────────────────────────────────────────┘
```

This is exactly how the macOS client is structured today — see
[`COOL-TUNNEL/core/`](https://github.com/coo1white/cool-tunnel/tree/main/core)
in the client repo. The plan is to extract the platform-agnostic
parts into `ct-protocol` (this server repo's `core/ct-protocol/`)
so every new platform reuses them verbatim.

## What `ct-protocol` provides

Pure Rust, `no_std`-friendly, zero `unsafe`, zero I/O. Safe to embed
on any target.

- `ProfileV1::parse(&str)` — validates `naive+https://…` URLs.
- `SubscriptionManifestV1` — JSON the server emits at
  `GET /api/v1/subscription/<token>`. Carries one or more profiles,
  the server's anti-tracking capabilities, and a `fake_site_slug`
  the client can show in its UI.
- `WireRequestV1` / `WireResponseV1` / `WireEventV1` — the JSON-per-
  line protocol the macOS client already uses to talk to its own
  Rust core. Reused as-is on any platform.
- `ComponentManifestV1` / `ComponentStatusV1` — the
  component-as-machine-part schema. Each platform's *Components* tab
  reads its own `manifests/` (or equivalent) and renders OK/NG.

## Per-platform glue (`ct-client-core-<plat>`)

These are **separate crates per platform** because the syscalls
differ — there's no single Rust crate that can talk to both
`networksetup` (macOS) and `NEPacketTunnelProvider` (iOS) and
`ProxyManager` (Android) and `WinHTTP` (Windows). They share
`ct-protocol` for everything platform-agnostic.

| Crate | Lives | Wraps |
| --- | --- | --- |
| `ct-client-core-macos` | inside `cool-tunnel/core/` (already exists) | `networksetup`, `lipo`, Keychain |
| `ct-client-core-ios` | future `cool-tunnel-ios/core/` | `NEPacketTunnelProvider`, Keychain |
| `ct-client-core-android` | future `cool-tunnel-android/core/` | `VpnService`, Android Keystore |
| `ct-client-core-win` | future `cool-tunnel-win/core/` | `WinHTTP`, DPAPI |
| `ct-client-core-linux` | future `cool-tunnel-linux/core/` | `proxy-resolver`, libsecret |

## Wire compatibility

Any client that:

1. Speaks NaiveProxy (HTTP/2 CONNECT over TLS) on the wire, **and**
2. Uses `ct-protocol` for profile / subscription / component types

… is interoperable with this server **today**. Even a non-Rust
client (e.g. a Go re-implementation on a NAS) can interoperate by
reading the JSON shape `ct-protocol` defines from
`docs/protocol.md` (planned).

## Versioning rule

The `V1` suffix is load-bearing. **Breaking changes** to any wire
type get a `V2` that lives side-by-side; clients negotiate via the
`version: 1` field on every payload. We never silently change `V1`.

## What this server commits to

For every release tagged here:

- The exact `ct-protocol` version is published as a Cargo crate
  with a Semver-compatible bump only when the wire is unchanged.
- The schema files in `manifests/*.upstream.json` are loadable by
  any release of `ct-protocol >= 0.0.1`.
- The `/api/v1/subscription/<token>` endpoint always emits a body
  that round-trips through `SubscriptionManifestV1` of the same
  major version the URL declares.

## Anti-tracking notes for client implementers

A few protocol details exist *because* the server is trying to look
like a generic HTTPS endpoint to anyone scanning it. Clients should
not rely on any tell that contradicts this:

- **Subscription signature lives in the JSON body, not in HTTP
  headers.** v0.0.8 and earlier used `X-CT-Signature` /
  `X-CT-Protocol` response headers; v0.0.9+ removed them because
  they were unmistakable project tells. The signature is now in the
  body's `signature` field, computed as
  `HMAC-SHA-256(canonical_body_with_signature_null, account_secret)`.
  To verify: clear `signature` to `null`, re-canonicalise (same
  serialiser settings, key order preserved), HMAC, compare against
  the spliced value with constant-time equality.
- **`capabilities.http3` is always `false`.** NaiveProxy is
  HTTP/2-only at the protocol level — sing-box's `naive` inbound
  does not serve QUIC. The server intentionally does NOT advertise
  HTTP/3 support; clients that attempt QUIC against this server
  will fail and fall back to TCP, producing a fingerprintable
  network signature. Don't try.
- **Invalid subscription tokens get a 200 + cover-site HTML body**,
  byte-identical to the camouflage cover-site catch-all (same body,
  same Content-Type, same `Cache-Control: public, max-age=3600`,
  same `ETag`). Don't probe a token you don't have — the server
  cannot tell you it's wrong without breaking that property. The
  same fall-through fires for: unknown token, expired/disabled
  account, rate-limit hit, signing-key misconfigured, and (as of
  v0.0.59) any account whose stored cleartext is empty or fails
  to decrypt — all of these are operationally distinct but
  on-the-wire identical. (Earlier revisions of this doc said "404 +
  HTML"; that was wrong — a 404 would distinguish the subscription
  endpoint from the rest of the cover-site catch-all by status code
  alone.)
- **`{{CLEARTEXT_PLACEHOLDER}}` is a server-internal marker.** The
  Rust core's `core/ct-server-core/src/subscription.rs` emits the
  literal string `{{CLEARTEXT_PLACEHOLDER}}` for the CLI-without-
  panel path; the panel's HTTP path splices the actual cleartext
  before signing and the HMAC covers the spliced body. If a client
  ever sees that string in a manifest's `password` field, the
  server is broken — DO NOT treat it as a literal password (it
  won't authenticate). Report it to the operator and refuse the
  profile.
- **A signed manifest with `password: ""` should be refused.**
  v0.0.58 and earlier could emit one when the panel's encrypted-
  cleartext column was empty (legacy row pre-v0.0.5, or APP_KEY
  rotation broke decryption). v0.0.59+ falls through to the cover
  site instead of emitting it, but a defensive client should still
  reject empty passwords on its own — that's a contract a future
  server bug or a man-in-the-middle proxy could violate.
- **No `Server:` or `X-Powered-By:` headers** on the subscription
  response. If you're testing a client and see one, that's a bug
  on the server side; please report.

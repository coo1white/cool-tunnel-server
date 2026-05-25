<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# singbox-core

Shared sing-box management core. Same TypeScript source compiled to a self-contained binary via `bun build --compile`, embedded by:

- **cool-tunnel-server** (this repo) — `ct-singbox` container uses `singbox-core supervise` to manage the server-side sing-box process; the admin API calls `singbox-core render` to emit `/data/config/singbox.json`.
- **cool-tunnel** (macOS client) — `Cool Tunnel.app` bundles the compiled binary and the macOS-side `TunnelOrchestrator` (Swift) shells to it for spawn / config / health.

## Why a shared core

v0.1.x → v0.3.x burned ten man-hours on "the server's wire format doesn't match the client's wire format" bugs. The naive client and the forwardproxy-plugin server were two repos on independent release cadences; one froze while the other kept moving. Same wire format mismatch class of bug every time.

v0.4.0 / v3.0.0 collapses that surface to zero: **same binary, same config schema, same protocol on both ends, pinned to the same upstream tag**. If the client and server can be rebuilt from one upstream tag without code changes, version skew is structurally impossible.

## Protocol

VLESS + Reality. Chosen because:

- Reality preserves the "looks like a vanilla HTTPS request to a real CDN" cover-site property that drew this project to naive in the first place.
- sing-box ships server + client modes for VLESS in the same binary — no protocol-specific forks.
- Active upstream maintenance (SagerNet/sing-box is one of the most-watched proxy projects in 2026).

## Subcommand surface

```
singbox-core render-server --input <path> --output <path>  # write server config.json
singbox-core render-client --input <path> --output <path>  # write client config.json
singbox-core supervise --config <path>                     # spawn + watch + respawn
singbox-core install --target-dir <path>                   # fetch+verify pinned sing-box
singbox-core reality-keygen                                # generate Reality X25519 keys
singbox-core version                                       # print CLI + pinned sing-box version
```

## Pinned version

See `singbox.upstream.json`. v0.4.0 / v3.0.0 pin: `v1.13.12` (released 2026-05-15).

## Build distribution

```sh
bun run build:all
# produces:
#   dist/singbox-core-linux-x64        — used in ct-singbox container
#   dist/singbox-core-darwin-arm64     — used in Cool Tunnel.app on Apple Silicon
#   dist/singbox-core-darwin-x64       — used in Cool Tunnel.app on Intel
```

Each `--compile` output is a single ~50 MB executable that embeds the Bun runtime + the TypeScript sources. No external Node/Bun install needed at runtime.

## License

AGPL-3.0-only. Copyright (C) 2026 coolwhite LLC.

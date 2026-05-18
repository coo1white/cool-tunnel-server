# cool-tunnel-server-core

Latency-sensitive Rust engine for the Cool Tunnel Server admin panel.

The PHP/Filament panel handles the UI and persistence; this binary
owns the parts where strict types, structured errors, and direct
syscalls matter:

| Subcommand | What it does |
| --- | --- |
| `ct-server-core caddyfile render` | Reads `server_configs` from the DB, substitutes into `Caddyfile.tpl`, writes atomically to `/etc/caddy/Caddyfile`. Returns the SHA-256 of the result. |
| `ct-server-core daemon` | Long-running mode for the panel socket, Redis revocation bridge, and internal metrics endpoint. |
| `ct-server-core component list/check` | Lists or verifies pinned component manifests. |
| `ct-server-core canary probe/status` | Runs and reports the self-probe canary. |
| `ct-server-core admin panel-domain` | Prints the resolved panel hostname. |

The wire format is the same `Request`/`Response`/`Event` JSON-over-
stdio used by the macOS client's Rust core, so the design intuitions
transfer.

## Build

```sh
cd core
cargo build --release
# → target/release/ct-server-core
```

In production the Compose stack ships a precompiled binary, so the
panel container can `exec` it without a Rust toolchain.

## Lint and test

```sh
cargo fmt --all -- --check
cargo clippy --release --all-targets -- -D warnings
cargo test --release
```

Production code paths can't trap: `unwrap_used` / `expect_used` /
`panic` / `todo` / `unimplemented` are all denied.

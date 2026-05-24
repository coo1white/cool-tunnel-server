# cool-tunnel-server-core

Latency-sensitive Rust engine for the Cool Tunnel Server stack.

The Bun/Hono admin panel handles operator UI, auth, and account state;
this binary owns the parts where strict types, structured errors, and
direct syscalls matter:

| Subcommand | What it does |
| --- | --- |
| `ct-server-core caddyfile render` | Reads `server_configs` from the DB, substitutes into `Caddyfile.tpl`, writes atomically to `/etc/caddy/Caddyfile`. Returns the SHA-256 of the result. |
| `ct-server-core daemon` | Long-running mode for the panel socket and internal metrics endpoint. |
| `ct-server-core admin panel-domain` | Prints the resolved panel hostname. |
| `ct-server-core version` | Prints the core binary version and protocol version. |

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
Bun admin container can `exec` it without a Rust toolchain.

## Lint and test

```sh
cargo fmt --all -- --check
cargo clippy --release --all-targets -- -D warnings
cargo test --release
```

Production code paths can't trap: `unwrap_used` / `expect_used` /
`panic` / `todo` / `unimplemented` are all denied.

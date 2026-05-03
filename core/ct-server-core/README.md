# cool-tunnel-server-core

Latency-sensitive Rust engine for the Cool Tunnel Server admin panel.

The PHP/Filament panel handles the UI and persistence; this binary
owns the parts where strict types, structured errors, and direct
syscalls matter:

| Subcommand | What it does |
| --- | --- |
| `ct-server-core caddyfile render` | Reads `proxy_accounts` + `server_configs` from the DB, substitutes into `Caddyfile.tpl`, writes atomically to `/etc/caddy/Caddyfile`. Returns the SHA-256 of the result. |
| `ct-server-core caddyfile validate` | Runs `caddy validate` on the rendered file (catches syntax errors before reload). |
| `ct-server-core caddy reload` | POSTs the rendered Caddyfile to Caddy's admin API on the unix socket; graceful, no dropped connections. |
| `ct-server-core traffic collect` | Scrapes Caddy `/metrics`, parses Prometheus text, upserts deltas into `traffic_logs` + `proxy_accounts.used_bytes`. |
| `ct-server-core quota enforce` | Disables accounts past expiry or quota. Re-renders + reloads if any state changed. |
| `ct-server-core probe anti-tracking` | Active check — runs a synthetic CONNECT through the local proxy and verifies `hide_ip` / `hide_via` are actually working. |
| `ct-server-core daemon` | Long-running mode — listens on a unix socket and accepts JSON requests from the panel. Faster than `Process::spawn` per call because the DB pool stays warm. |

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

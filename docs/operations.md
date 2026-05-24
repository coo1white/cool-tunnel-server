# Operations

Use `ct` for normal VPS operations:

```sh
ct doctor
ct backup
ct update
ct recover
```

## Secrets

Treat `.env`, backup archives, `BETTER_AUTH_SECRET`, database passwords, Redis passwords, and bootstrap tokens as secrets. Diagnostics and tests should redact secret-looking values.

## Panel Issues

If the panel restart-loops, check:

```sh
docker compose ps panel
docker compose logs --tail=120 panel
ct doctor
```

Common causes are missing `BETTER_AUTH_SECRET`, invalid admin config, failed SQLite migrations, or a Rust boundary command failure. Retrying `ct admin migrate` is safe.

If the panel domain returns 502, Caddy cannot reach the Bun admin server on `panel:9000`:

```sh
docker compose ps caddy panel
docker compose logs --tail=120 caddy panel
```

## Backup And Restore

`ct backup` snapshots runtime state and secrets, including `admin_data.tgz` for the Better Auth/admin SQLite volume. `ct restore` restores that volume before the panel starts, uses restrictive file permissions, and should not print secrets.

Keep the panel reachable through Caddy or the documented SSH loopback bind. Publishing the panel container port directly bypasses the trusted proxy-header boundary used for login rate limiting.

## Render

```sh
ct render caddyfile
ct render singbox
ct doctor
```

Generated files are owned by the operator/admin layer. Avoid hand-editing rendered Caddy or sing-box output on production VPSes.

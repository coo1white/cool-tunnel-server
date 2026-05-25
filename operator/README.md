# ct-operator

Operator CLI for Cool Tunnel Server, the self-hosted proxy server stack.
It replaces selected shell maintenance scripts (`ct doctor`,
`ct render`, `ct update`) with a single Bun-compiled binary for VPS
install, update, backup, restore, render, and health-check workflows.

The top-level `ct` dispatcher fetches and prefers
`operator/bin/ct-operator-*` for production commands. Shell scripts in
`scripts/` are thin bootstraps or maintainer/development helpers, not a
second production install/update implementation.

## Layout

```
src/runner/         TaskRunner + Command pattern
src/util/sh.ts      Bun.$ wrapper with structured results
src/tasks/          One file per subcommand
src/tasks/admin.ts  Account recovery/bootstrap commands for the admin API
build.ts            bun build --compile wrapper
tests/              bun test
```

## Build

```
pnpm install --frozen-lockfile
cd operator
bun run build                  # default: linux-x64
bun run build:linux-arm64
bun run build all              # full matrix
ls bin/
```

The binary is self-contained — it bundles the Bun runtime — but still
requires the operational deps it shells out to (`docker`, `journalctl`,
`socat`, `nc`). It is **not** a Bun runtime replacement, and the host
still needs `glibc` (Linux targets) or macOS userland.

## Run (dev)

```
bun run src/index.ts doctor
bun run src/index.ts admin bootstrap
bun run src/index.ts --help
```

## Account Admin

`apps/api` owns `/login`, `/setup`, `/api/users`, `/api/audit`,
`/api/proxy-accounts`, `/api/settings`, `/api/status`, and the public
subscription route. SQLite is the default account database
(`CT_ADMIN_DB_PATH`, defaulting to `./data/admin/admin.sqlite` on the
host and `/data/admin/admin.sqlite` inside admin-api).

First owner setup is token-based:

```
ct admin bootstrap
```

The printed token is one-time only and expires. Public signup is
disabled. CLI recovery commands are:

```
printf '%s\n' 'temporary long password' | ct admin create-owner --email EMAIL --username NAME --password-stdin
ct admin users list
ct admin users disable --id ID
ct admin users enable --id ID
printf '%s\n' 'temporary long password' | ct admin users reset-password --id ID --password-stdin
```

## Status

Current source implements the commands listed in `src/index.ts`; keep
`ct`, Makefile targets, docs, and release artifacts aligned with that
dispatcher.

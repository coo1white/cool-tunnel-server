# ct-operator

Operator CLI for Cool Tunnel Server. Replaces selected shell maintenance
scripts (`scripts/doctor.sh`, `scripts/fix.sh`, `scripts/late-night-comeback.sh`)
with a single Bun-compiled binary.

The legacy shell scripts remain in `scripts/` as a fallback; the top-level
`ct` dispatcher prefers `operator/bin/ct-operator-*` when present and falls
back to the `.sh` versions otherwise. No flag day.

## Layout

```
src/runner/         TaskRunner + Command pattern
src/util/sh.ts      Bun.$ wrapper with structured results
src/diag/           Incident-context capture + AI bridge formatter
src/tasks/          One file per subcommand
build.ts            bun build --compile wrapper
tests/              bun test
```

## Build

```
bun install
bun run build                  # default: linux-x64
bun run build:linux-arm64
bun run build all              # full matrix
ls bin/
```

The binary is self-contained — it bundles the Bun runtime — but still
requires the operational deps it shells out to (`docker`, `journalctl`,
`redis-cli`, `socat`, `nc`). It is **not** a Bun runtime replacement,
and the host still needs `glibc` (Linux targets) or macOS userland.

## Run (dev)

```
bun run src/index.ts doctor
bun run src/index.ts --help
```

## Self-update trust model

Releases publish `SHA256SUMS` + `SHA256SUMS.sig`. The binary verifies the
signature against an ed25519 pubkey baked in at build time via the
`CT_OPERATOR_PUBKEY` env var. Without a pubkey, `self-update` refuses all
updates. See `docs/operator.md` for keygen + CI wiring.

## Status

Phase 1: scaffolding only. Phases 2–6 fill in diagnostics, task ports,
self-update, ct/Makefile wiring, and release artifacts.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Contributing

This document codifies the conventions the codebase already
follows, so a new contributor (or a future maintainer revisiting
cold) can extend the project without reverse-engineering them.

The contract this guide serves: [`LTSC.md`](./LTSC.md) — the
project's published commitments and audit rhythm. Every pattern
below is a way to keep that contract honest at code-edit time
rather than at audit time.

---

## Repository layout

A Bun + TypeScript monorepo with one small Rust crate:

| Path | What |
| --- | --- |
| `apps/api` | Bun + Hono admin API: Better Auth, RBAC, SQLite store, subscription endpoint, the render/restart action boundary, and the `docker-proxy` socket forwarder |
| `apps/web` | Next.js admin dashboard (server components + server actions) |
| `packages/shared` | Zod schemas + types — the single source of truth for the client↔server contract — plus the RBAC role matrix |
| `packages/db` | SQLite store and idempotent migrations |
| `packages/security` | password hashing, token/HMAC helpers, secret redaction |
| `packages/config` | environment parsing + validation |
| `operator` | the `ct` CLI (install, update, doctor, backup, restore, render) |
| `singbox-core` | TypeScript supervisor + renderer for the sing-box runtime |
| `core/ct-protocol` | Rust crate: the canonical wire types clients fetch and build against |

See [`STRUCTURE.md`](./STRUCTURE.md) for the full tree and
[`docs/architecture.md`](./docs/architecture.md) for the design rationale.

---

## Local gates

Run before pushing anything that touches the release path:

```sh
pnpm install --frozen-lockfile
bun run typecheck      # every workspace
bun run test           # the full Bun test suite
make ci                # the full gate (typecheck + tests + lint + manifest drift)
```

For a Rust-only change in `core/ct-protocol`:

```sh
cd core && cargo fmt --all && cargo test --workspace --locked && cargo clippy --workspace
```

CI mirrors these (`.github/workflows/ci.yml`) plus a secret scan and a
stale-reference gate (`.github/workflows/audit.yml`). Wait for green before
merging.

---

## Patterns that hold the contract

### The API is schema-first
`packages/shared` exports Zod schemas (`*ResponseSchema`) that are the **single
source of truth** for every admin-API response. The API validates outgoing
payloads against them (`ok(...)` in `apps/api/src/app.ts`) and the web client
parses responses with the same schemas, so drift on either side fails loudly
instead of silently corrupting data. Change the schema first; both sides follow.

### Validation surfaces errors, never 500s
Request bodies go through explicit allow-lists (`parseProxyInput`,
`parseSettingsInput`, `parseRole`) and bad input returns a typed 4xx, not a 500.
Web server actions surface validation failures inline via `ActionState` rather
than throwing.

### Authorization is enforced server-side and re-checked in the store
Route guards (`requirePermission`) gate the HTTP layer; the store layer
re-checks (`canManageTarget`, last-owner preservation) so a wrong route guard
can't escalate. The role matrix lives in `packages/shared`. The client `has()`
helper only gates UI visibility — it is never the enforcement boundary.

### Logs and audit entries must not carry per-user data
Service stderr and the audit log pass through `redactSensitive` /
`maskSensitive` (`packages/security`). The published posture promises no
per-user analytics surface: usernames, emails, IPs, UUIDs, subscription tokens,
and secrets must never reach a log line or audit detail in the clear. If an
event needs that data to be useful, the abstraction is wrong — drop the field.

### Keep the Docker socket out of the app process
The Docker socket is held only by the allowlist-only `docker-proxy`
(`apps/api/src/docker-proxy.ts`); admin-api reaches container health + restart
over HTTP, never the raw socket. Secrets at rest (`.env`, the SQLite DB + its
WAL/SHM sidecars) are mode `0600`. See [`SECURITY.md`](./SECURITY.md).

### `core/ct-protocol` is append-only within a major
The `*V1` wire types (`WireRequestV1`, `SubscriptionManifestV1`,
`ComponentManifestV1`) are append-only; a breaking change ships a `V2`
side-by-side. The crate is sync, dependency-light, and `cargo test`-covered —
external clients fetch and build it, so its public API is a contract. Pin every
version spot in lockstep with `make set-version`.

---

## Commit + PR flow

- Branch off `main`. Naming: `feat/...`, `fix/...`, `chore/...`, `docs/...`.
- Run the local gates above before pushing when the change touches the release path.
- Commit messages: type-scoped subject (`feat(api): …`, `fix(operator): …`),
  body explaining *why* the change exists, not what it does (the diff shows what).
- Wait for CI green before merging. The single exception is `--prerelease`
  GitHub releases that ship operator-validated separately (see [`RELEASE.md`](./RELEASE.md)).

---

## What this document is NOT

- A style guide. `cargo fmt`, the TypeScript compiler, and the workspace test
  runners are the style gates; they run in CI.
- A complete reference. The contract is [`LTSC.md`](./LTSC.md), the audit cycles
  are [`AUDIT.md`](./AUDIT.md), and the release ritual is [`RELEASE.md`](./RELEASE.md).
  This file documents the *patterns* that hold those together at the code-edit layer.

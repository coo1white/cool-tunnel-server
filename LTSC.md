# LTSC — Long-Term Servicing Channel commitments

> The repo operates on Long-Term Servicing Channel discipline.
> This file is the **contract** an operator can rely on across
> releases — and the **boundaries** of what we deliberately do
> NOT promise.

## What LTSC means here

A pinned, reproducible, minor-version-stable stack:

1. Every external component is **pinned by exact version** in
   `manifests/*.upstream.json`. Bumps are deliberate, recorded in
   `CHANGELOG.md`, and propagate to Dockerfiles via
   `make set-version`.
2. Every release builds from a tagged commit with no
   environment dependencies beyond Docker + a populated `.env`.
3. Schema and code travel together. Compile-time SQL safety
   (`sqlx::query!()` + `core/.sqlx/`) makes a migration that
   doesn't reflect into Rust types fail at `cargo check`, not
   in production.
4. Rotation policy for every codified check is published in
   `AUDIT.md` § rotation.

## What we promise — the contract

| Surface | Contract | Validated by |
| --- | --- | --- |
| `naive+https://...` wire format | NaiveProxy HTTP/2 CONNECT, TLS 1.3 only, `cookie.*` cert from configured ACME directory | sing-box `naive` inbound; `cycle 40` audit job |
| Subscription manifest | `SubscriptionManifestV1` JSON, signature in body's `signature` field, no project-identifying HTTP headers | `ct-protocol::subscription`; `cycle 40` audit |
| Component reload | `≤100 ms` from operator save → client connection drops, via Redis pub/sub + Coalescer | `core/ct-server-core/src/util/debounce.rs` (1M+100k stress tests); `scripts/stress/c_revocation_latency.sh` runtime gate |
| Cert renewal | Caddy renews; sing-box re-reads cert without operator action; ≤60 s upper bound | cert-mtime in render-change SHA-256 hash; `cycle 35` manifest-drift |
| Schema↔code | A migration that retypes a column without `make sqlx-prepare` fails at `cargo check` | `cycle 43` sqlx-offline-check |
| Build reproducibility | Same commit + same `.env` → byte-identical images | pinned base images, locked Cargo.lock + composer.lock + .sqlx/ |
| API stability | `WireRequestV1` / `SubscriptionManifestV1` / `ComponentManifestV1` are append-only within a major | type tags `V1` are load-bearing; breaking → `V2` side-by-side |

## What we explicitly do NOT promise

| Surface | Why we don't | Where the operator deals with it |
| --- | --- | --- |
| Throughput / capacity | Single-VPS deploy; capacity = whatever the VPS can do | operator measures with `scripts/stress/b_throughput.sh` (planned) |
| Multi-region failover | Out of scope; one server per `domain` | DNS-level failover is the operator's call |
| Client UI / UX of `cool-tunnel` (macOS) | Lives in a separate repo with its own LTSC commitments | `docs/cross-platform-clients.md` |
| Analytics / telemetry | Deliberately not collected (anti-tracking posture) | `core/ct-server-core/src/metrics.rs` honest-no-op (v0.0.7) |
| Per-user destination logs | Refusing to collect ≠ failing to deliver | sing-box log level `warn` (v0.0.9) |

## Audit rhythm

Each minor version (v0.0.X) runs a focused 50-cycle LTSC audit
on one **axis**:

| Version | Axis | Codified into CI | Cycles |
| --- | --- | --- | --- |
| v0.0.6 | Initial structural review | one-shot | 1–5 |
| v0.0.7 | Deep code review | cargo-audit, cargo-deny, composer-audit, secret-scan, manifest-drift, dependency-review, stale-docs | 31–37 |
| v0.0.8 | UI/UX layout | php-style, blade-asset-links | 38–39 |
| v0.0.9 | Anti-network-tracking | anti-tracking-config | 40 |
| v0.0.10 | Code-robustness design | php-psr4, phpstan | 41–42 |
| v0.0.11 | Compile-time SQL safety | sqlx-offline-check + sing-box config validate | 43 + ci.yml `template:` job |
| v0.0.12 | Poka-yoke + release-gate | TBD: directory-mount templates, force-rerender, smoke-up | 44–48 |

The pattern: cycles 1–30 are hand-audit (real findings, real
fixes); cycles 31–50 are codified into `audit.yml`. Hand-audit
discovers what's worth catching; CI catches it forever. New
discoveries in future hand-passes append to the codified set.

## Boundaries

Three things the codebase is NOT trying to be:

- **Not a censorship-resistant network.** It's a single point of
  visibility (the operator's VPS, the operator's domain, the
  operator's ISP, the operator's hosting provider's compliance
  process). Anti-tracking targets passive scanners, not state-
  level adversaries with subpoena power.
- **Not a multi-tenant SaaS.** The control plane assumes one
  operator with full root. Sharing the panel across orgs would
  need a tenancy model the schema doesn't have.
- **Not a CDN.** Caddy here does ACME only, not HTTP serving.
  sing-box does proxy only, not TLS for arbitrary backends.
  Wedging this stack in front of a website is a misuse.

## The contract is deliberately narrow

Narrow contracts are the ones operators can actually trust over
years. Broad promises rot under environmental drift. This
LTSC.md is what survives a 2030 read of a 2026 deploy.

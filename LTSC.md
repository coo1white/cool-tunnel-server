# LTSC — Long-Term Servicing Channel commitments

> The repo operates on Long-Term Servicing Channel discipline.
> This file is the **contract** an operator can rely on across
> releases — and the **boundaries** of what we deliberately do
> NOT promise.
>
> **Current baseline (2026-05-30):** server `v0.6.2`,
> macOS client `v2.0.26` (separate repo —
> see [`docs/cross-platform-clients.md`](docs/cross-platform-clients.md)).

## What LTSC means here

A pinned, reproducible, minor-version-stable stack:

1. Every external component is **pinned by exact version** in
   `manifests/*.upstream.json`. Bumps are deliberate, recorded in
   `CHANGELOG.md`, and propagate to Dockerfiles via
   `make set-version`.
2. Every release builds from a tagged commit with no
   environment dependencies beyond Docker + a populated `.env`.
3. Schema and code travel together. SQLite migrations in
   `packages/db` are idempotent, tested, and surfaced by
   `ct admin migrate`, `ct update`, and `ct doctor` before the
   control plane can pretend it is healthy.
4. Rotation policy for every codified check is published in
   `AUDIT.md` § rotation.

## What we promise — the contract

| Surface | Contract | Validated by |
| --- | --- | --- |
| Admin auth | Better Auth owns login/session, public signup is disabled, and credentials are submitted by server-side POST only | `apps/api/tests/admin.test.ts`; Next middleware build |
| First owner bootstrap | One-time token, root-only material file, query-string scrub, no default credentials | API tests; operator admin tests |
| Subscription URL | One signed URL imports the VLESS UUID, Reality public key, dest_host, short ID, and client defaults; admin UI masks it by default | API proxy-account tests; client manifest parser |
| Subscription manifest | JSON manifest, signature in body's `signature` field, no project-identifying HTTP headers | API subscription tests; `cycle 40` audit |
| Component reload | Admin API render action writes `/data/config/singbox.json`; singbox-core supervisor picks up changed config | API action tests; `singbox-core/tests/supervise.test.ts`; `ct render` |
| Cert renewal | Caddy renews the panel-domain certificate; HTTP redirects strip query strings | `caddy/Caddyfile.tpl`; operator deployment tests |
| Schema↔code | SQLite migrations are idempotent and carry v0.5.1 legacy staging tables into SQLite without dropping admin/account/settings data | `packages/db/tests/migration.test.ts`; `ct doctor` migration check |
| Build reproducibility | Same commit + same `.env` → pinned release images and operator binaries | pinned base images, locked Cargo.lock + pnpm-lock.yaml, image BOMs |
| API stability | `WireRequestV1` / `SubscriptionManifestV1` / `ComponentManifestV1` are append-only within a major | type tags `V1` are load-bearing; breaking → `V2` side-by-side |
| Docker socket isolation | Only the allowlist-only `docker-proxy` holds the socket (read-only); admin-api can't reach the host daemon | `apps/api/tests/docker.test.ts`; `docker-compose.yml` |

## What we explicitly do NOT promise

| Surface | Why we don't | Where the operator deals with it |
| --- | --- | --- |
| Throughput / capacity | Single-VPS deploy; capacity = whatever the VPS can do | operator measures with `scripts/stress/b_throughput.sh` (planned) |
| Multi-region failover | Out of scope; one server per `domain` | DNS-level failover is the operator's call |
| Client UI / UX of `cool-tunnel` (macOS) | Lives in a separate repo with its own LTSC commitments | `docs/cross-platform-clients.md` |
| Analytics / telemetry | Deliberately not collected (anti-tracking posture) | no telemetry SDK; Better Auth telemetry disabled in `apps/api/src/auth.ts` |
| Per-user destination logs | Refusing to collect ≠ failing to deliver | sing-box log level `warn` (v0.0.9) |

## Audit rhythm

Pre-v0.0.12, each minor version ran a focused 50-cycle LTSC
audit on one **axis**, codifying cycles 31–43 between six
versions:

| Version | Axis | Codified into CI | LTSC cycles |
| --- | --- | --- | --- |
| v0.0.6 | Initial structural review | one-shot | 1–5 |
| v0.0.7 | Deep code review | cargo-audit, cargo-deny, composer-audit, secret-scan, manifest-drift, dependency-review, stale-docs | 31–37 |
| v0.0.8 | UI / UX layout | legacy PHP style and asset-link checks | 38–39 |
| v0.0.9 | Anti-network-tracking | anti-tracking-config | 40 |
| v0.0.10 | Code-robustness design | php-psr4, phpstan; `unwrap_used = deny` clippy floor (compile-time, not an audit cycle) | 41–42 |
| v0.0.11 | Compile-time SQL safety | sqlx-offline-check; ci.yml `templates:` job | 43 |

**Post-v0.0.12 the model shifted from per-version hand-passes
to continuous automation.** `audit.yml` runs cycles 31–43
weekly (cron `17 8 * * 1`) and on every PR that touches
relevant paths. No new LTSC cycle indices have been
codified — 44–50 remain forward placeholders.

Three "Cycle N" sub-projects extended the audit surface with
**independent** numbering (NOT the LTSC 31–50 series):

| Sub-project | Versions | What it codified |
| --- | --- | --- |
| Cycle 1 — `VerifySpecV1` | v0.0.34–v0.0.38 | Manifest verify spec; retired verifier commands ran inside the old panel container; `expect_no_version_line` opt-out for probes whose target had no parseable version line |
| Cycle 2 — drift detection | v0.0.39–v0.0.43 | Real drift detection across non-Rust components of that era: panel, Redis, MariaDB, sing-box, and HAProxy |
| Cycle 3 — panel-hostname SoT | v0.0.55–v0.0.56 | Single source of truth for the panel hostname; legacy PHP to Rust parity asserted by `scripts/verify_sot.sh` against fixture envs |

Hand-passes still occur — notably the **30-round audit-loop
hardening** that accompanied the v0.0.58 FrankenPHP runtime
swap — without claiming a new LTSC cycle index. v0.0.62
introduced a release-time gate
(`.github/workflows/tag-version.yml`) that asserts at
tag-push time that the bare `v*` version matched the PHP panel
version source. v0.5.2 moves that release source of truth to the
root `package.json`, package manifests, Rust workspace version, and
upstream manifests. See `AUDIT.md § Release-time gates`.

The pattern: cycles 1–30 are hand-audit (real findings, real
fixes); cycles 31–50 are codified into `audit.yml`; "Cycle N"
sub-projects and release-time gates extend the surface
separately. CI catches forever what hand-audit discovers.

## 2026 milestones

Cross-cutting policies that constrain what the codebase will
tolerate, codified during the 2026 release arc.

### Immutable Ballast

A comment longer than three lines in this codebase is
**load-bearing**, not removable cruft. The verbose `// Why:`
blocks in `core/deny.toml::ignore[]`, the retired deferred-fail-fast
explanation on the old PHP panel-domain resolver, the provenance markers on every related
declaration (`Cycle 2 / v0.0.39`, `R1-1 / R1-2`,
`low-mem-server pass`) — these encode incident provenance
and prevent re-debate at the next audit cycle.

**Rule.** Before deleting a comment longer than three lines,
trace its referenced version (`v0.0.X`) through
`CHANGELOG.md` and confirm the incident is no longer
relevant. If you can't confirm, the comment stays.

The principle was implicit through the v0.0.6–v0.0.61 arc;
named and codified during the v0.0.62 lean-and-clean audit
pass. Future de-watering operates against this rule
explicitly.

### Zero `unwrap()` floor

The Rust workspace forbids panicking patterns at compile
time via `core/Cargo.toml`'s clippy lints:

| Lint | Level | Catches |
| --- | --- | --- |
| `unwrap_used` | deny | Any `.unwrap()` (use `?` or explicit `match`) |
| `expect_used` | deny | Any `.expect("…")` |
| `panic` | deny | Direct `panic!()` invocations |
| `todo` | deny | `todo!()` placeholders |
| `unimplemented` | deny | `unimplemented!()` placeholders |

Every fallible operation has a typed error path. A
production-failure-as-panic regression cannot land — the
compiler refuses it. First codified in v0.0.10's
code-robustness pass; remains the workspace floor as of
v0.0.62.

`unsafe_code = "deny"` (`[workspace.lints.rust]`) is the
adjacent floor for memory safety, same enforcement model.

### Internal-health observability vs user analytics

The codebase distinguishes two categories of metric. They are
**not interchangeable**; conflating them is a posture-breaking
regression even if the implementation looks "internal."

| Category | Posture | Surface |
| --- | --- | --- |
| **Per-user analytics** (e.g. who connected, when, to what destination, with what subscription token) | **Deliberately not collected.** The cover-site invariant + audit cycle 40 codify the wire-side promise; this carve-out codifies the data-side promise. | None. Operator who wants per-user counters under `coolwhite LLC` stewardship would have to fork — and AGPL § 13 then requires them to publish the modification. |
| **Operator-internal-health** (e.g. service state, restart counts, migration status, render state) | **Operator-visible, internal-net only, never per-user data.** Admin API status and `ct doctor` expose health/remediation data without user destinations or credential material. | `apps/api` `/api/status`, `/api/doctor/run`; `ct doctor`. |

**Rule: a counter that identifies a specific user — even
indirectly via labels (`{username="alice"}`, `{account_id="42"}`,
`{target_host="..."}`, `{request_id="..."}`) — is not a metric.
It's an audit-log entry — and the audit log redacts secret-ish
fields (`packages/security`), never an operator-visible health
surface.**

The two categories are structurally separable:
- Per-user analytics has zero collection surface anywhere in the
  codebase — there is no per-user counter to add a label to.
- Internal-health is exposed only through `/api/status` and
  `ct doctor`, whose payloads are hand-built from process/service
  state, so a per-user field cannot slip in without an explicit,
  code-review-visible edit.

The audit cycles 40 (anti-tracking config) + 33 (composer audit)
already cover the wire-format and dependency-side anti-tracking
floor. The metrics-side carve-out above extends that to the
operator-observable surface.

## Boundaries

Three things the codebase is NOT trying to be:

- **Not a censorship-resistant network.** It's a single point of
  visibility (the operator's VPS, the operator's domain, the
  operator's ISP, the operator's hosting provider's compliance
  process). Anti-tracking targets passive scanners, not state-
  level adversaries with subpoena power.
- **Not a multi-tenant SaaS.** The control plane assumes one
  operator with full root. Sharing the admin UI across orgs would
  need a tenancy model the schema doesn't have.
- **Not a CDN.** Caddy here does ACME only, not HTTP serving.
  sing-box does proxy only, not TLS for arbitrary backends.
  Wedging this stack in front of a website is a misuse.

## The contract is deliberately narrow

Narrow contracts are the ones operators can actually trust over
years. Broad promises rot under environmental drift. This
LTSC.md is what survives a 2030 read of a 2026 deploy.

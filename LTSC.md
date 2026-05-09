# LTSC — Long-Term Servicing Channel commitments

> The repo operates on Long-Term Servicing Channel discipline.
> This file is the **contract** an operator can rely on across
> releases — and the **boundaries** of what we deliberately do
> NOT promise.
>
> **Current baseline (2026-05-09):** server `v0.0.69`,
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
| Daemon network boundary | Every Unix-socket request is bounded by max frame bytes, read timeout, and typed error mapping; malformed peers reset the connection, not the process | `core/ct-server-core/src/frame.rs`, `err.rs`, `daemon.rs`; Rust tests |
| Daemon state truth | One connection follows one FSM branch; invalid predecessor observations hard-reset the connection | `core/ct-server-core/src/daemon_fsm.rs`; `docs/daemon-fsm.md` |

## What we explicitly do NOT promise

| Surface | Why we don't | Where the operator deals with it |
| --- | --- | --- |
| Throughput / capacity | Single-VPS deploy; capacity = whatever the VPS can do | operator measures with `scripts/stress/b_throughput.sh` (planned) |
| Multi-region failover | Out of scope; one server per `domain` | DNS-level failover is the operator's call |
| Client UI / UX of `cool-tunnel` (macOS) | Lives in a separate repo with its own LTSC commitments | `docs/cross-platform-clients.md` |
| Analytics / telemetry | Deliberately not collected (anti-tracking posture) | `core/ct-server-core/src/metrics.rs` honest-no-op (v0.0.7) |
| Per-user destination logs | Refusing to collect ≠ failing to deliver | sing-box log level `warn` (v0.0.9) |

## Audit rhythm

Pre-v0.0.12, each minor version ran a focused 50-cycle LTSC
audit on one **axis**, codifying cycles 31–43 between six
versions:

| Version | Axis | Codified into CI | LTSC cycles |
| --- | --- | --- | --- |
| v0.0.6 | Initial structural review | one-shot | 1–5 |
| v0.0.7 | Deep code review | cargo-audit, cargo-deny, composer-audit, secret-scan, manifest-drift, dependency-review, stale-docs | 31–37 |
| v0.0.8 | UI / UX layout | php-style, blade-asset-links | 38–39 |
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
| Cycle 1 — `VerifySpecV1` | v0.0.34–v0.0.38 | Manifest verify spec; verify commands run inside the panel container; `expect_no_version_line` opt-out for probes whose target has no parseable version line |
| Cycle 2 — drift detection | v0.0.39–v0.0.43 | Real drift detection across every non-Rust component: panel (`ct:version`), redis (`INFO Server`), mariadb (`SELECT VERSION()`), sing-box (authenticated clash-API `/version`), haproxy (UNIX stats socket) |
| Cycle 3 — panel-hostname SoT | v0.0.55–v0.0.56 | Single source of truth for the panel hostname; PHP ↔ Rust parity asserted by `scripts/verify_sot.sh` against fixture envs |

Hand-passes still occur — notably the **30-round audit-loop
hardening** that accompanied the v0.0.58 FrankenPHP runtime
swap — without claiming a new LTSC cycle index. v0.0.62
introduced a release-time gate
(`.github/workflows/tag-version.yml`) that asserts at
tag-push time that the bare `v*` version equals
`panel/config/cool-tunnel.php::version`, refusing tags whose
source disagrees. See `AUDIT.md § Release-time gates`.

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
blocks in `core/deny.toml::ignore[]` (RUSTSEC-2023-0071 is
inapplicable because MariaDB 11 defaults to
`mysql_native_password`), the deferred-fail-fast explanation
on `panel/config/cool-tunnel.php::$resolvePanelDomain`
(Laravel bootstrap loads config unconditionally for phpunit
and larastan), the provenance markers on every related
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

### Zero blocking-syscall floor

The async path of `ct-server-core` is structurally guaranteed
not to leak blocking syscalls into the tokio runtime. Sweep
across `core/ct-server-core/src/` (v0.0.65 audit, codified
in this milestone) confirms:

| Probe | Source result |
| --- | --- |
| `std::fs::*` | **0 hits** — all file I/O routes through `tokio::fs` |
| `std::process::Command` | **0 hits** — no sync subprocess in async path |
| `std::thread::sleep` | **0 hits** — only `tokio::time::sleep` |
| `std::sync::Mutex` | **Bounded** — used only where the lock guard's `!Send` property is the *intended* compile-time guarantee against `.await`-while-held (e.g. the Coalescer in `redis_bridge`). Async-aware `tokio::sync::Mutex` is reserved for sites that genuinely cross await points. |
| `block_on` | **1 hit** — `main.rs:339`, the top-of-runtime entry. Any nested usage is structurally wrong and would be caught in code review. |

**Why the floor matters.** A blocking syscall on a tokio
worker thread parks the thread, starves every other task
sharing it, and inflates p99 latency for everything in the
runtime. The sweep is the audit-time check; the floor is the
norm we recheck every release. First codified in v0.0.65's
async hardening; the daemon's per-request timeout (T-2) is
the runtime tripwire, the semaphore (T-1) is the
backpressure, and the Coalescer's `std::sync::Mutex`
migration (T-4) makes the cross-`.await` violation a
**compile error** rather than a runtime regression.

### Zero leak (bounded-spawn) posture

Every `tokio::spawn` site in production code is bounded by a
known cardinality. v0.0.65 audit enumerated three
production sites with their bound:

| Site | Cardinality | Bound |
| --- | --- | --- |
| `daemon.rs::serve` per-client handler | 1 per accepted Unix-socket connection | `MAX_CONCURRENT_HANDLERS = 16` permits via `tokio::sync::Semaphore`; the 17th accept blocks. |
| `redis_bridge.rs::spawn` subscriber | 1 per process lifetime | Singular |
| `redis_bridge.rs::schedule_flush` trailing flush | 1 per Coalescer leading-edge admit | `FlushTracker.flush_handle.is_finished()` check makes it single-flight; defense-in-depth against a future Coalescer state-machine regression |

**Why the floor matters.** Unbounded spawn under hostile or
buggy load is a slow OOM in disguise — the runtime accepts
work faster than it completes, the task heap grows, and
eventually the process is killed. Bounded spawn turns the
failure mode into honest backpressure: clients see slower
accept, the daemon stays alive. Codified at v0.0.65 (T-1 +
T-3); future spawn sites must declare their cardinality
bound at the call site or in the surrounding module
docstring.

### Internal-health observability vs user analytics

The codebase distinguishes two categories of metric. They are
**not interchangeable**; conflating them is a posture-breaking
regression even if the implementation looks "internal."

| Category | Posture | Surface |
| --- | --- | --- |
| **Per-user analytics** (e.g. who connected, when, to what destination, with what subscription token) | **Deliberately not collected.** `core/ct-server-core/src/metrics.rs` remains an honest no-op (per v0.0.7 anti-tracking pass). The cover-site invariant + audit cycle 40 codify the wire-side promise; this carve-out codifies the data-side promise. | None. Operator who wants per-user counters under `coolwhite LLC` stewardship would have to fork — and AGPL § 13 then requires them to publish the modification. |
| **Operator-internal-health** (e.g. semaphore saturation, DB-pool utilization, restart counts, Coalescer fire rate) | **Operator-visible, internal-net only, never per-user data.** Optional `/metrics` endpoint exposes Prometheus text-format counters bound to a docker-internal address — never a public port. Off by default; operator opts in via `--metrics-bind` / `CT_METRICS_BIND`. | `ct-server-core --metrics-bind 127.0.0.1:9292`; reachable from inside the panel container via `docker compose exec panel curl`. Codified at v0.0.67 (R-1). |

**Rule: a counter that identifies a specific user — even
indirectly via labels (`{username="alice"}`, `{account_id="42"}`,
`{target_host="..."}`, `{request_id="..."}`) — is not a metric.
It's an audit-log entry, and it must go to
`tracing::debug!` per `CONTRIBUTING.md § Logging discipline`,
not to the `/metrics` endpoint.**

The two categories are structurally separable:
- Per-user analytics has zero collection surface anywhere in the
  binary; the existing `metrics.rs` no-op is the structural
  enforcement.
- Internal-health metrics live in `internal_metrics.rs` (added
  v0.0.67); the registry's counter set is hand-enumerated at
  module level so a future contribution adding a per-user label
  is impossible to slip in without an explicit module edit
  visible at code review.

The audit cycles 40 (anti-tracking config) + 33 (composer audit)
already cover the wire-format and dependency-side anti-tracking
floor. The metrics-side carve-out above extends that to the
operator-observable surface.

### Bounded frame discipline

Every network-boundary reader in `ct-server-core` must declare a
policy before it can consume bytes:

| Policy field | Bound |
| --- | --- |
| `policy_name()` | Stable semantic name for logs and documentation |
| `max_frame_len()` | Maximum complete frame bytes one peer can force into memory |
| `read_timeout()` | Maximum time one peer can retain a handler permit while framing |
| `max_read_chunk_len()` | Maximum bytes requested from Tokio in one read |

The daemon JSON-line protocol and internal HTTP metrics reader use
`BytesMut` buffers that are retained per connection and split when a
complete frame lands. This avoids per-turn `Vec` churn for honest
small requests and bounds memory retained for hostile partial frames.

`FrameTooLarge`, `ReadTimeout`, incomplete frames, invalid UTF-8, and
malformed JSON are connection-scoped recovery paths. They close or
hard-reset the offending connection and leave the daemon process alive.

Codified at v0.0.69 in `core/ct-server-core/src/frame.rs` and wired
through `daemon.rs` plus `internal_metrics.rs`.

### No-forking daemon FSM

Each accepted daemon Unix-socket connection is represented by a
deterministic finite state machine:

```text
Accepted -> ReadingFrame -> DecodingUtf8 -> DecodingJson
         -> Dispatching -> Responding -> ProbingConstancy
         -> ReadingFrame
```

Clean EOF moves to `Disconnected`. Protocol deviation, invalid UTF-8,
malformed JSON, oversized frames, read timeout, incomplete frames, or
response-write failure moves to `HardReset`.

The implementation uses `AtomicU8::compare_exchange`. A transition is
valid only when the observed state exactly matches the required
predecessor. Any mismatch records a hard reset and stores `HardReset`
instead of creating a second branch of truth.

After each successful turn the daemon enters `ProbingConstancy`: it
measures turn latency and frame-pressure basis points, keeps hard caps
unchanged, and narrows the next read chunk when pressure crosses the
50% or 80% thresholds. That initiative logic is Heng applied to the
control plane: active pressure sensing without speculative branching.

Codified at v0.0.69 in `core/ct-server-core/src/daemon_fsm.rs`; text
diagram and retrieval anchors live in `docs/daemon-fsm.md`.

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

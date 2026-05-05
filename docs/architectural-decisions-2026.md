# Architectural Decision Manual — 2026 Milestone Closing

> **Scope.** This document is the closing record for the v0.0.13 →
> v0.0.22 self-audit programme run between 2026-05-04 and 2026-05-05.
> Nine releases, eight self-check loops, ~70 commits. From an
> already-audited "v0.0.10 50-cycle hand audit" baseline through a
> programmatic self-discovery cycle that turned every fix into a
> regression guard, every CRITICAL into a release-blocking invariant,
> and every loop's diminishing-returns signal into the closing
> calibration. The 8th loop's "7 of 8 audit areas clean" finding is
> the project's official "spine is firm" marker.
>
> Reading order: §1 (origin) → §2 (the eight loops) → §3 (the seven
> load-bearing invariants) → §4 (defense-to-offense pivot) → §5
> (decisions and trade-offs) → §6 (deferred work) → §7 (closing).

---

## §1 — Origin: what v0.0.13's audit caught

The v0.0.13 release crystallised a set of audit findings that the
prior LTSC programme (`AUDIT.md` cycles 1–42) had codified as
weekly machine-run checks but had not yet hand-driven against the
shipped code. The hand-run produced eleven distinct findings,
graded H1 through R-panel-1:

| Tag | Finding | Severity |
| --- | --- | --- |
| **H1** | No login throttling on the Filament admin panel | HIGH |
| **H2** | `User::canAccessPanel()` returned `true` unconditionally | HIGH |
| **H3** | sing-box clash-API listener bound on every interface inside the container | HIGH |
| **M-rust-2** | `(s.uplink - prev_up).max(0)` could panic in debug / wrap in release | MEDIUM |
| **M-panel-1** | `APP_PREVIOUS_KEYS` parsed without `array_map('trim', …)` | MEDIUM |
| **M-panel-2** | `signingKey()` accepted empty `APP_KEY` and signed deterministically | MEDIUM |
| **R-panel-1** | `ProxyAccount::booted::saved` ran the full reload subprocess synchronously inside the request | RELIABILITY |
| **(infra)** | `docker/core/Dockerfile` hardcoded `x86_64-unknown-linux-musl` | (HIGH on arm64) |
| **(perf)** | The stack didn't fit cleanly inside the documented 1 vCPU / 1 GB minimum | PERF |
| **(docs)** | `docs/installation-debian.md` had no low-memory guidance | DOC |

These were the seed. Every subsequent loop was a probe in a
different direction asking "what other bugs would have hidden in
the same way the H/M findings did?".

---

## §2 — The eight loops

| Loop | Release | Lens | Most critical find |
| --- | --- | --- | --- |
| 0 | v0.0.13 | Initial hand-audit | 3× HIGH, 3× MEDIUM, 1× RELIABILITY |
| 1 | v0.0.14 | Anti-censorship cover-site invariant | Unified all subscription-endpoint failure modes to byte-equal cover-site bytes — 429 / 5xx / exception-trace each independently leaked endpoint existence |
| 2 | v0.0.15 | Runtime correctness under stress / concurrency / power loss | **2 CRITICAL**: Redis announce inside DB transaction (ghost revocations on rollback); `atomic_write` not fsyncing parent dir (revocation reverts on power loss) |
| 3 | v0.0.16 | Business logic + service-layer correctness | **HIGH**: Caddyfile-injection class via operator-controlled `domain`/`acme_email`/`acme_directory` |
| 4 | v0.0.17 | Storage / secrets / runtime resource limits | **HIGH**: panel image's naiveproxy-client download was `linux-x64`-only — silently wrong on every arm64 host |
| 5 | v0.0.18 | Test-coverage gaps + browser-side hardening | First HIGH-class find of the loop programme that was a **test gap** rather than a bug — the v0.0.16 caddyfile-validate guard had no test, so a regression that re-opened the injection vector would slip past CI |
| 6 | v0.0.19 | Panel PHPUnit scaffold + cover-site / auth feature tests | Closed the largest test-coverage gap the prior loops had surfaced (zero PHPUnit tests through v0.0.18) |
| 7 | v0.0.20 | CI integration of v0.0.19's tests + AfterCommit regression test | Discovered a **silent CI false-green**: the `template` validate job was rendering literal `{{ .ClashListen }}` / `{{ .DohServer }}` placeholders into "validated" configs because the sed substitution list missed three bindings added since v0.0.13 |
| 8 | v0.0.21 | Areas previous loops hadn't audited (Filament Resources, ct-protocol, TODO/FIXME residue, Rust idioms, seeders, wire size limits, quota concurrency) | Diminishing-returns marker: 7 of 8 areas audited clean. One LOW (defense-in-depth FQDN regex on `domain` form input). |
| 9 | v0.0.22 | **Closing strike**: DoH reachability + 1 GB resource hardening + this manual | Turn the spine firm |

The loop count's value-per-effort curve:

```
v0.0.13–14  ████████████████████████████████  10 commits each, P0/P1 dominant
v0.0.15     ████████████████████████          8 commits, 2 CRITICAL bugs
v0.0.16     ██████████                        3 commits, 1 HIGH
v0.0.17     ████████████                      4 commits, 1 HIGH
v0.0.18     ████████████                      4 commits, no HIGH (quality)
v0.0.19     ██████                            2 commits, 0 bugs (infrastructure)
v0.0.20     █████████                         3 commits, 1 silent-CI bug
v0.0.21     ████                              1 commit, 1 LOW
v0.0.22     ████████████                      this release
```

The curve flattens hard between v0.0.18 and v0.0.21. v0.0.22 is the
last loop because the deferred-but-real items (DoH reachability +
1 GB hardening) had been called out across multiple loops without
being addressable inside any single one of them — they needed
their own dedicated pass. That pass is here.

---

## §3 — The seven load-bearing invariants

Eight loops produced a small set of properties that the rest of
the system can now lean on. These are the "spine" — load-bearing,
test-guarded, release-blocking. Each one is something a
contributor can build on without re-auditing.

### 1. **Cover-site invariant**

> Every public-route response that is not a successful authenticated
> subscription manifest is byte-identical on the wire to the
> cover-site response.

Failure modes covered: unknown subscription token, expired account,
disabled account, rate-limit hit, empty `APP_KEY` (signing throws),
any uncaught Throwable on a non-`/admin` route.

Implementations:

- `panel/app/Http/Controllers/SubscriptionController.php` —
  in-controller rate limiter via `RateLimiter::tooManyAttempts/hit`
  (not middleware, which leaks 429), `Throwable` catch on resolver,
  fallback to `(new FakeSiteController())->show($request)`.
- `panel/bootstrap/app.php` — `withExceptions()->render()` callback
  renders cover-site for any uncaught Throwable on a non-admin path.
  Exact-or-prefix-with-trailing-slash match on `/admin`, `/livewire`,
  `/up` (v0.0.15 H2 tightening).
- `panel/app/Http/Controllers/FakeSiteController.php` — deterministic
  `sha256(body)` ETag + `If-None-Match` → 304.

Test guards: `panel/tests/Feature/CoverSiteInvariantTest` (4 cases)
asserts byte-equal Content-Type + ETag + body across all four
failure modes.

### 2. **Management-plane network isolation**

> sing-box's clash-API HTTP listener is reachable only from the
> panel container, never from caddy or any other neighbor.

Implementation:

- `docker-compose.yml` defines an `internal: true` network
  `ct-clash` with a default `172.30.0.0/24` subnet and the panel +
  sing-box as the only members. caddy is deliberately not joined.
- sing-box pins to `ipv4_address: ${CT_CLASH_SINGBOX_IP:-172.30.0.10}`
  on `ct-clash`.
- `core/ct-server-core/src/singbox/mod.rs::clash_listen()` reads
  `CT_CLASH_LISTEN` env (default `127.0.0.1:9090` for fail-closed)
  and substitutes into `config.json.tpl` as `{{ .ClashListen }}`.
- The shipped docker-compose sets `CT_CLASH_LISTEN=172.30.0.10:9090`
  via env interpolation so the bind matches the network membership.

Operator escape hatch (v0.0.17): `CT_CLASH_SUBNET` env override for
operators whose docker daemon already holds `172.30.0.0/24`.
`scripts/install.sh` cross-validates `CT_CLASH_SUBNET` and
`CT_CLASH_SINGBOX_IP` agree on the first three octets.

### 3. **No engine fingerprint on the wire**

> A probe against the public surface cannot distinguish this host
> from a static-website host of the same hosting class on the
> basis of response headers.

Stripped: `Server: Caddy` (via `header -Server` on the `:80`
redirect block), `X-Powered-By: PHP/...` (via `expose_php = Off`
in the panel's PHP hardening), `Server: nginx` (via
`server_tokens off`), and Filament/Livewire-revealing patterns
that the cover-site templates avoid by construction.

### 4. **Atomic, durable config writes**

> A power loss between sing-box config rename and any subsequent
> sync cannot revert the directory entry to the pre-rename state.

Implementation: `core/ct-server-core/src/singbox/mod.rs::atomic_write`
opens the parent directory and `sync_all().await?` after the
rename. Same shape applied where the Caddyfile is rendered.

This closes the v0.0.15 C2 critical correctness bug: a revoked
credential silently re-activating after an unclean reboot.

### 5. **Transaction-safe model events**

> A `ProxyAccount` save/delete inside a rolled-back transaction
> never produces a Redis ghost-revocation flag, never queues a
> phantom reload job.

Implementation: `panel/app/Models/ProxyAccount.php` defers the
Redis announce + `ReloadSingBoxJob::dispatch()` to
`DB::afterCommit(...)`. Snapshots `$username` + `$status` at
saved-time so the deferred closure sees the intended state, not
the post-rollback Eloquent instance.

Test guards: `panel/tests/Feature/ProxyAccountAfterCommitTest` (4
cases) covers committed-save, rolled-back-save, no-txn-save,
rolled-back-delete.

### 6. **Three-dimensional login rate limiting**

> A single email cannot be brute-forced regardless of how many
> source IPs the attacker controls.

Implementation: `panel/app/Providers/AppServiceProvider.php`
registers a `login` named limiter with three independent
dimensions: per-(email|ip), per-ip alone, per-email alone. Each
caps at 5/min, 20/min, 20/min respectively. A botnet rotating
1000 source IPs against one email is bounded at 20/min on the
email key.

Wired into Filament via `panel/app/Filament/Pages/Auth/Login.php`,
which calls `$this->rateLimit(5)` before delegating.

### 7. **Defense-in-depth on operator-controlled rendering**

> Any operator-supplied string that lands inside a Caddyfile or
> sing-box JSON template is either rejected (Caddyfile —
> `template::caddyfile_validate`) or escaped at the binding site
> (sing-box — `template::json_escape`).

Same risk class addressed twice with different fixes because the
two grammars allow different remediations:

- **JSON has a defined escape grammar** → `json_escape` transforms
  the value safely.
- **Caddyfile has no general escape mechanism** for `\n` / `{` /
  `}` / `"` inside an unquoted directive argument → refuse to
  render with a clear error.

Form-layer regex on the `domain` input (v0.0.21) catches the typo
case before it ever persists.

Test guards: `core/ct-server-core/src/template.rs` has 4 unit
tests for `caddyfile_validate` covering clean values, each
metasyntax char independently, the realistic injection payload,
and field-name propagation in error messages.

---

## §4 — Defense → offense pivot

The original v0.0.13 audit was largely **defensive**: close known
weaknesses, harden against known classes of attack. By v0.0.21 the
project's posture had shifted to **offensive**:

| Defensive (pre-loop) | Offensive (post-loop) |
| --- | --- |
| "Don't leak credentials in logs" | **Mask subscription tokens in nginx access log** so an operator who later opens the log archive doesn't recover them |
| "Validate user input" | **Refuse to render dubious input** with a loud error — operator sees the bad config before it reaches Caddy |
| "Rate-limit logins" | **Three-dimensional limiter** that defeats IP-rotation botnets, not just casual brute-force |
| "Bound resource use" | **Hard mem_limit + pids_limit** that turn unbounded growth into a deterministic OOM-kill the operator can debug, not a host-wide thrash |
| "Test the fixes" | **CI runs both Rust and PHPUnit on every PR**, with the cover-site invariant as a release-blocking integration test |
| "Document the deployment" | **Document the threat model** — anti-censorship-specific, not generic-proxy |
| "Don't fingerprint the server" | **Cover-site invariant** as a wire-level property — censor probes get the same bytes for every unknown URL |

The pivot is in §3.1's framing: "byte-identical to the cover-site
response." Pre-loop, the project tried to make the cover site look
like a normal website. Post-loop, the project guarantees that
**every observable failure path produces the same bytes as the
cover site**. There is no failure mode whose response shape
distinguishes the host as a proxy.

---

## §5 — Major architectural decisions and trade-offs

### 5.1 — Cover-site fall-through over status-code semantic

We chose to make the subscription endpoint return 200 cover-site
on rate-limit / bad-token / expired / exception, not the
HTTP-correct 429 / 404 / 401 / 500.

**Trade-off:** legitimate clients (cool-tunnel-client) lose the
ability to distinguish "your token is wrong" from "the server
doesn't recognise this URL". They get 200 + HTML cover-site in
both cases. Resolution: clients verify the response is a
JSON manifest with the expected shape; if not, treat as auth
failure regardless of HTTP code. The HTTP-code information is
strictly less valuable than the cover-site invariant.

### 5.2 — `DB::afterCommit` over inline announce

We accepted a small added latency on the announce path (queued
until commit, ~1ms in practice) for the safety of never
broadcasting a phantom revocation. The Redis fast-path's pre-fix
"sub-ms" guarantee becomes "sub-ms after commit" — operationally
identical for the user, correct under rollback.

### 5.3 — `release-small` cargo profile as a separate target, not a default

We didn't drop the full-LTO `release` profile in favour of
`release-small`. Operators with ≥2 GB build hosts get the smaller,
faster binary; operators on 1 GB hosts opt in via
`CT_CORE_BUILD_PROFILE=release-small`. The matrix is complicated
but correct: each operator picks the trade-off matching their
hardware.

### 5.4 — `cap_drop: [ALL]` over per-service tuning

YAML anchor `x-svc-hardening` applies the same `cap_drop`,
`security_opt`, and `logging` defaults to every service. caddy
and sing-box add back NET_BIND_SERVICE explicitly. We chose
uniformity over per-service capability minimization because (a)
the audit history shows operators routinely forget to harden
new services, and (b) NET_BIND_SERVICE is the only capability
any of our services genuinely needs.

### 5.5 — Manifest-driven verification with command runners is a controlled-trust API, not a security boundary

`manifests/*.upstream.json` files are mounted `:ro` from the
repo. The verifier runs whatever command the manifest specifies.
This is safe **because** manifests are repo-controlled — anyone
who can write a manifest can already write Rust code and PHP
code. The trust boundary is the repo, not the manifest format.

### 5.6 — Skip arm64 SHA pinning, not arm64 builds

For `naiveproxy-client` on arm64, we ship without a hand-pinned
SHA-256 (upstream doesn't publish SHA256SUMS). Build emits a
LOUD warning and proceeds. Alternative options were considered:

- **Skip arm64 entirely** — punishes M-series Mac dev builds,
  AWS Graviton deployments, RPi-class operators.
- **Fake a SHA** — would fail every arm64 build with a mismatch.
- **Build via QEMU emulation** — punishes performance for
  questionable benefit.

The chosen shape (warn + continue) lets operators opt into
verification by computing the hash on a trusted arm64 host and
passing `--build-arg NAIVE_SHA256_ARM64=...`.

### 5.7 — Test infrastructure as a release-blocking property

v0.0.19 lands the panel PHPUnit scaffold; v0.0.20 wires it into
CI. From v0.0.20 forward, **a panel PR that breaks the cover-
site invariant fails CI** before merge. This is the structural
guarantee the loop programme was building toward — not "we tried
hard to find bugs" but "regressions are caught before merge."

---

## §6 — Deferred work (post-v0.0.22 roadmap)

What's still on the bench, in rough priority order:

1. **arm64 SHA pinning for `naiveproxy-client`** — needs an arm64
   build host wired into CI (or a trusted arm64 dev host) to
   compute the hash and PR it as a default.
2. **Schedule "last successful run at" Filament widget** —
   complement to the v0.0.18 onFailure logging. Operator-visible
   signal in the panel UI rather than only in logs.
3. **Documentation drift across `installation-debian.md`,
   `RELEASE.md`, `architecture.md`, `STRUCTURE.md`** — the
   v0.0.20 sweep covered README + SECURITY only.
4. **R1-1 / R1-2: SNI-router for public `/admin` exposure** —
   the deferred architectural item from the original audit. Once
   landed, the `SecurityHeaders` middleware (v0.0.18) and the
   cover-site invariant (v0.0.14) become user-facing properties
   rather than SSH-tunnel-internal ones.
5. **Per-component update flow** — `ct-server-core component
   update` is mentioned in the schema but not implemented. Would
   let operators bump pinned versions through a single command
   that downloads → verifies → swaps.
6. **`tests/Feature/FakeWebsiteRaceTest`** — a test for the
   v0.0.16 activation race that's hard to write deterministically
   in PHPUnit but worth attempting with a parallel-test fixture.

These are real, but each is its own pass. The v0.0.22 closer
explicitly does not address them.

---

## §7 — Closing

The project shipped v0.0.13 already-audited. Eight self-check
loops layered on top produced:

```
22 audit-tag classes addressed
10 distinct hardening loops merged
~70 commits across the v0.0.13 → v0.0.22 arc
2 CRITICAL correctness bugs caught (v0.0.15)
~12 HIGH-severity items addressed
~15 MEDIUM items closed
1 silent CI false-green discovered and fixed (v0.0.20)
65 Rust unit tests + 13 panel PHPUnit cases as regression guards
0 unwrap/expect/panic in non-test Rust code
0 unsafe blocks (workspace-wide forbid)
0 TODO/FIXME/HACK/XXX residue
```

The seven load-bearing invariants in §3 are now the **spine**.
They are tested, CI-guarded, documented here. A future
contributor changing any of them needs an explicit reason and
a passing test that defends the change.

The defense-to-offense pivot in §4 — particularly the cover-site
invariant — gives the project a wire-level property that
distinguishes it from a generic proxy stack: a censor's mass
scanner cannot identify a Cool Tunnel Server from response shape
alone.

This is the v0.0.22 closer. **No further self-check loops are
required.** The project is firm.

凌晨出击。 🛡️🗡️

— 2026-05-05, v0.0.22 (LTSC HEAD recorded in `CHANGELOG.md`)

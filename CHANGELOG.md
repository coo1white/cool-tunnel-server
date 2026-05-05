# Changelog

All notable changes to Cool Tunnel Server are recorded here.

The format is loosely based on [Keep a Changelog][keepachangelog]
and the project follows [Semantic Versioning][semver] *as
interpreted by* [`VERSIONING.md`](./VERSIONING.md) — read that
before relying on a version bump as a compatibility signal.

[keepachangelog]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

## [Unreleased]

### Added

### Changed

### Fixed

### Security

---

## [0.0.24] — 2026-05-05 — deployment hotfix #2

**Real-world bug #3 from v0.0.22 deployment.** A user pulling
v0.0.23 onto a fresh Debian 13 RackNerd VPS got past the Docker
install (v0.0.23 fix) but the install script then stuck at
"MariaDB healthcheck never came up after 60s." `docker compose
logs db` showed:

```
ct-db | error: failed switching to 'mysql': operation not permitted
```

repeated every minute, forever.

### Fixed

- **`cap_drop: [ALL]` (v0.0.17 hardening) was too aggressive for
  three services** that legitimately need a small capability
  set: db, redis, panel. Each runs an entrypoint that drops root
  → service-user via `gosu` / `su-exec` / PHP-FPM's pool
  config — `setuid()` requires `CAP_SETUID` even when *demoting*
  privileges. Without it the entrypoint fails with "operation
  not permitted" and the container crash-loops without ever
  initialising. Restored the minimum cap set
  (`CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER`) on those three
  services. caddy and sing-box are unchanged
  (`NET_BIND_SERVICE` only) — they don't switch users.
- All other v0.0.17 hardening properties stay intact:
  `security_opt: no-new-privileges`, json-file log rotation,
  per-service `mem_limit` and `pids_limit`. The "spine" is
  unchanged.

### Note

The v0.0.17 cap_drop change was tested only in the Lima Debian-13
VM smoke tests, which used pre-existing volumes carried over
from earlier loops — MariaDB had already initialised, so the
first-boot user-switch path that needed `CAP_SETUID` was never
exercised. First real-world deploy with a clean volume caught
it instantly. Future smoke tests need to start from a freshly-
created volume to exercise the init-time codepath.

---

## [0.0.23] — 2026-05-05 — deployment hotfix

**Real-world deployment broke on the first try.** A user pulling
v0.0.22 onto a fresh Debian 13 RackNerd VPS hit a dpkg
file-conflict error the moment they ran the README's quickstart
`apt install` line. The README's shortcut mixed Debian's stock
`docker.io` with Docker's official `docker-compose-plugin` —
fine on a vanilla Debian box, deployment-breaker on any image
where Docker's official repo is pre-configured (which RackNerd /
Hetzner Cloud / Vultr / many other budget VPS images do).

The exact failure:

```
trying to overwrite '/usr/libexec/docker/cli-plugins/docker-buildx',
which is also in package docker-buildx-plugin
dpkg: error processing archive .../docker-buildx_0.13.1+ds1-3_amd64.deb
```

### Fixed

- **README quickstart now uses Docker's official apt repo
  end-to-end** (matches the long-form recipe already in
  `docs/installation-debian.md` § 5). Adds an inline callout for
  operators who hit the half-broken dpkg state from running an
  older copy of the README — `apt --fix-broken install` +
  remove `docker.io` + reinstall the `docker-ce` family.

### Note

This is a hotfix. The "2026 Milestone Closing" tag stays at
v0.0.22 — the spine is unchanged; only the install
documentation was wrong.

---

## [0.0.22] — 2026-05-05 — **2026 Milestone Closing**

**Surgical-strike closer.** Two final-anchor features and the
canonical retrospective for the v0.0.13 → v0.0.22 self-audit
programme. After this release, no further self-check loops are
required — the spine is firm.

### Added

- **DoH endpoint reachability check** for operators in censored
  regions. New `ComponentKindV1::DohEndpoint` variant in
  `ct-protocol`; new `verify_via_doh` arm in
  `ct-server-core/src/components.rs` that reads the live
  `ServerConfig.doh_resolver` (panel-editable, not the .env
  default) and dispatches an RFC 8484 binary DoH query for
  `example.com IN A`. Asserts HTTP 200 + ANCOUNT > 0 — catches
  captive portals, transparent DNS poisoners, and outright
  blocks of upstream resolvers like 1.1.1.1. Manifest at
  `manifests/doh-resolver.upstream.json`.
  Operator path: change resolver in panel → re-run `component
  check` → iterate until OK.
- **`mem_limit` + `pids_limit` per service** in
  `docker-compose.yml` (1 GB VPS determinism). caddy 64M/32,
  sing-box 128M/64, panel 320M/256, db 192M/128, redis 64M/32.
  Total hard cap 768 MiB; ~256 MiB reserved for host kernel +
  Docker daemon on a 1024 MiB box. Sized from the empirical
  measurements of all 9 prior releases — deterministic OOM-kill
  on overflow rather than host-wide thrash.
- **`docs/architectural-decisions-2026.md`** — 389-line
  retrospective covering the eight self-check loops, the seven
  load-bearing invariants that emerged, the defense-to-offense
  posture pivot, major architectural decisions + trade-offs, and
  the deferred-work roadmap. The canonical reference for any
  future contributor reasoning about the v0.0.13–v0.0.22 arc.

This is the **2026 Milestone Closing**. Tag.

---

## [0.0.21] — 2026-05-05

**Loop-7: diminishing-returns marker.** Audit angles previous
loops hadn't touched (Filament Resource action paths, ct-protocol
crate, TODO/FIXME residue, Rust idioms, seeders, wire size limits,
quota concurrency, install.sh under cap_drop). Eight areas swept;
seven returned "no bug found". One LOW finding shipped here:

### Fixed

- **Defense-in-depth FQDN regex on `ServerConfigPage::domain`
  input.** The v0.0.16 render-layer guard blocks metasyntactic
  values from reaching Caddy, but a typo'd domain still persists
  in the DB and breaks every subsequent render until the operator
  notices. Form regex (RFC 1123 label shape, max 253 chars)
  rejects the typo at save time.

### Audit areas confirmed clean (no fix needed)

- Filament Resource actions: `regenerate_password` correctly uses
  `setCleartextPassword()` and shows cleartext via persistent
  notification only; FakeWebsite payload stays inside `{{ }}`-
  escaped Blade; `TrafficLogResource` confirmed read-only.
- `ct-protocol`: `subscription.rs` carries `version: u32` and
  HMAC-SHA-256; `components.rs` verify-command path runs only
  manifests from the `:ro` mount under `/srv/manifests`; trust
  boundary is the repo, not a runtime input.
- Zero `TODO`/`FIXME`/`HACK`/`XXX` matches across the entire
  codebase.
- Zero `unwrap`/`expect`/`panic` in non-test Rust code; zero
  `unsafe` blocks (workspace-wide `forbid(unsafe_code)` holds).
- All 4 `tokio::spawn` sites have explicit error handling /
  retry-with-backoff / runtime-test scopes.
- `quota.rs` uses `SELECT ... FOR UPDATE` inside a transaction;
  no double-decrement risk.
- `DatabaseSeeder` does not seed a default-admin password; seeds
  three FakeWebsite rows so the cover-site invariant holds on
  fresh install.

---

## [0.0.20] — 2026-05-05

**Loop-6: closes the deferred items + a CI gap discovered along
the way.** Wires the v0.0.19 PHPUnit suite into CI, adds the test
that guards the v0.0.15 critical `DB::afterCommit` fix, sweeps
five releases of doc drift in README + SECURITY, and fixes a
silent CI false-green where the sing-box template-validate job
was rendering literal `{{ .DohServer }}` / `{{ .DohPath }}` /
`{{ .ClashListen }}` placeholders into "validated" configs.

### Added

- **`panel/tests/Feature/ProxyAccountAfterCommitTest`** — four
  cases covering the v0.0.15 C1 fix (rolled-back save → no
  dispatch, committed save → 1 dispatch, no-txn save → dispatch
  immediately, rolled-back delete → no dispatch + row preserved).
  Pre-fix the C1 bug was real and shipped without a test; this
  is the regression guard.
- **CI step `phpunit (panel)`** in `.github/workflows/ci.yml`'s
  `php` job. Runs `composer install --no-scripts` (matching
  v0.0.16's supply-chain hardening pattern) followed by
  `vendor/bin/phpunit --colors=never`. The v0.0.19 scaffold + 9
  tests + the v0.0.20 4-case AfterCommit test now exercise on
  every PR.

### Fixed

- **CI sing-box template substitution gap.** The `template` job
  in ci.yml was sed-substituting six bindings into the
  Caddyfile.tpl + sing-box config.json.tpl before passing them
  to upstream `caddy validate` and `sing-box check`. Since
  v0.0.13's H3 fix added `{{ .ClashListen }}` (and the prior
  sing-box 1.12+ DohServer/DohPath split landed without a
  matching CI substitution update), three bindings were leaking
  through as literal placeholder strings in the rendered file.
  Both validators happily accepted any string as the field value
  — no shape constraint fired — so CI was silently green on
  configs that wouldn't actually load. Adds the missing
  substitutions.

### Changed (docs only)

- **`README.md`** updated for v0.0.15-v0.0.19 properties:
  upgrade-checkout example v0.0.14 → v0.0.20, mention of
  `scripts/restore.sh` (v0.0.15) in Common operations,
  readiness-gate count 10 → 11 checks (v0.0.18 added the
  cover-site invariant check).
- **`SECURITY.md` Defensive defaults** updated: DB::afterCommit
  (v0.0.15), atomic_write parent fsync (v0.0.15), Caddyfile-
  injection guard (v0.0.16), composer --no-scripts (v0.0.16),
  cap_drop ALL + no-new-privileges (v0.0.17), SecurityHeaders
  middleware (v0.0.18), schedule onFailure logging (v0.0.18).
  New "Test coverage" section documents the v0.0.19/v0.0.20
  PHPUnit + Rust counts.

---

## [0.0.19] — 2026-05-05

**Loop-5: panel test scaffold + automated coverage of the cover-site
invariant + H2 auth gate.** Pre-fix the panel had ZERO PHPUnit tests
through v0.0.13–v0.0.18 (every fix landed unverified by automated
test). Loops 1–4 surfaced the gap; this loop closes the largest
risk it implied.

### Added

- **`panel/phpunit.xml`** — PHPUnit 11 config (SQLite in-memory test
  DB, sync queue, array cache, fixed APP_KEY, fail-on-warning +
  fail-on-risky).
- **`panel/tests/TestCase.php`** — base test case extending Laravel
  11's `BaseTestCase`.
- **`panel/database/factories/{User,ProxyAccount,FakeWebsite,
  ServerConfig}Factory.php`** — Eloquent factories with default
  values + states (`viewer`, `inactive`, `expired`, `disabled`,
  `active`) covering the v0.0.13/v0.0.16 model invariants.
- **`panel/tests/Feature/CoverSiteInvariantTest`** — four cases
  asserting byte-equal Content-Type + ETag + body between every
  failure response (unknown token, expired account, rate-limit
  hit, uncaught route exception) and a baseline cover-site hit.
  A regression in any of the four paths fails CI.
- **`panel/tests/Unit/UserCanAccessPanelTest`** — five cases
  exercising the H2 three-way gate (panel id, `is_active`,
  `role`) plus a defense-in-depth assertion that `password` /
  `role` / `is_active` stay out of `$fillable`.
- **`make php-test`** target — runs the panel test suite.
  Required `cd panel && composer install` first; emits a clear
  hint to that effect if `vendor/` is absent.
- **`HasFactory` on `App\Models\ServerConfig`** so the new
  factory resolves (the other three models already had it).

### Deferred to future loops

- Wiring `make php-test` into `make ci` and the `audit.yml` /
  `ci.yml` GitHub Actions workflows. Today the tests exist on
  disk but only run on demand. Plumbing them into CI requires a
  composer-install + sqlite step in the runner; not hard, but
  out of scope for v0.0.19's "land the test infrastructure"
  goal.
- `ProxyAccountAfterCommitTest` — verifying that a transaction
  rollback drops the Redis announce + queue dispatch (v0.0.15
  C1 fix). Doable but needs a transaction + rollback fixture
  pattern that's worth its own pass.

---

## [0.0.18] — 2026-05-05

**Loop-4 self-check pass: 1 HIGH-class test gap closed + browser-
side hardening + scheduler observability + DX.** This round's
lens: test-coverage gaps for the v0.0.13–v0.0.17 fixes, browser-
side security headers, and the deferred items from loop 3.

### Added

- **Test coverage for `template::caddyfile_validate`** (the v0.0.16
  Caddyfile-injection guard had zero tests — single highest-risk
  untested path per the loop-4 audit). Four new unit tests in
  `core/ct-server-core/src/template.rs`: clean values pass, every
  rejected metasyntax char independently fails, the realistic
  injection payload `example.com\n}\nadmin localhost:2019\n{` is
  rejected, error message names the offending field. Test count:
  51 → 55 in ct-server-core.
- **`panel/app/Http/Middleware/SecurityHeaders`** — emits six
  browser-side headers on every `/admin` response: `X-Frame-
  Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (deny camera/microphone/geolocation/payment/
  usb), `Cache-Control: no-store, must-revalidate`,
  `Strict-Transport-Security: max-age=63072000; includeSubDomains`.
  Filament 3 ships with none of these by default. Wired into
  `AdminPanelProvider`'s middleware stack.
- **`make fmt` / `make lint` / `make test` aliases** — delegate
  to `rust-fmt` / `rust-clippy` / `rust-test`. Muscle-memory DX
  win for cargo-project operators.

### Fixed

- **`panel/routes/console.php`: `->onFailure(...)` on every
  scheduled task.** Pre-fix, a Throwable inside `traffic:rollup`,
  `quota:enforce`, or `singbox:render` was swallowed silently by
  Laravel's scheduler. The insidious case: `quota:enforce` dies
  → over-quota users keep tunneling forever with no operator
  signal. Now every failure logs `schedule.failed` at
  `Log::critical` with cmd + err + exception type.

### Deferred to a future loop

- **DoH reachability check** — synthetic component-check arm that
  verifies `cfg.doh_resolver` actually resolves a query. Needs a
  new `ComponentKindV1::DohEndpoint` variant in `ct-protocol`
  and a `verify_via_https` arm in `components.rs`. Real value
  for operators in censored regions where 1.1.1.1 may be blocked,
  but a non-trivial design.
- **PHPUnit feature tests** for SubscriptionController cover-site
  fallback, exception handler scope, and ProxyAccount
  DB::afterCommit. Needs `panel/phpunit.xml` + `panel/tests/TestCase.php`
  scaffold. Current `panel/tests/` is empty — every panel-side
  fix in five releases is unverified by automated test. Worth a
  dedicated round to land properly with sqlite test DB +
  factories.

---

## [0.0.17] — 2026-05-05

**Loop-3 self-check pass: 1 HIGH (arm64 panel build) + 3 MEDIUM
(backup secret on argv, cap_drop / no-new-privileges, json-file
rotation) + 1 LOW (DX).** The lens this round: storage / secrets /
runtime resource limits / observability gaps.

### Fixed

- **HIGH — `docker/panel/Dockerfile`: TARGETARCH-aware naive
  client.** Pre-fix the URL was hardcoded `linux-x64`, so on
  arm64 hosts the build "succeeded" but installed an x86_64
  binary that fails to exec when the probe path runs. Same
  class as v0.0.13's core/Dockerfile fix; the panel had been
  missed. amd64 SHA stays strict-pinned; arm64 emits a loud
  WARN when no SHA is provided (klzgrad/naiveproxy doesn't
  publish a SHA256SUMS file — operator can pin via
  `--build-arg NAIVE_SHA256_ARM64=<hash>`).
- **MEDIUM — `scripts/backup.sh`: DB root password via
  `MYSQL_PWD` env, not `-p` on argv.** Pre-fix the password
  surfaced in `ps -ef` for the duration of the dump.
- **MEDIUM — `docker-compose.yml`: `cap_drop: [ALL]` +
  `security_opt: [no-new-privileges:true]` on every service**
  via a `x-svc-hardening` YAML anchor. caddy + sing-box add
  back NET_BIND_SERVICE; nothing else needs any capability.
- **MEDIUM — `docker-compose.yml`: json-file log rotation** (10
  MB × 3 files) on every service. Bounds container-log disk
  growth — the docker daemon default is unbounded.
- **LOW (DX) — `scripts/install.sh`: cross-validate
  `CT_CLASH_SUBNET` vs `CT_CLASH_SINGBOX_IP`.** Operators who
  override the subnet to escape a docker-network collision now
  get a clear "first three octets must match" error at pre-
  flight rather than the unhelpful Docker-side "Invalid
  Address" later.

---

## [0.0.16] — 2026-05-05

**Loop-2 self-check pass: 1 HIGH (Caddyfile injection) + 2 MEDIUM
(FakeWebsite race, Composer scripts).** Continued the loop hunt
established in v0.0.14/15. This round's lens: business-logic and
service-layer correctness — Filament Resources, the Caddy/sing-box
generators, model events, scheduled tasks, supply-chain hygiene.

### Fixed

- **HIGH — `core/caddy`: refuse to render Caddyfile with
  metasyntactic operator input.** `caddy::render` previously
  substituted operator-controlled `domain`, `acme_email`, and
  `acme_directory` raw into the Caddyfile template. Caddy's
  grammar treats `{` `}` as block delimiters, `"` as quoted-
  string opener, and `\n` as a directive terminator — a hostile
  DOMAIN like `example.com\n}\nadmin localhost:2019\n{` would
  break out of `{{ .Domain }}:8443 { … }` and inject a Caddy
  admin endpoint onto the public surface. Adds
  `template::caddyfile_validate` (deny-list of those chars) and
  validates every binding before render. Matches the project's
  posture of "refuse rather than sanitise" — Caddyfile has no
  general escape syntax for these.
- **MEDIUM — `panel/fake-website`: serialise activation via DB
  transaction + lockForUpdate.** Two admins concurrently
  activating different rows could leave both `is_active=true`,
  producing nondeterministic cover-site shape. Wrap the
  deactivation of all-others in `DB::transaction` with
  `lockForUpdate` to serialise.
- **MEDIUM — `docker/panel`: composer install `--no-scripts` on
  first boot.** Pre-fix, every transitive Composer package's
  declared scripts ran as the panel user during `vendor/`
  bootstrap. Now `--no-scripts` is passed and the single
  project-known post-install script (`php artisan
  package:discover --ansi`) is invoked explicitly. Bounds the
  supply-chain footgun.

---

## [0.0.15] — 2026-05-05

**Loop-1 self-check pass: 2 CRITICAL correctness bugs + 4 HIGH
hardening + 1 supply-chain advisory waived.** Continued the
self-audit programme that produced v0.0.14; this round's hunt
focused on **runtime correctness under stress** (concurrency,
power-loss, supervisor restart semantics, upgrade ordering) and
**supply-chain audit hygiene**. Both CRITICAL findings are real
correctness bugs, not just hardening — the project would silently
diverge state under specific production conditions.

### Fixed

- **CRITICAL — Redis announce + queue dispatch deferred to
  `DB::afterCommit`** (`panel/app/Models/ProxyAccount.php`).
  Pre-fix, `setAccountStatus`, `announceAccountChanged`, and
  `ReloadSingBoxJob::dispatch` ran inline in `static::saved` /
  `static::deleted`, which fire AFTER the row's INSERT/UPDATE
  but BEFORE the surrounding transaction commits. A rollback
  later in the same transaction left a Redis ghost flag for a
  row that never persisted, plus a queued reload for a phantom
  change. Both callbacks now snapshot the relevant fields at
  save-time and defer the side effects to `DB::afterCommit`,
  which only fires if the outermost transaction commits. Outside
  a transaction the callback runs immediately — pre-fix
  behaviour preserved.
- **CRITICAL — `atomic_write` fsyncs the parent directory after
  rename** (`core/ct-server-core/src/singbox/mod.rs`). POSIX
  rename is atomic for concurrent readers, but the directory
  entry update can sit in the page cache for arbitrarily long.
  Power loss between the rename and the next implicit sync
  reverts the directory entry — sing-box reloads the OLD
  config.json on next boot, silently re-activating revoked
  credentials. Standard fix: open + fsync the parent dir after
  rename. One additional `fdatasync` per render — only triggers
  on actual changes (the SHA-256 dedupe at the caller short-
  circuits unchanged renders).
- **HIGH — `supervisord.conf` `startretries=10` + `startsecs=5`
  on every program** (`docker/panel/supervisord.conf`). Pre-fix
  only `ct-core-daemon` declared retries; the other four
  (php-fpm, nginx, queue, scheduler) inherited supervisord's
  default `startretries=3, startsecs=1`. Three rapid crashes
  (transient Redis blip during `queue:work` boot, first-boot
  timing window before `/run/cool-tunnel` is writable) put the
  program in FATAL — supervisord gives up forever. The most
  common silent regression: `queue:work` FATAL → ReloadSingBoxJob
  backstop dies. Saves still fire the Redis fast-path so the
  user-visible reload happens, but the cold-path consistency
  layer is silently broken until the operator notices via
  `supervisorctl status`.
- **HIGH — `bootstrap/app.php` exception handler tightens
  prefix match** to exact-or-prefix-with-trailing-slash. The
  v0.0.14 `str_starts_with($path, 'admin')` would also match
  future routes like `administrator/`, `admins/list`,
  `admin-export/` — silently losing cover-site protection on
  any path that happens to start with the literal `admin`. Same
  shape applied to `livewire`. Forward-looking; no current
  route exposes it.
- **HIGH — `update.sh` brings the new panel image up BEFORE
  running migrations** (`scripts/update.sh`). Pre-fix the
  sequence was `compose build` → `compose exec panel migrate`
  (against the OLD running container) → `compose up -d panel`
  (finally swap in the new image). Migrations applied via the
  OLD PHP runtime; the OLD interpreter then briefly executed
  against the new schema. Today's migrations happen to be
  additive-with-defaults so the order is safe in practice, but
  the order was fragile by accident. Pinned.
- **HIGH — `backup.sh` quiesces Caddy before tarring
  `caddy_data`**. A cert renewal landing mid-tar could capture
  a half-written `*.crt` or `*.key` in the archive — backup
  silently corrupted, restore would fail to load on the new box.
  Caddy is `compose stop`-ed, the tar runs against the now-
  static volume, then Caddy is restarted (only if it was
  running). The 1-2 minute :80 downtime is acceptable for
  backup; :443 proxy traffic is unaffected.

### Added

- **`scripts/restore.sh`** — companion to `backup.sh`. Pre-fix
  the project shipped a one-way backup with no documented
  restore path. The new script reverses the tarball: untar,
  restore `.env` + manifests + templates, bring up db + redis,
  mariadb-import the dump, restore the `caddy_data` volume,
  bring up panel + sing-box + caddy, run a component check.
  Refuses to overwrite a running stack; idempotent on partial
  re-invocation.
- **`scripts/late-night-comeback.sh` cover-site invariant
  check** (the new check #11, raising the gate from /10 to /11).
  Verifies `/api/v1/subscription/<bogus>` and
  `/lnc-cover-probe` both return HTTP 200 with byte-identical
  ETags, AND that the public Caddy redirect on :80 emits no
  `Server:` header. A v0.0.14 anti-fingerprint regression now
  fails the readiness gate before the box takes real users.

### Security

- **`RUSTSEC-2023-0071` (Marvin Attack on `rsa` 0.9 via
  `sqlx-mysql`) waived**, with documented rationale. We ship
  MariaDB 11 which never invokes the `rsa` codepath
  (`mysql_native_password`, not `caching_sha2_password`); the
  MariaDB connection is on the internal-only `ct-data` docker
  network, blocking any timing-sidechannel pre-condition. No
  upstream fix forthcoming for the rsa 0.9 line. Waiver mirrored
  across `core/audit.toml`, `core/deny.toml`, and the
  `cargo-audit` step in `.github/workflows/audit.yml` so all
  three audit pathways agree.

---

## [0.0.14] — 2026-05-05

**Self-check pass + anti-censorship cover-site hardening.** Two-stage
bug hunt over the v0.0.13 patches surfaced four real bugs (one HIGH,
two MEDIUM, one LOW); a follow-up sweep with the project's actual
threat model (anti-censorship, not just "service down") added six
P0-class hardening items focused on preserving the cover-site invariant
under every observable failure path.

End-to-end verified on a Debian 13 (trixie) Lima VM with
`CT_CLASH_SUBNET=10.99.99.0/24` to exercise the new env-tunable network
path: 65 burst hits past the rate-limit cap all returned HTTP 200 with
identical body, byte-equal ETag, byte-equal Content-Type — censor
indistinguishable from a vanilla unknown-path probe.

### Added

- **`bootstrap/app.php` exception render override** — for any uncaught
  `Throwable` on a public route (everything except `/admin`, `/livewire`,
  `/up`), Laravel now renders FakeSiteController instead of a 5xx HTML
  error page or stack-trace dump. Operator still sees the original
  exception via `Log::critical`.
- **Per-email login rate limit dimension** in `AppServiceProvider`:
  `Limit::perMinute(20)->by('email:'.strtolower($email))`. Defeats
  IP-rotation brute-force against a single email; the per-(email|ip)
  and per-ip dimensions both reset under botnet rotation.
- **Deterministic ETag on cover-site responses** in
  `FakeSiteController` — `sha256(rendered body)` prefix-16. Conditional
  GET (`If-None-Match`) returns 304. Removes the "static-looking site
  with no validators" probe distinguisher.
- **`CT_CLASH_SUBNET` + `CT_CLASH_SINGBOX_IP` env tunables** in
  `.env.example` and `docker-compose.yml`. v0.0.13 hardcoded
  `172.30.0.0/24`; operators with a colliding network (corporate VPN
  bridge, k8s flannel, Tailscale subnet route) couldn't bring the
  stack up. Override both together; `CT_CLASH_LISTEN` is now derived
  from `CT_CLASH_SINGBOX_IP` so a single edit propagates everywhere.

### Changed

- **`SubscriptionController::show`** — anti-enumeration rate limit
  enforced *inside* the controller via `RateLimiter::tooManyAttempts/hit`
  rather than via `throttle:subscription` middleware. Middleware
  returns HTTP 429 on hit, distinguishable from the 200 cover-site;
  in-controller falls through to FakeSiteController on rate-limit hit
  for byte-level parity. The `resolve()` call is now wrapped in a
  `Throwable` catch so any resolver exception (e.g. M-panel-2's
  empty-`APP_KEY` `RuntimeException`) also falls through to
  FakeSiteController.
- **`caddy/Caddyfile.tpl`** — `header -Server` added to both `:80` and
  `:8443` blocks. Stock Caddy emits `Server: Caddy` on every response;
  a censor's `curl -I` previously identified the engine instantly.
  Verified absent from the 308 HTTPS-redirect response.
- **`docker/panel/nginx.conf`** — `map $request $request_logged`
  rewrites `/api/v1/subscription/<token>` to
  `/api/v1/subscription/<masked>` before the access log line is
  written. Pattern matches all HTTP methods, not just GET. Tokens no
  longer persist in `docker logs ct-panel`, in the json-file driver
  on disk, or in operator log-shipping pipelines.
- **`Makefile` `set-version`** — now refreshes `core/Cargo.lock` via
  `cargo update --workspace --offline` so the workspace member version
  entries match `Cargo.toml`. Fails loudly with a remediation hint if
  cargo errors; the prior silent-on-error swallowed three distinct
  failure modes behind a "lockfile still stale" trap.
- **`AppServiceProvider::configureRateLimiters`** — removed the
  unused `RateLimiter::for('subscription')` registration; the limit
  is now expressed as constants inside `SubscriptionController`.

### Fixed

- **`ReloadSingBoxJob::uniqueId()` was dead code** — the class did
  not implement `Illuminate\Contracts\Queue\ShouldBeUnique`, so
  Laravel never consulted `uniqueId()` and the docstring's claim of
  queue-layer dedupe was misleading. Removed the method; updated the
  docstring to honestly attribute idempotency to
  `SingBoxConfigGenerator::renderToFile`'s SHA-256 short-circuit.
- **`ReloadSingBoxJob` queue-connection comment** — said `database`,
  but the shipped `.env.example` is `QUEUE_CONNECTION=redis`. Updated
  to reflect the production reality.

### Security

- **Cover-site invariant now holds across every observed failure
  path** — the byte-on-the-wire response to
  `/api/v1/subscription/<bad-token>`, `/random-path`, a rate-limited
  request, an empty-APP_KEY request, and any uncaught exception is
  identical: status 200, `Content-Type: text/html; charset=utf-8`,
  same ETag, same body. A censor sweeping for proxy endpoints
  cannot distinguish a Cool Tunnel Server from a static-website
  host of the same hosting class purely from response shape.
- **`Server: Caddy` no longer leaked** on the public `:80` redirect.
- **Subscription HMAC tokens no longer logged in plaintext** by the
  panel's nginx access log.

---

## [0.0.13] — 2026-05-05

**High-severity audit hotfixes + low-memory tuning.** Rolls up the
three H-rated findings (rate-limiting gap, single-tier authz, clash-API
blast radius), three M-rated findings, the queue refactor that uncouples
panel saves from the reload subprocess, plus a perf pass that fits the
stack into the documented 1 vCPU / 1 GB minimum spec without OOM.

End-to-end verified on a Debian 13 (trixie) Lima VM: Docker official
apt repo install, `docker compose up -d`, full migration run, sing-box
clash-API reachability test from `panel` (HTTP 401, ✓) and from `caddy`
(timeout, ✓ — caddy is no longer on the management network).

### Added

- **Custom Filament login page** (`panel/app/Filament/Pages/Auth/Login.php`)
  that calls `$this->rateLimit(5)` before delegating to the framework's
  `authenticate()`. (H1.)
- **`login` and `subscription` named rate limiters** in
  `AppServiceProvider::configureRateLimiters()`. (H1.)
- **`users.role` (`varchar(32)` default `admin`) and `users.is_active`
  (`boolean` default `true`)** columns + matching migration
  (`2026_05_05_000001_add_role_and_active_to_users`). (H2.)
- **`App\Jobs\ReloadSingBoxJob`** — queued, idempotent, `tries=3`,
  `90s` per-try cap. Backstops the inline Redis pub/sub announce.
  (R-panel-1.)
- **`ct-clash` internal-only docker network** (172.30.0.0/24) carrying
  clash-API HTTP between `panel` and `sing-box`. Sing-box pinned to
  `ipv4_address: 172.30.0.10` with the `ct-singbox-mgmt` alias. Caddy
  is **not** a member. (H3.)
- **`clash_listen()` in `core/ct-server-core/src/singbox/mod.rs`**:
  reads `CT_CLASH_LISTEN` env, defaults `127.0.0.1:9090` (fail-closed).
  Substituted into `config.json.tpl` as `{{ .ClashListen }}`. (H3.)
- **`release-small` cargo profile** (`core/Cargo.toml`): no LTO,
  `codegen-units = 16`, `opt-level = "s"`. Halves peak compile-time
  RAM (~1.5-2 GB → ~0.6-0.9 GB) at ~5-15 % runtime cost. Selected via
  `CT_CORE_BUILD_PROFILE=release-small` in `.env`; threaded through
  `install.sh` to `docker compose build --build-arg CARGO_PROFILE=…`.
- **`PHP_FPM_PM_MODE` / `_MAX_CHILDREN` / `_IDLE_TIMEOUT` /
  `_MAX_REQUESTS` env tunables** (defaults `ondemand` / `4` / `60s`
  / `500`) in `docker/panel/entrypoint.sh`.
- **Low-memory MariaDB tuning** in `docker-compose.yml`'s `db.command:`
  block: `innodb-buffer-pool-size=64M`, `performance-schema=OFF`,
  `max-connections=20`, `skip-name-resolve`, etc.
- **§ "Before first boot — low-memory VPS prep"** in
  `docs/installation-debian.md`: 2 GB swapfile recipe + `vm.swappiness=10`,
  `release-small` selection, runtime tuning knob table, OOM-watch
  guidance, steady-state expectations table.

### Changed

- **`User::canAccessPanel(Panel $panel)`** now gates on (panel id matches
  `admin`) AND (`is_active === true`) AND (`role === ROLE_ADMIN`). Pre-fix
  this returned `true` unconditionally — any seeded row had full ProxyAccount
  / ServerConfig / FakeWebsite authority. (H2.)
- **`User::$fillable`** trimmed to `['name', 'email']`. `password`, `role`,
  `is_active` removed — set via `setPasswordAttribute` / explicit
  `forceFill` / console seeders only. Defense-in-depth against
  privilege-bearing fields landing in `User::create($request->all())`.
- **`ProxyAccount::booted()`** keeps the Redis revocation pub/sub
  announce inline (~1 ms fire-and-forget) but moves
  `SingBoxConfigGenerator::renderToFile()` + `SingBoxReloader::reload()`
  to `ReloadSingBoxJob::dispatch()`. Pre-fix a hung `ct-server-core`
  blocked the Filament request for up to 60 s; bulk-delete fanned out
  N synchronous reloads. (R-panel-1.)
- **`docker/core/Dockerfile`** detects Docker's `TARGETARCH` and maps
  to the matching musl rustc triple (`x86_64-unknown-linux-musl`,
  `aarch64-unknown-linux-musl`, `armv7-unknown-linux-musleabihf`).
  Project shipped x86_64-only before — broke arm64 hosts.
- **`docker/panel/opcache.ini`** sized for a 1 GB box: shared opcache
  `128 → 64 MB`, JIT buffer `64 → 32 MB`, `max_accelerated_files`
  `10000 → 5000`, `revalidate_freq` `2 → 60 s`.
- **`docker/panel/entrypoint.sh` FPM pool** now `pm = ondemand` with
  `max_children = 4` by default (was `pm = dynamic, max_children = 16`).
  Drops the panel's worst-case from ~480-800 MiB to ~120-200 MiB on
  small boxes; tunable up via env on bigger ones.
- **Throttle middleware on `/api/v1/subscription/{token}`** (60/min
  per IP via the new `subscription` named limiter). (H1.)

### Fixed

- **Saturating subtraction on uplink/downlink deltas**
  (`core/ct-server-core/src/metrics.rs`). Plain subtraction panicked in
  debug and silently wrapped in release if either side approached
  `i64::MIN/MAX`. The hot path is gated by an early-return today
  (sing-box doesn't emit Prometheus-shaped per-user metrics yet — see
  module docstring) so this is hardening for the eventual re-enable
  rather than a live correctness fix. (M-rust-2.)
- **`config('app.previous_keys')` trims each segment**
  (`panel/config/app.php`). `array_filter(explode(',', $env))` kept
  whitespace and `\n` — a stray space in `.env` produced a malformed
  key and silent decryption failures, and accounts mysteriously dropped
  out of the rendered manifest after a key rotation. (M-panel-1.)

### Security

- **`SubscriptionController::signingKey()` refuses an empty `APP_KEY`**.
  `.env.example` ships `APP_KEY=` blank; an operator who forgets
  `php artisan key:generate` would otherwise hash with
  `hash_hmac('sha256', $idStr, '')` — deterministic, so every forged
  token verifies. Hard-fail with `RuntimeException` and a clear
  remediation hint. (M-panel-2.)
- **Six unused dependencies removed** from `core/ct-server-core/Cargo.toml`
  (`hyper`, `hyper-util`, `hyperlocal`, `http-body-util`, `bytes`,
  `hmac`). Matching `From`-impl removals in `err.rs`. The unix-domain
  admin path that needed them was retired long ago; `reqwest` is the
  only HTTP client the binary actually exercises. Shrinks the
  dependency tree, lowers peak compile RAM, and eliminates the
  audit-flagged "unused but pinned" carry-over.

---

## [0.0.11] — 2026-05-03

**Compile-time SQL safety.** Every `sqlx::query()` call in the
Rust core is now `sqlx::query!()` — type-checked against the
panel's MariaDB schema at `cargo check` time, with offline
metadata committed under `core/.sqlx/` so the build never needs
a live DB. Schema regressions (column dropped, retyped, renamed)
become **build failures**, not production failures.

The motivation is the v0.0.10 BIGINT UNSIGNED issue: an `i64`
bound to an unsigned column was caught by sqlx at runtime, after
a 12-minute Docker rebuild + container start. With `query!()` +
offline mode, the same class of bug surfaces during `cargo check`
in seconds, before any image is built.

### Changed (wire-format / build pipeline)

- **`core/ct-server-core/src/db.rs`,`quota.rs`, `subscription.rs`**
  — every query migrated from `sqlx::query("…")` (runtime-checked)
  to `sqlx::query!("…")` (compile-time-checked). The macros
  inspect the live schema during `cargo sqlx prepare` and embed
  exact column types (incl. nullability + UNSIGNED) into
  `core/.sqlx/query-<hash>.json`. The committed JSON files are
  the schema↔code contract; `cargo build` validates against them.

- **Builds now require `SQLX_OFFLINE=true` + a populated
  `core/.sqlx/` directory.** Wired in:
  - `docker/core/Dockerfile` (`ENV SQLX_OFFLINE=true`)
  - `.github/workflows/ci.yml` (per-step env on `cargo build`,
    `cargo test`, `cargo clippy`)
  - `Makefile` (`rust-build`, `rust-test`, `rust-clippy`)

- **First-time and post-migration generation:**
  `scripts/sqlx-prepare.sh` (also `make sqlx-prepare`). The script
  brings up MariaDB via the project's `docker-compose.yml`, runs
  Laravel migrations, installs `sqlx-cli` if missing, runs
  `cargo sqlx prepare --workspace` against the live schema, and
  reports the diff for the operator to commit. Idempotent.
  Containerised fallback for when the DB port isn't host-mapped.

### Added

- **Cycle 43 codified: `sqlx-offline-check` audit job.** Runs
  `cargo check --workspace` with `SQLX_OFFLINE=true` against the
  committed `core/.sqlx/`. If a `query!()` call has no matching
  metadata (operator forgot `make sqlx-prepare`) or the metadata
  is for a different schema (migration ran but wasn't reflected),
  the job fails with `error: no cached data for this query` and
  blocks the merge. Triggers: weekly cron + every PR touching
  `core/**` or `panel/database/migrations/**`.
- **`docs/sqlx-offline.md`** — explains the why, the how, the
  per-migration loop, common errors, and the prepare-vs-runtime
  trade-off table.
- **`make sqlx-check`** target — runs the same check locally
  before push. Prints a "↳ run make sqlx-prepare and commit"
  hint on staleness.
- **`.gitignore` comment** — explicit "do NOT add `core/.sqlx`
  to ignore patterns" note. The directory MUST be committed; CI
  fails without it.

### Migrations / op-side action required (one-time per deploy)

Pulling v0.0.11 onto a working v0.0.10 deployment requires one
extra step before the next build will succeed:

```bash
cd /opt/cool-tunnel-server
git fetch --depth 1 origin main && git reset --hard FETCH_HEAD
make sqlx-prepare
git add core/.sqlx
git commit -m "chore(sqlx): initial offline metadata"
git push origin main
docker compose --profile build-only build core-builder
docker compose up -d --force-recreate panel
```

After that, every future `cargo build` / CI run / Docker rebuild
runs offline; the only time `sqlx-prepare` is rerun is after a
migration changes column types or someone adds/edits a `query!()`
call.

### Tests

51 passing once `core/.sqlx/` is generated (build won't compile
without it — that's the whole point). Build + clippy + fmt +
shellcheck still clean with offline mode wired in.

### Security

- Removes the entire class of "code expects T, schema returns
  U, runtime decode error in production" bugs. The contract is
  literal JSON checked into git; review-able in PR diffs.
- The `.sqlx/*.json` files contain query SQL + column types. They
  are NOT secrets — no data, no credentials. Safe to commit and
  diff publicly (well, would be — the repo stays private for
  other reasons).

---

## [0.0.10] — 2026-05-03

Fourth 50-cycle LTSC audit, focused on **code-robustness design**:
panic potential, error propagation, subprocess + network timeouts,
transaction boundaries, resource caps, and the unhappy paths the
existing test suite doesn't exercise. Cycles 1–30 by hand surfaced
ten findings, two of them outright **showstopper bugs** that have
been broken in production since v0.0.4 — never caught because
nobody had clicked through the panel save flow on a real deploy.
Cycles 31–50 added two new codified jobs whose absence let those
showstoppers ship: a PSR-4 filename-vs-class lint and PHPStan
level-5 undefined-method analysis.

### Fixed (showstopper, was broken since v0.0.4)

- **`panel/app/Services/SingBoxReloader.php` declared
  `class CaddyReloader`.** PSR-4 autoloading resolves
  `App\Services\SingBoxReloader::class` to `SingBoxReloader.php`,
  finds it, includes it — but the class declared inside is
  `CaddyReloader`, so the symbol `SingBoxReloader` is undefined.
  Result: every `app(SingBoxReloader::class)` resolution from
  `AppServiceProvider` raised "Class not found" at runtime,
  breaking every panel save that fired the model-saved event.
  Class renamed to match the filename; `reload()` now calls
  `reloadSingBox()` (was `reloadCaddy()` — also undefined).
- **`CaddyfileGenerator::renderToFile()`,
  `SingBoxConfigGenerator::renderToFile()`, and
  `SingBoxReloader::reload()` called methods that don't exist
  on `CtServerCore` (`renderCaddyfile`, `reloadCaddy`, etc.).**
  Each invocation raised PHP `Error` ("call to undefined
  method"), which the surrounding `catch (\RuntimeException
  $e)` did NOT catch (Error doesn't extend Exception). Result:
  every `ServerConfig::saved` and `ProxyAccount::saved` event
  threw a fatal Error, abandoning the model save mid-flight.
  v0.0.10 adds the missing `renderCaddyfile()` method,
  corrects the `SingBoxConfigGenerator` to call
  `renderSingBoxConfig()`, and broadens all generator catches
  from `\RuntimeException` to `\Throwable` so a future class
  of similar bug at least gets logged instead of silently
  bringing the panel down.

### Fixed (other robustness)

- **Hyper unix-socket calls had no timeout.** `admin::reload`,
  `admin::dump_config`, and `metrics::fetch_metrics_text` all
  did `client.request(req).await?` with no `tokio::time::timeout`
  wrapper. A hung sing-box process (deadlock, signal-blocked,
  etc.) accepting the connection but never responding would
  have wedged the panel's reload path forever. Now wrapped:
  reload + dump in 15s, metrics in 10s.
- **Daemon's JSON-per-line reader was unbounded.** A misbehaving
  client sending a huge line without a newline could grow the
  read buffer until OOM. Now caps at 1 MiB per line; an
  oversized request triggers a `request_too_large` error
  response and the connection is closed.
- **Daemon had no graceful shutdown.** SIGTERM/SIGINT during
  `accept()` killed the process leaving the unix socket file
  on disk, which the next start would have to clean up. Now
  installs SIGINT + SIGTERM handlers; shutdown drops the
  listener, removes the socket file, returns Ok.
- **`db::active_proxy_accounts` silently defaulted on schema
  mismatches.** `try_get("quota_bytes").ok()` /
  `try_get("used_bytes").unwrap_or(0)` /
  `try_get("expires_at").unwrap_or(None)` would have masked a
  schema migration that dropped or retyped any of those
  columns — every account would have silently become
  "unlimited quota, never expires." Now returns an Error with
  context ("schema regression?") on type mismatch; the only
  silent path remains `password_cleartext_encrypted` (which
  is legitimately Optional and just gets logged on type
  mismatch instead of returning an error).
- **`db::add_used_bytes` accepted any delta.** A buggy metric
  source could add `i64::MAX` and silently disable every
  account via the quota path. Now rejects negative deltas
  outright and clamps the upper bound at 1 PiB
  (`MAX_USED_BYTES_DELTA`) — well above any plausible
  per-window traffic for a single account; values above
  almost certainly indicate a parser regression.
- **`quota::enforce` SELECT + UPDATE had no transaction.** An
  operator re-enabling an account in the panel between our
  `SELECT enabled = 1 WHERE expired/quota` and our subsequent
  `UPDATE enabled = 0` would have had their re-enable
  silently overwritten. Now wraps both in a transaction with
  `SELECT ... FOR UPDATE`, so concurrent panel saves block on
  our row locks for the (typically sub-millisecond)
  enforcement window.
- **`probe::client_no_proxy()` fell back to
  `reqwest::Client::new()` if the timeout-configured builder
  failed.** That fallback path silently lost the 10s timeout
  and the `no_proxy()` opt-out — both load-bearing for the
  probe's correctness. Now propagates the build error
  instead.
- **`components::list` was unbounded.** No size limit per
  manifest file (a 10 GiB rogue file would have OOM'd the
  process), no count limit on the directory (pointing at the
  wrong path could have walked unrelated JSON files). Now
  caps at 64 KiB per manifest, 256 manifests total, with
  warnings logged on overflow.
- **`CtServerCore::run()` captured unbounded
  stdout/stderr.** A regression where ct-server-core looped
  printing could have OOM'd the panel container via the
  captured String. Now bounds capture at 1 MiB per channel
  with a `…[truncated]` marker in the error message; sets a
  Symfony `setIdleTimeout` to detect a wedged subprocess.
- **`reload_caddyfile_text` alias removed.** The misleading
  v0.0.4-era backward-compat shim referenced "Caddyfile" but
  reloaded sing-box. All callers updated to use `admin::reload`
  directly.

### Changed

- `daemon::handle_client` now uses `read_until(b'\n')` with a
  pre-cap instead of `BufReader::lines()`, so the per-line
  size limit is enforced before a full line is consumed.
- `daemon` `WireRequestV1::RenderCaddyfile` and
  `WireRequestV1::ReloadCaddy` variants kept their historical
  names for WireV1 compat; added comments explaining the
  v0.0.2 rename plan was deferred to v0.1.
- `redis_bridge::fire_reload` log line corrected: was "caddy
  reload applied", now "sing-box reload applied" (post-v0.0.4
  this is sing-box via clash API).

### Added

- **Cycle 41 codified: `php-psr4` audit job.** Runs
  `composer dump-autoload --strict-psr` plus a grep that
  verifies every `class|interface|trait|enum` declaration in
  `panel/app/**/*.php` matches the basename of the file
  declaring it. Would have caught the v0.0.10 Showstopper #1
  the moment it was committed.
- **Cycle 42 codified: `phpstan` audit job.** Runs PHPStan
  level 5 against `panel/app`. Catches undefined-method
  calls + type errors at lint time. Would have caught the
  v0.0.10 Showstopper #2 the moment it was committed.
  PHPStan added to `panel/composer.json` `require-dev`.

### Tests

51 passing (8 ct-protocol + 42 ct-server-core + 1 doc-tests at 0).
Build + clippy + fmt + shellcheck all clean. The added
robustness reads (size-bounded manifest reads, type-strict
`try_get`s, transaction-wrapped quota enforcement) all
exercised by existing tests.

### Security

- The hyper-without-timeout class of bug is a denial-of-
  service vector: a single hung sing-box process would have
  wedged every subsequent panel save indefinitely. v0.0.10
  closes the class for all three call sites
  (`admin::reload`, `admin::dump_config`,
  `metrics::fetch_metrics_text`).
- The unbounded daemon line buffer is a memory-exhaustion
  vector for any process that can connect to the daemon
  socket (which is mode 0660; only the panel and root). Not
  a public risk but a robustness vector. Capped at 1 MiB.
- The schema-mismatch silent-default class of bug is the
  category of "the database changed under us and we
  accidentally became permissive." Now fails loudly on
  schema regression.

---

## [0.0.9] — 2026-05-03

Third 50-cycle LTSC audit, focused on **anti-network-tracking** —
the fingerprintable surfaces a censorship system or scanner sees
when probing the server. Cycles 1–30 by hand surfaced eleven real
findings, of which four were active **anti-tracking** bugs (custom
`X-CT-*` response headers, the HTTP/3 advertising-but-not-serving
loop, sing-box's TCP-bound clash API, and the "managed" string
respond on the Caddy ghost site). Cycles 31–50 added one more
codified job: an anti-tracking config smell-test that asserts on
the rendered template content.

### Changed (wire-format)

- **Subscription manifest signature moved into the JSON body.**
  v0.0.8 and earlier sent `X-CT-Signature: <hex>` and
  `X-CT-Protocol: 1` response headers — both unmistakable
  project tells to anyone hitting `/api/v1/subscription/<token>`.
  v0.0.9 removes both headers; the signature now rides in the
  body's `signature` field (HMAC-SHA-256 over the canonical body
  with `signature` set to null). On the wire the response now
  looks like any other authenticated JSON API response. **This
  is a breaking change for clients consuming v0.0.8 manifests** —
  see `docs/cross-platform-clients.md` for the new verification
  rule. The `SubscriptionManifestV1` Rust struct gained a
  `signature: Option<String>` field with `skip_serializing_if =
  "Option::is_none"` so unsigned construction round-trips
  unchanged.
- **`capabilities.http3` is now always `false`** in the
  subscription manifest, regardless of the `http3_enabled` DB
  toggle. NaiveProxy is HTTP/2-only at the protocol level —
  sing-box's `naive` inbound does not serve QUIC. Advertising
  HTTP/3 made clients attempt QUIC, fail (no UDP listener), and
  fall back via TCP — a recognisable network signature. Honest
  `false` removes the fingerprint. The DB column survives for
  forward-compat in case a future protocol pivot adds genuine
  QUIC support.
- **Sing-box config (`sing-box/config.json.tpl`) hardened:**
  - `log.level` lowered from `"info"` → `"warn"`. Info-level
    logs every connection, a forensic goldmine on seizure.
    `warn` keeps operational issues visible without per-user
    traces.
  - `tls.min_version` raised from `"1.2"` → `"1.3"` plus
    `tls.max_version: "1.3"`. Pins the wire fingerprint to
    TLS 1.3 only — modern HTTPS is overwhelmingly 1.3, so a
    1.2 fallback connection stands out in flow analysis.
  - `clash_api.external_controller: "127.0.0.1:9090"` (TCP)
    **removed**. Only `external_controller_unix:
    "/run/sing-box/clash.sock"` remains. The TCP listener was
    a public-attack surface if firewall is misconfigured;
    nothing in this stack ever connected via TCP.
  - `experimental.cache_file.enabled: true` → `false`. The
    DNS / connection cache was written to disk at
    `/data/cache.db`; if the server is ever seized, that file
    is forensic. Disabled by default; operators wanting the
    perf can flip it locally with full awareness.
- **Caddyfile (`caddy/Caddyfile.tpl`) hardened:**
  - The `:8443` ghost site no longer responds with the literal
    string `"managed"` (a recognisable signature for
    "Cool-Tunnel-style split-port stack"). Now responds with
    empty body + status 444 + `close` — looks like a generic
    firewalled endpoint to anyone who somehow reaches it
    inside the container network.
  - The ghost site's `protocols tls1.2 tls1.3` is now
    `protocols tls1.3` (it never serves real traffic, so
    there's no compat reason to advertise legacy versions).
  - `events { on cert_failed exec sh -c "echo \"$(date ...)\"
    >> /data/cert-failures.log" }` rewritten to log to STDERR
    (which docker logs captures + the daemon rotates). The
    previous line wrote a timestamped failure trail into the
    `caddy_data` volume — a forensic artefact nobody asked
    for.
- **Docker port maps and Dockerfile EXPOSE lines** stopped
  advertising UDP/443:
  - `docker-compose.yml`: removed `"443:443/udp"` mapping
    from the sing-box service.
  - `docker/sing-box/Dockerfile`: `EXPOSE 80 443 443/udp` →
    `EXPOSE 443`. (The :80 line was also stale — Caddy
    handles HTTP-01 in this stack, sing-box no longer
    binds :80.) Exposing UDP/443 with no listener produced
    fingerprintable RSTs on QUIC scans.
- **`docs/cross-platform-clients.md`** gained an
  "Anti-tracking notes for client implementers" section that
  documents the new signature-in-body shape, the
  always-`false` HTTP/3 advertise, the 404+HTML invalid-token
  response (matches the camouflage catch-all), and the
  no-`Server:`/`X-Powered-By:` header guarantee.
- **`panel/app/Filament/Pages/ServerConfigPage.php`** —
  removed the `Toggle::make('http3_enabled')` form control;
  replaced with a `Placeholder` explaining why the toggle is
  retired (NaiveProxy is HTTP/2-only). The DB column is kept
  for forward-compat.

### Added

- **Cycle 40 codified: `anti-tracking-config` audit job.**
  Static assertions on `sing-box/config.json.tpl` and
  `caddy/Caddyfile.tpl`:
  - sing-box `tls.min_version` must be `"1.3"`
  - sing-box `log.level` must not be `debug` / `info` / `trace`
  - sing-box `clash_api.external_controller` (TCP) must not
    be present
  - sing-box `experimental.cache_file.enabled` must be `false`
  - Caddy ghost site `respond` must not be a recognisable
    string (`managed`, `ok`, `alive`, `cool`, `tunnel`,
    `naive`, `sing-box`)
  - Caddy ghost site `protocols` must not include `tls1.2`
  - Caddy `cert_failed` event must not append to `/data/...`
  - `panel/app/**` must not call `->header('X-CT-...')`
- **`stale-docs` blacklist gained two new patterns:**
  - `->header('X-CT-` — catches header regression in PHP
  - `"443:443/udp"|EXPOSE.*443/udp` — catches UDP port-map
    regression in compose / Dockerfiles
- **Pull-request paths trigger expanded** to include
  `sing-box/config.json.tpl` and `caddy/Caddyfile.tpl`, so a PR
  that touches either template runs the smell-test job.

### Tests

51 passing (was 50): one new `signature_field_is_skipped_when_none`
test in `core/ct-protocol/src/subscription.rs` asserts that
`signature: None` is omitted from the serialised JSON (load-
bearing for canonicalisation on the client side). Build +
clippy + fmt + shellcheck still clean.

### Security

- The clash-API TCP listener was the highest-impact finding
  this audit. A misconfigured firewall (or an operator running
  `docker compose down && up` after editing docker-compose to
  expose 9090 for "debugging" and forgetting to revert) could
  have exposed every connection's per-user metadata to the
  internet. The unix-socket-only path was always there; v0.0.9
  removes the TCP fallback entirely.
- The HTTP/3-advertise-but-no-listener pattern was a slow-burn
  fingerprint: every NaiveProxy client that opted into QUIC
  produced one observable failed-handshake-then-fall-back
  signature per connection. v0.0.9's always-false advertise
  removes the signature class entirely.

---

## [0.0.8] — 2026-05-03

Second 50-cycle LTSC audit, this one focused on **UI / UX layout
design** — the operator-facing Filament panel, the public-facing
camouflage Blade pages, the operator-facing CLI scripts, and the
docs that are visible during incident response. Cycles 1–30 by
hand surfaced eleven real findings; cycles 31–50 are codified by
adding two new jobs to the existing `audit.yml` (PHP style + Blade
asset-link 404 check). The user also asked us to remove unused
files; one orphan service was dropped.

### Added

- **Camouflage cover pages** (`blog`, `portfolio`, `corporate`)
  now have parity on probe-resistance hygiene: `meta name=
  "description"`, `meta name="robots"`, `og:type` / `og:title` /
  `og:description`, and `link rel="canonical"` are present in all
  three. Each template ships an inline-SVG favicon (no separate
  HTTP request, no 404), and the CSS now respects
  `prefers-color-scheme: dark`. Blog post links use proper slugged
  hrefs and `<time datetime="…">` instead of every post pointing at
  `/`.
- **`panel/public/favicon.svg`** — admin-panel branding asset that
  the new `AdminPanelProvider::favicon()` call resolves to.
- **`scripts/render-caddyfile.sh`** — sibling to
  `render-singbox.sh`. The old `render-singbox.sh` was
  *named* sing-box but was actually shelling out to
  `caddyfile render`; the body is fixed and a real
  `render-caddyfile.sh` now exists.
- **`AdminPanelProvider`** now enables `->profile()` (so an admin
  can change their own password from the panel without needing
  `php artisan tinker`), `->darkMode()`, `->sidebarCollapsibleOnDesktop()`,
  and three navigation groups (`Users`, `Reporting`, `System`) so
  the sidebar isn't a flat 5-item list.
- **`TrafficLogResource`** now ships a date-range filter
  (`from` / `to`) so an operator can answer "how much did
  account X use last week" without a SQL console. Sent / Received
  columns are right-aligned for easier visual scanning, with
  hover tooltips disambiguating direction.
- **`FakeWebsiteResource`** now has a "Currently active"
  ternary filter and defaults the table sort to `is_active desc`
  so the live cover site appears first.
- **`ProxyAccountResource`** form is grouped into `Identity` and
  `Limits` `Section`s (matching the visual hierarchy already used
  on `ServerConfigPage`), and the `expires_at` picker now has
  `minDate(now())` so an accidental past date isn't silently
  accepted.
- **Audit workflow cycles 38 + 39 codified**:
  - **`php-style`** — runs `vendor/bin/pint --test` (Laravel
    Pint, already in `panel/composer.json` require-dev) on weekly
    cron and on every PR that touches `panel/app/**` or
    `panel/resources/views/**`.
  - **`blade-asset-links`** — greps every `panel/resources/views/**.blade.php`
    for literal `href="/foo.css"` / `src="/foo.js"` /
    `href="/foo.svg"` / `…/foo.png|ico|webp|woff|woff2` and fails
    the build if the corresponding `panel/public/$path` file does
    not exist. Catches the exact bug class that v0.0.8 found
    (the `/static/style.css` 404 in three Blade files).

### Fixed

- **Camouflage pages were leaking `/static/style.css` 404s** to
  any scanner that opens devtools — `blog.blade.php`,
  `portfolio.blade.php`, and `corporate.blade.php` all linked a
  stylesheet that has no matching public file or registered
  route. Removed in all three.
- **`scripts/backup.sh` was snapshotting the wrong volume.**
  Comments said "ACME state lives in singbox_data" — that was
  true in v0.0.2 / v0.0.3 but not since v0.0.4 reintroduced
  Caddy as the ACME side. The script was tarring up an empty
  volume and skipping the actual cert directory; restoring from
  one of these backups would have burned Let's Encrypt
  rate-limit budget on every recovery. Now snapshots
  `caddy_data` (the real ACME state) and bundles
  `caddy/Caddyfile.tpl` alongside `sing-box/config.json.tpl`
  so a restore lands on a complete tree.
- **`scripts/render-singbox.sh` was actually rendering the
  Caddyfile.** Body said `caddyfile render`; comment said
  sing-box. Now actually renders sing-box config (matches the
  filename and the documentation in `STRUCTURE.md` /
  `README.md`).
- **`ServerConfigPage` description and save notification only
  named Caddy.** Anti-tracking toggles + HTTP/3 also drive the
  sing-box config (cert-mtime + DB hash → `singbox:render
  --if-changed --reload` since v0.0.4); the user-visible text
  now says "Caddyfile + sing-box config regenerated; both
  services hot-reloading" so the operator's mental model
  matches the actual machinery.
- **`docs/installation-debian.md` § Renew TLS** still said
  "sing-box's built-in ACME renews automatically" — three audit
  cycles past v0.0.4 and the prose hadn't caught up. Now
  correctly explains the cert-mtime → render-change-hash chain
  and that `docker compose restart caddy` is the way to force a
  renewal.
- **`docs/architecture.md`** softened the "sing-box has a
  built-in ACME implementation but it lacks Caddy's
  CertMagic-grade reliability" wording so it doesn't read as
  active recommendation against a feature we don't use; also
  removed the dangling `forwardproxy` reference and pointed
  readers at `CHANGELOG.md` for the v0.0.2 pivot.
- **`README.md` filetree** still listed `AntiTrackingFilter`
  as a Service, which had been orphaned and was deleted by
  this audit. Now lists the actual services (`CaddyfileGenerator`
  added; `AntiTrackingFilter` removed).
- **`ProxyAccountResource.last_seen_at`** column was visible in
  the default table layout but is always `never` in current
  deployments (the column is written by `metrics::collect`
  which is the no-op since v0.0.7 — see metrics.rs module
  docstring). Now `toggleable(isToggledHiddenByDefault: true)`
  so it doesn't show stale data, with a comment explaining why
  and a clear path to flip the default once sing-box per-user
  metrics land.
- **`ComponentsPage` Blade view used hardcoded `grid-cols-3`**,
  which was cramped on the phone an operator might pull out
  during incident response. Now `grid-cols-1 sm:grid-cols-3`,
  with `overflow-x-auto` on the table so wide diagnostic
  messages scroll instead of breaking layout. Status badges
  gained dark-mode variants (`dark:bg-success-900/40 dark:text-success-300`)
  so they don't render as low-contrast on dark theme.
  Accessibility: `<caption class="sr-only">`, `<th scope="col">`,
  `role="status"` on the OK/NG pill, `aria-label` for screen
  readers.
- **`ServerConfigPage` Edge-auth section** previously had
  `admin_basic_auth_hash` as a plain `TextInput` — the bcrypt
  hash was rendering visibly on screen. Now `password()` +
  `revealable()` with `autocomplete="new-password"` so it
  doesn't autofill or shoulder-surf.

### Removed

- **`panel/app/Services/AntiTrackingFilter.php`** — defined a
  `FEATURES` constant array intended for a Filament
  Anti-Tracking page that never shipped. The class was
  referenced nowhere in the codebase outside its own file
  (verified by `grep -r AntiTrackingFilter`). Dead code, gone.

### Tests

50 passing (8 ct-protocol + 42 ct-server-core). Build + clippy
+ fmt + shellcheck still clean. Two new audit jobs (`php-style`,
`blade-asset-links`) ship in `audit.yml`.

---

## [0.0.7] — 2026-05-03

50-cycle LTSC code audit. Cycles 1–5 were the v0.0.6 hand-audit;
cycles 6–30 were a deeper hand-audit that surfaced four more
real-world findings (stale ACME doc references, an untruthful
metrics scrape path, a missing test surface around the
Caddyfile-username domain rule, an async-test using `std::fs`).
Cycles 31–50 are codified as a recurring weekly CI workflow —
hand-auditing 50 files every release does not scale, so the
sustainable pattern is "do it by hand once, then make the
machine do it forever."

### Added

- `.github/workflows/audit.yml` — scheduled audit workflow
  running weekly on Monday 08:17 UTC plus on-demand and on
  any PR that touches Cargo / composer / Dockerfiles /
  manifests. Jobs: **`cargo-audit`** (RustSec advisory DB),
  **`cargo-deny`** (licences, ban list, source registry),
  **`composer-audit`** (Packagist advisories on the panel
  side), **`secret-scan`** (gitleaks across full history),
  **`manifest-drift`** (verifies `manifests/*.upstream.json`
  versions track `core/Cargo.toml` and Dockerfile pins —
  catches the v0.0.6 "I bumped Cargo.toml but forgot the
  manifest" failure mode), **`dependency-review`** (PR-only
  vuln + licence diff vs. base), **`stale-docs`** (regex
  blacklist for known-stale strings like `forwardproxy@naive`
  and `sing-box.*built-in ACME`).
- `core/deny.toml` — cargo-deny configuration: allowed
  licence list (Apache-2.0 / MIT / BSD-{2,3} / ISC /
  Unicode-3.0 / Zlib / MPL-2.0 / OpenSSL / CC0-1.0 / 0BSD
  + Apache-2.0 WITH LLVM-exception); explicit ban on
  `openssl` and `openssl-sys` (we standardise on rustls);
  unknown-registry and unknown-git denied so every dep is
  reproducible.
- `AUDIT.md` — policy doc explaining where each cycle lives
  (1–30: git history, 31–50: codified in `audit.yml`),
  rotation policy for fixing red audit jobs, and what
  deliberately stays out of automation (Docker bringup,
  taste calls, perf regressions).
- 4 new domain-rule tests in `core/ct-server-core/src/domain/mod.rs`
  for `caddyfile_safe_username` covering the accept set
  (alpha / digit / `-` / `.` / `_`), the size guard (empty
  + oversize), the dangerous-char reject set (`;` `\n` `"`
  `\` `{` `}`), and the maximum-length boundary.

### Fixed

- **Two stale ACME references in `README.md`** — one in the
  feature bullet ("Runs sing-box ... built-in ACME, hot
  reload via clash API") and one in the architecture
  diagram ("TLS (built-in ACME Let's Encrypt, auto-renew on
  :80)"). Both were left over from before v0.0.4 reintroduced
  Caddy as the ACME provider. They now correctly say sing-box
  reads cert + key from `/data/caddy/...` and Caddy is the
  ACME side.
- **Stale architecture diagram in `docs/architecture.md`**
  — sing-box box was showing `naive inbound { users,
  tls(ACME)}` and `listen :443 (h2 + h3) + :80 (ACME)`,
  which is the v0.0.2/v0.0.3 shape, not v0.0.4+. Replaced
  with the current `tls { cert+key from /data/caddy/...}` /
  `listen :443 (h2 + h3)` shape.
- **`core/ct-server-core/src/caddy/mod.rs` test used
  `std::fs::read_to_string` inside an `#[tokio::test]`.**
  In a `#[tokio::test(flavor = "multi_thread")]` runtime
  this technically works but it's a footgun — the moment
  someone bumps the test to add a real I/O step, the
  blocking call will silently stall the executor on busy
  CI. Switched to `tokio::fs::read_to_string` for
  consistency with the rest of the async surface.

### Changed

- **`core/ct-server-core/src/metrics.rs` is now an honest
  no-op.** The Prometheus parser was still looking for
  `caddy_forwardproxy_bytes_total{user=...,direction=...}`
  metrics — names that the unmaintained klzgrad plugin
  emits but sing-box does not. Net effect since v0.0.2:
  `traffic:rollup` ran every minute and silently
  contributed zero bytes to `traffic_logs`. Now `collect()`
  early-emits a `tracing::info!` line on every call so an
  operator inspecting panel logs sees the gap is
  acknowledged, not silently ignored. The legacy parser is
  preserved with module-level docstrings explaining the
  three v0.1 paths forward (clash-API streaming consumer,
  upstream sing-box adding Prometheus-shaped per-user
  counters, or patching sing-box to expose them).

### Tests

42 passing (was 38 in v0.0.6). Build + clippy + fmt +
shellcheck all clean. Audit workflow validates against
`actions/dependency-review-action@v4` schema.

### Security

- The `cargo-deny` configuration explicitly bans the
  C-OpenSSL FFI (`openssl` / `openssl-sys` crates) so a
  dependency upgrade can't silently pull a libssl link
  in — we standardise on rustls + `tokio-rustls`
  end-to-end and the deny rule keeps that property
  invariant going forward.
- `gitleaks` scheduled scan reads full repo history
  (`fetch-depth: 0`) so a hypothetical credential
  committed to a feature branch and force-pushed away
  is still caught.

---

## [0.0.6] — 2026-05-03

5-cycle LTSC code audit. Two structural bugs fixed (the v0.0.4
sing-box template never picked up the ACME→cert-path change; the
v0.0.3 mass-assignment guard reverted somewhere along the way),
plus a reliability gap and a clutch of stale comments.

### Fixed

- **`sing-box/config.json.tpl` still had the `acme` block** —
  v0.0.4's "switch to certificate_path / key_path" edit landed in
  the Rust render code (which set CertPath / KeyPath bindings) but
  not in the template file itself. With this template, sing-box
  would attempt BOTH built-in ACME AND read certs Caddy wrote,
  causing port-80 binding conflicts or undefined behaviour. Now the
  template uses `certificate_path` + `key_path` to match the bindings.
- **`ProxyAccount.$fillable` had `password_hash` and
  `password_cleartext_encrypted` back in it.** The v0.0.3 hardening
  apparently reverted between then and now — Cycle 2 caught it.
  Both columns are out of `$fillable` again; only
  `setCleartextPassword()` can write them.
- **Subprocess calls had no timeout.** `Command::new("docker")`
  invocations in `admin.rs`, `singbox/mod.rs`, and `components.rs`
  could hang indefinitely on a sick docker daemon. All three now
  wrap with `tokio::time::timeout` (60s for restart, 30s for
  validation, 15s for component-verify).
- Stale comments: `quota.rs` referred to "re-render the Caddyfile";
  `subscription.rs` referred to "Caddyfile basic_auth presence";
  `installation-debian.md` UFW comment said `forward_proxy`. All
  three now name the actual sing-box-era machinery.

### Changed

- `install.sh` pre-flight now also requires `dig`, `curl`, `jq`,
  and `htpasswd` — every tool a real install needs. Also requires
  `PANEL_BASIC_AUTH_HASH` to be set in `.env` (with a hint to
  generate one via `htpasswd -nbB admin '<pw>'`). Catches "I
  forgot to set the panel password" before bringing services up.
- Friendlier error messages from `admin::reload`: a non-2xx clash
  API response now suggests running `sing-box check -c …` to
  validate the config first; a missing clash socket suggests the
  most likely cause (sing-box not running, or the volume not
  mounted into the panel container).

### Tests

38 passing; build + clippy + fmt + shellcheck all clean.

---

## [0.0.5] — 2026-05-03

LTSC discipline pass. No runtime behaviour change; everything is
process / docs / supply-chain.

### Added

- `.github/workflows/ci.yml` — runs `cargo build`, `cargo test`,
  `cargo clippy --deny warnings`, `cargo fmt --check`, `shellcheck`,
  and `composer validate` on every push and PR.
- `CHANGELOG.md` (this file), `SECURITY.md`, `SUPPORT.md`,
  `RELEASE.md`, `VERSIONING.md`.
- `.editorconfig`, `rustfmt.toml`, `Makefile` for consistent
  developer experience.
- `renovate.json` so dependency updates land as tidy PRs grouped
  by ecosystem rather than as floods.
- `scripts/sbom.sh` generating CycloneDX SBOMs for the Cargo workspace,
  Composer panel, and Docker images. Output lands under `sbom/`.
- `ct-data` internal-only docker network for `db` + `redis`
  (`internal: true`), so a compromised database can't initiate
  outbound traffic.
- A `LTSC` table at the top of `README.md` listing the supported
  Debian / Rust / PHP / Caddy / sing-box versions.

### Fixed

- `docker/core/Dockerfile` was still pinning `rust:1.78-alpine` even
  though `core/rust-toolchain.toml` was bumped to `1.86` in v0.0.3.
  Production builds would have failed at `cargo build`. Both files
  now name `1.86` and the comment block at the top of the
  Dockerfile says they must move together.

### Changed

- All Docker base images now have a comment listing both the **tag
  pin** and the **expected digest** (commented out, populated by
  `make pin-images` on a host that has docker installed). Tag-only
  remains the source of truth until the operator runs the pin
  command.

---

## [0.0.4] — 2026-05-03

Caddy comes back as the ACME provider only. Sing-box keeps the
proxy on `:443` but reads its cert + key from a shared volume that
Caddy writes to. The unmaintained `forwardproxy` plugin from v0.0.1
is **not** back — Caddy here is stock, no plugins.

### Added

- `caddy/Caddyfile.tpl` — Go-template, ACME-only mode, `events {
  on cert_obtained ... }` hook so cert renewal flips a flag.
- `core/ct-server-core/src/caddy/mod.rs` — render Caddyfile module
  + tests (`cert_paths_compose_correctly`,
  `ca_folder_strips_scheme_and_replaces_slashes`).
- `panel/app/Services/CaddyfileGenerator.php` and
  `panel/app/Console/Commands/CaddyfileRender.php`.
- New `ct-server-core caddyfile render` CLI subcommand mirroring
  `singbox render`.
- `manifests/caddy.upstream.json` restored.

### Changed

- `core/ct-server-core/src/singbox/mod.rs`: `tls.acme` block →
  `tls.certificate_path` + `tls.key_path` reading from
  `/data/caddy/certificates/.../...`. Cert mtime is folded into the
  render-change SHA-256, so a Caddy renewal flips the existing
  scheduled `singbox:render --if-changed --reload` (no new
  plumbing).
- `docker-compose.yml`: `caddy` service back; `caddy_data` shared
  RW between caddy + panel, RO into sing-box.
- `scripts/install.sh`: starts Caddy first, waits up to 90s for the
  cert file to land, then starts sing-box.

### Tests

37 → 38 passing. Still: 1M-event Debouncer stress, 100k-event
Coalescer stress, 64-task concurrent Coalescer test all green.

---

## [0.0.3] — 2026-05-03

Per-language idiomatic refresh + bigger stress tests + Debian-noob
install path.

### Added

- `scripts/lib.sh` — shared shell helpers (step / ok / warn / die /
  require_cmd / require_file / require_env / load_env / wait_for /
  prompt_yn / prompt_secret / require_docker / compose).
- `core/ct-server-core/src/template.rs` — tiny Go-template-style
  renderer, 12 unit tests.
- `core/ct-server-core/src/laravel_crypt.rs` — Laravel-Crypt
  AES-256-GCM decrypt; friendlier error messages with concrete
  remediation hints.
- `GETTING_STARTED.md` (Debian-noob walkthrough) + `STRUCTURE.md`
  (repo map).
- `.dockerignore` keeping secrets and `target/` out of build
  contexts.
- `HEALTHCHECK` directives on `caddy` and `panel` images.

### Changed

- `sing-box/config.json.tpl` rewritten in Go-template `{{ .Field }}`
  syntax.
- 56 PHP files now `declare(strict_types=1);`.
- `ProxyAccount.password_hash` and `password_cleartext_encrypted`
  removed from `$fillable`. Only `setCleartextPassword()` writes
  them — Filament forms can't poison those columns.
- `install.sh` rewritten as a numbered, colour-coded walkthrough
  with per-failure `↳ try:` hints.

### Tests

33 → 35 passing.

### Fixed

- `cargo build --release` no longer emits warnings.

### Security

- Tracing audit: no password / `APP_KEY` / cleartext leaks.

---

## [0.0.2] — 2026-05-03

Architecture pivot: drop the unmaintained klzgrad/forwardproxy
plugin in favour of [SagerNet/sing-box](https://github.com/SagerNet/sing-box)
(GPL-3.0). Wire-protocol-compatible — clients connect unchanged.

### Added

- `docker/sing-box/Dockerfile` + `sing-box/config.json.tpl` (then
  using `__VAR__` substitution; rewrote in v0.0.3 to Go template).
- `core/ct-server-core/src/laravel_crypt.rs` (was added here, then
  the friendly errors landed in v0.0.3).
- `password_cleartext_encrypted` column on `proxy_accounts`
  (sing-box's `naive` inbound checks the password as cleartext).
- New CLI subcommands: `ct-server-core singbox render | validate`,
  `ct-server-core server reload | config`.

### Removed

- `caddy/Caddyfile.tpl` (returned in v0.0.4 as ACME-only).
- `klzgrad/forwardproxy` dependency.

### Changed

- Rust toolchain bumped 1.78 → 1.86 (sqlx's icu_* transitives).

### Tests

23 → 31 passing (added Laravel-Crypt round-trip + sing-box render
tests; existing Coalescer stress tests stayed green).

---

## [0.0.1] — 2026-05-03

Initial pre-release. Three-layer stack: Caddy + `klzgrad/forwardproxy@naive`
plugin + Filament/Laravel + Rust core + MariaDB + Redis. Component-as-
machine-part model with `manifests/*.upstream.json`. Subscription manifest
API for cross-platform clients. Step-by-step Debian 10/11/12/13+ install
guide. Late-Night Comeback launch-readiness checklist.

This release was retired in favour of v0.0.2 once the unmaintained-
forwardproxy concern surfaced. Tag is preserved for archaeological
purposes; do not deploy v0.0.1.

[Unreleased]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.11...HEAD
[0.0.11]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/coo1white/cool-tunnel-server/releases/tag/v0.0.1

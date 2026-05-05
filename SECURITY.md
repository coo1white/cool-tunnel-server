# Security policy

Cool Tunnel Server is a self-hosted proxy stack. By design it
processes traffic on behalf of users and holds the credential store
that authorises that traffic. Vulnerabilities in this codebase
matter and we treat reports seriously.

## Supported versions

We patch security issues on a rolling-LTSC cadence. The supported
matrix at any time is the **most recent two minor release lines**:

| Version line | Status | Security patches | Bug fixes | Feature work |
| --- | --- | --- | --- | --- |
| `0.0.x` (current) | **Pre-release / active** | yes | yes | yes |
| earlier (no minors yet) | n/a | — | — | — |

Once we cut `0.1.0`, the policy becomes:

| Version line | Status | Security patches | Bug fixes | Feature work |
| --- | --- | --- | --- | --- |
| `0.1.x` (current) | active | yes | yes | yes |
| `0.0.x` (legacy) | maintained | yes (for 90 days after `0.1.0`) | no | no |

Older lines are unsupported and operators MUST upgrade. Each
release page on GitHub spells out the supported-until date for that
line explicitly.

## Reporting a vulnerability

**Please do NOT open a public GitHub issue for security
vulnerabilities.** Use one of these channels instead:

- [GitHub Security Advisory][gh-advisory] — preferred. Fully
  private, lets us coordinate a fix and credit you in the advisory.
- Email — TBD; once we publish a contact address we will sign
  the announcement with the same key the v0.1+ tags will be
  signed with.

[gh-advisory]: https://github.com/coo1white/cool-tunnel-server/security/advisories/new

When you report, please include:

1. The version (commit SHA + tag if any) you saw the issue on.
2. A minimal reproduction or proof-of-concept.
3. Your assessment of impact (what an attacker could do).
4. Any mitigations or workarounds you've identified.

We'll acknowledge within **72 hours** and aim to ship a fix or
mitigation within **14 days** for critical issues, **30 days** for
high, **90 days** for medium / low.

## What we consider in-scope

| Category | Examples |
| --- | --- |
| **Auth bypass** | Sneaking past basic_auth on the naive inbound; bypassing the panel admin login |
| **Privilege escalation** | A proxy user reaching the Filament admin or DB; a `viewer`-role admin bypassing `User::canAccessPanel()` |
| **Credential disclosure** | Cleartext password leak via tracing, logs, error responses; subscription HMAC tokens persisted in any log file |
| **Memory safety** | Anything reachable from untrusted input that triggers UB in Rust (we `forbid(unsafe_code)`) |
| **Cryptographic weakness** | Wrong AEAD nonce reuse, weak HMAC verification, broken cert pinning, deterministic clash-API bearer derivation |
| **Supply-chain integrity** | A pinned manifest's verifier passing on a tampered binary |
| **Denial-of-service** | An unauthed CONNECT or panel request that takes down sing-box / panel / db |
| **Information leak via probe** | An unauthed probe that fingerprints us as a proxy despite probe-resistance settings |
| **Cover-site invariant violation** | Any wire-level shape that distinguishes a Cool Tunnel Server from a static-website host of the same hosting class — distinct status, response time, body length, headers (`Server`, `X-Powered-By`), missing/present validators (`ETag`, `Last-Modified`) on `/api/v1/subscription/<garbage>` vs `/random-path`, 429 vs 200 on rate-limit hit, or exception traces under any failure mode. (v0.0.14 lifted this to a hard release-blocking property.) |

## What's out of scope

| Category | Why |
| --- | --- |
| Operator misconfiguration | The `.env` file is the operator's responsibility (passwords, DOMAIN, etc.) |
| Issues in the upstream NaiveProxy protocol | Report to klzgrad/naiveproxy |
| Issues in sing-box itself | Report to SagerNet/sing-box |
| Issues in the macOS client | Report to coo1white/cool-tunnel |
| Censorship-system specific fingerprinting that requires a known censor's cooperation | This is research, not a vulnerability |
| Reports requiring a privileged network position (passive global adversary, ISP-level MitM) | Outside the proxy's threat model |

## Coordinated disclosure

We follow a 90-day default disclosure window. If you intend to
publicly disclose, please coordinate with us so we can ship a fix
first. We're happy to credit reporters in the advisory and the
release notes.

## Defensive defaults

The server ships with:

- `forbid(unsafe_code)` and `deny(clippy::unwrap_used,
  clippy::expect_used, clippy::panic, clippy::todo,
  clippy::unimplemented)` workspace-wide.
- `declare(strict_types=1);` on every panel PHP file.
- `password_hash`, `password_cleartext_encrypted`, `password`,
  `role`, and `is_active` removed from `$fillable` so
  mass-assignment can't poison them. Privileged fields are set via
  explicit setters or seeders, never `Model::create($request->all())`.
- Constant-time HMAC verification (`hash_equals` in PHP, byte-wise
  comparison via `aes-gcm` 0.10's tag check in Rust).
- **TLS 1.3 only** on the proxy listener (`min_version =
  max_version = "1.3"` in the rendered sing-box config). No
  legacy-protocol fallback surface.
- DNS-over-HTTPS for the proxy's outbound resolution.
- **Cover-site invariant on every public route** (v0.0.14): any
  unknown URL, rate-limited request, expired token, empty
  `APP_KEY`, or uncaught panel exception renders byte-identical
  to `FakeSiteController` (status 200, `Content-Type: text/html`,
  deterministic `sha256`-derived ETag). The custom Laravel
  exception handler in `bootstrap/app.php` enforces this for
  uncaught throwables; the in-controller anti-enumeration limiter
  in `SubscriptionController` enforces it for rate-limit hits.
- **Subscription HMAC tokens masked in all panel logs** (v0.0.14).
  The panel's nginx access log rewrites
  `/api/v1/subscription/<token>` to
  `/api/v1/subscription/<masked>` before write. Caddy ships with
  no access log directive at all.
- **No engine-fingerprint headers** in cover-site responses
  (v0.0.14): `Server: Caddy` stripped via `header -Server` in the
  Caddyfile, `X-Powered-By` disabled via `expose_php = Off` in
  the panel's PHP hardening drop-in, nginx `server_tokens off`.
- **Login rate limiter binds across three dimensions**
  (v0.0.13 + v0.0.14): per-(email|ip), per-ip, and per-email —
  defeating both single-email IP-rotation and single-IP
  email-rotation brute-force shapes.
- **Three internal-only docker networks** isolate the management
  surface from the proxy data plane (v0.0.13 introduced
  `ct-clash`): `ct-data` (db + redis), `ct-clash` (panel ↔
  sing-box clash-API — caddy is deliberately NOT a member), and
  `ct-net` (the public-facing leg). A compromised caddy cannot
  reach the management plane; a compromised db cannot phone home.
  The `ct-clash` subnet is operator-tunable via `CT_CLASH_SUBNET`
  / `CT_CLASH_SINGBOX_IP` for collision recovery (v0.0.14).
- **Per-install random clash-API bearer**: derived from
  `sha256("ct-clash-secret-v1:" || CT_CLASH_SECRET_SEED)`; install
  generates the seed from `/dev/urandom` on first boot. Rotating
  the seed invalidates any captured bearer.
- **Refuse-to-boot guards** on missing `APP_KEY` (subscription
  endpoint) and missing `CT_CLASH_SECRET_SEED` (clash-API
  rendering) — fail-loud with a remediation hint rather than
  silently falling back to a deterministic default.
- **`DB::afterCommit` semantics on every `ProxyAccount` save +
  delete** (v0.0.15). A rolled-back transaction never leaves a
  Redis ghost-revocation flag or a phantom queued reload — the
  announce + dispatch fire only after the outermost transaction
  commits. Verified by `tests/Feature/ProxyAccountAfterCommitTest`.
- **Atomic config write fsyncs the parent directory after rename**
  (`core/ct-server-core/src/singbox/mod.rs`, v0.0.15). Power loss
  between rename and the next implicit sync no longer reverts
  the directory entry — sing-box never loads a stale
  config.json on next boot.
- **Caddyfile-injection guard at the binding site** (v0.0.16).
  `template::caddyfile_validate` rejects any
  operator-controlled value containing `\n`/`\r`/`{`/`}`/`"`
  before render — closes the class of attack where a hostile
  DOMAIN breaks out of `{{ .Domain }}:8443 { … }` and injects
  a Caddy admin endpoint.
- **`composer install --no-scripts` on every panel boot**
  (v0.0.16). Transitive Composer packages cannot execute
  arbitrary code via `post-install-cmd` / `post-autoload-dump`
  hooks during `vendor/` bootstrap.
- **`cap_drop: [ALL]` + `security_opt: no-new-privileges` on
  every container** (v0.0.17). caddy + sing-box add back
  `NET_BIND_SERVICE` for privileged ports; nothing else needs
  any capability. RCE in any container can no longer wield raw
  capabilities even if the exploited binary ran as root.
- **Browser-side hardening on `/admin`** via
  `App\Http\Middleware\SecurityHeaders` (v0.0.18) — emits
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (deny camera/microphone/geolocation/
  payment/usb), `Cache-Control: no-store, must-revalidate`, and
  two-year HSTS on every panel response.
- **Scheduled-task failure logging** (v0.0.18). Every entry in
  `routes/console.php` (`traffic:rollup`, `quota:enforce`,
  `singbox:render`) registers `->onFailure(...)` that emits
  `Log::critical('schedule.failed', …)`. Pre-fix, scheduler
  failures were silently swallowed — a `quota:enforce` crash
  would let over-quota users keep tunneling forever with no
  operator signal.

## Test coverage

- **`core/ct-server-core` Rust unit tests**: 64 passing across
  workspace as of v0.0.20.
- **`panel/tests/`**: 13 PHPUnit cases as of v0.0.20:
  4 in `CoverSiteInvariantTest`, 5 in `UserCanAccessPanelTest`,
  4 in `ProxyAccountAfterCommitTest`. CI runs `vendor/bin/phpunit`
  on every PR.

## Audit-ability

- **Reproducible builds**: every release tag pins to specific
  upstream image tags + Cargo.lock + composer.lock. See `RELEASE.md`
  for the bit-for-bit reproduction recipe.
- **SBOM**: every release ships a CycloneDX SBOM under `sbom/` of
  the Cargo workspace, Composer dependency graph, and Docker image
  layers. Generate locally with `make sbom`.
- **Manifest verifier**: `ct-server-core component check` walks
  `manifests/*.upstream.json` and prints OK/NG for every component
  on every release. The same check runs in CI.

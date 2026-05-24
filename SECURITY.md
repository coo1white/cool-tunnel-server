# Security policy

cool-tunnel-server is a self-hosted proxy stack. By design it
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
| **Auth bypass** | Bypassing VLESS UUID auth; bypassing the panel admin login |
| **Privilege escalation** | A proxy user reaching the admin panel or DB; a `viewer` role bypassing protected Hono route checks |
| **Credential disclosure** | Cleartext password leak via tracing, logs, error responses; subscription HMAC tokens persisted in any log file |
| **Memory safety** | Anything reachable from untrusted input that triggers UB in Rust (we `forbid(unsafe_code)`) |
| **Cryptographic weakness** | Wrong AEAD nonce reuse, weak HMAC verification, broken cert pinning, weak Reality key handling |
| **Supply-chain integrity** | A pinned manifest's verifier passing on a tampered binary |
| **Denial-of-service** | An unauthed CONNECT or panel request that takes down sing-box / panel / db |
| **Information leak via probe** | An unauthed probe that fingerprints us as a proxy despite probe-resistance settings |
| **Cover-site invariant violation** | Any wire-level shape that distinguishes cool-tunnel-server from a static-website host of the same hosting class — distinct status, response time, body length, headers (`Server`, `X-Powered-By`), missing/present validators (`ETag`, `Last-Modified`) on `/api/v1/subscription/<garbage>` vs `/random-path`, 429 vs 200 on rate-limit hit, or exception traces under any failure mode. (v0.0.14 lifted this to a hard release-blocking property.) |

## What's out of scope

| Category | Why |
| --- | --- |
| Operator misconfiguration | The `.env` file is the operator's responsibility (passwords, DOMAIN, etc.) |
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
- Better Auth owns password hashing, signed httpOnly cookie sessions,
  session storage, and email/password login security.
- Admin role checks stay close to protected Hono routes and use the
  small owner/admin/operator/viewer model.
- Constant-time HMAC verification for bootstrap token hashes and
  byte-wise comparison via `aes-gcm` 0.10's tag check in Rust.
- **TLS 1.3 only** on the proxy listener (`min_version =
  max_version = "1.3"` in the rendered sing-box config). No
  legacy-protocol fallback surface.
- DNS-over-HTTPS for the proxy's outbound resolution.
- **Secret redaction in diagnostics and logs** masks subscription
  URLs, bootstrap setup tokens, UUIDs, Better Auth secrets, database
  passwords, Redis passwords, and secret-looking JSON fields.
- **No engine-fingerprint headers** in cover-site responses
  (v0.0.14): `Server: Caddy` stripped via `header -Server` in the
  Caddyfile; the Bun admin server does not emit framework banners.
- **Login rate limiting** is enabled in Better Auth. It keys on the
  `X-Forwarded-For` value set by the Caddy panel proxy; do not expose
  the panel container port directly to the public internet.
- **Network isolation**: `ct-net` carries the public-facing Caddy,
  panel, and sing-box traffic; `ct-data` is internal-only for db,
  redis, and panel. A compromised db or redis cannot phone home.
- **Refuse-to-boot guards** on missing `BETTER_AUTH_SECRET` — fail
  loudly with a remediation hint rather than falling back to a
  deterministic default.
- **First-owner bootstrap** uses expiring one-time tokens. Raw tokens
  are not logged, passwords are never generated or printed, and
  bootstrap is disabled automatically once an owner exists.
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
- **`cap_drop: [ALL]` + `security_opt: no-new-privileges` on
  every container** (v0.0.17). caddy + sing-box add back
  `NET_BIND_SERVICE` for privileged ports; nothing else needs
  any capability. RCE in any container can no longer wield raw
  capabilities even if the exploited binary ran as root.
- **Browser-side hardening on `/admin`** via Hono middleware emits
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`,
  `Permissions-Policy` (deny camera/microphone/geolocation/
  payment/usb), and a constrained Content Security Policy.
- **Admin mutations use CSRF/origin checks** for browser actions
  outside Better Auth's own `/api/auth/*` handlers.

## Test coverage

- **`core/ct-server-core` Rust unit tests**: 64 passing across
  workspace as of v0.0.20.
- **`operator/tests/`**: Bun tests cover admin bootstrap, login,
  route protection, role authorization, migrations, redaction,
  deployment file guards, and operator workflows.

## Audit-ability

- **Reproducible builds**: every release tag pins to specific
  upstream image tags, Cargo.lock, and Bun lockfiles. See `RELEASE.md`
  for the bit-for-bit reproduction recipe.
- **SBOM**: every release ships a CycloneDX SBOM under `sbom/` of
  the Cargo workspace, Bun dependency graph, and Docker image
  layers. Generate locally with `make sbom`.
- **Manifest verifier**: `ct-server-core component check` walks
  `manifests/*.upstream.json` and prints OK/NG for every component
  on every release. The same check runs in CI.

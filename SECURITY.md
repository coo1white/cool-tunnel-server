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
| **Privilege escalation** | A proxy user reaching the Filament admin or DB |
| **Credential disclosure** | Cleartext password leak via tracing, logs, error responses |
| **Memory safety** | Anything reachable from untrusted input that triggers UB in Rust (we `forbid(unsafe_code)`) |
| **Cryptographic weakness** | Wrong AEAD nonce reuse, weak HMAC verification, broken cert pinning |
| **Supply-chain integrity** | A pinned manifest's verifier passing on a tampered binary |
| **Denial-of-service** | An unauthed CONNECT or panel request that takes down sing-box / panel / db |
| **Information leak via probe** | An unauthed probe that fingerprints us as a proxy despite probe-resistance settings |

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
- `password_hash` and `password_cleartext_encrypted` removed from
  `$fillable` so mass-assignment can't poison them.
- Constant-time HMAC verification (`hash_equals` in PHP, byte-wise
  comparison via `aes-gcm` 0.10's tag check in Rust).
- TLS 1.2 minimum on the proxy listener.
- DNS-over-HTTPS for the proxy's outbound resolution.
- No cleartext request URLs or response bodies in any access log
  by default.
- A separate internal-only docker network for `db` + `redis` so
  a compromised database can't initiate outbound traffic.

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

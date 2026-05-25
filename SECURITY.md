# Security Policy

cool-tunnel-server is a self-hosted proxy stack. It processes user
traffic and stores credentials for the admin and proxy-account control
plane, so vulnerabilities matter and reports are treated seriously.

## Supported Versions

Security patches follow the active release line. During the v0.x period,
operators should run the newest published release unless a release page
states a longer support window.

| Version line | Status | Security patches |
| --- | --- | --- |
| `0.5.x` | active | yes |
| older lines | upgrade required | no, unless a release advisory says otherwise |

## Reporting A Vulnerability

Do not open a public GitHub issue for security vulnerabilities. Use
[GitHub Security Advisories][gh-advisory] instead.

[gh-advisory]: https://github.com/coo1white/cool-tunnel-server/security/advisories/new

Please include:

1. Version or commit SHA.
2. A minimal reproduction or proof of concept.
3. Expected impact.
4. Any mitigation you already identified.

We aim to acknowledge within 72 hours and ship a fix or mitigation
within 14 days for critical issues, 30 days for high issues, and 90
days for medium or low issues.

## In Scope

| Category | Examples |
| --- | --- |
| Auth bypass | Bypassing Better Auth admin login, sessions, or proxy UUID auth |
| Privilege escalation | Viewer/operator/admin role boundaries failing server-side |
| Credential disclosure | Passwords, cookies, bootstrap tokens, subscription URLs, UUIDs, database paths, or private keys in logs/errors/HTML |
| Storage safety | Migration bugs that silently drop users, roles, settings, or proxy-account data |
| Cryptography | Weak session secrets, broken token hashing, weak Reality key validation |
| Supply chain | A manifest verifier accepting tampered release artifacts |
| Denial of service | Unauthenticated requests taking down admin-api, admin-web, Caddy, or sing-box |
| Fingerprinting | Public routes leaking proxy-specific headers, traces, or distinct error bodies |

## Out Of Scope

| Category | Why |
| --- | --- |
| Operator misconfiguration | The operator owns domain, DNS, firewall, and `.env` choices |
| Vulnerabilities in sing-box itself | Report upstream to SagerNet/sing-box |
| Client app issues | Report to the relevant client repository |
| Reports requiring a privileged global network position | Outside the server threat model |

## Defensive Defaults

The v0.5.2 stack ships with these active controls:

- Next.js admin UI talks only to the Hono API.
- Hono API owns auth, sessions, authorization, admin APIs, audit logs,
  settings, proxy-account management, and migration status.
- Better Auth session cookies are httpOnly, SameSite=Lax, and Secure in
  production after HTTPS validation.
- Public signup is disabled by default and there are no default
  credentials.
- Login and setup credentials are submitted through server-side POST,
  never credential-bearing URLs.
- Login/setup query strings are scrubbed, and sensitive responses use
  no-store/no-referrer headers.
- Login pages use restrictive CSP; credential-bearing scripts are not
  required.
- Bootstrap material is written to a root-only file and is not printed
  as normal terminal output.
- Caddy HTTP redirects use query-stripping paths.
- Secret redaction is centralized in `packages/security` and is used by
  API logs, operator output, doctor diagnostics, shell errors, and tests.
- SQLite migrations in `packages/db` are idempotent and preserve
  upgrade data where migration fixtures exist.
- Rust code keeps `unsafe_code = "deny"` and strict clippy lints.
- Container services drop unnecessary privileges in the compose/runtime
  configuration.
- No telemetry, analytics, tracking, phone-home behavior, or hidden
  external calls are part of the admin runtime.

## Test Coverage

Security-sensitive behavior is covered in:

- `apps/api/tests`: login/setup/session, protected routes, role checks,
  signup-disabled behavior, CSRF/action checks, audit logging, and
  subscription masking.
- `packages/db/tests`: migrations, bootstrap tokens, role/last-owner
  rules, proxy accounts, settings, and legacy import fixtures.
- `packages/security/tests`: redaction, validation, token/password
  helpers, and sensitive-output guards.
- `packages/config/tests`: production config validation and safe defaults.
- `operator/tests`: `ct admin`, bootstrap file permissions, update/doctor
  migration messaging, backups/restores, docs command drift, and redacted
  shell output.

Run the release gate from the repository root:

```bash
make ci
```

## Auditability

- Release manifests under `manifests/` pin component versions.
- `make manifest-lockstep` verifies app/package/Rust/manifest version
  alignment.
- `make stale-reference-scan` rejects active references to retired admin
  runtime surfaces.
- `make sbom` generates release SBOM material through the operator tools.

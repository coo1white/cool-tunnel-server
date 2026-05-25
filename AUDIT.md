# Audit Policy

The project historically used numbered LTSC audit cycles to turn manual
findings into repeatable CI checks. v0.5.2 keeps that spirit but resets
the active audit surface around the Better-T-Stack-style monorepo:
Next.js web, Hono/Bun API, Better Auth, SQLite, operator CLI, Caddy,
sing-box, and Rust internal core.

Historical cycle notes remain in `CHANGELOG.md` and git history. This
file describes active release gates.

## Active Gates

| Gate | Command or workflow | What it protects |
| --- | --- | --- |
| UTF-8 check | `make utf8-check` | Tracked text files are valid UTF-8 |
| TypeScript typecheck | `make ts-typecheck` | App/package imports and contracts compile |
| API/package tests | `make ts-test` | Auth, storage, roles, setup, audit, migrations, redaction |
| Next build | `make web-build` | Required admin routes compile |
| Operator typecheck/tests | `make operator-typecheck operator-test` | VPS lifecycle commands and docs drift |
| sing-box package tests | `make singbox-typecheck singbox-test` | Render/supervise package behavior |
| Docker compose config | `make compose-config` | Required v0.5.2 services exist; retired live services do not |
| Manifest JSON | `make manifests-jq` | Release manifests parse |
| Manifest lockstep | `make manifest-lockstep` | v0.5.2 metadata is aligned |
| Rust format/lints/tests/build | `make rust-fmt-check rust-clippy rust-test rust-build` | Internal Rust core remains healthy |
| Stale reference scan | `make stale-reference-scan` | Active docs/config/scripts do not point operators at removed runtime surfaces |
| Secret scan | GitHub workflow / local gitleaks | Committed secrets are rejected |

`make ci` runs the full local release gate.

## Release-Time Expectations

Before tagging:

1. Run the local gates listed above.
2. Review `git status` and `git diff --stat`.
3. Confirm generated artifacts are not accidentally staged.
4. Confirm docs describe the v0.5.2 runtime and migration path.
5. Confirm no sensitive values appear in logs, tests, docs, or final
   release notes.

## Handling Failures

- RustSec or cargo-deny failures: update the affected crate or document a
  time-boxed exception in `core/deny.toml`.
- TypeScript failures: fix the package boundary or shared type drift
  rather than duplicating contracts.
- Migration failures: keep the failed migration recoverable, add a
  fixture when practical, and update `ct doctor` remediation output.
- Stale references: update active docs/config/scripts. Historical
  references are acceptable only when clearly marked as historical or
  migration context.
- Secret scan failures: rotate the exposed credential before publishing a
  fix.

## Adding A Gate

When a review finds a repeatable class of bug, add an automated gate and
document:

1. The command or workflow job.
2. The files it owns.
3. The expected cadence.
4. The failure remediation.

Keep gates self-contained and suitable for a fresh CI runner.

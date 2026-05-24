# Audit policy

The project ran a series of focused **50-cycle LTSC audits**
between v0.0.6 and v0.0.11, codifying recurring machine-run
checks at cycle indices 31–43. The first 30 cycles of each
pass are performed by hand and surface real findings (see
`CHANGELOG.md`); cycles 31–50 ride in `audit.yml` so the
checks fire automatically, weekly and on-PR. This is the only
scalable way to keep an LTSC project honest across releases.

Each pre-v0.0.12 pass added cycles to the codified set:

| Pass | Axis | New cycles codified |
| --- | --- | --- |
| v0.0.6 / v0.0.7 | Initial structural + deep code review | 31–37 (cargo-audit, cargo-deny, legacy composer-audit, secret-scan, manifest-drift, dependency-review, stale-docs) |
| v0.0.8 | UI / UX layout | 38 (retired php-style), 39 (retired blade-asset-links) |
| v0.0.9 | Anti-network-tracking | 40 (anti-tracking-config) |
| v0.0.10 | Code-robustness design | 41 (retired php-psr4), 42 (retired phpstan) |
| v0.0.11 | Compile-time SQL safety | 43 (sqlx-offline-check) |

The `unwrap_used = "deny"` clippy floor (v0.0.10) is enforced
at compile time by `core/Cargo.toml`, not by an audit cycle —
see `LTSC.md § Zero unwrap() floor`.

**Post-v0.0.12 the audit pattern shifted from per-version
hand-passes to continuous automation.** No new LTSC cycles
have been codified at indices 44–50 (kept as forward
placeholders). Three "Cycle N" sub-projects extended the
audit surface separately, with their own numbering (NOT the
LTSC 31–50 series):

| Sub-project | Versions | What it codified |
| --- | --- | --- |
| Cycle 1 — `VerifySpecV1` | v0.0.34–v0.0.38 | Manifest verify spec; verify commands run inside the panel container; `expect_no_version_line` opt-out for probes whose target has no parseable version line |
| Cycle 2 — drift detection | v0.0.39–v0.0.43 | Real drift detection across every non-Rust component: panel (`ct:version`), redis (`INFO Server`), mariadb (`SELECT VERSION()`), sing-box (authenticated clash-API `/version`), haproxy (UNIX stats socket) |
| Cycle 3 — panel-hostname SoT | v0.0.55–v0.0.56 | Single source of truth for the panel hostname; PHP ↔ Rust parity asserted by `scripts/verify_sot.sh` against fixture envs |

Hand-passes still happen as needed — notably the **30-round
audit-loop hardening** that accompanied the v0.0.58
FrankenPHP runtime swap — without claiming a new LTSC cycle
index. v0.0.62 introduced a release-time gate
(`.github/workflows/tag-version.yml`) outside the LTSC
numbering; see § Release-time gates below.

## Where each cycle lives

| Cycles | Where | Cadence |
| --- | --- | --- |
| 1–5 | git history (v0.0.6 commit + CHANGELOG) | one-shot, on demand |
| 6–10 | git history (v0.0.7 commit + CHANGELOG) | one-shot, on demand |
| 11–15 | git history (v0.0.7 commit + CHANGELOG) | one-shot, on demand |
| 16–20 | git history (v0.0.7 commit + CHANGELOG) | one-shot, on demand |
| 21–30 | git history (v0.0.7 commit) | one-shot, on demand |
| **31** — RustSec advisories | `.github/workflows/audit.yml` job `cargo-audit` | **weekly** + on PR touching Cargo |
| **32** — Cargo-deny: licences + ban list + source registry | `audit.yml` job `cargo-deny` (config in `core/deny.toml`) | **weekly** + on PR touching Cargo |
| **33** — PHP Composer audit | retired with the PHP panel; dependency review now covers Bun lockfile changes | historical |
| **34** — Secret scan (gitleaks) | `audit.yml` job `secret-scan` | **weekly** |
| **35** — Manifest version drift (manifests/ ↔ Cargo.toml ↔ Dockerfiles) | `audit.yml` job `manifest-drift` | **weekly** + on every PR |
| **36** — Dependency review (vuln/licence diff vs base) | `audit.yml` job `dependency-review` | every PR |
| **37** — Stale-doc grep (forwardproxy, sing-box ACME, AntiTrackingFilter, etc.) | `audit.yml` job `stale-docs` | **weekly** |
| **38** — PHP style (Laravel Pint) | retired with the PHP panel | historical |
| **39** — Blade asset-link 404 check (`href="/foo.css"` ⟂ `panel/public/`) | retired with the PHP panel | historical |
| **40** — Anti-tracking config smell-test (sing-box TLS 1.3, no TCP clash, no disk cache; Caddy ghost site no recognisable string; no `X-CT-*` headers) | `audit.yml` job `anti-tracking-config` | **weekly** + on every PR |
| **41** — PHP class-vs-filename PSR-4 lint (catches "file Foo.php declares `class Bar`") | retired with the PHP panel | historical |
| **42** — PHPStan level-5 (undefined-method, type errors) | retired with the PHP panel | historical |
| **43** — sqlx offline metadata staleness (every `query!()` call has matching `.sqlx/` JSON) | retained for Rust/MariaDB query shapes | on PR touching `core/` |
| 44–50 | placeholders for future codified checks | — |

## Release-time gates

Separate from the weekly LTSC audit cycles, these workflows
fire on tag pushes (`refs/tags/v*`) only:

| Gate | Workflow | What it asserts | First-gated tag |
| --- | --- | --- | --- |
| `tag-version-check` | `.github/workflows/tag-version.yml` | The bare tag version (`v0.0.62` → `0.0.62`) equals `operator/package.json`'s version. Refuses tags whose source disagrees. | v0.0.62 |

Release-time gates fire once per tag (not weekly) and refuse
the tag (not just flag a regression on main) — intentionally
outside the LTSC cycle 31–50 numbering.

## What's scheduled vs. on-demand

| Trigger | Jobs |
| --- | --- |
| Cron `17 8 * * 1` (Mon 08:17 UTC) | cargo-audit, cargo-deny, secret-scan, manifest-drift, stale-docs, anti-tracking-config |
| Pull-request touching dependencies / manifests / Dockerfiles / templates / operator / core | cargo-audit, cargo-deny, manifest-drift, dependency-review, anti-tracking-config |
| Manual `workflow_dispatch` | every job |

## Adding a new cycle

When a future hand-audit surfaces a class of bug we want to catch
forever, codify it:

1. Add a job to `.github/workflows/audit.yml`. Keep it self-contained
   — runs in ≤ 10 minutes on a `ubuntu-24.04` runner, no external
   secrets beyond `GITHUB_TOKEN`.
2. Add a row to the table above naming the cycle and the cadence.
3. Update `CHANGELOG.md` with the new check.

## What doesn't get codified

- **Anything that needs Docker bringup** (real ACME issuance, real
  sing-box reload, real DB migration). Those live in
  `ct readiness`, which is what an operator runs
  on real metal — CI doesn't pretend it covers them.
- **Subjective taste calls** (variable naming, comment style,
  test-name shape). Those land in code review, not automation.
- **Performance regressions.** We have stress tests for the
  burst-coalescing contracts (1M events in `Debouncer`,
  100k+concurrent in `Coalescer`); if a future audit cycle adds
  more, it goes in `cargo bench` not in audit.yml.

## Rotation policy

Cycles in `audit.yml` should each pass on a clean tree. If a job
goes red:

- **`cargo-audit` / RustSec**: usually a transitive crate. Bump via
  `cargo update -p <crate>`. If no fixed version is available, add
  the advisory ID to `core/deny.toml` `[advisories].ignore` with a
  comment explaining the exception and the date by which we'll
  revisit.
- **`cargo-deny`**: usually a duplicate-version diamond. Resolve
  with `cargo tree --duplicates` and bump the offending dep.
- **Bun dependency advisories**: update the package with `bun update`
  or a targeted package bump, commit `operator/package.json` and
  `operator/bun.lock`, then rerun `cd operator && bun test`.
- **`secret-scan`**: a real secret got committed. Rotate the secret
  immediately, then `git filter-repo` or follow GitHub's secret-
  scanning remediation. Revoke the credential before pushing a fix.
- **`manifest-drift`**: somebody bumped one place and forgot the
  other. Run `make set-version V=…` and commit.
- **`stale-docs`**: a previous concept leaked back in. Update the
  doc; if the leak was intentional (historical reference in
  CHANGELOG / NOTICE), add the file to the workflow's exclude list.

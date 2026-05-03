# Audit policy

This project has run four 50-cycle LTSC audits to date: v0.0.6 /
v0.0.7 (general code), v0.0.8 (UI / UX), v0.0.9
(anti-network-tracking), and v0.0.10 (code-robustness design).
The first 30 cycles of each pass are performed by hand and
surface real findings (see `CHANGELOG.md`). Cycles 31–50 are
codified as recurring machine-run checks: this is the **only**
scalable way to keep an LTSC project honest across releases.

Each pass adds a few more cycles to the codified set as new
classes of regression are discovered. v0.0.7 codified seven
checks (cycles 31–37); v0.0.8 added two more (cycles 38–39) for
PHP style and Blade asset-link validation; v0.0.9 added the
anti-tracking config smell-test (cycle 40); v0.0.10 added the
PSR-4 filename-vs-class lint (cycle 41) and PHPStan
undefined-method analysis (cycle 42), both directly motivated by
showstopper bugs that v0.0.10's hand-audit found.

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
| **33** — Composer audit | `audit.yml` job `composer-audit` | **weekly** + on PR touching composer.lock |
| **34** — Secret scan (gitleaks) | `audit.yml` job `secret-scan` | **weekly** |
| **35** — Manifest version drift (manifests/ ↔ Cargo.toml ↔ Dockerfiles) | `audit.yml` job `manifest-drift` | **weekly** + on every PR |
| **36** — Dependency review (vuln/licence diff vs base) | `audit.yml` job `dependency-review` | every PR |
| **37** — Stale-doc grep (forwardproxy, sing-box ACME, AntiTrackingFilter, etc.) | `audit.yml` job `stale-docs` | **weekly** |
| **38** — PHP style (Laravel Pint) | `audit.yml` job `php-style` | **weekly** + on every PR |
| **39** — Blade asset-link 404 check (`href="/foo.css"` ⟂ `panel/public/`) | `audit.yml` job `blade-asset-links` | **weekly** + on every PR |
| **40** — Anti-tracking config smell-test (sing-box TLS 1.3, no TCP clash, no disk cache; Caddy ghost site no recognisable string; no `X-CT-*` headers) | `audit.yml` job `anti-tracking-config` | **weekly** + on every PR |
| **41** — PHP class-vs-filename PSR-4 lint (catches "file Foo.php declares `class Bar`") | `audit.yml` job `php-psr4` | **weekly** + on every PR touching `panel/app/**` |
| **42** — PHPStan level-5 (undefined-method, type errors) | `audit.yml` job `phpstan` | **weekly** + on every PR touching `panel/app/**` |
| 43–50 | placeholders for future codified checks | — |

## What's scheduled vs. on-demand

| Trigger | Jobs |
| --- | --- |
| Cron `17 8 * * 1` (Mon 08:17 UTC) | cargo-audit, cargo-deny, composer-audit, secret-scan, manifest-drift, stale-docs, php-style, blade-asset-links, anti-tracking-config, php-psr4, phpstan |
| Pull-request touching dependencies / manifests / Dockerfiles / Blade / templates / panel | cargo-audit, cargo-deny, composer-audit, manifest-drift, dependency-review, php-style, blade-asset-links, anti-tracking-config, php-psr4, phpstan |
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
  `scripts/late-night-comeback.sh`, which is what an operator runs
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
- **`composer-audit`**: same flow on the PHP side. Run
  `composer update <package>` locally, commit `composer.lock`.
- **`secret-scan`**: a real secret got committed. Rotate the secret
  immediately, then `git filter-repo` or follow GitHub's secret-
  scanning remediation. Revoke the credential before pushing a fix.
- **`manifest-drift`**: somebody bumped one place and forgot the
  other. Run `make set-version V=…` and commit.
- **`stale-docs`**: a previous concept leaked back in. Update the
  doc; if the leak was intentional (historical reference in
  CHANGELOG / NOTICE), add the file to the workflow's exclude list.

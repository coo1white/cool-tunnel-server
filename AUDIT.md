# Audit policy

This project ran a 50-cycle LTSC audit during v0.0.6 / v0.0.7. The
first 30 cycles were performed by hand and surfaced real findings
(see `CHANGELOG.md`). Cycles 31–50 are codified as recurring
machine-run checks: this is the **only** scalable way to keep an
LTSC project honest.

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
| **37** — Stale-doc grep (forwardproxy, sing-box ACME, etc.) | `audit.yml` job `stale-docs` | **weekly** |
| 38–50 | placeholders for future codified checks | — |

## What's scheduled vs. on-demand

| Trigger | Jobs |
| --- | --- |
| Cron `17 8 * * 1` (Mon 08:17 UTC) | cargo-audit, cargo-deny, composer-audit, secret-scan, manifest-drift, stale-docs |
| Pull-request touching dependencies / manifests / Dockerfiles | cargo-audit, cargo-deny, composer-audit, manifest-drift, dependency-review |
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

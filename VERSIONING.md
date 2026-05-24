# Versioning policy

Short version: this project follows [SemVer](https://semver.org)
for the **operator-facing surface area**. Internal Rust APIs,
internal database schema, Docker image layout, and panel HTML are
explicitly NOT covered by SemVer until `1.0.0`.

## What's covered by SemVer

The "public API" we promise SemVer compatibility on:

| Surface | What you can rely on across compatible versions |
| --- | --- |
| `naive+https://...` profile URL format | A `0.X.Y` URL parses on any `0.X.Z` release |
| `SubscriptionManifestV1` JSON shape | Field set is additive within `V1`; breaking changes go in `V2` |
| `ComponentManifestV1` JSON shape | Same |
| `WireRequestV1` / `WireResponseV1` / `WireEventV1` | Same |
| `ct-server-core` CLI subcommand surface | Subcommands and flags don't change names within a minor; new ones may be added |
| `.env` keys | Existing keys keep their semantics; new ones may be added; deprecations get a one-minor warning window |
| Admin URL routes (`/admin`, `/api/admin/...`, `/api/auth/...`) | Stable within a minor |

Anything else is an internal implementation detail and may change
without notice. Don't write a script that parses the panel's HTML;
don't rely on a specific table name in the database.

## Pre-`1.0` (where we are now)

A few things relax in pre-`1.0`:

- **Minor bumps may break compatibility** with explicit changelog
  notes. We use the patch position (`0.0.X` → `0.0.Y`) for
  no-breaking-change releases and the minor position
  (`0.X.Y` → `0.X+1.Y`) for any breaking change.
- **The DB schema is migration-managed but unstable.** Every
  release runs `ct admin migrate` cleanly from any prior
  release in the same minor line. Across minors, you may need to
  run a documented migration script.
- **The wire format is forward-compatible only**, not
  backward-compatible. A `0.0.5` server speaks to a `0.0.4`
  client, but a `0.0.4` server may reject a `0.0.5` client's
  subscription token.

## Post-`1.0`

When we cut `1.0.0`:

- The wire formats freeze. Any change is a `V2` that lives
  side-by-side with `V1`.
- Minor releases are additive only.
- Major releases get a 12-month deprecation window — old surface
  works, with deprecation warnings, for one full year before
  removal.
- The database schema commits to forward + backward migrations
  within a major line.

## Cross-platform-client compatibility

The Rust client cores (current `cool-tunnel-core` for macOS, future
ones for iOS / Android / Windows / Linux desktop) all link the same
`ct-protocol` crate. We commit to:

- A `ct-protocol` minor release is a non-breaking superset of
  earlier minor releases in the same major.
- A client built against `ct-protocol = "0.0.5"` works against any
  server running `ct-protocol >= 0.0.5` within the same `0.x` line.

## How we cut a release

See [`RELEASE.md`](./RELEASE.md). The short version:

1. Update `CHANGELOG.md`. Move the `[Unreleased]` items into a new
   versioned section.
2. Bump the version in `core/Cargo.toml` workspace.
3. Bump the version in the relevant `manifests/*.upstream.json`
   files.
4. `make ci` locally — must be green before tagging.
5. `git tag -a vX.Y.Z -m "..."` and push.
6. CI builds the release artefacts; we mark the GitHub release
   pre-release until the operator(s) running production have
   confirmed.

## Rollback

A release can be rolled back by checking out the previous tag and
running `./ct update`. Database migrations are designed to
be **safe-to-roll-back within a minor line** but **not necessarily
between minor lines** — the changelog calls out any migration
that's one-way.

If you've already taken a `down` migration that's one-way, the
backup taken by `./ct backup` before the upgrade is your
recovery path.

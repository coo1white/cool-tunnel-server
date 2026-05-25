# Versioning Policy

This project follows SemVer for the operator-facing surface area.
Internal Rust APIs, SQLite table layout, Docker image layout, and admin
HTML are not public contracts before `1.0.0`.

## Covered Surfaces

| Surface | Compatibility promise inside a minor line |
| --- | --- |
| `ct` operator commands | Existing command names and flags keep their behavior unless the changelog calls out a migration |
| `.env` keys | Existing keys keep their semantics; new keys may be added with safe defaults |
| Admin API JSON contracts | Additive changes are allowed; removals require release notes |
| Subscription manifest shape | Additive within the current manifest version |
| Component manifest shape | Additive within the current manifest version |
| Rust wire/profile types | Additive within the current minor line |

Anything else is internal. Do not automate against rendered admin HTML
or private SQLite table names unless the docs explicitly bless that use.

## Pre-1.0 Rules

- Patch releases should avoid breaking operator workflows.
- Minor releases may include breaking changes with explicit changelog and
  migration notes.
- Storage changes must go through idempotent migrations.
- Cross-stack migrations, such as v0.5.1 PHP-backed admin data to
  v0.5.2 SQLite, must have either an operator command or documented
  maintainer action.

## Release Checklist

See [RELEASE.md](./RELEASE.md). The short version:

1. Update `CHANGELOG.md`.
2. Bump root, app, package, operator, singbox-core, Rust, and manifest
   versions.
3. Run `make manifest-lockstep`.
4. Run the TypeScript, operator, Docker, stale-reference, and Rust
   verification gates listed in `RELEASE.md`.
5. Commit, push, and open a pull request.
6. Tag and publish only after required verification passes.

## Rollback

Before upgrade, take a backup:

```bash
./ct backup
```

Rollback is checking out the previous release and running `./ct update`.
If a migration is one-way, the changelog calls it out and the backup is
the recovery path.

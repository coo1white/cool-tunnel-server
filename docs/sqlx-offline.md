# SQLx Offline Mode

The active v0.5.2 admin runtime stores state in SQLite through
`packages/db`. Rust remains internal for protocol/config/runtime work.

This page is retained for the remaining `core/ct-server-core`
`sqlx::query!()` calls. Those calls still compile against committed
offline metadata in `core/.sqlx/` so Rust builds do not need a live
database.

## Current Contract

```bash
cd core
SQLX_OFFLINE=true cargo check --workspace --locked
```

If a Rust query changes and `core/.sqlx/` no longer matches, cargo
fails with a cached-query metadata error. That is intentional: fix the
Rust query or refresh the metadata on a maintainer host before merging.

There is no active root `make sqlx-prepare` target in v0.5.2. The
previous prepare helper was removed with the PHP admin runtime. If a
future Rust change needs fresh metadata, maintainers should recreate the
minimal schema fixture for `core/ct-server-core/src/db.rs`, run
`cargo sqlx prepare` manually on that fixture, and commit the updated
`core/.sqlx/*.json` files.

## Common Errors

**`error: no cached data for this query`** means a `query!()` call is
not represented in `core/.sqlx/`. Either avoid the compile-time macro
for that internal path, or refresh and commit the offline metadata.

**`prepared metadata for query is for a different schema`** means the
committed metadata and Rust query expectations disagree. Keep the
failure recoverable by updating the fixture/metadata in the same change
as the Rust query.

# SQLx Offline Metadata

The Rust workspace uses committed `core/.sqlx/*.json` files for compile-time query checking with `SQLX_OFFLINE=true`.

CI runs:

```sh
cd core
SQLX_OFFLINE=true cargo check --workspace --locked
```

If a retained MariaDB query changes and the offline metadata is stale, regenerate `core/.sqlx/` from a trusted development database and commit the updated JSON files. Production install/update does not run metadata preparation.

# SQLx offline mode

> **Why:** every `sqlx::query!()` / `query_as!()` call in
> `core/ct-server-core/` is type-checked **at compile time**
> against the panel's MariaDB schema. No more "BIGINT UNSIGNED
> doesn't match i64" errors at runtime — schema regressions
> become `cargo check` failures, never production failures.

## How it works

```
panel migrations             core/.sqlx/*.json              core/ src/db.rs
─────────────────       ↘    ─────────────────       ↗     ─────────────────
                                                            sqlx::query!(...)

  $table->id();        ─→    [scripts/sqlx-prepare.sh]    
  ...                                  │                    
                                       ▼                    cargo check
                              {"id":{"sql":"BIGINT UNSIGNED",     │
                                     "rust":"u64"}, ...}          ▼
                                                            E0277 / E0382
                                                            if mismatch
```

1. Operator runs **`make sqlx-prepare`** (script:
   [`scripts/sqlx-prepare.sh`](../scripts/sqlx-prepare.sh)).
2. The script brings up MariaDB, runs Laravel migrations, points
   `DATABASE_URL` at the result, runs `cargo sqlx prepare`.
3. sqlx-cli inspects every `query!()` / `query_as!()` call in
   the workspace, runs each against the live DB, captures the
   inferred column types, writes one JSON file per query under
   `core/.sqlx/`.
4. Operator commits `core/.sqlx/`.
5. From then on, every `cargo build` / `cargo check` (CI included)
   runs with **`SQLX_OFFLINE=true`**. The macros validate against
   the committed JSON instead of needing a live DB.

## When to re-run

- **After a migration changes a column** (added, dropped, retyped)
- **After you add or change a `sqlx::query!()` call** in the Rust
  workspace
- **First checkout** if `core/.sqlx/` is missing (it's committed,
  but a feature-branch pull might not have it yet)

CI's `sqlx-offline-check` job (codified in
[`.github/workflows/audit.yml`](../.github/workflows/audit.yml))
fails the build if the committed metadata doesn't match the
current source — the operator can't forget to regenerate.

## Run it

```bash
make sqlx-prepare
git add core/.sqlx
git commit -m "chore(sqlx): refresh offline metadata after <migration>"
git push origin main
```

That's the whole loop.

## Why we picked this

| Path | Pros | Cons | Picked? |
| --- | --- | --- | --- |
| **`sqlx::query()` runtime** | No prepare step | Schema mismatches surface in production logs, not CI | ❌ — what bit us in v0.0.10 |
| **`sqlx::query!()` online** | Compile-time typed, no extra files | `cargo build` requires a live DB | ❌ — bloats every CI runner / Docker build with a MariaDB |
| **`sqlx::query!()` offline** | Compile-time typed, builds without DB | One extra step per migration | ✅ — what we ship |

## What the JSON looks like

`core/.sqlx/query-<hash>.json` per query. Example shape:

```json
{
  "db_name": "MySQL",
  "query": "SELECT id, domain ...",
  "describe": {
    "columns": [
      { "ordinal": 0, "name": "id", "type_info": "BIGINT UNSIGNED" },
      { "ordinal": 1, "name": "domain", "type_info": "VARCHAR" },
      ...
    ],
    "parameters": { ... },
    "nullable": [false, false, ...]
  }
}
```

The compiler reads this at macro-expansion time and refuses to
compile `let id: i64 = row.id` if `id` is `BIGINT UNSIGNED` (i.e.
`u64`).

## Common errors

**`error: no cached data for this query`** — you added a
`query!()` call without running `make sqlx-prepare`. Fix:

```bash
make sqlx-prepare && git add core/.sqlx
```

**`error: cannot find DATABASE_URL`** during prepare — your `.env`
isn't loaded or the panel container can't reach the db. Fix:

```bash
docker compose ps   # is `db` healthy?
```

**`error: prepared metadata for query is for a different schema`**
— a migration ran but `.sqlx/` is from before. Same fix:
re-prepare and commit.
